import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { FlipHorizontal2, FlipVertical2, StretchVertical, Link2, Unlink2, ZoomIn, ZoomOut, Scan, RotateCcw, FolderOpen, ImageDown } from "lucide-react";
import type {
    Axis,
    LabelOverlay,
    ViewportState,
    Volume,
} from "../types";
import {
    differenceColorPosition,
    getSliceCount,
    getSliceSize,
    getVoxel,
    renderSliceToCanvas,
    slicePixelToVoxel,
    sliceValues,
} from "../rendering";
import { saveViewportImage } from "../exportImage";
import { LINK_GROUPS, imagePlacement, resetState, zoomedState } from "../viewport";
import { DEFAULT_WINDOW_CENTER, DEFAULT_WINDOW_WIDTH } from "../windowing";
import { COLOR_MAPS, COLOR_MAP_GROUPS, colorBarGradient, colorFromMap } from "../colormaps";
import type { VisualizationColorMap } from "../colormaps";

type Props = {
    state: ViewportState;
    volumes: Volume[];
    overlays: LabelOverlay[];
    compareRole?: string;
    differencePane?: boolean;
    // Registration view: pane sources come from the Registration panel.
    volumeLocked?: boolean;
    onOpenFiles: () => void;
    active: boolean;
    linkEnabled: boolean;
    // Compare mode: one shared control bar replaces per-pane toolbar and slice controls.
    sharedControls?: boolean;
    onActivate: () => void;
    onToggleSingleView?: () => void;
    onSaveError?: (message: string) => void;
    // Ctrl-hover crosshair: position as a fraction of the drawn image, shared by every pane that takes part.
    crosshair?: { fx: number; fy: number } | null;
    onCrosshair?: (point: { fx: number; fy: number } | null) => void;
    onChange: (nextState: ViewportState) => void;
};

const axisLabels: Record<Axis, string> = {
    axial: "Axial",
    coronal: "Coronal",
    sagittal: "Sagittal",
};

type WindowDragState = {
    startX: number;
    startY: number;
    windowCenter: number;
    windowWidth: number;
};

type HoverVoxel = {
    x: number;
    y: number;
    z: number;
    value: number;
    label?: number;
};

function formatVolumeOptionLabel(volume: Volume) {
    const parentDir =
        volume.sourceParentDir ??
        (volume.renderMode === "difference" ? "Difference" : volume.patientId);
    return `${volume.name} (${parentDir})`;
}

function formatVoxelValue(value?: number) {
    if (value === undefined) return "-";
    if (!Number.isFinite(value)) return "NaN";
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

// Click toggles the link; right-click (or the context-menu key) picks the group.
function LinkButton({ state, onChange }: { state: ViewportState; onChange: (nextState: ViewportState) => void }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const group = LINK_GROUPS.find(item => item.id === state.linkGroup) ?? LINK_GROUPS[0];
    useEffect(() => {
        if (!menuOpen) return;
        const close = (event: Event) => {
            if (event instanceof KeyboardEvent ? event.key === "Escape" : !rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
        };
        document.addEventListener("pointerdown", close);
        document.addEventListener("keydown", close);
        return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
    }, [menuOpen]);
    const label = `${state.linked ? "Disable" : "Enable"} viewport link (group ${group.id})`;
    return (
        <div className="linkControl" ref={rootRef} style={{ "--link-color": group.color } as CSSProperties}>
            <button className={`linkButton ${state.linked ? "linked" : ""}`} type="button" aria-label={label}
                aria-haspopup="menu" aria-expanded={menuOpen} title={`${label}. Right-click to choose a link group.`}
                onClick={() => onChange({ ...state, linked: !state.linked })}
                onContextMenu={event => { event.preventDefault(); setMenuOpen(open => !open); }}>
                {state.linked ? <Link2 size={14} /> : <Unlink2 size={14} />}
                <span className="linkGroupBadge" aria-hidden="true">{group.id}</span>
            </button>
            {menuOpen && <div className="linkGroupMenu" role="menu" aria-label="Link group">
                {LINK_GROUPS.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === group.id}
                    autoFocus={item.id === group.id} style={{ "--link-color": item.color } as CSSProperties}
                    onClick={() => { onChange({ ...state, linked: true, linkGroup: item.id }); setMenuOpen(false); }}>
                    <i aria-hidden="true" /> Group {item.id}
                </button>)}
            </div>}
        </div>
    );
}

