import { useEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle,
    FolderOpen,
    GitCompare,
    Grid3X3,
    Info,
    Minus,
    PanelLeftClose,
    PanelLeftOpen,
    Plus,
    Search,
    Trash2,
    X,
} from "lucide-react";
import { SliceViewport } from "./components/SliceViewport";
import {
    buildStudyTree,
    createDifferenceVolume,
    loadMedicalFiles,
} from "./loaders/medicalLoader";
import { getSliceCount } from "./rendering";
import type {
    MedicalFile,
    MedicalFileReference,
    ViewportState,
    Volume,
} from "./types";
import { DEFAULT_WINDOW_CENTER, DEFAULT_WINDOW_WIDTH } from "./windowing";

function createViewport(id: number, volume?: Volume): ViewportState {
    return {
        id: `view-${id}`,
        volumeId: volume?.id,
        linked: false,
        axis: "axial",
        slice: volume ? Math.floor(volume.dimensions[2] / 2) : 0,
        windowCenter: DEFAULT_WINDOW_CENTER,
        windowWidth: DEFAULT_WINDOW_WIDTH,
    };
}

async function filesFromInput(fileList: FileList): Promise<MedicalFile[]> {
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
    let nextName = displayName.replace(/\.(nii\.gz|nii|npy|dcm|dicom)$/i, "");

    while (nextName !== displayName) {
        displayName = nextName;
        nextName = displayName.replace(/\.(nii\.gz|nii|npy|dcm|dicom)$/i, "");
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
        extension === ".npy" || extension === ".nii" || extension === ".nii.gz"
    );
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

function linkedSliceForViewport(
    viewport: ViewportState,
    slice: number,
    availableVolumes: Volume[],
) {
    const volume = availableVolumes.find(
        (item) => item.id === viewport.volumeId,
    );
    if (!volume) return 0;

    return Math.min(
        Math.max(slice, 0),
        getSliceCount(volume, viewport.axis) - 1,
    );
}

function sliceRatioForViewport(
    viewport: ViewportState,
    slice: number,
    availableVolumes: Volume[],
) {
    const volume = availableVolumes.find(
        (item) => item.id === viewport.volumeId,
    );
    if (!volume) return 0;

    const maxSlice = getSliceCount(volume, viewport.axis) - 1;
    if (maxSlice <= 0) return 0;

    return Math.min(Math.max(slice, 0), maxSlice) / maxSlice;
}

function sliceFromRatioForViewport(
    viewport: ViewportState,
    ratio: number,
    availableVolumes: Volume[],
) {
    const volume = availableVolumes.find(
        (item) => item.id === viewport.volumeId,
    );
    if (!volume) return 0;

    const maxSlice = getSliceCount(volume, viewport.axis) - 1;
    return Math.min(Math.max(Math.round(ratio * maxSlice), 0), maxSlice);
}

function App() {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [volumes, setVolumes] = useState<Volume[]>([]);
    const [loadErrors, setLoadErrors] = useState<string[]>([]);
    const [loadingState, setLoadingState] = useState<LoadingState | null>(null);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [rows, setRows] = useState(1);
    const [columns, setColumns] = useState(1);
    const [compareMode, setCompareMode] = useState(false);
    const [singleViewportId, setSingleViewportId] = useState<string | null>(
        null,
    );
    const [activeViewportId, setActiveViewportId] = useState("view-1");
    const [metadataVolume, setMetadataVolume] = useState<Volume | null>(null);
    const [metadataQuery, setMetadataQuery] = useState("");
    const [viewports, setViewports] = useState<ViewportState[]>([
        createViewport(1),
    ]);

    const studyTree = useMemo(() => buildStudyTree(volumes), [volumes]);
    const primaryCompare = volumes.find(
        (volume) => volume.id === viewports[0]?.volumeId,
    );
    const secondaryCompare = volumes.find(
        (volume) => volume.id === viewports[1]?.volumeId,
    );
    const differenceVolume = useMemo(
        () =>
            primaryCompare && secondaryCompare
                ? createDifferenceVolume(primaryCompare, secondaryCompare)
                : undefined,
        [primaryCompare, secondaryCompare],
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
    const windowLevelMin = Math.floor(
        Math.min(
            activeVolume?.min ?? -1000,
            activeViewport?.windowCenter ?? 40,
        ),
    );
    const windowLevelMax = Math.ceil(
        Math.max(activeVolume?.max ?? 3000, activeViewport?.windowCenter ?? 40),
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
        if (!compareMode || !differenceVolume) return;

        setViewports((current) =>
            resizeViewports(current, 3, volumes[0]).map((viewport, index) =>
                index === 2
                    ? { ...viewport, volumeId: differenceVolume.id }
                    : viewport,
            ),
        );
    }, [compareMode, differenceVolume, volumes]);

    const appendLoadedResult = (result: {
        volumes: Volume[];
        errors: string[];
    }) => {
        setVolumes((current) => {
            const next = [...current, ...result.volumes];
            setViewports((viewportState) =>
                viewportState.map((viewport, index) => {
                    if (viewport.volumeId || index > 0 || !next[0])
                        return viewport;
                    return createViewport(1, next[0]);
                }),
            );
            return next;
        });

        if (result.errors.length > 0) {
            setLoadErrors((current) => [...current, ...result.errors]);
        }
    };

    const importPreparedFiles = async (files: MedicalFile[]) => {
        const result = await loadMedicalFiles(files, {
            onProgress: setLoadingState,
        });
        appendLoadedResult(result);
    };

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

    const importElectronFiles = async (
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
            const dicomFiles: MedicalFile[] = [];
            let completed = 0;

            for (const fileReference of fileReferences) {
                setLoadingState({
                    message: `Reading ${fileReference.name}`,
                    current: completed,
                    total: fileReferences.length,
                });

                const file = await window.dcmViewer.readMedicalFile(
                    fileReference.path,
                );

                completed += 1;

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
            setLoadingState(null);
        }
    };

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
                await importElectronFiles(
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

    const assignVolumeToActive = (volume: Volume) => {
        setViewports((current) =>
            current.map((viewport) =>
                viewport.id === activeViewportId
                    ? {
                          ...viewport,
                          volumeId: volume.id,
                          slice: Math.floor(volume.dimensions[2] / 2),
                          windowCenter: DEFAULT_WINDOW_CENTER,
                          windowWidth: DEFAULT_WINDOW_WIDTH,
                      }
                    : viewport,
            ),
        );
    };

    const removeVolume = (volumeId: string) => {
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
                          linked: false,
                          slice: 0,
                          windowCenter: DEFAULT_WINDOW_CENTER,
                          windowWidth: DEFAULT_WINDOW_WIDTH,
                      }
                    : viewport,
            ),
        );
        setMetadataVolume((current) =>
            current?.id === volumeId ? null : current,
        );
    };

    const updateViewport = (nextViewport: ViewportState) => {
        setViewports((current) => {
            if (!compareMode) {
                const currentViewport = current.find(
                    (viewport) => viewport.id === nextViewport.id,
                );
                const volumeChanged =
                    currentViewport?.volumeId !== nextViewport.volumeId;
                const axisChanged = currentViewport?.axis !== nextViewport.axis;
                const controlsChanged =
                    currentViewport?.slice !== nextViewport.slice ||
                    currentViewport?.windowCenter !==
                        nextViewport.windowCenter ||
                    currentViewport?.windowWidth !== nextViewport.windowWidth;
                const shouldSyncLinkedControls =
                    currentViewport?.linked &&
                    nextViewport.linked &&
                    !volumeChanged &&
                    (controlsChanged || axisChanged);

                if (!shouldSyncLinkedControls) {
                    return current.map((viewport) =>
                        viewport.id === nextViewport.id
                            ? nextViewport
                            : viewport,
                    );
                }

                return current.map((viewport) => {
                    const targetViewport =
                        viewport.id === nextViewport.id
                            ? nextViewport
                            : viewport;

                    if (!targetViewport.linked) return targetViewport;

                    const syncedViewport = {
                        ...targetViewport,
                        axis: nextViewport.axis,
                    };

                    return {
                        ...syncedViewport,
                        slice: axisChanged
                            ? sliceFromRatioForViewport(
                                  syncedViewport,
                                  sliceRatioForViewport(
                                      nextViewport,
                                      nextViewport.slice,
                                      volumes,
                                  ),
                                  volumes,
                              )
                            : linkedSliceForViewport(
                                  syncedViewport,
                                  nextViewport.slice,
                                  volumes,
                              ),
                        windowCenter: nextViewport.windowCenter,
                        windowWidth: nextViewport.windowWidth,
                    };
                });
            }

            const currentViewport = current.find(
                (viewport) => viewport.id === nextViewport.id,
            );
            const sourceViewport = currentViewport ?? nextViewport;
            const volumeChanged =
                currentViewport?.volumeId !== nextViewport.volumeId;
            const axisChanged = currentViewport?.axis !== nextViewport.axis;
            const sliceRatio = sliceRatioForViewport(
                { ...sourceViewport, axis: nextViewport.axis },
                nextViewport.slice,
                displayVolumes,
            );

            return current.map((viewport, index) => {
                const volumeId =
                    viewport.id === nextViewport.id
                        ? nextViewport.volumeId
                        : viewport.volumeId;
                const targetViewport = {
                    ...viewport,
                    volumeId:
                        index === 2 && differenceVolume
                            ? differenceVolume.id
                            : volumeId,
                    axis: nextViewport.axis,
                };

                return {
                    ...targetViewport,
                    slice:
                        viewport.id === nextViewport.id &&
                        (volumeChanged || axisChanged)
                            ? nextViewport.slice
                            : sliceFromRatioForViewport(
                                  targetViewport,
                                  sliceRatio,
                                  displayVolumes,
                              ),
                    windowCenter: nextViewport.windowCenter,
                    windowWidth: nextViewport.windowWidth,
                };
            });
        });
    };

    const updateActiveWindowing = (
        nextWindowing: Pick<ViewportState, "windowCenter" | "windowWidth">,
    ) => {
        if (!activeViewport) return;
        updateViewport({ ...activeViewport, ...nextWindowing });
    };

    const applyWindowingPreset = (presetId: string) => {
        const preset = windowingPresets.find((item) => item.id === presetId);
        if (!preset) return;

        updateActiveWindowing({
            windowCenter: preset.windowCenter,
            windowWidth: preset.windowWidth,
        });
    };

    const updateGrid = (nextRows: number, nextColumns: number) => {
        const safeRows = Math.min(Math.max(nextRows, 1), 4);
        const safeColumns = Math.min(Math.max(nextColumns, 1), 4);
        setSingleViewportId(null);
        setRows(safeRows);
        setColumns(safeColumns);
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
                          }
                        : viewport,
            ),
        );
    };

    const enableCompareView = () => {
        setCompareMode(true);
        setSingleViewportId(null);
        setViewports((current) => {
            const next = resizeViewports(current, 3, volumes[0]);
            return next.map((viewport, index) => ({
                ...viewport,
                volumeId:
                    index === 2 && differenceVolume
                        ? differenceVolume.id
                        : viewport.volumeId,
            }));
        });
    };

    const activeVolumeCount = volumes.length;

    return (
        <main
            className={
                sidebarCollapsed ? "appShell sidebarCollapsed" : "appShell"
            }
        >
            <input
                ref={fileInputRef}
                className="hiddenInput"
                type="file"
                multiple
                accept=".dcm,.dicom,.nii,.nii.gz,.npy"
                disabled={isLoading}
                onChange={async (event) => {
                    if (event.target.files)
                        await importInputFiles(event.target.files);
                    event.target.value = "";
                }}
            />

            <aside className="sidebar">
                <div className="brandBlock">
                    <div className="brandBlockText">
                        <h1>DCMViewer</h1>
                        <p>CT volume workstation</p>
                    </div>
                    <div className="brandActions">
                        <button
                            className="iconButton"
                            type="button"
                            onClick={() =>
                                setSidebarCollapsed((current) => !current)
                            }
                            aria-label={
                                sidebarCollapsed
                                    ? "Expand sidebar"
                                    : "Collapse sidebar"
                            }
                            title={
                                sidebarCollapsed
                                    ? "Expand sidebar"
                                    : "Collapse sidebar"
                            }
                        >
                            {sidebarCollapsed ? (
                                <PanelLeftOpen size={18} />
                            ) : (
                                <PanelLeftClose size={18} />
                            )}
                        </button>
                        <button
                            className="iconButton"
                            type="button"
                            onClick={openFiles}
                            disabled={isLoading}
                            title="Open files or folder"
                        >
                            <FolderOpen size={18} />
                        </button>
                    </div>
                </div>

                <div className="treeHeader">
                    <span>Patients</span>
                    <strong>{activeVolumeCount}</strong>
                </div>

                <div className="treePanel">
                    {studyTree.length === 0 ? (
                        <div className="emptyTree">
                            Open medical image files to get started.
                        </div>
                    ) : (
                        studyTree.map((patient) => (
                            <details key={patient.patientId} open>
                                <summary>{patient.patientId}</summary>
                                {patient.studies.map((study) => (
                                    <details
                                        key={study.studyId}
                                        open
                                        className="studyNode"
                                    >
                                        <summary>
                                            {displayStudyName(study.studyId)}
                                        </summary>
                                        {study.volumes.map((volume) => (
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
                                                    <span>{volume.name}</span>
                                                </button>
                                                {volume.format === "DICOM" && (
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
                                                        <Info size={13} />
                                                    </button>
                                                )}
                                                <button
                                                    className="removeVolumeButton"
                                                    type="button"
                                                    aria-label={`Remove ${volume.name}`}
                                                    title="Remove file"
                                                    onClick={() =>
                                                        removeVolume(volume.id)
                                                    }
                                                >
                                                    <Trash2 size={13} />
                                                </button>
                                            </div>
                                        ))}
                                    </details>
                                ))}
                            </details>
                        ))
                    )}
                </div>

                <section className="windowingPanel">
                    <div className="windowingPanelHeader">
                        <span>Windowing</span>
                        <strong>{activeViewport?.id ?? "-"}</strong>
                    </div>
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
                                <option key={preset.id} value={preset.id}>
                                    {preset.label} ({preset.windowCenter}/
                                    {preset.windowWidth})
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        <span>
                            WL {Math.round(activeViewport?.windowCenter ?? 0)}
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
                                    windowCenter: Number(event.target.value),
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
                            WW {Math.round(activeViewport?.windowWidth ?? 0)}
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
                                    windowWidth: Number(event.target.value),
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
                </section>
            </aside>

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
                            onClick={enableNormalView}
                        >
                            <Grid3X3 size={17} />
                            View
                        </button>
                        <button
                            className={compareMode ? "selected" : ""}
                            type="button"
                            onClick={enableCompareView}
                        >
                            <GitCompare size={17} />
                            Compare
                        </button>
                    </div>

                    <div
                        className="toolbarGroup gridControls"
                        aria-label="Grid settings"
                    >
                        <Grid3X3 size={17} />
                        <span>Rows</span>
                        <button
                            className="stepButton"
                            type="button"
                            onClick={() => updateGrid(rows - 1, columns)}
                            disabled={compareMode}
                        >
                            <Minus size={14} />
                        </button>
                        <strong>{rows}</strong>
                        <button
                            className="stepButton"
                            type="button"
                            onClick={() => updateGrid(rows + 1, columns)}
                            disabled={compareMode}
                        >
                            <Plus size={14} />
                        </button>
                        <span>Cols</span>
                        <button
                            className="stepButton"
                            type="button"
                            onClick={() => updateGrid(rows, columns - 1)}
                            disabled={compareMode}
                        >
                            <Minus size={14} />
                        </button>
                        <strong>{columns}</strong>
                        <button
                            className="stepButton"
                            type="button"
                            onClick={() => updateGrid(rows, columns + 1)}
                            disabled={compareMode}
                        >
                            <Plus size={14} />
                        </button>
                    </div>
                </header>

                {loadErrors.length > 0 && (
                    <div className="errorStrip">
                        <AlertTriangle size={17} />
                        <span>{loadErrors.slice(0, 3).join(" / ")}</span>
                    </div>
                )}

                <div
                    className="viewerGrid"
                    style={{
                        gridTemplateColumns: `repeat(${displayedGridColumns}, minmax(0, 1fr))`,
                        gridTemplateRows: `repeat(${displayedGridRows}, minmax(0, 1fr))`,
                    }}
                >
                    {displayedViewports.map((viewport) => (
                        <SliceViewport
                            key={viewport.id}
                            state={viewport}
                            volumes={displayVolumes}
                            active={activeViewportId === viewport.id}
                            linkEnabled={!compareMode}
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
                            onChange={updateViewport}
                        />
                    ))}
                </div>
            </section>

            {isLoading && (
                <div
                    className="loadingOverlay"
                    role="alertdialog"
                    aria-modal="true"
                    aria-label="Loading medical data"
                >
                    <div className="loadingModal">
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
                    </div>
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
