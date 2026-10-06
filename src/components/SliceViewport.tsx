import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { FlipHorizontal2, FlipVertical2, Link2, Unlink2, ZoomIn, ZoomOut, Scan, RotateCcw, FolderOpen } from "lucide-react";
import type {
    Axis,
    LabelOverlay,
    ViewportState,
    VisualizationColorMap,
    Volume,
} from "../types";
import {
    getSliceCount,
    getSliceSize,
    getVoxel,
    renderSliceToCanvas,
    slicePixelToVoxel,
} from "../rendering";
import { imagePlacement } from "../viewport";
import { DEFAULT_WINDOW_CENTER, DEFAULT_WINDOW_WIDTH } from "../windowing";

type Props = {
    state: ViewportState;
    volumes: Volume[];
    overlays: LabelOverlay[];
    compareRole?: "Case 1" | "Case 2" | "Difference";
    onOpenFiles: () => void;
    active: boolean;
    linkEnabled: boolean;
    onActivate: () => void;
    onToggleSingleView?: () => void;
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

function colorBarGradient(colorMap: VisualizationColorMap) {
    if (colorMap === "grayscale") {
        return "linear-gradient(to top, #000000 0%, #ffffff 100%)";
    }

    if (colorMap === "hot") {
        return "linear-gradient(to top, #000000 0%, #ff0000 33%, #ffff00 66%, #ffffff 100%)";
    }

    if (colorMap === "viridis") {
        return "linear-gradient(to top, #440154 0%, #3b528b 25%, #21918c 50%, #5ec962 75%, #fde725 100%)";
    }

    return "linear-gradient(to top, #0000ff 0%, #00ffff 25%, #00ff00 50%, #ffff00 75%, #ff0000 100%)";
}

export function SliceViewport({
    state,
    volumes,
    overlays,
    compareRole,
    onOpenFiles,
    active,
    linkEnabled,
    onActivate,
    onToggleSingleView,
    onChange,
}: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const panDragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
    const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
    const [sliceInput, setSliceInput] = useState("");
    const windowDragRef = useRef<WindowDragState | null>(null);
    const [hoverVoxel, setHoverVoxel] = useState<HoverVoxel | null>(null);
    const volume = volumes.find((item) => item.id === state.volumeId);
    const overlay = overlays.find(item => item.id === state.labelOverlayId && item.targetVolumeId === volume?.id);
    const visibleLabel = state.showLabel ? overlay?.volume : undefined;
    const sliceCount = volume ? getSliceCount(volume, state.axis) : 1;
    const boundedSlice = Math.min(Math.max(state.slice, 0), sliceCount - 1);

    const sliceSize = volume ? getSliceSize(volume, state.axis) : { width: 1, height: 1 };
    const placement = imagePlacement(stageSize.width, stageSize.height, sliceSize.width, sliceSize.height, state.zoom, state.panX, state.panY);

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

    useEffect(() => { setHoverVoxel(null); setSliceInput(""); }, [volume, boundedSlice, state.axis, state.flipHorizontal, state.flipVertical, state.zoom, state.panX, state.panY, visibleLabel]);

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
            if (!volume || !stageRef.current) {
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
                sliceSize.width, sliceSize.height, state.zoom, state.panX, state.panY);
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
                Math.max(Math.floor(localY / scale), 0),
                sliceSize.height - 1,
            );
            const voxel = slicePixelToVoxel(volume, state.axis, boundedSlice, sliceX, sliceY,
                state.flipHorizontal, state.flipVertical);

            setHoverVoxel({
                ...voxel,
                value: getVoxel(volume, voxel.x, voxel.y, voxel.z),
                label: visibleLabel ? getVoxel(visibleLabel, voxel.x, voxel.y, voxel.z) : undefined,
            });
        },
        [boundedSlice, state.axis, state.flipHorizontal, state.flipVertical, state.zoom, state.panX, state.panY, volume, visibleLabel],
    );

    const zoomImage = useCallback((nextZoom: number, origin?: { x: number; y: number }) => {
        const zoom = Math.min(Math.max(nextZoom, 0.25), 8);
        const factor = zoom / state.zoom;
        onChange({ ...state, zoom,
            panX: origin ? origin.x - (origin.x - state.panX) * factor : state.panX * factor,
            panY: origin ? origin.y - (origin.y - state.panY) * factor : state.panY * factor });
    }, [onChange, state]);

    const resetView = () => {
        if (!volume) return;
        onChange({ ...state, zoom: 1, panX: 0, panY: 0,
            flipHorizontal: false, flipVertical: false,
            windowCenter: volume.windowCenter, windowWidth: volume.windowWidth,
            clipMin: volume.min, clipMax: volume.max, colorMap: "grayscale",
            labelOpacity: 0.4, showLabel: true, labelMode: "fill", hiddenLabelClasses: [] });
    };

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
        if (!volume || !canvasRef.current) return;
        renderSliceToCanvas(
            canvasRef.current,
            volume,
            state.axis,
            boundedSlice,
            state.windowCenter,
            state.windowWidth,
            {
                colorMap: state.colorMap,
                clipMin: state.clipMin,
                clipMax: state.clipMax,
                flipHorizontal: state.flipHorizontal,
                flipVertical: state.flipVertical,
            },
            visibleLabel ? { volume: visibleLabel, opacity: state.labelOpacity, mode: state.labelMode, hiddenClasses: state.hiddenLabelClasses } : undefined,
        );
    }, [
        boundedSlice,
        state.axis,
        state.windowCenter,
        state.windowWidth,
        state.colorMap,
        state.clipMin,
        state.clipMax,
        state.flipHorizontal,
        state.flipVertical,
        state.labelOpacity,
        state.labelMode,
        state.hiddenLabelClasses,
        visibleLabel,
        volume,
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
            if (!volume || event.deltaY === 0) return;

            event.preventDefault();
            onActivate();
            if (event.ctrlKey || event.metaKey) {
                const rect = stage.getBoundingClientRect();
                zoomImage(state.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15),
                    { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 });
            } else changeSlice(boundedSlice + (event.deltaY > 0 ? 1 : -1) * (event.shiftKey ? 10 : 1));
        };

        stage.addEventListener("wheel", handleWheel, { passive: false });
        return () => stage.removeEventListener("wheel", handleWheel);
    }, [boundedSlice, changeSlice, onActivate, volume, state.zoom, zoomImage]);

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
                className={`viewportHeader ${linkEnabled ? "" : "viewportHeaderNoLink"}`}
            >
                {compareRole && <div className="compareRole">{compareRole}</div>}
                {linkEnabled && (
                    <button
                        className={`linkButton ${state.linked ? "linked" : ""}`}
                        type="button"
                        aria-label={
                            state.linked
                                ? "Disable viewport link"
                                : "Enable viewport link"
                        }
                        title={
                            state.linked
                                ? "Disable viewport link"
                                : "Enable viewport link"
                        }
                        onClick={() =>
                            onChange({ ...state, linked: !state.linked })
                        }
                    >
                        {state.linked ? (
                            <Link2 size={14} />
                        ) : (
                            <Unlink2 size={14} />
                        )}
                    </button>
                )}
                <select
                    aria-label="Select volume"
                    disabled={compareRole === "Difference"}
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
                    {volumes.map((item) => (
                        <option key={item.id} value={item.id}>
                            {formatVolumeOptionLabel(item)}
                        </option>
                    ))}
                </select>
                <div className="orientationControls">
                    <button type="button" title="Zoom out (−)" aria-label="Zoom out" disabled={!volume || state.zoom <= 0.25} onClick={() => zoomImage(state.zoom / 1.25)}><ZoomOut size={15} /></button>
                    <span className="zoomValue">{Math.round(state.zoom * 100)}%</span>
                    <button type="button" title="Zoom in (+)" aria-label="Zoom in" disabled={!volume || state.zoom >= 8} onClick={() => zoomImage(state.zoom * 1.25)}><ZoomIn size={15} /></button>
                    <button type="button" title="Fit image (0)" aria-label="Fit image" disabled={!volume} onClick={() => onChange({ ...state, zoom: 1, panX: 0, panY: 0 })}><Scan size={15} /></button>
                    <button type="button" title="Reset view (R)" aria-label="Reset view" disabled={!volume} onClick={resetView}><RotateCcw size={15} /></button>
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
            </div>

            <div
                ref={stageRef}
                className="canvasStage"
                tabIndex={0}
                aria-label="Image viewport. Use arrows to change slices, plus and minus to zoom."
                onFocus={onActivate}
                onKeyDown={handleKeyDown}
                onPointerDown={handlePointerDown}
                onPointerMove={(event) => {
                    handlePointerMove(event);
                    updateHoverVoxel(event);
                }}
                onPointerUp={stopWindowDrag}
                onPointerCancel={stopWindowDrag}
                onPointerLeave={() => setHoverVoxel(null)}
                onContextMenu={(event) => event.preventDefault()}
            >
                {volume ? (
                    <canvas ref={canvasRef} style={{ width: placement.width, height: placement.height, left: placement.left, top: placement.top }} />
                ) : (
                    <div className="emptyViewport">
                        <strong>{compareRole === "Difference" ? "Difference unavailable" : "No image selected"}</strong>
                        <span>{compareRole === "Difference" ? "Select two different cases with matching in-plane dimensions." : "Open DICOM, NIfTI or NPY files, then select a volume."}</span>
                        {!compareRole && <button type="button" onClick={onOpenFiles}><FolderOpen size={16} /> Open images</button>}
                    </div>
                )}
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
                                }}
                            />
                            <span>{state.clipMin.toFixed(1)}</span>
                        </div>
                    )}
            </div>

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
        </section>
    );
}