type ControlProps = { state: ViewportState; volume?: Volume; onChange: (nextState: ViewportState) => void };

// Colormap and Min/Max for the Compare difference pane; values beyond Min/Max take the boundary color.
// Number boxes commit on blur or Enter so partial input such as "-" is not rejected mid-typing.
function DifferenceControls({ state, volume, onChange }: ControlProps & { volume: Volume }) {
    const low = Math.min(volume.min, 0);
    const high = Math.max(volume.max, 0);
    const setMin = (value: number) => Number.isFinite(value) && onChange({ ...state, clipMin: value, clipMax: Math.max(state.clipMax, value) });
    const setMax = (value: number) => Number.isFinite(value) && onChange({ ...state, clipMax: value, clipMin: Math.min(state.clipMin, value) });
    return (
        <div className="differenceControls">
            <select aria-label="Difference colormap" value={state.colorMap}
                onChange={event => onChange({ ...state, colorMap: event.target.value as VisualizationColorMap })}>
                {COLOR_MAP_GROUPS.map(group => <optgroup key={group} label={group}>
                    {COLOR_MAPS.filter(map => map.group === group).map(map => <option key={map.id} value={map.id}>{map.label}</option>)}
                </optgroup>)}
            </select>
            <label>Min
                <input type="range" aria-label="Difference Min" min={low} max={high} step="any" value={state.clipMin}
                    onChange={event => setMin(Number(event.target.value))} />
                <input type="number" className="numberInput" aria-label="Difference Min value" step="any" key={state.clipMin} defaultValue={formatVoxelValue(state.clipMin)}
                    onBlur={event => setMin(event.target.valueAsNumber)} onKeyDown={event => event.key === "Enter" && event.currentTarget.blur()} />
            </label>
            <label>Max
                <input type="range" aria-label="Difference Max" min={low} max={high} step="any" value={state.clipMax}
                    onChange={event => setMax(Number(event.target.value))} />
                <input type="number" className="numberInput" aria-label="Difference Max value" step="any" key={state.clipMax} defaultValue={formatVoxelValue(state.clipMax)}
                    onBlur={event => setMax(event.target.valueAsNumber)} onKeyDown={event => event.key === "Enter" && event.currentTarget.blur()} />
            </label>
            <button type="button" title="Use the full difference range" onClick={() => onChange({ ...state, clipMin: volume.min, clipMax: volume.max })}>Full</button>
        </div>
    );
}

const HISTOGRAM_BINS = 48;
const HISTOGRAM_WIDTH = 160;
const HISTOGRAM_HEIGHT = 56;

// Distribution of the visible slice over the current Min..Max; values beyond either end fall into the edge bins,
// matching how they are drawn. Bars use the pane's colormap, heights a log scale so the zero spike does not flatten the rest.
function DifferenceHistogram({ values, state }: { values: Float32Array; state: ViewportState }) {
    const low = Math.min(state.clipMin, state.clipMax);
    const high = Math.max(state.clipMin, state.clipMax);
    const counts = useMemo(() => {
        const bins = new Uint32Array(HISTOGRAM_BINS);
        const width = (high - low) / HISTOGRAM_BINS || 1;
        for (const value of values) {
            if (Number.isNaN(value)) continue;
            bins[Math.min(Math.max(Math.floor((value - low) / width), 0), HISTOGRAM_BINS - 1)] += 1;
        }
        return bins;
    }, [values, low, high]);
    const peak = Math.log1p(Math.max(...counts));
    const barWidth = HISTOGRAM_WIDTH / HISTOGRAM_BINS;
    const zero = low < 0 && high > 0 ? (-low / (high - low)) * HISTOGRAM_WIDTH : undefined;
    return (
        <figure className="differenceHistogram" aria-label={`Difference histogram from ${formatVoxelValue(low)} to ${formatVoxelValue(high)}`}>
            <svg width={HISTOGRAM_WIDTH} height={HISTOGRAM_HEIGHT} viewBox={`0 0 ${HISTOGRAM_WIDTH} ${HISTOGRAM_HEIGHT}`} aria-hidden="true">
                {Array.from(counts, (count, index) => {
                    const height = peak ? (Math.log1p(count) / peak) * HISTOGRAM_HEIGHT : 0;
                    const center = low + ((index + 0.5) / HISTOGRAM_BINS) * (high - low);
                    const color = colorFromMap(state.colorMap, differenceColorPosition(center, low, high, state.colorMap));
                    return <rect key={index} x={index * barWidth} y={HISTOGRAM_HEIGHT - height} width={barWidth} height={height} fill={`rgb(${color.join(",")})`} />;
                })}
                {zero !== undefined && <line className="differenceHistogramZero" x1={zero} x2={zero} y1={0} y2={HISTOGRAM_HEIGHT} />}
            </svg>
            <figcaption><span>{formatVoxelValue(low)}</span><span>Slice (log)</span><span>{formatVoxelValue(high)}</span></figcaption>
        </figure>
    );
}

