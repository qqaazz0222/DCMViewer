import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle,
    ChevronsDown,
    CircleHelp,
    ChevronsUp,
    Eraser,
    FolderOpen,
    FolderTree,
    GitCompare,
    Grid3X3,
    ImageDown,
    Info,
    Minus,
    Keyboard,
    Layers,
    LogOut,
    Palette,
    Plus,
    RotateCcw,
    Save,
    Search,
    Settings,
    LoaderCircle,
    Move3d,
    Trash2,
    X,
} from "lucide-react";
import { composeGrid, renderViewportImage, saveCanvas } from "./exportImage";
import { volumeToNpy } from "./exportVolume";
import { safeFileName, saveBlob } from "./download";
import { ReleaseNotes } from "./components/ReleaseNotes";
import { SliceControls, SliceViewport, ViewControls } from "./components/SliceViewport";
import {
    buildStudyTree,
    createDifferenceVolume,
    loadMedicalFiles,
} from "./loaders/medicalLoader";
import { readMedicalFiles } from "./medicalFiles";
import { remoteLoadGroups } from "./remoteSlices";
import { getSliceCount } from "./rendering";
import { matchesVolume, mergeVolumes, sliceRatio, synchronizeViewports } from "./viewport";
import type {
    LabelOverlay,
    MedicalFile,
    MedicalFileReference,
    RegistrationMethod,
    RegistrationParams,
    RegistrationStatus,
    VisualizationColorMap,
    ViewportState,
    Volume,
} from "./types";
import { labelColor, validateLabelVolume } from "./labels";
import { REGISTRATION_METHODS, defaultRegistrationParams, formatDuration, type RegistrationParam } from "./registrationMethods";
import { COLOR_MAPS, COLOR_MAP_GROUPS, colorBarGradient } from "./colormaps";
import { computeSliceWindow, DEFAULT_WINDOW_CENTER, DEFAULT_WINDOW_WIDTH } from "./windowing";
import { ACCENT_PRESETS, DEFAULT_UI_SETTINGS, ICON_SCALE_RANGE, TEXT_SCALE_RANGE, THEMES, applyUiSettings, loadUiSettings } from "./uiSettings";

const DEFAULT_COLOR_MAP: VisualizationColorMap = "grayscale";
const DEFAULT_CLIP_MIN = -1000;
const DEFAULT_CLIP_MAX = 3000;
// Activity bar entries, VS Code style: one sidebar panel at a time.
const sidebarViews = [
    { id: "patients", label: "Patients", icon: FolderTree },
    { id: "visualization", label: "Visualization", icon: Palette },
    { id: "labels", label: "Label Overlay", icon: Layers },
    { id: "registration", label: "Registration", icon: Move3d },
] as const;
type SidebarView = (typeof sidebarViews)[number]["id"] | "settings";
// crypto.randomUUID needs a secure context; plain-HTTP server deployments lack it.
let labelSequence = 0;
const nextLabelId = () => `label:${++labelSequence}`;
let registrationSequence = 0;
// Rate for the ETA is measured from the first real progress sample, so Python start-up time does not inflate it.
type RegistrationProgress = RegistrationStatus & { anchor?: { time: number; progress: number } };

function createViewport(id: number, volume?: Volume): ViewportState {
    return {
        id: `view-${id}`,
        volumeId: volume?.id,
        linked: false,
        linkGroup: 1,
        axis: "axial",
        slice: volume ? Math.floor(volume.dimensions[2] / 2) : 0,
        windowCenter: volume?.windowCenter ?? DEFAULT_WINDOW_CENTER,
        windowWidth: volume?.windowWidth ?? DEFAULT_WINDOW_WIDTH,
        colorMap: DEFAULT_COLOR_MAP,
        clipMin: volume?.min ?? DEFAULT_CLIP_MIN,
        clipMax: volume?.max ?? DEFAULT_CLIP_MAX,
        showColorbar: true,
        flipHorizontal: false,
        flipVertical: false,
        labelOpacity: 0.4,
        showLabel: true,
        labelMode: "fill",
        hiddenLabelClasses: [],
        zoom: 1,
        panX: 0,
        panY: 0,
    };
}

async function filesFromInput(fileList: FileList | File[]): Promise<MedicalFile[]> {
    return Promise.all(
        [...fileList].map(async (file) => ({
            path: file.webkitRelativePath || file.name,
            name: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
        })),
    );
}

function resizeViewports(
    current: ViewportState[],
    count: number,
    firstVolume?: Volume,
) {
    if (current.length === count) return current;
    if (current.length > count) return current.slice(0, count);

    return [
        ...current,
        ...Array.from({ length: count - current.length }, (_, index) =>
            createViewport(current.length + index + 1, firstVolume),
        ),
    ];
}

function displayStudyName(studyId: string) {
    let displayName = studyId;
    let nextName = displayName.replace(/\.(nii\.gz|nii|npy|npz|dcm|dicom)$/i, "");

    while (nextName !== displayName) {
        displayName = nextName;
        nextName = displayName.replace(/\.(nii\.gz|nii|npy|npz|dcm|dicom)$/i, "");
    }

    return displayName;
}

function extensionOfPath(path: string) {
    const lowerPath = path.toLowerCase();
    if (lowerPath.endsWith(".nii.gz")) return ".nii.gz";
    const lastDot = lowerPath.lastIndexOf(".");
    return lastDot >= 0 ? lowerPath.slice(lastDot) : "";
}

function isStandaloneVolumeFile(
    file: Pick<MedicalFileReference, "path" | "name">,
) {
    const extension = extensionOfPath(file.name || file.path);
    return (
        extension === ".npy" ||
        extension === ".npz" ||
        extension === ".nii" || extension === ".nii.gz"
    );
}

function patientTreeNodeId(patientId: string) {
    return `patient:${patientId}`;
}

function studyTreeNodeId(patientId: string, studyId: string) {
    return `study:${patientId}:${studyId}`;
}

function volumeTooltip(volume: Volume) {
    return volume.dimensions.join(" × ");
}

function numericInputValue(value: string) {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Failed to load files.";
}

function waitForLoadingModal() {
    return new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
    });
}

type LoadingState = {
    message: string;
    current: number;
    total: number;
};

const windowingPresets = [
    { id: "brain", label: "Brain", windowCenter: 40, windowWidth: 80 },
    { id: "subdural", label: "Subdural", windowCenter: 65, windowWidth: 175 },
    { id: "lung", label: "Lung", windowCenter: -550, windowWidth: 1750 },
    { id: "bone", label: "Bone", windowCenter: 350, windowWidth: 1750 },
    {
        id: "soft-tissue",
        label: "Soft Tissue",
        windowCenter: 45,
        windowWidth: 375,
    },
    { id: "liver", label: "Liver", windowCenter: 30, windowWidth: 150 },
    {
        id: "mediastinum",
        label: "Mediastinum",
        windowCenter: 50,
        windowWidth: 350,
    },
    {
        id: "angiography",
        label: "Angiography",
        windowCenter: 100,
        windowWidth: 600,
    },
];

