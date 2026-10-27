import { useEffect, useMemo, useState } from "react";
import { CircleHelp, LoaderCircle, Move3d, RotateCcw, Save, X } from "lucide-react";
import { volumeToNpy } from "../exportVolume";
import { safeFileName, saveBlob } from "../download";
import { createDifferenceVolume } from "../loaders/medicalLoader";
import { REGISTRATION_METHODS, defaultRegistrationParams, formatDuration, type RegistrationParam } from "../registrationMethods";
import type { RegistrationMethod, RegistrationParams, RegistrationStatus, Volume } from "../types";
import type { ExtensionContribution, ExtensionHost, ViewerExtension } from "./types";

let registrationSequence = 0;
const ROLES = ["Fixed", "Moving", "Moving − Fixed", "Registered", "Registered − Fixed"];
// Rate for the ETA is measured from the first real progress sample, so Python start-up time does not inflate it.
type RegistrationProgress = RegistrationStatus & { anchor?: { time: number; progress: number } };

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function useRegistration(host: ExtensionHost): ExtensionContribution {
    const { active, volumes } = host;
    const [method, setMethod] = useState<RegistrationMethod>("convexadam");
    const [paramsByMethod, setParamsByMethod] = useState(() => Object.fromEntries(
        REGISTRATION_METHODS.map(item => [item.id, defaultRegistrationParams(item)])) as Record<RegistrationMethod, RegistrationParams>);
    const [helpOpen, setHelpOpen] = useState(false);
    const [fixedId, setFixedId] = useState("");
    const [movingId, setMovingId] = useState("");
    const [resultId, setResultId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [progress, setProgress] = useState<RegistrationProgress | null>(null);
    const [startedAt, setStartedAt] = useState(0);
    const [now, setNow] = useState(0);
    const [savingVolumeId, setSavingVolumeId] = useState("");
    useEffect(() => window.dcmViewer?.onRegistrationStatus?.(status => {
        const time = Date.now();
        setNow(time);
        setProgress(current => ({ ...status,
            anchor: current?.anchor ?? (status.phase === "run" && status.progress ? { time, progress: status.progress } : undefined) }));
    }), []);
    // Ticks elapsed time between progress lines (setup and long iterations report rarely).
    useEffect(() => {
        if (!busy) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [busy]);

    // Workspace panes: Fixed spans the left column; Moving | Moving − Fixed above Registered | Registered − Fixed.
    const viewFixed = volumes.find(volume => volume.id === fixedId);
    const viewMoving = volumes.find(volume => volume.id === movingId);
    const viewRegistered = volumes.find(volume => volume.id === resultId);
    const movingDifference = useMemo(
        () => active && viewFixed && viewMoving && viewFixed.id !== viewMoving.id ? createDifferenceVolume(viewFixed, viewMoving) : undefined,
        [active, viewFixed, viewMoving],
    );
    const registeredDifference = useMemo(
        () => active && viewFixed && viewRegistered && viewFixed.id !== viewRegistered.id ? createDifferenceVolume(viewFixed, viewRegistered) : undefined,
        [active, viewFixed, viewRegistered],
    );

    // Desktop registers voxels held in this window; the web platform registers volumes the server holds (by token).
    const source = window.dcmViewer?.registerVolumes ? window.dcmViewer.registrationSource : undefined;
    const candidates = volumes.filter(volume => source === "server" ? Boolean(volume.remote?.token)
        : source === "memory" && !volume.remote);
    const fixed = candidates.find(volume => volume.id === fixedId);
    const moving = candidates.find(volume => volume.id === movingId);
    const info = REGISTRATION_METHODS.find(item => item.id === method)!;
    const params = paramsByMethod[method];
    const setParam = (key: string, value: string | number | boolean) =>
        setParamsByMethod(current => ({ ...current, [method]: { ...current[method], [key]: value } }));

    const run = async () => {
        const registerVolumes = window.dcmViewer?.registerVolumes;
        if (!registerVolumes || !fixed || !moving) return;
        // Inputs are not clamped while typing (that would fight the keyboard); out-of-range values are fixed here.
        const request: RegistrationParams = {};
        for (const param of info.params) {
            const value = params[param.key];
            if (param.type === "number") {
                request[param.key] = Number.isFinite(Number(value)) ? Math.min(Math.max(Number(value), param.min), param.max) : param.default;
            } else if (param.type === "integers" && !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(String(value))) {
                setError(`${param.label} must be comma-separated integers, e.g. ${param.default}.`);
                return;
            } else {
                request[param.key] = value;
            }
        }
        setBusy(true);
        setError("");
        setProgress(null);
        setStartedAt(Date.now());
        setNow(Date.now());
        try {
            const output = await registerVolumes(info.id,
                { data: fixed.data, dimensions: fixed.dimensions, token: fixed.remote?.token },
                { data: moving.data, dimensions: moving.dimensions, token: moving.remote?.token }, request);
            let min = Infinity;
            let max = -Infinity;
            if (output instanceof Float32Array) for (const value of output) {
                if (value < min) min = value;
                if (value > max) max = value;
            }
            // The server returns a streamed volume with its own range; desktop output is the voxel array itself.
            const result: Volume = {
                ...(output instanceof Float32Array ? {
                    data: output, min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0,
                } : { data: output.data, remote: output.remote, min: output.min, max: output.max }),
                id: `registration:${++registrationSequence}`,
                name: `${moving.name} → ${fixed.name} (${info.label})`,
                format: moving.format,
                patientId: fixed.patientId,
                studyId: "Registration",
                seriesId: "Registration",
                dimensions: fixed.dimensions,
                windowCenter: moving.windowCenter,
                windowWidth: moving.windowWidth,
                sourceParentDir: "Registration",
            };
            host.addVolume(result);
            setResultId(result.id);
            if (!active) host.showVolume(result);
        } catch (failure) {
            // Electron prefixes IPC errors with "Error invoking remote method '…': Error:".
            setError(errorMessage(failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
        } finally {
            setBusy(false);
        }
    };
    const saveVolume = async (volume: Volume) => {
        setSavingVolumeId(volume.id);
        try {
            await saveBlob(await volumeToNpy(volume), `${safeFileName(volume.name)}.npy`);
        } catch (failure) {
            setError(`Could not save ${volume.name}: ${errorMessage(failure)}`);
        } finally {
            setSavingVolumeId("");
        }
    };
    const percent = progress?.phase === "run" && progress.progress ? Math.round(progress.progress * 100) : undefined;
    const anchor = progress?.anchor;
    const eta = anchor && progress?.progress !== undefined && progress.progress - anchor.progress >= 0.01
        ? (now - anchor.time) / 1000 * (1 - progress.progress) / (progress.progress - anchor.progress)
        : undefined;
    const paramControl = (param: RegistrationParam) => {
        const value = params[param.key];
        if (param.type === "boolean") {
            return <label key={param.key} className="registrationParam labelToggle" title={param.hint}>
                <input type="checkbox" checked={Boolean(value)} onChange={event => setParam(param.key, event.target.checked)} />
                <span>{param.label}</span>
            </label>;
        }
        return <label key={param.key} className={param.type === "select" ? "registrationParam registrationParamWide" : "registrationParam"} title={param.hint}>
            <span>{param.label}</span>
            {param.type === "select"
                ? <select aria-label={param.label} value={String(value)} onChange={event => setParam(param.key, event.target.value)}>
                    {param.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                : param.type === "number"
                    ? <input type="number" aria-label={param.label} min={param.min} max={param.max} step={param.step} value={String(value)}
                        onChange={event => setParam(param.key, event.target.value)} />
                    : <input type="text" aria-label={param.label} inputMode="numeric" pattern="\s*\d+(\s*,\s*\d+)*\s*" value={String(value)}
                        onChange={event => setParam(param.key, event.target.value)} />}
        </label>;
    };

    const renderPanel = () => <section className="windowingPanel sidebarPanel labelPanel" aria-label="Registration">
        <div className="windowingPanelHeader"><span>Registration</span></div>
        <div className="registrationMethodRow">
            <label className="windowingPresetRow"><span>Method</span>
                <select aria-label="Registration method" value={method} disabled={busy}
                    onChange={event => setMethod(event.target.value as RegistrationMethod)}>
                    {REGISTRATION_METHODS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
            </label>
            <button type="button" className="iconButton" aria-label={`About ${info.label}`} aria-expanded={helpOpen}
                title={helpOpen ? "Hide method description" : "Show method description"} onClick={() => setHelpOpen(open => !open)}>
                <CircleHelp size={16} />
            </button>
        </div>
        {helpOpen
            ? <div className="registrationHelp">{info.help.map(text => <p key={text}>{text}</p>)}</div>
            : <small>{info.summary}</small>}
        <fieldset className="registrationParams" disabled={busy}>
            <legend>{info.label} parameters</legend>
            {info.params.map(paramControl)}
            <button type="button" onClick={() => setParamsByMethod(current => ({ ...current, [method]: defaultRegistrationParams(info) }))}>
                <RotateCcw size={14} /> Reset to defaults
            </button>
        </fieldset>
        <label className="windowingPresetRow"><span>Fixed</span>
            <select aria-label="Fixed volume" value={fixed?.id ?? ""} disabled={busy} onChange={event => setFixedId(event.target.value)}>
                <option value="">Choose volume</option>
                {candidates.map(volume => <option key={volume.id} value={volume.id}>{volume.name}</option>)}
            </select>
        </label>
        <label className="windowingPresetRow"><span>Moving</span>
            <select aria-label="Moving volume" value={moving?.id ?? ""} disabled={busy} onChange={event => setMovingId(event.target.value)}>
                <option value="">Choose volume</option>
                {candidates.map(volume => <option key={volume.id} value={volume.id}>{volume.name}</option>)}
            </select>
        </label>
        <label className="windowingPresetRow"><span>Registered</span>
            <select aria-label="Registered volume" value={viewRegistered?.id ?? ""} onChange={event => setResultId(event.target.value)}>
                <option value="">None</option>
                {volumes.map(volume => <option key={volume.id} value={volume.id}>{volume.name}</option>)}
            </select>
        </label>
        <button type="button" disabled={!window.dcmViewer?.registerVolumes || !fixed || !moving || fixed.id === moving.id || busy}
            onClick={() => void run()}>
            {busy ? <><LoaderCircle size={14} className="spinner" aria-hidden="true" /> Registering…</> : <><Move3d size={14} /> Register</>}
        </button>
        {busy && window.dcmViewer?.cancelRegistration && <button type="button" onClick={() => void window.dcmViewer?.cancelRegistration?.()}>
            <X size={14} /> Cancel
        </button>}
        {busy && <div className="registrationProgress" role="status" aria-live="polite">
            <strong>{progress?.message || "Preparing…"}</strong>
            <div className={percent !== undefined ? "loadingProgress" : "loadingProgress loadingProgressIndeterminate"}
                role="progressbar" aria-label="Registration progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <span style={{ width: percent !== undefined ? `${percent}%` : undefined }} />
            </div>
            <small>
                {progress?.phase === "queue" ? "Queued" : progress?.phase === "setup" ? "One-time setup"
                    : percent !== undefined ? `${percent}%` : "Starting"}
                {" · "}{progress?.phase === "queue" || progress?.phase === "setup" ? "ETA after start" : eta !== undefined ? `ETA ${formatDuration(eta)}` : "Estimating ETA…"}
                {" · "}Elapsed {formatDuration((now - startedAt) / 1000)}
            </small>
        </div>}
        {volumes.filter(volume => volume.id.startsWith("registration:")).map(volume =>
            <div className="registrationResult" key={volume.id}>
                <span title={volume.name}>{volume.name}</span>
                <button type="button" disabled={Boolean(savingVolumeId)} title="Save the registered volume as a Float32 .npy file"
                    onClick={() => void saveVolume(volume)}>
                    {savingVolumeId === volume.id ? <LoaderCircle size={14} className="spinner" aria-hidden="true" /> : <Save size={14} />} Save .npy
                </button>
            </div>)}
        {error && <small className="panelError" role="alert">{error}</small>}
        <small>{source === "server"
            ? "Runs on the server, one registration at a time. Only volumes opened from the server are listed; files viewed in the browser only cannot be registered."
            : source === "memory"
                ? "Warps Moving onto the Fixed grid in voxel units and adds the result under Registration. Missing Python packages are installed on first use after you confirm."
                : "Registration is available in the desktop app and on the web platform."}</small>
    </section>;

    const panes = useMemo(() => [viewFixed, viewMoving, movingDifference, viewRegistered, registeredDifference]
        .map((volume, index) => ({ role: ROLES[index], volume, difference: index === 2 || index === 4 })),
    [viewFixed, viewMoving, movingDifference, viewRegistered, registeredDifference]);
    return {
        renderPanel,
        workspace: {
            rows: 2,
            columns: 3,
            className: "registrationGrid",
            panes,
            derivedVolumes: [movingDifference, registeredDifference].filter((volume): volume is Volume => Boolean(volume)),
            status: !viewFixed || !viewMoving ? "Select Fixed and Moving in the Registration panel."
                : viewFixed.id === viewMoving.id ? "Select two different volumes."
                : !viewRegistered ? "Run registration or pick a Registered volume to fill the bottom row."
                : `Differences are X − Fixed${!movingDifference || !registeredDifference ? " · Unavailable where in-plane dimensions differ" : ""}`,
            // ponytail: Fixed sits top-left only; its row-spanning layout is not reproduced in the PNG grid.
            exportGaps: [3],
            // Difference panes are derived, so only Fixed, Moving and Registered take a picked volume.
            assign: (index, volume) => [setFixedId, setMovingId, undefined, setResultId][index]?.(volume.id),
        },
    };
}

export const registrationExtension: ViewerExtension = { id: "registration", label: "Registration", icon: Move3d, use: useRegistration };