// Zoom, fit, reset, flips and axis.
export function ViewControls({ state, volume, onChange }: ControlProps) {
    return (
        <div className="orientationControls">
            <button type="button" title="Zoom out (−)" aria-label="Zoom out" disabled={!volume || state.zoom <= 0.25} onClick={() => onChange(zoomedState(state, state.zoom / 1.25))}><ZoomOut size={15} /></button>
            <span className="zoomValue">{Math.round(state.zoom * 100)}%</span>
            <button type="button" title="Zoom in (+)" aria-label="Zoom in" disabled={!volume || state.zoom >= 8} onClick={() => onChange(zoomedState(state, state.zoom * 1.25))}><ZoomIn size={15} /></button>
            <button type="button" title="Fit image (0)" aria-label="Fit image" disabled={!volume} onClick={() => onChange({ ...state, zoom: 1, panX: 0, panY: 0 })}><Scan size={15} /></button>
            <button type="button" title="Reset view (R)" aria-label="Reset view" disabled={!volume} onClick={() => volume && onChange(resetState(state, volume))}><RotateCcw size={15} /></button>
            <button type="button" title="Flip left / right" aria-label="Flip left / right"
                aria-pressed={state.flipHorizontal} disabled={!volume}
                onClick={() => onChange({ ...state, flipHorizontal: !state.flipHorizontal })}>
                <FlipHorizontal2 size={16} />
            </button>
            <button type="button" title="Flip up / down" aria-label="Flip up / down"
                aria-pressed={state.flipVertical} disabled={!volume}
                onClick={() => onChange({ ...state, flipVertical: !state.flipVertical })}>
                <FlipVertical2 size={16} />
            </button>
            <button type="button" title="Stretch coronal / sagittal slices to the pane height" aria-label="Stretch to pane height"
                aria-pressed={Boolean(state.stretch)} disabled={!volume || state.axis === "axial"}
                onClick={() => onChange({ ...state, stretch: !state.stretch })}>
                <StretchVertical size={16} />
            </button>
            <div
                className="segmented"
                role="group"
                aria-label="Select axis"
            >
                {(["axial", "coronal", "sagittal"] as Axis[]).map(
                    (axis) => (
                        <button
                            key={axis}
                            className={
                                state.axis === axis ? "selected" : ""
                            }
                            type="button"
                            aria-pressed={state.axis === axis}
                            disabled={!volume}
                            onClick={() => {
                                const nextCount = volume
                                    ? getSliceCount(volume, axis)
                                    : 1;
                                onChange({
                                    ...state,
                                    axis,
                                    slice: Math.floor(nextCount / 2),
                                });
                            }}
                        >
                            {axisLabels[axis]}
                        </button>
                    ),
                )}
            </div>
        </div>
    );
}