function App() {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const labelInputRef = useRef<HTMLInputElement>(null);
    const labelTargetRef = useRef<{ image: Volume; viewportId: string } | null>(null);
    const [labelOverlays, setLabelOverlays] = useState<LabelOverlay[]>([]);
    const [volumes, setVolumes] = useState<Volume[]>([]);
    const [volumeQuery, setVolumeQuery] = useState("");
    const [cacheNotice, setCacheNotice] = useState("");
    const [autoWindowBusy, setAutoWindowBusy] = useState(false);
    const [autoWindowError, setAutoWindowError] = useState("");
    const autoWindowRequest = useRef<AbortController | null>(null);
    const [registrationMethod, setRegistrationMethod] = useState<RegistrationMethod>("convexadam");
    const [registrationParams, setRegistrationParams] = useState(() => Object.fromEntries(
        REGISTRATION_METHODS.map(method => [method.id, defaultRegistrationParams(method)])) as Record<RegistrationMethod, RegistrationParams>);
    const [imageDialogOpen, setImageDialogOpen] = useState(false);
    const [imageSaveMode, setImageSaveMode] = useState<"separate" | "grid">("separate");
    const [savingImages, setSavingImages] = useState(false);
    const [savingVolumeId, setSavingVolumeId] = useState("");
    const [registrationHelpOpen, setRegistrationHelpOpen] = useState(false);
    const [registrationFixedId, setRegistrationFixedId] = useState("");
    const [registrationMovingId, setRegistrationMovingId] = useState("");
    const [registrationBusy, setRegistrationBusy] = useState(false);
    const [registrationError, setRegistrationError] = useState("");
    const [registrationProgress, setRegistrationProgress] = useState<RegistrationProgress | null>(null);
    const [registrationStartedAt, setRegistrationStartedAt] = useState(0);
    const [registrationNow, setRegistrationNow] = useState(0);
    useEffect(() => window.dcmViewer?.onRegistrationStatus?.(status => {
        const now = Date.now();
        setRegistrationNow(now);
        setRegistrationProgress(current => ({ ...status,
            anchor: current?.anchor ?? (status.phase === "run" && status.progress ? { time: now, progress: status.progress } : undefined) }));
    }), []);
    // Ticks elapsed time between progress lines (setup and long iterations report rarely).
    useEffect(() => {
        if (!registrationBusy) return;
        const timer = window.setInterval(() => setRegistrationNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [registrationBusy]);
    const [labelClassQuery, setLabelClassQuery] = useState("");
    const [focusLabelClass, setFocusLabelClass] = useState("");
    const [showHelp, setShowHelp] = useState(false);
    const [showErrors, setShowErrors] = useState(false);
    const [loadErrors, setLoadErrors] = useState<string[]>([]);
    const [loadingState, setLoadingState] = useState<LoadingState | null>(null);
    // Remote groups still being prepared, shown as disabled rows in the patient list.
    const [pendingVolumes, setPendingVolumes] = useState<{ id: string; name: string }[]>([]);
    // null: sidebar collapsed (active activity icon clicked again).
    // Narrow windows start with the floating sidebar closed so images stay visible.
    const [sidebarView, setSidebarView] = useState<SidebarView | null>(() => window.innerWidth <= 900 ? null : "patients");
    const [uiSettings, setUiSettings] = useState(loadUiSettings);
    // Layout effect: apply before paint so a saved accent never flashes the default.
    useLayoutEffect(() => applyUiSettings(uiSettings), [uiSettings]);
    useEffect(() => {
        if (uiSettings.theme !== "system" || !window.matchMedia) return;
        const query = window.matchMedia("(prefers-color-scheme: light)");
        const follow = () => applyUiSettings(uiSettings);
        query.addEventListener("change", follow);
        return () => query.removeEventListener("change", follow);
    }, [uiSettings]);
    const toggleSidebarView = (view: SidebarView) => setSidebarView(current => current === view ? null : view);
    const [rows, setRows] = useState(1);
    const [columns, setColumns] = useState(1);
    const [compareMode, setCompareMode] = useState(false);
    const [singleViewportId, setSingleViewportId] = useState<string | null>(
        null,
    );
    const [activeViewportId, setActiveViewportId] = useState("view-1");
    const [metadataVolume, setMetadataVolume] = useState<Volume | null>(null);
    const [metadataQuery, setMetadataQuery] = useState("");
    const [expandedTreeNodes, setExpandedTreeNodes] = useState<Set<string>>(
        () => new Set(),
    );
    const [viewports, setViewports] = useState<ViewportState[]>([
        createViewport(1),
    ]);

    const filteredVolumes = useMemo(() => volumes.filter(volume => matchesVolume(volume, volumeQuery)), [volumes, volumeQuery]);
    const studyTree = useMemo(() => buildStudyTree(filteredVolumes), [filteredVolumes]);
    const treeNodeIds = useMemo(
        () =>
            studyTree.flatMap((patient) => [
                patientTreeNodeId(patient.patientId),
                ...patient.studies.map((study) =>
                    studyTreeNodeId(patient.patientId, study.studyId),
                ),
            ]),
        [studyTree],
    );
    const primaryCompare = volumes.find(
        (volume) => volume.id === viewports[0]?.volumeId,
    );
    const secondaryCompare = volumes.find(
        (volume) => volume.id === viewports[1]?.volumeId,
    );
    const differenceVolume = useMemo(
        () =>
            compareMode && primaryCompare && secondaryCompare && primaryCompare.id !== secondaryCompare.id
                ? createDifferenceVolume(primaryCompare, secondaryCompare)
                : undefined,
        [compareMode, primaryCompare, secondaryCompare],
    );
    const displayVolumes =
        compareMode && differenceVolume
            ? [...volumes, differenceVolume]
            : volumes;
    const gridRows = compareMode ? 1 : rows;
    const gridColumns = compareMode ? 3 : columns;
    const viewportCount = gridRows * gridColumns;
    const visibleViewports = resizeViewports(
        viewports,
        viewportCount,
        volumes[0],
    );
    const singleViewport = !compareMode
        ? visibleViewports.find((viewport) => viewport.id === singleViewportId)
        : undefined;
    const displayedViewports = singleViewport
        ? [singleViewport]
        : visibleViewports;
    const displayedGridRows = singleViewport ? 1 : gridRows;
    const displayedGridColumns = singleViewport ? 1 : gridColumns;
    const activeViewport =
        visibleViewports.find((viewport) => viewport.id === activeViewportId) ??
        visibleViewports[0];
    const activeVolume = displayVolumes.find(
        (volume) => volume.id === activeViewport?.volumeId,
    );
    useEffect(() => {
        autoWindowRequest.current?.abort();
        setAutoWindowBusy(false);
        setAutoWindowError("");
        return () => autoWindowRequest.current?.abort();
    }, [activeViewport?.id, activeViewport?.volumeId, activeViewport?.axis, activeViewport?.slice, compareMode]);
    // The shared compare bar follows the focused pane, or Case 1 if that pane is empty.
    const compareDriver = activeVolume ? activeViewport : visibleViewports[0];
    const compareDriverVolume = displayVolumes.find(volume => volume.id === compareDriver?.volumeId);
    const windowLevelMin = Math.floor(
        Math.min(
            activeVolume?.min ?? -1000,
            activeViewport?.windowCenter ?? 40,
        ),
    );
    const windowLevelMax = Math.ceil(
        Math.max(activeVolume?.max ?? 3000, activeViewport?.windowCenter ?? 40),
    );
    const differenceActive = activeVolume?.renderMode === "difference";
    const clipRangeMin = Math.floor(activeVolume?.min ?? DEFAULT_CLIP_MIN);
    const clipRangeMax = Math.ceil(activeVolume?.max ?? DEFAULT_CLIP_MAX);
    const clipMinValue = Math.max(
        Math.min(activeViewport?.clipMin ?? clipRangeMin, clipRangeMax),
        clipRangeMin,
    );
    const clipMaxValue = Math.max(
        Math.min(activeViewport?.clipMax ?? clipRangeMax, clipRangeMax),
        clipRangeMin,
    );
    const windowWidthMax = Math.max(
        Math.ceil((activeVolume?.max ?? 3000) - (activeVolume?.min ?? -1000)),
        Math.ceil(activeViewport?.windowWidth ?? DEFAULT_WINDOW_WIDTH),
        2,
    );
    const selectedWindowingPreset =
        windowingPresets.find(
            (preset) =>
                Math.round(activeViewport?.windowCenter ?? 0) ===
                    preset.windowCenter &&
                Math.round(activeViewport?.windowWidth ?? 0) ===
                    preset.windowWidth,
        )?.id ?? "";
    const isLoading = loadingState !== null;
    const loadingPercent = loadingState?.total
        ? Math.round((loadingState.current / loadingState.total) * 100)
        : 0;
    // Once a remote volume is usable, further loading moves out of the way: into the patient list when it is open.
    const backgroundLoading = volumes.some(volume => volume.remote);
    const loadingProgress = loadingState && (
        <>
            <strong>{loadingState.message}</strong>
            <div
                className={
                    loadingState.total > 0
                        ? "loadingProgress"
                        : "loadingProgress loadingProgressIndeterminate"
                }
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={loadingState.total || undefined}
                aria-valuenow={
                    loadingState.total
                        ? loadingState.current
                        : undefined
                }
            >
                <span
                    style={{
                        width:
                            loadingState.total > 0
                                ? `${loadingPercent}%`
                                : undefined,
                    }}
                />
            </div>
            <span>
                {loadingState.total > 0
                    ? `${loadingState.current}/${loadingState.total} files (${loadingPercent}%)`
                    : "Waiting for file selection..."}
            </span>
        </>
    );
    useEffect(() => {
        const close = (event: KeyboardEvent) => {
            if (event.key === "Escape") { setShowHelp(false); setShowErrors(false); setMetadataVolume(null); }
        };
        window.addEventListener("keydown", close);
        return () => window.removeEventListener("keydown", close);
    }, []);
    const filteredMetadata = useMemo(() => {
        const metadata = metadataVolume?.metadata ?? [];
        const query = metadataQuery.trim().toLowerCase();

        if (!query) return metadata;

        return metadata.filter((entry) =>
            [
                entry.tagId,
                entry.tagName,
                entry.value,
                entry.vr,
                entry.length,
                entry.label,
            ]
                .join(" ")
                .toLowerCase()
                .includes(query),
        );
    }, [metadataQuery, metadataVolume]);

    useEffect(() => {
        if (!compareMode) return;

        setViewports((current) =>
            resizeViewports(current, 3, volumes[0]).map((viewport, index) =>
                index === 2
                    ? viewport.volumeId === differenceVolume?.id ? viewport
                        : { ...viewport, volumeId: differenceVolume?.id, labelOverlayId: undefined, colorMap: "bwr", invertColors: false,
                            clipMin: differenceVolume?.min ?? DEFAULT_CLIP_MIN, clipMax: differenceVolume?.max ?? DEFAULT_CLIP_MAX }
                    : viewport,
            ),
        );
    }, [compareMode, differenceVolume, volumes]);

    useEffect(() => {
        setExpandedTreeNodes((current) => {
            const next = new Set(current);
            let changed = false;

            for (const nodeId of treeNodeIds) {
                if (next.has(nodeId)) continue;
                next.add(nodeId);
                changed = true;
            }

            return changed ? next : current;
        });
    }, [treeNodeIds]);

    const appendLoadedResult = useCallback((result: {
        volumes: Volume[];
        errors: string[];
    }) => {
        setVolumes(current => mergeVolumes(current, result.volumes));
        const first = result.volumes[0];
        if (first) setViewports(current => current.map((viewport, index) =>
            index === 0 && !viewport.volumeId ? createViewport(1, first) : viewport,
        ));

        if (result.errors.length > 0) {
            setLoadErrors((current) => [...current, ...result.errors]);
        }
    }, []);

    const importPreparedFiles = useCallback(async (files: MedicalFile[]) => {
        const result = await loadMedicalFiles(files, {
            onProgress: setLoadingState,
        });
        appendLoadedResult(result);
    }, [appendLoadedResult]);

    const importFiles = async (files: MedicalFile[]) => {
        if (files.length === 0) return;

        setLoadErrors([]);
        setLoadingState({
            message: "Preparing medical data...",
            current: 0,
            total: files.length,
        });

        try {
            await waitForLoadingModal();
            await importPreparedFiles(files);
        } catch (error) {
            setLoadErrors([errorMessage(error)]);
        } finally {
            setLoadingState(null);
        }
    };

    const importHostFiles = useCallback(async (
        fileReferences: MedicalFileReference[],
    ) => {
        if (fileReferences.length === 0 || !window.dcmViewer) return;

        setLoadErrors([]);
        setLoadingState({
            message: "Reading medical files...",
            current: 0,
            total: fileReferences.length,
        });

        try {
            await waitForLoadingModal();
            if (window.dcmViewer.loadRemoteVolumes) {
                const groups = remoteLoadGroups(fileReferences);
                setPendingVolumes(groups.map((group, index) => ({
                    id: `pending-${index}`,
                    name: group.length === 1 ? group[0].name : `${group.length} DICOM files`,
                })));
                let handled = false;
                let completed = 0;
                for await (const result of window.dcmViewer.loadRemoteVolumes(fileReferences)) {
                    completed += groups[0]?.length ?? 0;
                    groups.shift();
                    setPendingVolumes(current => current.slice(1));
                    setLoadingState({ message: "Preparing medical data...", current: completed, total: fileReferences.length });
                    handled = true;
                    appendLoadedResult(result);
                }
                setPendingVolumes([]);
                if (handled) return;
            }
            const dicomFiles: MedicalFile[] = [];
            let completed = 0;

            for await (const result of readMedicalFiles(fileReferences, window.dcmViewer)) {
                const fileReference = result.reference;
                completed += 1;
                setLoadingState({ message: `Reading ${fileReference.name}`, current: completed, total: fileReferences.length });
                const file = result.file;
                if (!file) {
                    setLoadErrors(current => [...current, `${fileReference.name}: ${result.error}`]);
                    continue;
                }

                if (isStandaloneVolumeFile(fileReference)) {
                    const result = await loadMedicalFiles([file]);
                    appendLoadedResult(result);
                    setLoadingState({
                        message: `Loaded ${completed} of ${fileReferences.length}`,
                        current: completed,
                        total: fileReferences.length,
                    });
                    await waitForLoadingModal();
                    continue;
                }

                dicomFiles.push(file);
                setLoadingState({
                    message: `Read ${completed} of ${fileReferences.length}`,
                    current: completed,
                    total: fileReferences.length,
                });

                if (completed % 8 === 0) {
                    await waitForLoadingModal();
                }
            }

            if (dicomFiles.length > 0) {
                setLoadingState({
                    message: "Building DICOM volumes...",
                    current: fileReferences.length,
                    total: fileReferences.length,
                });
                await importPreparedFiles(dicomFiles);
            }
        } catch (error) {
            setLoadErrors((current) => [...current, errorMessage(error)]);
        } finally {
            setPendingVolumes([]);
            setLoadingState(null);
        }
    }, [appendLoadedResult, importPreparedFiles]);

    // A custom editor supplies its file once; the ref also prevents duplicate
    // imports when React StrictMode replays mount effects in development.
    const initialFilesRequested = useRef(false);
    useEffect(() => {
        const getInitialFiles = window.dcmViewer?.getInitialFiles;
        if (!getInitialFiles || initialFilesRequested.current) return;
        initialFilesRequested.current = true;
        void getInitialFiles().then(importHostFiles).catch(error => {
            setLoadErrors([errorMessage(error)]);
        });
    }, [importHostFiles]);

    const importInputFiles = async (fileList: FileList) => {
        if (fileList.length === 0) return;

        setLoadingState({
            message: "Reading medical files...",
            current: 0,
            total: fileList.length,
        });

        try {
            await importFiles(await filesFromInput(fileList));
        } catch (error) {
            setLoadErrors([errorMessage(error)]);
        } finally {
            setLoadingState(null);
        }
    };

    const openFiles = async () => {
        if (window.dcmViewer) {
            setLoadingState({
                message: "Opening medical files...",
                current: 0,
                total: 0,
            });

            try {
                await importHostFiles(
                    await window.dcmViewer.openMedicalFiles(),
                );
            } catch (error) {
                setLoadErrors([errorMessage(error)]);
            } finally {
                setLoadingState(null);
            }

            return;
        }

        fileInputRef.current?.click();
    };

    const importLabelFiles = async (files: MedicalFile[], target: { image: Volume; viewportId: string }) => {
        if (!files.length) return;
        setLoadErrors([]);
        setLoadingState({ message: "Loading label masks...", current: 0, total: files.length });
        try {
            await waitForLoadingModal();
            const result = await loadMedicalFiles(files, { onProgress: setLoadingState });
            const overlays: LabelOverlay[] = [];
            const errors = [...result.errors];
            for (const volume of result.volumes) {
                try {
                    const classes = validateLabelVolume(volume, target.image);
                    overlays.push({ id: nextLabelId(), volume, classes, targetVolumeId: target.image.id });
                } catch (error) { errors.push(`${volume.name}: ${errorMessage(error)}`); }
            }
            setLoadErrors(errors);
            setLabelOverlays(current => [...current, ...overlays]);
            if (overlays[0]) {
                setViewports(current => current.map(viewport =>
                    viewport.id === target.viewportId && viewport.volumeId === target.image.id
                        ? { ...viewport, labelOverlayId: overlays[0].id, showLabel: true, hiddenLabelClasses: [] }
                        : viewport,
                ));
            }
        } catch (error) { setLoadErrors([errorMessage(error)]); }
        finally { setLoadingState(null); }
    };

    const openLabelFiles = async () => {
        if (!activeVolume || !activeViewport || isLoading) return;
        const target = { image: activeVolume, viewportId: activeViewport.id };
        if (!window.dcmViewer) {
            labelTargetRef.current = target;
            labelInputRef.current?.click();
            return;
        }
        setLoadingState({ message: "Opening label files...", current: 0, total: 0 });
        try {
            const references = await window.dcmViewer.openMedicalFiles();
            if (window.dcmViewer.loadRemoteVolumes) {
                let handled = false;
                const loaded: LabelOverlay[] = [];
                const errors: string[] = [];
                for await (const result of window.dcmViewer.loadRemoteVolumes(references)) {
                    handled = true;
                    errors.push(...result.errors);
                    for (const volume of result.volumes) {
                        try { loaded.push({ id: nextLabelId(), volume, classes: validateLabelVolume(volume, target.image), targetVolumeId: target.image.id }); }
                        catch (error) { errors.push(`${volume.name}: ${errorMessage(error)}`); }
                    }
                }
                if (handled) {
                    setLoadErrors(errors);
                    setLabelOverlays(current => [...current, ...loaded]);
                    if (loaded[0]) setViewports(current => current.map(viewport => viewport.id === target.viewportId && viewport.volumeId === target.image.id
                        ? { ...viewport, labelOverlayId: loaded[0].id, showLabel: true, hiddenLabelClasses: [] } : viewport));
                    return;
                }
            }
            const files: MedicalFile[] = [];
            const readErrors: string[] = [];
            let completed = 0;
            for await (const result of readMedicalFiles(references, window.dcmViewer)) {
                completed += 1;
                setLoadingState({ message: `Reading ${result.reference.name}`, current: completed, total: references.length });
                if (result.file) files.push(result.file);
                else readErrors.push(`${result.reference.name}: ${result.error}`);
            }
            await importLabelFiles(files, target);
            if (readErrors.length) setLoadErrors(current => [...current, ...readErrors]);
        } catch (error) { setLoadErrors([errorMessage(error)]); }
        finally { setLoadingState(null); }
    };

    const activeLabelOptions = labelOverlays.filter(item => item.targetVolumeId === activeVolume?.id);
    const activeLabel = activeLabelOptions.find(item => item.id === activeViewport?.labelOverlayId);
    useEffect(() => { setLabelClassQuery(""); setFocusLabelClass(""); }, [activeLabel?.id]);
    const filteredLabelClasses = activeLabel?.classes.filter(value => String(value).includes(labelClassQuery.trim())) ?? [];
    const removeActiveLabel = () => {
        if (!activeLabel) return;
        setLabelOverlays(current => current.filter(item => item.id !== activeLabel.id));
        setViewports(current => current.map(viewport => viewport.labelOverlayId === activeLabel.id
            ? { ...viewport, labelOverlayId: undefined } : viewport));
    };

    const assignVolumeToActive = (volume: Volume) => {
        const targetId = compareMode && activeViewport?.id === "view-3" ? "view-1" : activeViewport?.id;
        if (!targetId) return;
        setActiveViewportId(targetId);
        setViewports(current => {
            const viewport = current.find(view => view.id === targetId);
            if (!viewport || viewport.volumeId === volume.id) return current;
            return synchronizeViewports(current, {
                ...viewport, volumeId: volume.id,
                slice: Math.floor(getSliceCount(volume, viewport.axis) / 2),
                labelOverlayId: undefined, hiddenLabelClasses: [],
                zoom: 1, panX: 0, panY: 0,
                windowCenter: compareMode ? viewport.windowCenter : volume.windowCenter,
                windowWidth: compareMode ? viewport.windowWidth : volume.windowWidth,
                clipMin: volume.min, clipMax: volume.max,
            }, displayVolumes, compareMode);
        });
    };

    // Desktop registers voxels held in this window; the web platform registers volumes the server holds (by token).
    const registrationSource = window.dcmViewer?.registerVolumes ? window.dcmViewer.registrationSource : undefined;
    const registrationVolumes = volumes.filter(volume => registrationSource === "server" ? Boolean(volume.remote?.token)
        : registrationSource === "memory" && !volume.remote);
    const registrationFixed = registrationVolumes.find(volume => volume.id === registrationFixedId);
    const registrationMoving = registrationVolumes.find(volume => volume.id === registrationMovingId);
    const registrationInfo = REGISTRATION_METHODS.find(method => method.id === registrationMethod)!;
    const activeRegistrationParams = registrationParams[registrationMethod];
    const setRegistrationParam = (key: string, value: string | number | boolean) =>
        setRegistrationParams(current => ({ ...current, [registrationMethod]: { ...current[registrationMethod], [key]: value } }));
    const runRegistration = async () => {
        const registerVolumes = window.dcmViewer?.registerVolumes;
        if (!registerVolumes || !registrationFixed || !registrationMoving) return;
        const method = registrationInfo;
        // Inputs are not clamped while typing (that would fight the keyboard); out-of-range values are fixed here.
        const params: RegistrationParams = {};
        for (const param of method.params) {
            const value = activeRegistrationParams[param.key];
            if (param.type === "number") {
                params[param.key] = Number.isFinite(Number(value)) ? Math.min(Math.max(Number(value), param.min), param.max) : param.default;
            } else if (param.type === "integers" && !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(String(value))) {
                setRegistrationError(`${param.label} must be comma-separated integers, e.g. ${param.default}.`);
                return;
            } else {
                params[param.key] = value;
            }
        }
        setRegistrationBusy(true);
        setRegistrationError("");
        setRegistrationProgress(null);
        setRegistrationStartedAt(Date.now());
        setRegistrationNow(Date.now());
        try {
            const output = await registerVolumes(method.id,
                { data: registrationFixed.data, dimensions: registrationFixed.dimensions, token: registrationFixed.remote?.token },
                { data: registrationMoving.data, dimensions: registrationMoving.dimensions, token: registrationMoving.remote?.token }, params);
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
                name: `${registrationMoving.name} → ${registrationFixed.name} (${method.label})`,
                format: registrationMoving.format,
                patientId: registrationFixed.patientId,
                studyId: "Registration",
                seriesId: "Registration",
                dimensions: registrationFixed.dimensions,
                windowCenter: registrationMoving.windowCenter,
                windowWidth: registrationMoving.windowWidth,
                sourceParentDir: "Registration",
            };
            setVolumes(current => [...current, result]);
            assignVolumeToActive(result);
        } catch (error) {
            // Electron prefixes IPC errors with "Error invoking remote method '…': Error:".
            setRegistrationError(errorMessage(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
        } finally {
            setRegistrationBusy(false);
        }
    };
    const saveRegisteredVolume = async (volume: Volume) => {
        setSavingVolumeId(volume.id);
        try {
            await saveBlob(await volumeToNpy(volume), `${safeFileName(volume.name)}.npy`);
        } catch (error) {
            setRegistrationError(`Could not save ${volume.name}: ${errorMessage(error)}`);
        } finally {
            setSavingVolumeId("");
        }
    };
    const registrationPercent = registrationProgress?.phase === "run" && registrationProgress.progress
        ? Math.round(registrationProgress.progress * 100) : undefined;
    const registrationAnchor = registrationProgress?.anchor;
    const registrationEta = registrationAnchor && registrationProgress?.progress !== undefined
        && registrationProgress.progress - registrationAnchor.progress >= 0.01
        ? (registrationNow - registrationAnchor.time) / 1000 * (1 - registrationProgress.progress) / (registrationProgress.progress - registrationAnchor.progress)
        : undefined;
    const registrationParamControl = (param: RegistrationParam) => {
        const value = activeRegistrationParams[param.key];
        if (param.type === "boolean") {
            return <label key={param.key} className="registrationParam labelToggle" title={param.hint}>
                <input type="checkbox" checked={Boolean(value)} onChange={event => setRegistrationParam(param.key, event.target.checked)} />
                <span>{param.label}</span>
            </label>;
        }
        return <label key={param.key} className={param.type === "select" ? "registrationParam registrationParamWide" : "registrationParam"} title={param.hint}>
            <span>{param.label}</span>
            {param.type === "select"
                ? <select aria-label={param.label} value={String(value)} onChange={event => setRegistrationParam(param.key, event.target.value)}>
                    {param.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                : param.type === "number"
                    ? <input type="number" aria-label={param.label} min={param.min} max={param.max} step={param.step} value={String(value)}
                        onChange={event => setRegistrationParam(param.key, event.target.value)} />
                    : <input type="text" aria-label={param.label} inputMode="numeric" pattern="\s*\d+(\s*,\s*\d+)*\s*" value={String(value)}
                        onChange={event => setRegistrationParam(param.key, event.target.value)} />}
        </label>;
    };

    const removeVolume = (volumeId: string) => {
        setLabelOverlays(current => current.filter(item => item.targetVolumeId !== volumeId));
        setVolumes((current) =>
            current.filter((volume) => volume.id !== volumeId),
        );
        setViewports((current) =>
            current.map((viewport) =>
                viewport.volumeId === volumeId ||
                viewport.volumeId?.startsWith("diff:")
                    ? {
                          ...viewport,
                          volumeId: undefined,
                          labelOverlayId: undefined,
                          zoom: 1, panX: 0, panY: 0,
                          hiddenLabelClasses: [],
                          flipHorizontal: false,
                          flipVertical: false,
                          linked: false,
                          slice: 0,
                          windowCenter: DEFAULT_WINDOW_CENTER,
                          windowWidth: DEFAULT_WINDOW_WIDTH,
                          clipMin: DEFAULT_CLIP_MIN,
                          clipMax: DEFAULT_CLIP_MAX,
                          colorMap: DEFAULT_COLOR_MAP,
                          showColorbar: true,
                      }
                    : viewport,
            ),
        );
        setMetadataVolume((current) =>
            current?.id === volumeId ? null : current,
        );
    };

    const removeAllVolumes = () => {
        setVolumes([]);
        setVolumeQuery("");
        setLabelOverlays([]);
        setLoadErrors([]);
        setMetadataVolume(null);
        setMetadataQuery("");
        setSingleViewportId(null);
        setCompareMode(false);
        setActiveViewportId("view-1");
        setExpandedTreeNodes(new Set());
        setViewports((current) =>
            resizeViewports(current, rows * columns).map((viewport, index) =>
                index === 0
                    ? createViewport(1)
                    : {
                          ...viewport,
                          volumeId: undefined,
                          labelOverlayId: undefined,
                          zoom: 1, panX: 0, panY: 0,
                          hiddenLabelClasses: [],
                          flipHorizontal: false,
                          flipVertical: false,
                          linked: false,
                          slice: 0,
                          windowCenter: DEFAULT_WINDOW_CENTER,
                          windowWidth: DEFAULT_WINDOW_WIDTH,
                          clipMin: DEFAULT_CLIP_MIN,
                          clipMax: DEFAULT_CLIP_MAX,
                          colorMap: DEFAULT_COLOR_MAP,
                          showColorbar: true,
                      },
            ),
        );
    };

    const setTreeNodeExpanded = (nodeId: string, expanded: boolean) => {
        setExpandedTreeNodes((current) => {
            const next = new Set(current);
            if (expanded) {
                next.add(nodeId);
            } else {
                next.delete(nodeId);
            }
            return next;
        });
    };

    const expandAllTreeNodes = () => {
        setExpandedTreeNodes(new Set(treeNodeIds));
    };

    const collapseAllTreeNodes = () => {
        setExpandedTreeNodes(new Set());
    };

    const saveDisplayedImages = async (mode: "separate" | "grid") => {
        setSavingImages(true);
        try {
            const images = await Promise.all(displayedViewports.map(viewport => renderViewportImage(viewport, displayVolumes, labelOverlays)));
            if (!images.some(Boolean)) throw new Error("Select a volume before saving images.");
            if (mode === "grid") {
                const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
                await saveCanvas(composeGrid(images.map(image => image?.canvas), displayedGridColumns), `DCMViewer_grid_${stamp}.png`);
            } else {
                const single = images.filter(Boolean).length === 1;
                for (const [index, image] of images.entries()) {
                    if (image) await saveCanvas(image.canvas, single ? image.fileName : `view${index + 1}_${image.fileName}`);
                }
            }
            setImageDialogOpen(false);
        } catch (error) {
            setImageDialogOpen(false);
            setLoadErrors(current => [...current, `Save images: ${errorMessage(error)}`]);
        } finally {
            setSavingImages(false);
        }
    };

    const updateViewport = (nextViewport: ViewportState) => {
        setViewports(current => synchronizeViewports(current, nextViewport, displayVolumes, compareMode));
    };

    const updateActiveWindowing = (
        nextWindowing: Pick<ViewportState, "windowCenter" | "windowWidth">,
    ) => {
        if (!activeViewport) return;
        autoWindowRequest.current?.abort();
        setAutoWindowBusy(false);
        setAutoWindowError("");
        updateViewport({ ...activeViewport, ...nextWindowing });
    };

    const updateActiveVisualization = (
        nextVisualization: Pick<
            ViewportState,
            "colorMap" | "clipMin" | "clipMax" | "showColorbar"
        >,
    ) => {
        if (!activeViewport) return;
        updateViewport({ ...activeViewport, ...nextVisualization });
    };

    const applyWindowingPreset = (presetId: string) => {
        const preset = windowingPresets.find((item) => item.id === presetId);
        if (!preset) return;

        updateActiveWindowing({
            windowCenter: preset.windowCenter,
            windowWidth: preset.windowWidth,
        });
    };

    const autoWindowSlice = async () => {
        if (!activeViewport || !activeVolume || activeVolume.renderMode === "difference") return;
        autoWindowRequest.current?.abort();
        const controller = new AbortController();
        autoWindowRequest.current = controller;
        const target = activeViewport;
        setAutoWindowBusy(true);
        setAutoWindowError("");
        try {
            const reader = await activeVolume.remote?.ensureSlice(target.axis, target.slice, controller.signal);
            if (controller.signal.aborted) return;
            const window = computeSliceWindow(activeVolume, target.axis, target.slice, reader || undefined);
            setViewports(current => {
                const latest = current.find(view => view.id === target.id);
                if (!latest || latest.volumeId !== target.volumeId || latest.axis !== target.axis || latest.slice !== target.slice) return current;
                if (latest.windowCenter !== target.windowCenter || latest.windowWidth !== target.windowWidth) return current;
                return synchronizeViewports(current, { ...latest, ...window }, displayVolumes, compareMode);
            });
        } catch (error) {
            if (!controller.signal.aborted) setAutoWindowError(errorMessage(error));
        } finally {
            if (autoWindowRequest.current === controller && !controller.signal.aborted) setAutoWindowBusy(false);
        }
    };

    const updateGrid = (nextRows: number, nextColumns: number) => {
        const safeRows = Math.min(Math.max(nextRows, 1), 4);
        const safeColumns = Math.min(Math.max(nextColumns, 1), 4);
        setSingleViewportId(null);
        setRows(safeRows);
        setColumns(safeColumns);
        if (Number(activeViewportId.replace("view-", "")) > safeRows * safeColumns) setActiveViewportId("view-1");
        setViewports((current) =>
            resizeViewports(current, safeRows * safeColumns, volumes[0]),
        );
    };

    const enableNormalView = () => {
        setCompareMode(false);
        setViewports((current) =>
            resizeViewports(current, rows * columns, volumes[0]).map(
                (viewport) =>
                    viewport.volumeId?.startsWith("diff:")
                        ? {
                              ...viewport,
                              volumeId: undefined,
                              slice: 0,
                              windowCenter: DEFAULT_WINDOW_CENTER,
                              windowWidth: DEFAULT_WINDOW_WIDTH,
                              clipMin: DEFAULT_CLIP_MIN,
                              clipMax: DEFAULT_CLIP_MAX,
                              colorMap: DEFAULT_COLOR_MAP,
                              showColorbar: true,
                          }
                        : viewport,
            ),
        );
    };

    const enableCompareView = () => {
        if (volumes.length < 2) return;
        setCompareMode(true);
        setSingleViewportId(null);
        setViewports(current => {
            const next = resizeViewports(current, 3, volumes[0]);
            const first = volumes.find(volume => volume.id === next[0].volumeId) ?? volumes[0];
            const second = volumes.find(volume => volume.id === next[1].volumeId && volume.id !== first.id)
                ?? volumes.find(volume => volume.id !== first.id)!;
            const initial = [createViewport(1, first), createViewport(2, second), createViewport(3)];
            initial[0] = { ...next[0], volumeId: first.id };
            initial[1] = next[1].volumeId === second.id ? next[1] : createViewport(2, second);
            const ratio = sliceRatio(first, initial[0].axis, initial[0].slice);
            return initial.map((view, index) => ({ ...view, axis: initial[0].axis,
                windowCenter: initial[0].windowCenter, windowWidth: initial[0].windowWidth,
                flipHorizontal: initial[0].flipHorizontal, flipVertical: initial[0].flipVertical,
                slice: index === 0 ? initial[0].slice : Math.round(ratio * (getSliceCount(index === 1 ? second : first, initial[0].axis) - 1)),
            }));
        });
    };

    const activeVolumeCount = volumes.length;

    return (
        <main
            className={
                sidebarView ? "appShell" : "appShell sidebarCollapsed"
            }
        >
            <input
                ref={fileInputRef}
                className="hiddenInput"
                type="file"
                multiple
                disabled={isLoading}
                onChange={async (event) => {
                    if (event.target.files)
                        await importInputFiles(event.target.files);
                    event.target.value = "";
                }}
            />

            <input ref={labelInputRef} type="file" className="hiddenInput" multiple
                aria-label="Load label files" onChange={event => {
                    const files = Array.from(event.target.files ?? []);
                    const target = labelTargetRef.current;
                    event.target.value = "";
                    if (!files.length || !target) return;
                    setLoadingState({ message: "Reading label files...", current: 0, total: files.length });
                    // Snapshot before awaiting so another dialog cannot change the target.
                    void filesFromInput(files).then(prepared => importLabelFiles(prepared, target))
                        .catch(error => setLoadErrors([errorMessage(error)]))
                        .finally(() => setLoadingState(null));
                }} />
            <nav className="activityBar" aria-label="Sidebar views">
                {sidebarViews.map(({ id, label, icon: Icon }) => (
                    <button key={id} type="button" className={sidebarView === id ? "selected" : ""}
                        aria-label={label} aria-pressed={sidebarView === id} title={sidebarView === id ? `Hide ${label}` : label}
                        onClick={() => toggleSidebarView(id)}>
                        <Icon size={18} />
                    </button>
                ))}
                <div className="activityBarEnd">
                    <button type="button" aria-label="Controls" title="Mouse controls and keyboard shortcuts" onClick={() => setShowHelp(true)}><Keyboard size={18} /></button>
                    {window.dcmViewer?.clearLocalCache && <button type="button" aria-label={cacheNotice || "Clear local cache"} title={cacheNotice || "Clear local cache: delete locally stored remote image slices"} onClick={() => {
                        void window.dcmViewer!.clearLocalCache!().then(() => setCacheNotice("Local cache cleared")).catch(error => setLoadErrors(current => [...current, errorMessage(error)]));
                    }}><Eraser size={18} /></button>}
                    {window.dcmViewer?.logout && <button type="button" aria-label="Sign out" title="Sign out" onClick={() => {
                        void window.dcmViewer!.logout!().catch(error => setLoadErrors(current => [...current, errorMessage(error)]));
                    }}><LogOut size={18} /></button>}
                    <button type="button" className={sidebarView === "settings" ? "selected" : ""} aria-label="Settings" aria-pressed={sidebarView === "settings"}
                        title={sidebarView === "settings" ? "Hide Settings" : "Settings"} onClick={() => toggleSidebarView("settings")}><Settings size={18} /></button>
                </div>
            </nav>
            {sidebarView && <aside className="sidebar">
                {sidebarView === "patients" && <>
                <div className="treeHeader">
                    <div className="treeHeaderTitle">
                        <span>Patients</span>
                        <strong>{activeVolumeCount}</strong>
                    </div>
                    <div className="treeHeaderActions">
                        <button
                            className="treeActionButton"
                            type="button"
                            aria-label="Expand all folders"
                            title="Expand all"
                            disabled={treeNodeIds.length === 0}
                            onClick={expandAllTreeNodes}
                        >
                            <ChevronsDown size={13} />
                        </button>
                        <button
                            className="treeActionButton"
                            type="button"
                            aria-label="Collapse all folders"
                            title="Collapse all"
                            disabled={treeNodeIds.length === 0}
                            onClick={collapseAllTreeNodes}
                        >
                            <ChevronsUp size={13} />
                        </button>
                        <button
                            className="treeActionButton"
                            type="button"
                            aria-label="Remove all files"
                            title="Remove all"
                            disabled={volumes.length === 0}
                            onClick={removeAllVolumes}
                        >
                            <Trash2 size={13} />
                        </button>
                    </div>
                </div>

                    <div className="sidebarOpen">
                        <button type="button" onClick={() => void openFiles()} disabled={isLoading}><FolderOpen size={14} /> Open</button>
                    </div>
                    {isLoading && backgroundLoading && <div className="treeLoading" role="status" aria-label="Loading medical data">{loadingProgress}</div>}
                    <div className="treePanel">
                        <label className="volumeSearch"><Search size={14} />
                            <input type="search" aria-label="Search volumes" placeholder="Search patient, study, file…" value={volumeQuery} onChange={event => setVolumeQuery(event.target.value)} />
                        </label>
                        {pendingVolumes.map(item => (
                            <div key={item.id} className="volumeNodeRow">
                                <button className="volumeNode" type="button" disabled aria-busy="true" title={`Loading ${item.name}`}>
                                    <span><LoaderCircle size={12} className="spinner" aria-hidden="true" /> {item.name}</span>
                                </button>
                            </div>
                        ))}
                        {studyTree.length === 0 ? pendingVolumes.length > 0 ? null : (
                            <div className="emptyTree">
                                {volumes.length ? "No matching volumes. Try another search." : "Open medical image files to get started."}
                            </div>
                        ) : (
                            studyTree.map((patient) => {
                                const patientNodeId = patientTreeNodeId(
                                    patient.patientId,
                                );

                                return (
                                    <details
                                        key={patient.patientId}
                                        open={expandedTreeNodes.has(
                                            patientNodeId,
                                        )}
                                        onToggle={(event) =>
                                            setTreeNodeExpanded(
                                                patientNodeId,
                                                event.currentTarget.open,
                                            )
                                        }
                                    >
                                        <summary>{patient.patientId}</summary>
                                        {patient.studies.map((study) => {
                                            const studyNodeId = studyTreeNodeId(
                                                patient.patientId,
                                                study.studyId,
                                            );
                                            const standaloneVolumes =
                                                study.volumes.filter(
                                                    (volume) =>
                                                        !volume.channelLabel,
                                                );
                                            const channelMap = new Map<
                                                string,
                                                Volume[]
                                            >();

                                            for (const volume of study.volumes) {
                                                if (!volume.channelLabel)
                                                    continue;

                                                channelMap.set(
                                                    volume.channelLabel,
                                                    [
                                                        ...(channelMap.get(
                                                            volume.channelLabel,
                                                        ) ?? []),
                                                        volume,
                                                    ],
                                                );
                                            }

                                            const channelGroups = [
                                                ...channelMap.entries(),
                                            ]
                                                .map(
                                                    ([
                                                        label,
                                                        channelVolumes,
                                                    ]) => ({
                                                        label,
                                                        volumes: channelVolumes,
                                                        channelIndex:
                                                            channelVolumes[0]
                                                                ?.channelIndex,
                                                    }),
                                                )
                                                .sort((left, right) => {
                                                    const leftIndex =
                                                        left.channelIndex ??
                                                        Number.MAX_SAFE_INTEGER;
                                                    const rightIndex =
                                                        right.channelIndex ??
                                                        Number.MAX_SAFE_INTEGER;

                                                    if (
                                                        leftIndex !== rightIndex
                                                    ) {
                                                        return (
                                                            leftIndex -
                                                            rightIndex
                                                        );
                                                    }

                                                    return left.label.localeCompare(
                                                        right.label,
                                                    );
                                                });

                                            return (
                                                <details
                                                    key={study.studyId}
                                                    open={expandedTreeNodes.has(
                                                        studyNodeId,
                                                    )}
                                                    className="studyNode"
                                                    onToggle={(event) =>
                                                        setTreeNodeExpanded(
                                                            studyNodeId,
                                                            event.currentTarget
                                                                .open,
                                                        )
                                                    }
                                                >
                                                    <summary>
                                                        {displayStudyName(
                                                            study.studyId,
                                                        )}
                                                    </summary>
                                                    {standaloneVolumes.map(
                                                        (volume) => (
                                                            <div
                                                                key={volume.id}
                                                                className="volumeNodeRow"
                                                            >
                                                                <button
                                                                    className="volumeNode"
                                                                    type="button"
                                                                    title={volumeTooltip(
                                                                        volume,
                                                                    )}
                                                                    onClick={() =>
                                                                        assignVolumeToActive(
                                                                            volume,
                                                                        )
                                                                    }
                                                                >
                                                                    <span>
                                                                        {
                                                                            volume.name
                                                                        }
                                                                    </span>
                                                                </button>
                                                                {volume.format ===
                                                                    "DICOM" && (
                                                                    <button
                                                                        className="metadataVolumeButton"
                                                                        type="button"
                                                                        aria-label={`View metadata for ${volume.name}`}
                                                                        title="View metadata"
                                                                        onClick={() => {
                                                                            setMetadataQuery(
                                                                                "",
                                                                            );
                                                                            setMetadataVolume(
                                                                                volume,
                                                                            );
                                                                        }}
                                                                    >
                                                                        <Info
                                                                            size={
                                                                                13
                                                                            }
                                                                        />
                                                                    </button>
                                                                )}
                                                                <button
                                                                    className="removeVolumeButton"
                                                                    type="button"
                                                                    aria-label={`Remove ${volume.name}`}
                                                                    title="Remove file"
                                                                    onClick={() =>
                                                                        removeVolume(
                                                                            volume.id,
                                                                        )
                                                                    }
                                                                >
                                                                    <Trash2
                                                                        size={
                                                                            13
                                                                        }
                                                                    />
                                                                </button>
                                                            </div>
                                                        ),
                                                    )}
                                                    {channelGroups.map(
                                                        (channelGroup) =>
                                                            channelGroup.volumes
                                                                .length <= 1 ? (
                                                                channelGroup.volumes.map(
                                                                    (
                                                                        volume,
                                                                    ) => (
                                                                        <div
                                                                            key={
                                                                                volume.id
                                                                            }
                                                                            className="volumeNodeRow"
                                                                        >
                                                                            <button
                                                                                className="volumeNode"
                                                                                type="button"
                                                                                title={volumeTooltip(
                                                                                    volume,
                                                                                )}
                                                                                onClick={() =>
                                                                                    assignVolumeToActive(
                                                                                        volume,
                                                                                    )
                                                                                }
                                                                            >
                                                                                <span>
                                                                                    {
                                                                                        volume.name
                                                                                    }
                                                                                </span>
                                                                            </button>
                                                                            <button
                                                                                className="removeVolumeButton"
                                                                                type="button"
                                                                                aria-label={`Remove ${volume.name}`}
                                                                                title="Remove file"
                                                                                onClick={() =>
                                                                                    removeVolume(
                                                                                        volume.id,
                                                                                    )
                                                                                }
                                                                            >
                                                                                <Trash2
                                                                                    size={
                                                                                        13
                                                                                    }
                                                                                />
                                                                            </button>
                                                                        </div>
                                                                    ),
                                                                )
                                                            ) : (
                                                                <details
                                                                    key={`${study.studyId}:${channelGroup.label}`}
                                                                    className="studyNode channelNode"
                                                                    open
                                                                >
                                                                    <summary>
                                                                        {
                                                                            channelGroup.label
                                                                        }
                                                                    </summary>
                                                                    {channelGroup.volumes.map(
                                                                        (
                                                                            volume,
                                                                        ) => (
                                                                            <div
                                                                                key={
                                                                                    volume.id
                                                                                }
                                                                                className="volumeNodeRow"
                                                                            >
                                                                                <button
                                                                                    className="volumeNode"
                                                                                    type="button"
                                                                                    title={volumeTooltip(
                                                                                        volume,
                                                                                    )}
                                                                                    onClick={() =>
                                                                                        assignVolumeToActive(
                                                                                            volume,
                                                                                        )
                                                                                    }
                                                                                >
                                                                                    <span>
                                                                                        {
                                                                                            volume.name
                                                                                        }
                                                                                    </span>
                                                                                </button>
                                                                                <button
                                                                                    className="removeVolumeButton"
                                                                                    type="button"
                                                                                    aria-label={`Remove ${volume.name}`}
                                                                                    title="Remove file"
                                                                                    onClick={() =>
                                                                                        removeVolume(
                                                                                            volume.id,
                                                                                        )
                                                                                    }
                                                                                >
                                                                                    <Trash2
                                                                                        size={
                                                                                            13
                                                                                        }
                                                                                    />
                                                                                </button>
                                                                            </div>
                                                                        ),
                                                                    )}
                                                                </details>
                                                            ),
                                                    )}
                                                </details>
                                            );
                                        })}
                                    </details>
                                );
                            })
                        )}
                    </div>
                </>}

                {sidebarView === "visualization" && <section className="windowingPanel sidebarPanel" aria-label="Visualization controls">
                    <div className="windowingPanelHeader">
                        <span>Visualization</span>
                        <strong>{activeViewport?.id ?? "-"}</strong>
                    </div>
                    <section className="visualizationGroup" aria-labelledby="windowingGroupTitle">
                        <h2 id="windowingGroupTitle">Windowing</h2>
                        <>
                            <label className="windowingPresetRow">
                                <span>Preset</span>
                                <select
                                    aria-label="Windowing Preset"
                                    value={selectedWindowingPreset}
                                    disabled={!activeVolume || !activeViewport}
                                    onChange={(event) =>
                                        applyWindowingPreset(event.target.value)
                                    }
                                >
                                    <option value="">Custom</option>
                                    {windowingPresets.map((preset) => (
                                        <option
                                            key={preset.id}
                                            value={preset.id}
                                        >
                                            {preset.label} (
                                            {preset.windowCenter}/
                                            {preset.windowWidth})
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                <span>
                                    WL{" "}
                                    {Math.round(
                                        activeViewport?.windowCenter ?? 0,
                                    )}
                                </span>
                                <input
                                    type="range"
                                    min={windowLevelMin}
                                    max={windowLevelMax}
                                    value={
                                        activeViewport?.windowCenter ??
                                        DEFAULT_WINDOW_CENTER
                                    }
                                    disabled={!activeVolume || !activeViewport}
                                    onChange={(event) =>
                                        updateActiveWindowing({
                                            windowCenter: Number(
                                                event.target.value,
                                            ),
                                            windowWidth:
                                                activeViewport?.windowWidth ??
                                                DEFAULT_WINDOW_WIDTH,
                                        })
                                    }
                                />
                                <input
                                    className="numberInput"
                                    type="number"
                                    aria-label="Active Window Level"
                                    value={Math.round(
                                        activeViewport?.windowCenter ??
                                            DEFAULT_WINDOW_CENTER,
                                    )}
                                    disabled={!activeVolume || !activeViewport}
                                    onChange={(event) => {
                                        const nextValue = numericInputValue(
                                            event.target.value,
                                        );
                                        if (nextValue === undefined) return;
                                        updateActiveWindowing({
                                            windowCenter: nextValue,
                                            windowWidth:
                                                activeViewport?.windowWidth ??
                                                DEFAULT_WINDOW_WIDTH,
                                        });
                                    }}
                                />
                            </label>
                            <label>
                                <span>
                                    WW{" "}
                                    {Math.round(
                                        activeViewport?.windowWidth ?? 0,
                                    )}
                                </span>
                                <input
                                    type="range"
                                    min={1}
                                    max={windowWidthMax}
                                    value={
                                        activeViewport?.windowWidth ??
                                        DEFAULT_WINDOW_WIDTH
                                    }
                                    disabled={!activeVolume || !activeViewport}
                                    onChange={(event) =>
                                        updateActiveWindowing({
                                            windowCenter:
                                                activeViewport?.windowCenter ??
                                                DEFAULT_WINDOW_CENTER,
                                            windowWidth: Number(
                                                event.target.value,
                                            ),
                                        })
                                    }
                                />
                                <input
                                    className="numberInput"
                                    type="number"
                                    aria-label="Active Window Width"
                                    min={1}
                                    value={Math.round(
                                        activeViewport?.windowWidth ??
                                            DEFAULT_WINDOW_WIDTH,
                                    )}
                                    disabled={!activeVolume || !activeViewport}
                                    onChange={(event) => {
                                        const nextValue = numericInputValue(
                                            event.target.value,
                                        );
                                        if (nextValue === undefined) return;
                                        updateActiveWindowing({
                                            windowCenter:
                                                activeViewport?.windowCenter ??
                                                DEFAULT_WINDOW_CENTER,
                                            windowWidth: Math.max(nextValue, 1),
                                        });
                                    }}
                                />
                            </label>
                        </>
                        <div className="panelActions">
                            <button type="button" disabled={!activeVolume || autoWindowBusy || activeVolume.renderMode === "difference"}
                                onClick={() => void autoWindowSlice()}>{autoWindowBusy ? "Adjusting…" : "Auto slice"}</button>
                            <button type="button" disabled={!activeVolume || activeVolume.renderMode === "difference"}
                                onClick={() => activeVolume && updateActiveWindowing({ windowCenter: activeVolume.windowCenter, windowWidth: activeVolume.windowWidth })}>Original window</button>
                        </div>
                        <button type="button" disabled={!activeVolume || activeVolume.renderMode === "difference"}
                            onClick={() => activeVolume && updateActiveWindowing({ windowCenter: (activeVolume.min + activeVolume.max) / 2,
                                windowWidth: Math.max(activeVolume.max - activeVolume.min, 1) })}>Window full range</button>
                        <small className="panelHint">Auto uses the current slice's 2nd–98th percentiles (up to 65,536 samples). Linked views share WL/WW.</small>
                        {autoWindowError && <small className="panelError" role="alert">{autoWindowError}</small>}
                    </section>
                    <section className="visualizationGroup" aria-labelledby="colorGroupTitle">
                        <h2 id="colorGroupTitle">Color &amp; range</h2>
                        <>
                            <label className="windowingPresetRow">
                                <span>CMap</span>
                                <select
                                    aria-label="Visualization colormap"
                                    value={
                                        activeViewport?.colorMap ??
                                        DEFAULT_COLOR_MAP
                                    }
                                    disabled={!activeVolume || !activeViewport || differenceActive}
                                    onChange={(event) =>
                                        updateActiveVisualization({
                                            colorMap: event.target
                                                .value as VisualizationColorMap,
                                            clipMin:
                                                activeViewport?.clipMin ??
                                                clipMinValue,
                                            clipMax:
                                                activeViewport?.clipMax ??
                                                clipMaxValue,
                                            showColorbar:
                                                activeViewport?.showColorbar ??
                                                true,
                                        })
                                    }
                                >
                                    {COLOR_MAP_GROUPS.map(group => <optgroup key={group} label={group}>
                                        {COLOR_MAPS.filter(map => map.group === group).map(map =>
                                            <option key={map.id} value={map.id}>{map.label}</option>)}
                                    </optgroup>)}
                                </select>
                            </label>
                            <div className="colormapPreview" aria-hidden="true" title="Color scale: low → high"
                                style={{ background: colorBarGradient(activeViewport?.colorMap ?? DEFAULT_COLOR_MAP).replace('to top', 'to right'),
                                    transform: activeViewport?.invertColors ? 'scaleX(-1)' : undefined }} />
                            <label>
                                <span>Min {Math.round(clipMinValue)}</span>
                                <input
                                    type="range"
                                    min={clipRangeMin}
                                    max={clipRangeMax}
                                    value={clipMinValue}
                                    disabled={!activeVolume || !activeViewport || differenceActive}
                                    onChange={(event) => {
                                        const nextMin = Number(
                                            event.target.value,
                                        );
                                        updateActiveVisualization({
                                            colorMap:
                                                activeViewport?.colorMap ??
                                                DEFAULT_COLOR_MAP,
                                            clipMin: nextMin,
                                            clipMax: Math.max(
                                                activeViewport?.clipMax ??
                                                    clipMaxValue,
                                                nextMin,
                                            ),
                                            showColorbar:
                                                activeViewport?.showColorbar ??
                                                true,
                                        });
                                    }}
                                />
                                <input
                                    className="numberInput"
                                    type="number"
                                    aria-label="Visualization Clip Min"
                                    value={Math.round(clipMinValue)}
                                    disabled={!activeVolume || !activeViewport || differenceActive}
                                    onChange={(event) => {
                                        const nextValue = numericInputValue(
                                            event.target.value,
                                        );
                                        if (nextValue === undefined) return;
                                        updateActiveVisualization({
                                            colorMap:
                                                activeViewport?.colorMap ??
                                                DEFAULT_COLOR_MAP,
                                            clipMin: nextValue,
                                            clipMax: Math.max(
                                                activeViewport?.clipMax ??
                                                    clipMaxValue,
                                                nextValue,
                                            ),
                                            showColorbar:
                                                activeViewport?.showColorbar ??
                                                true,
                                        });
                                    }}
                                />
                            </label>
                            <label>
                                <span>Max {Math.round(clipMaxValue)}</span>
                                <input
                                    type="range"
                                    min={clipRangeMin}
                                    max={clipRangeMax}
                                    value={clipMaxValue}
                                    disabled={!activeVolume || !activeViewport || differenceActive}
                                    onChange={(event) => {
                                        const nextMax = Number(
                                            event.target.value,
                                        );
                                        updateActiveVisualization({
                                            colorMap:
                                                activeViewport?.colorMap ??
                                                DEFAULT_COLOR_MAP,
                                            clipMin: Math.min(
                                                activeViewport?.clipMin ??
                                                    clipMinValue,
                                                nextMax,
                                            ),
                                            clipMax: nextMax,
                                            showColorbar:
                                                activeViewport?.showColorbar ??
                                                true,
                                        });
                                    }}
                                />
                                <input
                                    className="numberInput"
                                    type="number"
                                    aria-label="Visualization Clip Max"
                                    value={Math.round(clipMaxValue)}
                                    disabled={!activeVolume || !activeViewport || differenceActive}
                                    onChange={(event) => {
                                        const nextValue = numericInputValue(
                                            event.target.value,
                                        );
                                        if (nextValue === undefined) return;
                                        updateActiveVisualization({
                                            colorMap:
                                                activeViewport?.colorMap ??
                                                DEFAULT_COLOR_MAP,
                                            clipMin: Math.min(
                                                activeViewport?.clipMin ??
                                                    clipMinValue,
                                                nextValue,
                                            ),
                                            clipMax: nextValue,
                                            showColorbar:
                                                activeViewport?.showColorbar ??
                                                true,
                                        });
                                    }}
                                />
                            </label>
                            <label className="visualizationToggleRow">
                                <span>Colorbar</span>
                                <input
                                    type="checkbox"
                                    checked={
                                        activeViewport?.showColorbar ?? true
                                    }
                                    disabled={!activeVolume || !activeViewport || differenceActive}
                                    onChange={(event) =>
                                        updateActiveVisualization({
                                            colorMap:
                                                activeViewport?.colorMap ??
                                                DEFAULT_COLOR_MAP,
                                            clipMin:
                                                activeViewport?.clipMin ??
                                                clipMinValue,
                                            clipMax:
                                                activeViewport?.clipMax ??
                                                clipMaxValue,
                                            showColorbar: event.target.checked,
                                        })
                                    }
                                />
                            </label>
                            <label className="visualizationToggleRow">
                                <span>Invert</span>
                                <input type="checkbox" aria-label="Invert colors" checked={activeViewport?.invertColors ?? false}
                                    disabled={!activeVolume || activeVolume.renderMode === "difference"}
                                    onChange={event => activeViewport && updateViewport({ ...activeViewport, invertColors: event.target.checked })} />
                            </label>
                            <div className="panelActions">
                                <button type="button" disabled={!activeVolume || !activeViewport || differenceActive}
                                    onClick={() => activeVolume && activeViewport && updateViewport({ ...activeViewport, clipMin: activeVolume.min, clipMax: activeVolume.max })}>Full range</button>
                                <button type="button" disabled={!activeVolume || !activeViewport || differenceActive}
                                    onClick={() => activeVolume && activeViewport && updateViewport({ ...activeViewport, colorMap: DEFAULT_COLOR_MAP,
                                        invertColors: false, clipMin: activeVolume.min, clipMax: activeVolume.max, showColorbar: true })}>Reset colors</button>
                            </div>
                            <small className="panelHint">{differenceActive ? "Set the difference colormap and Min / Max in the Difference pane." : "Color changes apply to this viewport. Voxel values stay unchanged."}</small>
                        </>
                    </section>
                </section>}

                {sidebarView === "labels" && <section className="windowingPanel sidebarPanel labelPanel">
                    <div className="windowingPanelHeader"><span>Label Overlay</span></div>
                    <button type="button" disabled={!activeVolume || isLoading} onClick={() => void openLabelFiles()}>
                        <FolderOpen size={14} /> Load label
                    </button>
                    <label className="windowingPresetRow">
                        <span>Mask</span>
                        <select aria-label="Label mask" value={activeLabel?.id ?? ""} disabled={!activeVolume}
                            onChange={event => activeViewport && updateViewport({ ...activeViewport, labelOverlayId: event.target.value || undefined, showLabel: true, hiddenLabelClasses: [] })}>
                            <option value="">None</option>
                            {activeLabelOptions.map(item => <option key={item.id} value={item.id}>{item.volume.name}</option>)}
                        </select>
                    </label>
                    <label className="labelToggle"><input type="checkbox" checked={activeViewport?.showLabel ?? true} disabled={!activeLabel}
                        onChange={event => activeViewport && updateViewport({ ...activeViewport, showLabel: event.target.checked })} /> Show overlay</label>
                    <label>Opacity {Math.round((activeViewport?.labelOpacity ?? 0.4) * 100)}%
                        <input type="range" aria-label="Label opacity" min={0} max={1} step={0.05} value={activeViewport?.labelOpacity ?? 0.4} disabled={!activeLabel}
                            onChange={event => activeViewport && updateViewport({ ...activeViewport, labelOpacity: Number(event.target.value) })} />
                    </label>
                    {activeLabel && <>
                        <div className="panelActions" role="group" aria-label="Label opacity presets">
                            {[0.25, 0.5, 0.75].map(opacity => <button key={opacity} type="button" aria-pressed={activeViewport?.labelOpacity === opacity}
                                onClick={() => activeViewport && updateViewport({ ...activeViewport, labelOpacity: opacity, showLabel: true })}>{opacity * 100}%</button>)}
                        </div>
                        <label className="windowingPresetRow"><span>Mode</span>
                            <select aria-label="Label display mode" value={activeViewport?.labelMode ?? "fill"}
                                onChange={event => activeViewport && updateViewport({ ...activeViewport, labelMode: event.target.value as "fill" | "outline" })}>
                                <option value="fill">Fill</option><option value="outline">Outline</option>
                            </select>
                        </label>
                        <label className="windowingPresetRow"><span>Focus</span>
                            <select aria-label="Focus label class" value={focusLabelClass} onChange={event => setFocusLabelClass(event.target.value)}>
                                <option value="">Choose class</option>
                                {activeLabel.classes.map(value => <option key={value} value={value}>Class {value}</option>)}
                            </select>
                        </label>
                        <button type="button" disabled={!focusLabelClass} onClick={() => activeViewport && updateViewport({ ...activeViewport,
                            hiddenLabelClasses: activeLabel.classes.filter(value => value !== Number(focusLabelClass)), showLabel: true })}>Show only selected class</button>
                        <input className="labelClassSearch" type="search" aria-label="Search label classes" placeholder="Search class ID…"
                            value={labelClassQuery} onChange={event => setLabelClassQuery(event.target.value)} />
                        <small className="panelHint">{activeLabel.classes.filter(value => !activeViewport?.hiddenLabelClasses.includes(value)).length} / {activeLabel.classes.length} classes enabled</small>
                        <div className="labelClassActions">
                            <button type="button" onClick={() => activeViewport && updateViewport({ ...activeViewport, hiddenLabelClasses: [] })}>Show all</button>
                            <button type="button" onClick={() => activeViewport && updateViewport({ ...activeViewport, hiddenLabelClasses: activeLabel.classes })}>Hide all</button>
                        </div>
                        <div className="labelLegend" aria-label="Label classes">
                            {filteredLabelClasses.map(value => <button type="button" key={value} title={`Toggle label ${value}`} aria-label={`Show label ${value}`}
                                aria-pressed={!activeViewport?.hiddenLabelClasses.includes(value)}
                                onClick={() => activeViewport && updateViewport({ ...activeViewport, hiddenLabelClasses: activeViewport.hiddenLabelClasses.includes(value)
                                    ? activeViewport.hiddenLabelClasses.filter(item => item !== value) : [...activeViewport.hiddenLabelClasses, value] })}>
                                <i style={{ background: `rgb(${labelColor(value).join(",")})` }} />{value}
                            </button>)}
                            {!activeLabel.classes.length && <span>Background only</span>}
                            {activeLabel.classes.length > 0 && !filteredLabelClasses.length && <span>No matching classes</span>}
                        </div>
                        <button type="button" onClick={removeActiveLabel}><Trash2 size={14} /> Remove label</button>
                    </>}
                    <small>0 = background · Same voxel grid as image</small>
                </section>}

                {sidebarView === "registration" && <section className="windowingPanel sidebarPanel labelPanel" aria-label="Registration">
                    <div className="windowingPanelHeader"><span>Registration</span></div>
                    <div className="registrationMethodRow">
                        <label className="windowingPresetRow"><span>Method</span>
                            <select aria-label="Registration method" value={registrationMethod} disabled={registrationBusy}
                                onChange={event => setRegistrationMethod(event.target.value as RegistrationMethod)}>
                                {REGISTRATION_METHODS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                            </select>
                        </label>
                        <button type="button" className="iconButton" aria-label={`About ${registrationInfo.label}`} aria-expanded={registrationHelpOpen}
                            title={registrationHelpOpen ? "Hide method description" : "Show method description"} onClick={() => setRegistrationHelpOpen(open => !open)}>
                            <CircleHelp size={16} />
                        </button>
                    </div>
                    {registrationHelpOpen
                        ? <div className="registrationHelp">{registrationInfo.help.map(text => <p key={text}>{text}</p>)}</div>
                        : <small>{registrationInfo.summary}</small>}
                    <fieldset className="registrationParams" disabled={registrationBusy}>
                        <legend>{registrationInfo.label} parameters</legend>
                        {registrationInfo.params.map(registrationParamControl)}
                        <button type="button" onClick={() => setRegistrationParams(current => ({ ...current, [registrationMethod]: defaultRegistrationParams(registrationInfo) }))}>
                            <RotateCcw size={14} /> Reset to defaults
                        </button>
                    </fieldset>
                    <label className="windowingPresetRow"><span>Fixed</span>
                        <select aria-label="Fixed volume" value={registrationFixed?.id ?? ""} disabled={registrationBusy}
                            onChange={event => setRegistrationFixedId(event.target.value)}>
                            <option value="">Choose volume</option>
                            {registrationVolumes.map(volume => <option key={volume.id} value={volume.id}>{volume.name}</option>)}
                        </select>
                    </label>
                    <label className="windowingPresetRow"><span>Moving</span>
                        <select aria-label="Moving volume" value={registrationMoving?.id ?? ""} disabled={registrationBusy}
                            onChange={event => setRegistrationMovingId(event.target.value)}>
                            <option value="">Choose volume</option>
                            {registrationVolumes.map(volume => <option key={volume.id} value={volume.id}>{volume.name}</option>)}
                        </select>
                    </label>
                    <button type="button" disabled={!window.dcmViewer?.registerVolumes || !registrationFixed || !registrationMoving
                        || registrationFixed.id === registrationMoving.id || registrationBusy} onClick={() => void runRegistration()}>
                        {registrationBusy ? <><LoaderCircle size={14} className="spinner" aria-hidden="true" /> Registering…</> : <><Move3d size={14} /> Register</>}
                    </button>
                    {registrationBusy && window.dcmViewer?.cancelRegistration && <button type="button" onClick={() => void window.dcmViewer?.cancelRegistration?.()}>
                        <X size={14} /> Cancel
                    </button>}
                    {registrationBusy && <div className="registrationProgress" role="status" aria-live="polite">
                        <strong>{registrationProgress?.message || "Preparing…"}</strong>
                        <div className={registrationPercent !== undefined ? "loadingProgress" : "loadingProgress loadingProgressIndeterminate"}
                            role="progressbar" aria-label="Registration progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={registrationPercent}>
                            <span style={{ width: registrationPercent !== undefined ? `${registrationPercent}%` : undefined }} />
                        </div>
                        <small>
                            {registrationProgress?.phase === "queue" ? "Queued" : registrationProgress?.phase === "setup" ? "One-time setup"
                                : registrationPercent !== undefined ? `${registrationPercent}%` : "Starting"}
                            {" · "}{registrationProgress?.phase === "queue" || registrationProgress?.phase === "setup" ? "ETA after start" : registrationEta !== undefined ? `ETA ${formatDuration(registrationEta)}` : "Estimating ETA…"}
                            {" · "}Elapsed {formatDuration((registrationNow - registrationStartedAt) / 1000)}
                        </small>
                    </div>}
                    {volumes.filter(volume => volume.id.startsWith("registration:")).map(volume =>
                        <div className="registrationResult" key={volume.id}>
                            <span title={volume.name}>{volume.name}</span>
                            <button type="button" disabled={Boolean(savingVolumeId)} title="Save the registered volume as a Float32 .npy file"
                                onClick={() => void saveRegisteredVolume(volume)}>
                                {savingVolumeId === volume.id ? <LoaderCircle size={14} className="spinner" aria-hidden="true" /> : <Save size={14} />} Save .npy
                            </button>
                        </div>)}
                    {registrationError && <small className="panelError" role="alert">{registrationError}</small>}
                    <small>{registrationSource === "server"
                        ? "Runs on the server, one registration at a time. Only volumes opened from the server are listed; files viewed in the browser only cannot be registered."
                        : registrationSource === "memory"
                            ? "Warps Moving onto the Fixed grid in voxel units and adds the result under Registration. Missing Python packages are installed on first use after you confirm."
                            : "Registration is available in the desktop app and on the web platform."}</small>
                </section>}

                {sidebarView === "settings" && <section className="windowingPanel sidebarPanel settingsPanel">
                    <div className="windowingPanelHeader"><span>Settings</span></div>
                    <label className="windowingPresetRow"><span>Theme</span>
                        <select aria-label="Theme" value={uiSettings.theme}
                            onChange={event => setUiSettings(current => ({ ...current, theme: event.target.value as typeof current.theme }))}>
                            {THEMES.map(theme => <option key={theme.value} value={theme.value}>{theme.label}</option>)}
                        </select>
                    </label>
                    <div className="settingsGroup">
                        <span id="accentLabel">Accent color</span>
                        <div className="accentSwatches" role="radiogroup" aria-labelledby="accentLabel">
                            {ACCENT_PRESETS.map(preset => <button key={preset.value} type="button" role="radio" aria-checked={uiSettings.accent === preset.value}
                                aria-label={preset.label} title={preset.label} style={{ background: preset.value }}
                                onClick={() => setUiSettings(current => ({ ...current, accent: preset.value }))} />)}
                            <input type="color" aria-label="Custom accent color" title="Custom color" value={uiSettings.accent}
                                onChange={event => setUiSettings(current => ({ ...current, accent: event.target.value }))} />
                        </div>
                    </div>
                    <label>Icon size {Math.round(uiSettings.iconScale * 100)}%
                        <input type="range" aria-label="Icon size" min={ICON_SCALE_RANGE[0]} max={ICON_SCALE_RANGE[1]} step={0.05} value={uiSettings.iconScale}
                            onChange={event => setUiSettings(current => ({ ...current, iconScale: Number(event.target.value) }))} />
                    </label>
                    <label>Text size {Math.round(uiSettings.textScale * 100)}%
                        <input type="range" aria-label="Text size" min={TEXT_SCALE_RANGE[0]} max={TEXT_SCALE_RANGE[1]} step={0.05} value={uiSettings.textScale}
                            onChange={event => setUiSettings(current => ({ ...current, textScale: Number(event.target.value) }))} />
                    </label>
                    <button type="button" onClick={() => setUiSettings(DEFAULT_UI_SETTINGS)}>Reset to defaults</button>
                    <small>Saved in this browser only.</small>
                    <footer className="settingsAbout">
                        <span>DCMViewer v{__APP_VERSION__}</span>
                        {/^[0-9a-f]+/.test(__APP_COMMIT__)
                            ? <a href={`https://github.com/qqaazz0222/DCMViewer/commit/${__APP_COMMIT__.replace(/-dirty$/, "")}`} target="_blank" rel="noreferrer"
                                title="Open this commit on GitHub">{__APP_COMMIT__}</a>
                            : <span>{__APP_COMMIT__}</span>}
                        {window.dcmViewer?.checkForUpdates && <button type="button" onClick={() => {
                            void window.dcmViewer!.checkForUpdates!().catch(error => setLoadErrors(current => [...current, errorMessage(error)]));
                        }}>Check for updates</button>}
                    </footer>
                </section>}
            </aside>}

            <section className="workspace">
                <header className="toolbar">
                    <div
                        className="viewModeControl"
                        role="group"
                        aria-label="View mode"
                    >
                        <button
                            className={!compareMode ? "selected" : ""}
                            type="button"
                            aria-pressed={!compareMode}
                            onClick={enableNormalView}
                        >
                            <Grid3X3 size={17} />
                            View
                        </button>
                        <button
                            className={compareMode ? "selected" : ""}
                            type="button"
                            aria-pressed={compareMode}
                            onClick={enableCompareView}
                            disabled={volumes.length < 2}
                            title={volumes.length < 2 ? "Load at least two volumes to compare" : "Compare two volumes and their difference"}
                        >
                            <GitCompare size={17} />
                            Compare
                        </button>
                    </div>

                    <button type="button" className="saveImagesButton" disabled={savingImages || !displayedViewports.some(viewport => viewport.volumeId)}
                        title="Save the displayed slices as PNG images"
                        onClick={() => displayedViewports.filter(viewport => viewport.volumeId).length > 1 ? setImageDialogOpen(true) : void saveDisplayedImages("separate")}>
                        {savingImages ? <LoaderCircle size={17} className="spinner" aria-hidden="true" /> : <ImageDown size={17} />}
                        Save images
                    </button>

                    <div
                        className="toolbarGroup gridControls toolbarEnd"
                        aria-label="Grid settings"
                    >
                        <Grid3X3 size={17} />
                        <span>Rows</span>
                        <button
                            className="stepButton"
                            type="button"
                            aria-label="Decrease rows"
                            onClick={() => updateGrid(rows - 1, columns)}
                            disabled={compareMode || rows <= 1}
                        >
                            <Minus size={14} />
                        </button>
                        <strong>{compareMode ? 1 : rows}</strong>
                        <button
                            className="stepButton"
                            type="button"
                            aria-label="Increase rows"
                            onClick={() => updateGrid(rows + 1, columns)}
                            disabled={compareMode || rows >= 4}
                        >
                            <Plus size={14} />
                        </button>
                        <span>Cols</span>
                        <button
                            className="stepButton"
                            type="button"
                            aria-label="Decrease columns"
                            onClick={() => updateGrid(rows, columns - 1)}
                            disabled={compareMode || columns <= 1}
                        >
                            <Minus size={14} />
                        </button>
                        <strong>{compareMode ? 3 : columns}</strong>
                        <button
                            className="stepButton"
                            type="button"
                            aria-label="Increase columns"
                            onClick={() => updateGrid(rows, columns + 1)}
                            disabled={compareMode || columns >= 4}
                        >
                            <Plus size={14} />
                        </button>
                    </div>
                </header>

                {compareMode && <div className="compareStatus" role="status">
                    {!primaryCompare || !secondaryCompare ? "Select Case 1 and Case 2 to compare."
                        : primaryCompare.id === secondaryCompare.id ? "Select two different volumes."
                        : !differenceVolume ? "Difference unavailable: in-plane dimensions must match. The two cases can still be viewed."
                        : `Case 2 − Case 1 · ${primaryCompare.dimensions[2] === secondaryCompare.dimensions[2] ? "Matching grid dimensions" : "Different depths: slices matched by relative position"} · No spatial registration`}
                </div>}
                {compareMode && compareDriver && <div className="compareControls" role="group" aria-label="Comparison controls">
                    <ViewControls state={compareDriver} volume={compareDriverVolume} onChange={updateViewport} />
                    <SliceControls state={compareDriver} volume={compareDriverVolume} onChange={updateViewport} />
                </div>}
                {loadErrors.length > 0 && (
                    <div className="errorStrip" role="status">
                        <AlertTriangle size={17} />
                        <span>{loadErrors.length} loading issue(s): {loadErrors[0]}</span>
                        <button type="button" onClick={() => setShowErrors(true)}>Details</button>
                        <button type="button" aria-label="Dismiss errors" onClick={() => setLoadErrors([])}><X size={14} /></button>
                    </div>
                )}

                <div
                    className="viewerGrid"
                    style={{
                        gridTemplateColumns: `repeat(${displayedGridColumns}, minmax(200px, 1fr))`,
                        gridTemplateRows: `repeat(${displayedGridRows}, minmax(220px, 1fr))`,
                    }}
                >
                    {displayedViewports.map((viewport) => (
                        <SliceViewport
                            key={viewport.id}
                            state={viewport}
                            volumes={displayVolumes}
                            overlays={labelOverlays}
                            compareRole={compareMode ? (viewport.id === "view-1" ? "Case 1" : viewport.id === "view-2" ? "Case 2" : "Difference") : undefined}
                            onOpenFiles={() => void openFiles()}
                            active={activeViewportId === viewport.id}
                            linkEnabled={!compareMode}
                            sharedControls={compareMode}
                            onActivate={() => setActiveViewportId(viewport.id)}
                            onToggleSingleView={
                                compareMode
                                    ? undefined
                                    : () =>
                                          setSingleViewportId((current) =>
                                              current === viewport.id
                                                  ? null
                                                  : viewport.id,
                                          )
                            }
                            onSaveError={message => setLoadErrors(current => [...current, `Save image: ${message}`])}
                            onChange={updateViewport}
                        />
                    ))}
                </div>
            </section>

            {window.dcmViewer?.checkForUpdates && <ReleaseNotes version={__APP_VERSION__} />}

            {(showHelp || showErrors) && <div className="metadataOverlay" onClick={() => { setShowHelp(false); setShowErrors(false); }}>
                <section className="helpModal" role="dialog" aria-modal="true" aria-label={showHelp ? "Viewer controls" : "Loading issues"} onClick={event => event.stopPropagation()}>
                    <header><strong>{showHelp ? "Viewer controls" : `Loading issues (${loadErrors.length})`}</strong>
                        <button autoFocus type="button" aria-label="Close dialog" onClick={() => { setShowHelp(false); setShowErrors(false); }}><X size={16} /></button></header>
                    {showHelp ? <dl>
                        <dt>Scroll / ↑ ↓</dt><dd>Previous / next slice (Shift: 10 slices)</dd>
                        <dt>Home / End</dt><dd>First / last slice</dd>
                        <dt>Ctrl or ⌘ + scroll / + −</dt><dd>Zoom in / out</dd>
                        <dt>Left drag</dt><dd>Pan image</dd>
                        <dt>Right drag</dt><dd>Adjust WL / WW</dd>
                        <dt>H / V</dt><dd>Flip horizontally / vertically</dd>
                        <dt>L</dt><dd>Toggle label overlay</dd>
                        <dt>0</dt><dd>Fit image to viewport</dd>
                        <dt>R / Reset</dt><dd>Reset view controls and windowing</dd>
                        <dt>Right-click link button</dt><dd>Choose a link group; linked panes sync within their group</dd>
                        <dt>Double-click image</dt><dd>Toggle single view in normal mode</dd>
                    </dl> : <ul>{loadErrors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
                    {showHelp && <p>Click an image to focus its controls. Shortcuts apply while the image is focused.</p>}
                </section>
            </div>}

            {isLoading && !(backgroundLoading && sidebarView === "patients") && (
                <div
                    className={`loadingOverlay${backgroundLoading ? " backgroundLoading" : ""}`}
                    role={backgroundLoading ? "status" : "alertdialog"}
                    aria-modal={backgroundLoading ? undefined : true}
                    aria-label="Loading medical data"
                >
                    <div className="loadingModal">{loadingProgress}</div>
                </div>
            )}

            {imageDialogOpen && (
                <div className="metadataOverlay" role="dialog" aria-modal="true" aria-label="Save images"
                    onMouseDown={event => { if (event.target === event.currentTarget && !savingImages) setImageDialogOpen(false); }}>
                    <section className="saveImagesModal">
                        <header className="metadataModalHeader">
                            <strong>Save displayed slices</strong>
                            <button className="iconButton" type="button" aria-label="Close" title="Close" disabled={savingImages}
                                onClick={() => setImageDialogOpen(false)}><X size={17} /></button>
                        </header>
                        <div className="saveImagesOptions" role="radiogroup" aria-label="Save format">
                            <label><input type="radio" name="imageSaveMode" checked={imageSaveMode === "separate"} onChange={() => setImageSaveMode("separate")} />
                                <span><strong>Separate images</strong><small>One PNG per view.</small></span></label>
                            <label><input type="radio" name="imageSaveMode" checked={imageSaveMode === "grid"} onChange={() => setImageSaveMode("grid")} />
                                <span><strong>One grid image</strong><small>All views in a single PNG, laid out like the viewer grid.</small></span></label>
                        </div>
                        <footer className="saveImagesActions">
                            <button type="button" disabled={savingImages} onClick={() => setImageDialogOpen(false)}>Cancel</button>
                            <button type="button" disabled={savingImages} onClick={() => void saveDisplayedImages(imageSaveMode)}>
                                {savingImages ? <LoaderCircle size={14} className="spinner" aria-hidden="true" /> : <ImageDown size={14} />} Save
                            </button>
                        </footer>
                    </section>
                </div>
            )}
            {metadataVolume && (
                <div
                    className="metadataOverlay"
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Metadata for ${metadataVolume.name}`}
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                            setMetadataVolume(null);
                        }
                    }}
                >
                    <section className="metadataModal">
                        <header className="metadataModalHeader">
                            <div>
                                <span>Metadata</span>
                                <strong>{metadataVolume.name}</strong>
                            </div>
                            <button
                                className="iconButton"
                                type="button"
                                aria-label="Close metadata"
                                title="Close"
                                onClick={() => setMetadataVolume(null)}
                            >
                                <X size={17} />
                            </button>
                        </header>
                        <div className="metadataSearchRow">
                            <Search size={15} />
                            <input
                                type="search"
                                aria-label="Search metadata by tag ID or name"
                                placeholder="Search tag, attribute, value, VR, or length"
                                value={metadataQuery}
                                onChange={(event) =>
                                    setMetadataQuery(event.target.value)
                                }
                            />
                            <span>
                                {filteredMetadata.length}/
                                {metadataVolume.metadata?.length ?? 0}
                            </span>
                        </div>
                        <div className="metadataGrid" role="table">
                            <div className="metadataGridHeader" role="row">
                                <span role="columnheader">Tag</span>
                                <span role="columnheader">Attribute</span>
                                <span role="columnheader">Value</span>
                                <span role="columnheader">VR</span>
                                <span role="columnheader">Length</span>
                            </div>
                            {filteredMetadata.map((entry) => (
                                <div
                                    key={entry.tagId}
                                    className="metadataGridRow"
                                    role="row"
                                >
                                    <span role="cell">{entry.tagId}</span>
                                    <span role="cell">{entry.tagName}</span>
                                    <span role="cell">{entry.value}</span>
                                    <span role="cell">{entry.vr}</span>
                                    <span role="cell">{entry.length}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
            )}
        </main>
    );
}

export default App;