// Slice stepper, jump-to-number and slider.
export function SliceControls({ state, volume, onChange }: ControlProps) {
    const [sliceInput, setSliceInput] = useState("");
    const sliceCount = volume ? getSliceCount(volume, state.axis) : 1;
    const boundedSlice = Math.min(Math.max(state.slice, 0), sliceCount - 1);
    useEffect(() => { setSliceInput(""); }, [volume, boundedSlice, state.axis]);
    const changeSlice = (nextSlice: number) => {
        const clampedSlice = Math.min(Math.max(nextSlice, 0), sliceCount - 1);
        if (clampedSlice !== boundedSlice) onChange({ ...state, slice: clampedSlice });
    };
    return (
        <div className="viewportFooter">
            <div className="sliceNavigation">
                <button type="button" aria-label="Previous slice" disabled={!volume || boundedSlice === 0} onClick={() => changeSlice(boundedSlice - 1)}>‹</button>
                <input type="number" aria-label="Slice number" min={1} max={sliceCount} placeholder={String(boundedSlice + 1)} value={sliceInput} disabled={!volume}
                    onChange={event => setSliceInput(event.target.value)}
                    onBlur={event => { const value = event.currentTarget.value; if (value.trim() && Number.isFinite(Number(value))) changeSlice(Math.round(Number(value)) - 1); setSliceInput(""); }}
                    onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = ""; setSliceInput(""); event.currentTarget.blur(); } }} />
                <span>/ {sliceCount}</span>
                <button type="button" aria-label="Next slice" disabled={!volume || boundedSlice === sliceCount - 1} onClick={() => changeSlice(boundedSlice + 1)}>›</button>
            </div>
            <label>
                <span>
                    Slice {boundedSlice + 1}/{sliceCount}
                </span>
                <input
                    type="range"
                    disabled={!volume || sliceCount <= 1}
                    min={0}
                    max={Math.max(sliceCount - 1, 0)}
                    value={boundedSlice}
                    onChange={(event) =>
                        onChange({
                            ...state,
                            slice: Number(event.target.value),
                        })
                    }
                />
            </label>
        </div>
    );
}

export function SliceViewport({
    state,
    volumes,
    overlays,
    compareRole,
    differencePane,
    volumeLocked,
    onOpenFiles,
    active,
    linkEnabled,
    sharedControls,
    onActivate,
    onToggleSingleView,
    onSaveError,
    crosshair,
    onCrosshair,
    onChange,
}: Props) {
    const [remoteState, setRemoteState] = useState<{ key: string; image?: Volume; label?: Volume; error?: string } | null>(null);
    const [retry, setRetry] = useState(0);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const paintedFrame = useRef<{ volume: Volume; label?: Volume; axis: Axis; flipHorizontal: boolean; flipVertical: boolean } | null>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const panDragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
    const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
    const windowDragRef = useRef<WindowDragState | null>(null);
    const [hoverVoxel, setHoverVoxel] = useState<HoverVoxel | null>(null);
    const volume = volumes.find((item) => item.id === state.volumeId);
    const overlay = overlays.find(item => item.id === state.labelOverlayId && item.targetVolumeId === volume?.id);
    const visibleLabel = state.showLabel ? overlay?.volume : undefined;
    const sliceCount = volume ? getSliceCount(volume, state.axis) : 1;
    const boundedSlice = Math.min(Math.max(state.slice, 0), sliceCount - 1);

    const remoteKey = `${volume?.id}|${volume?.remote?.version}|${visibleLabel?.id}|${visibleLabel?.remote?.version}|${state.axis}|${boundedSlice}|${retry}`;
    const needsRemote = Boolean(volume?.remote || visibleLabel?.remote);
    // Slices already in memory render in the same commit as the slice change.
    const syncRemote = useMemo(() => {
        if (!volume || !needsRemote) return undefined;
        const peek = (item: Volume) => {
            if (!item.remote) return item;
            const reader = item.remote.peekSlice?.(state.axis, boundedSlice);
            return reader && { ...item, remote: { ...item.remote, getVoxel: reader } };
        };
        const image = peek(volume);
        const label = visibleLabel && peek(visibleLabel);
        return image && (!visibleLabel || label) ? { key: remoteKey, image, label: label || undefined } : undefined;
    }, [volume, visibleLabel, needsRemote, state.axis, boundedSlice, remoteKey]);
    const remoteFrame = syncRemote ?? remoteState;
    const remoteReady = !needsRemote || (remoteFrame?.key === remoteKey && Boolean(remoteFrame.image));
    const shownVolume = needsRemote ? remoteFrame?.key === remoteKey ? remoteFrame.image : undefined : volume;
    const differenceValues = useMemo(
        () => differencePane && shownVolume && remoteReady ? sliceValues(shownVolume, state.axis, boundedSlice) : undefined,
        [differencePane, shownVolume, remoteReady, state.axis, boundedSlice],
    );
    const shownLabel = needsRemote ? remoteFrame?.key === remoteKey ? remoteFrame.label : undefined : visibleLabel;
    const backgroundSliceLoading = import.meta.env.MODE === "web";
    const hasRemoteError = remoteState?.key === remoteKey && Boolean(remoteState.error);
    const keepPreviousFrame = backgroundSliceLoading && !hasRemoteError && volume !== undefined &&
        paintedFrame.current?.volume === volume && paintedFrame.current.label === visibleLabel &&
        paintedFrame.current.axis === state.axis && paintedFrame.current.flipHorizontal === state.flipHorizontal &&
        paintedFrame.current.flipVertical === state.flipVertical;
    useEffect(() => {
        const previous = paintedFrame.current;
        if (previous && (previous.volume !== volume || previous.label !== visibleLabel || previous.axis !== state.axis ||
            previous.flipHorizontal !== state.flipHorizontal || previous.flipVertical !== state.flipVertical)) paintedFrame.current = null;
    }, [volume, visibleLabel, state.axis, state.flipHorizontal, state.flipVertical]);
    useEffect(() => {
        if (!volume || !needsRemote) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const prefetch = () => {
            volume.remote?.prefetch?.(state.axis, boundedSlice, controller.signal);
            visibleLabel?.remote?.prefetch?.(state.axis, boundedSlice, controller.signal);
        };
        if (syncRemote) {
            timer = setTimeout(prefetch, 180);
            return () => { controller.abort(); clearTimeout(timer); };
        }
        const snapshot = async (item: Volume) => {
            if (!item.remote) return item;
            const reader = await item.remote.ensureSlice(state.axis, boundedSlice, controller.signal);
            return reader ? { ...item, remote: { ...item.remote, getVoxel: reader } } : item;
        };
        void Promise.all([snapshot(volume), visibleLabel ? snapshot(visibleLabel) : undefined]).then(([image, label]) => {
            if (controller.signal.aborted) return;
            setRemoteState({ key: remoteKey, image, label });
            timer = setTimeout(prefetch, 180);
        }).catch(error => {
            if (!controller.signal.aborted) setRemoteState({ key: remoteKey, error: error instanceof Error ? error.message : String(error) });
        });
        return () => { controller.abort(); clearTimeout(timer); };
    }, [volume, visibleLabel, needsRemote, state.axis, boundedSlice, remoteKey, syncRemote]);

    const sliceSize = volume ? getSliceSize(volume, state.axis) : { width: 1, height: 1 };
    const stretch = Boolean(state.stretch) && state.axis !== "axial";
    const placement = imagePlacement(stageSize.width, stageSize.height, sliceSize.width, sliceSize.height, state.zoom, state.panX, state.panY, stretch);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const observer = new ResizeObserver(entries => {
            const rect = entries[0].contentRect;
            setStageSize({ width: rect.width, height: rect.height });
        });
        observer.observe(stage);
        return () => observer.disconnect();
    }, []);

    useEffect(() => { setHoverVoxel(null); }, [volume, boundedSlice, state.axis, state.flipHorizontal, state.flipVertical, state.zoom, state.panX, state.panY, stretch, visibleLabel]);

    const wheelSlice = useRef(boundedSlice);
    const wheelFrame = useRef(0);
    useLayoutEffect(() => { if (!wheelFrame.current) wheelSlice.current = boundedSlice; }, [boundedSlice]);
    const changeSlice = useCallback(
        (nextSlice: number) => {
            const clampedSlice = Math.min(
                Math.max(nextSlice, 0),
                sliceCount - 1,
            );
            if (clampedSlice === boundedSlice) return;
            onChange({ ...state, slice: clampedSlice });
        },
        [boundedSlice, onChange, sliceCount, state],
    );

    const updateHoverVoxel = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            if (!volume || !shownVolume || !remoteReady || !stageRef.current) {
                setHoverVoxel(null);
                return;
            }

            const stageRect = stageRef.current.getBoundingClientRect();
            const sliceSize = getSliceSize(volume, state.axis);

            if (
                stageRect.width <= 0 ||
                stageRect.height <= 0 ||
                sliceSize.width <= 0 ||
                sliceSize.height <= 0
            ) {
                setHoverVoxel(null);
                return;
            }

            const layout = imagePlacement(stageRect.width, stageRect.height,
                sliceSize.width, sliceSize.height, state.zoom, state.panX, state.panY, stretch);
            const scale = layout.scale;
            const drawnWidth = layout.width;
            const drawnHeight = layout.height;
            const localX = event.clientX - stageRect.left - layout.left;
            const localY = event.clientY - stageRect.top - layout.top;

            if (
                localX < 0 ||
                localY < 0 ||
                localX >= drawnWidth ||
                localY >= drawnHeight
            ) {
                setHoverVoxel(null);
                return;
            }

            const sliceX = Math.min(
                Math.max(Math.floor(localX / scale), 0),
                sliceSize.width - 1,
            );
            const sliceY = Math.min(
                Math.max(Math.floor(localY / layout.scaleY), 0),
                sliceSize.height - 1,
            );
            const voxel = slicePixelToVoxel(volume, state.axis, boundedSlice, sliceX, sliceY,
                state.flipHorizontal, state.flipVertical);

            setHoverVoxel({
                ...voxel,
                value: getVoxel(shownVolume, voxel.x, voxel.y, voxel.z),
                label: shownLabel ? getVoxel(shownLabel, voxel.x, voxel.y, voxel.z) : undefined,
            });
        },
        [boundedSlice, state.axis, state.flipHorizontal, state.flipVertical, state.zoom, state.panX, state.panY, stretch, volume, shownVolume, shownLabel, remoteReady],
    );

    const zoomImage = useCallback((nextZoom: number, origin?: { x: number; y: number }) => {
        onChange(zoomedState(state, nextZoom, origin));
    }, [onChange, state]);

    const resetView = () => { if (volume) onChange(resetState(state, volume)); };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!volume || event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
        switch (event.key.toLowerCase()) {
            case "arrowup": case "arrowleft": changeSlice(boundedSlice - (event.shiftKey ? 10 : 1)); break;
            case "arrowdown": case "arrowright": changeSlice(boundedSlice + (event.shiftKey ? 10 : 1)); break;
            case "pageup": changeSlice(boundedSlice - 10); break;
            case "pagedown": changeSlice(boundedSlice + 10); break;
            case "home": changeSlice(0); break;
            case "end": changeSlice(sliceCount - 1); break;
            case "+": case "=": zoomImage(state.zoom * 1.25); break;
            case "-": zoomImage(state.zoom / 1.25); break;
            case "0": onChange({ ...state, zoom: 1, panX: 0, panY: 0 }); break;
            case "h": onChange({ ...state, flipHorizontal: !state.flipHorizontal }); break;
            case "v": onChange({ ...state, flipVertical: !state.flipVertical }); break;
            case "l": if (overlay) onChange({ ...state, showLabel: !state.showLabel }); break;
            case "r": resetView(); break;
            default: return;
        }
        event.preventDefault();
    };

    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (!volume || (event.button !== 0 && event.button !== 2)) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        onActivate();
        event.currentTarget.setPointerCapture(event.pointerId);
        if (event.button === 0) {
            panDragRef.current = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
        } else {
            windowDragRef.current = { startX: event.clientX, startY: event.clientY,
                windowCenter: state.windowCenter, windowWidth: state.windowWidth };
        }
    };

    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (!volume) return;
        const fx = (event.clientX - event.currentTarget.getBoundingClientRect().left - placement.left) / placement.width;
        const fy = (event.clientY - event.currentTarget.getBoundingClientRect().top - placement.top) / placement.height;
        onCrosshair?.(event.ctrlKey && fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { fx, fy } : null);
        const pan = panDragRef.current;
        if (pan && (event.buttons & 1)) {
            onChange({ ...state, panX: pan.panX + event.clientX - pan.x, panY: pan.panY + event.clientY - pan.y });
            return;
        }
        const drag = windowDragRef.current;
        if (!drag || (event.buttons & 2) === 0) return;
        onChange({ ...state, windowCenter: drag.windowCenter - (event.clientY - drag.startY),
            windowWidth: Math.max(drag.windowWidth + event.clientX - drag.startX, 1) });
    };

    const stopWindowDrag = (event: PointerEvent<HTMLDivElement>) => {
        windowDragRef.current = null;
        panDragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    useEffect(() => {
        if (!shownVolume || !remoteReady || !canvasRef.current) return;
        renderSliceToCanvas(
            canvasRef.current,
            shownVolume,
            state.axis,
            boundedSlice,
            state.windowCenter,
            state.windowWidth,
            {
                colorMap: state.colorMap,
                invertColors: state.invertColors,
                clipMin: state.clipMin,
                clipMax: state.clipMax,
                flipHorizontal: state.flipHorizontal,
                flipVertical: state.flipVertical,
            },
            shownLabel ? { volume: shownLabel, opacity: state.labelOpacity, mode: state.labelMode, hiddenClasses: state.hiddenLabelClasses } : undefined,
        );
        if (volume) paintedFrame.current = { volume, label: visibleLabel, axis: state.axis,
            flipHorizontal: state.flipHorizontal, flipVertical: state.flipVertical };
    }, [
        boundedSlice,
        state.axis,
        state.windowCenter,
        state.windowWidth,
        state.colorMap,
        state.invertColors,
        state.clipMin,
        state.clipMax,
        state.flipHorizontal,
        state.flipVertical,
        state.labelOpacity,
        state.labelMode,
        state.hiddenLabelClasses,
        visibleLabel,
        volume,
        shownVolume, shownLabel, remoteReady,
    ]);

    useEffect(() => {
        if (volume && state.slice !== boundedSlice) {
            onChange({ ...state, slice: boundedSlice });
        }
    }, [boundedSlice, onChange, state, volume]);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return undefined;

        const handleWheel = (event: globalThis.WheelEvent) => {
            // Wheel events outpace frames: accumulate the target, commit at most one slice change per frame.
            if (!volume || event.deltaY === 0) return;

            event.preventDefault();
            onActivate();
            if (event.ctrlKey || event.metaKey) {
                const rect = stage.getBoundingClientRect();
                zoomImage(state.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15),
                    { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 });
            } else {
                const next = Math.min(Math.max(wheelSlice.current + (event.deltaY > 0 ? 1 : -1) * (event.shiftKey ? 10 : 1), 0), sliceCount - 1);
                if (next === wheelSlice.current) return;
                wheelSlice.current = next;
                if (!wheelFrame.current) wheelFrame.current = requestAnimationFrame(() => {
                    wheelFrame.current = 0;
                    onChange({ ...state, slice: wheelSlice.current });
                });
            }
        };

        stage.addEventListener("wheel", handleWheel, { passive: false });
        return () => stage.removeEventListener("wheel", handleWheel);
    }, [onActivate, onChange, volume, sliceCount, state, zoomImage]);

    return (
        <section
            className={`viewport ${active ? "viewportActive" : ""}`}
            onMouseDown={onActivate}
            onDoubleClick={(event) => {
                if (
                    event.target instanceof HTMLElement &&
                    event.target.closest("button, select, input")
                ) {
                    return;
                }

                onActivate();
                onToggleSingleView?.();
            }}
        >
            <div
                className="viewportHeader"
            >
                {compareRole && <div className="compareRole">{compareRole}</div>}
                {linkEnabled && <LinkButton state={state} onChange={onChange} />}
                <select
                    aria-label="Select volume"
                    title={volume ? formatVolumeOptionLabel(volume) : 'Select a volume'}
                    disabled={differencePane || volumeLocked}
                    value={state.volumeId ?? ""}
                    onChange={(event) => {
                        const nextVolume = volumes.find(
                            (item) => item.id === event.target.value,
                        );
                        onChange({
                            ...state,
                            volumeId: nextVolume?.id,
                            labelOverlayId: nextVolume?.id === state.volumeId ? state.labelOverlayId : undefined,
                            slice: nextVolume
                                ? Math.floor(
                                      getSliceCount(nextVolume, state.axis) / 2,
                                  )
                                : 0,
                            zoom: 1, panX: 0, panY: 0, hiddenLabelClasses: [],
                            windowCenter: compareRole ? state.windowCenter : nextVolume?.windowCenter ?? DEFAULT_WINDOW_CENTER,
                            windowWidth: compareRole ? state.windowWidth : nextVolume?.windowWidth ?? DEFAULT_WINDOW_WIDTH,
                            clipMin: nextVolume?.min ?? state.clipMin,
                            clipMax: nextVolume?.max ?? state.clipMax,
                        });
                    }}
                >
                    <option value="">No volume</option>
                    {/* The difference volume is only listed in its own pane, never as a case to pick. */}
                    {volumes.filter(item => item.renderMode !== "difference" || item.id === state.volumeId).map((item) => (
                        <option key={item.id} value={item.id}>
                            {formatVolumeOptionLabel(item)}
                        </option>
                    ))}
                </select>
                <button type="button" className="iconButton" aria-label="Save slice as image" title="Save this slice as a PNG image"
                    disabled={!volume || (needsRemote && !remoteReady)}
                    onClick={() => void saveViewportImage({ ...state, slice: boundedSlice }, volumes, overlays)
                        .catch(error => onSaveError?.(error instanceof Error ? error.message : String(error)))}>
                    <ImageDown size={15} />
                </button>
                {!sharedControls && <ViewControls state={state} volume={volume} onChange={onChange} />}
                {differencePane && volume && <DifferenceControls state={state} volume={volume} onChange={onChange} />}
            </div>

            <div
                ref={stageRef}
                className={volume ? "canvasStage canvasStageImage" : "canvasStage"}
                tabIndex={0}
                aria-label="Image viewport. Use arrows to change slices, plus and minus to zoom."
                aria-busy={needsRemote && !remoteReady && !hasRemoteError}
                onFocus={onActivate}
                onKeyDown={handleKeyDown}
                onPointerDown={handlePointerDown}
                onPointerMove={(event) => {
                    handlePointerMove(event);
                    updateHoverVoxel(event);
                }}
                onPointerUp={stopWindowDrag}
                onPointerCancel={stopWindowDrag}
                onPointerLeave={() => { setHoverVoxel(null); onCrosshair?.(null); }}
                onContextMenu={(event) => event.preventDefault()}
            >
                {volume ? (
                    <canvas ref={canvasRef} data-slice-ready={remoteReady} style={{ visibility: remoteReady || keepPreviousFrame ? "visible" : "hidden", width: placement.width, height: placement.height, left: placement.left, top: placement.top }} />
                ) : (
                    <div className="emptyViewport">
                        <strong>{differencePane ? "Difference unavailable" : "No image selected"}</strong>
                        <span>{differencePane ? "Select two different cases with matching in-plane dimensions." : "Open DICOM, NIfTI or NPY files, then select a volume."}</span>
                        {!compareRole && <button type="button" onClick={onOpenFiles}><FolderOpen size={16} /> Open images</button>}
                    </div>
                )}
                {volume && !remoteReady && (hasRemoteError || !backgroundSliceLoading) && <div className="emptyViewport remoteSliceStatus" role="status">
                    {remoteState?.key === remoteKey && remoteState.error
                        ? <><strong>Slice unavailable</strong><span>{remoteState.error}</span><button onClick={() => setRetry(current => current + 1)}>Retry slice</button></>
                        : <><strong>Loading slice…</strong><span>Fetching full-resolution pixels</span></>}
                </div>}
                {volume && crosshair && <>
                    <div className="crosshairLine crosshairVertical" style={{ left: placement.left + crosshair.fx * placement.width }} />
                    <div className="crosshairLine crosshairHorizontal" style={{ top: placement.top + crosshair.fy * placement.height }} />
                </>}
                {volume && (
                    <div className="voxelInfoPanel" aria-live="polite">
                        <span>X: {hoverVoxel ? hoverVoxel.x : "-"}</span>
                        <span>Y: {hoverVoxel ? hoverVoxel.y : "-"}</span>
                        <span>Z: {hoverVoxel ? hoverVoxel.z : "-"}</span>
                        <span>
                            Value: {formatVoxelValue(hoverVoxel?.value)}
                        </span>
                        {visibleLabel && <span>Label: {formatVoxelValue(hoverVoxel?.label)}</span>}
                    </div>
                )}
                {differenceValues && <DifferenceHistogram values={differenceValues} state={state} />}
                {volume &&
                    state.showColorbar &&
                    volume.renderMode !== "difference" && (
                        <div className="viewportColorbar" aria-hidden="true">
                            <span>{state.clipMax.toFixed(1)}</span>
                            <div
                                className="viewportColorbarGradient"
                                style={{
                                    background: colorBarGradient(
                                        state.colorMap,
                                    ),
                                    transform: state.invertColors ? "scaleY(-1)" : undefined,
                                }}
                            />
                            <span>{state.clipMin.toFixed(1)}</span>
                        </div>
                    )}
            </div>

            {sharedControls
                ? <div className="viewportFooter"><span className="viewportSliceLabel">Slice {boundedSlice + 1}/{sliceCount}</span></div>
                : <SliceControls state={state} volume={volume} onChange={onChange} />}
        </section>
    );
}
