import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { Link2, Unlink2 } from "lucide-react";
import type {
    Axis,
    ViewportState,
    VisualizationColorMap,
    Volume,
} from "../types";
import {
    getSliceCount,
    getSliceSize,
    getVoxel,
    renderSliceToCanvas,
} from "../rendering";
import { DEFAULT_WINDOW_CENTER, DEFAULT_WINDOW_WIDTH } from "../windowing";

type Props = {
    state: ViewportState;
    volumes: Volume[];
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
    active,
    linkEnabled,
    onActivate,
    onToggleSingleView,
    onChange,
}: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const windowDragRef = useRef<WindowDragState | null>(null);
    const [hoverVoxel, setHoverVoxel] = useState<HoverVoxel | null>(null);
    const volume = volumes.find((item) => item.id === state.volumeId);
    const sliceCount = volume ? getSliceCount(volume, state.axis) : 1;
    const boundedSlice = Math.min(Math.max(state.slice, 0), sliceCount - 1);

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

            const scale = Math.min(
                stageRect.width / sliceSize.width,
                stageRect.height / sliceSize.height,
            );
            const drawnWidth = sliceSize.width * scale;
            const drawnHeight = sliceSize.height * scale;
            const offsetX = (stageRect.width - drawnWidth) / 2;
            const offsetY = (stageRect.height - drawnHeight) / 2;
            const localX = event.clientX - stageRect.left - offsetX;
            const localY = event.clientY - stageRect.top - offsetY;

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
            const depthRow = volume.dimensions[2] - 1 - sliceY;
            const voxel =
                state.axis === "axial"
                    ? { x: sliceX, y: sliceY, z: boundedSlice }
                    : state.axis === "coronal"
                      ? { x: sliceX, y: boundedSlice, z: depthRow }
                      : { x: boundedSlice, y: sliceX, z: depthRow };

            setHoverVoxel({
                ...voxel,
                value: getVoxel(volume, voxel.x, voxel.y, voxel.z),
            });
        },
        [boundedSlice, state.axis, volume],
    );

    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (!volume || event.button !== 2) return;

        event.preventDefault();
        onActivate();
        event.currentTarget.setPointerCapture(event.pointerId);
        windowDragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            windowCenter: state.windowCenter,
            windowWidth: state.windowWidth,
        };
    };

    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const dragState = windowDragRef.current;
        if (!volume || !dragState || (event.buttons & 2) === 0) return;

        event.preventDefault();
        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;

        onChange({
            ...state,
            windowCenter: dragState.windowCenter - deltaY,
            windowWidth: Math.max(dragState.windowWidth + deltaX, 1),
        });
    };

    const stopWindowDrag = (event: PointerEvent<HTMLDivElement>) => {
        if (!windowDragRef.current) return;

        windowDragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
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
            },
        );
    }, [
        boundedSlice,
        state.axis,
        state.windowCenter,
        state.windowWidth,
        state.colorMap,
        state.clipMin,
        state.clipMax,
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
            changeSlice(boundedSlice + (event.deltaY > 0 ? 1 : -1));
        };

        stage.addEventListener("wheel", handleWheel, { passive: false });
        return () => stage.removeEventListener("wheel", handleWheel);
    }, [boundedSlice, changeSlice, onActivate, volume]);

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
                    value={state.volumeId ?? ""}
                    onChange={(event) => {
                        const nextVolume = volumes.find(
                            (item) => item.id === event.target.value,
                        );
                        onChange({
                            ...state,
                            volumeId: nextVolume?.id,
                            slice: nextVolume
                                ? Math.floor(
                                      getSliceCount(nextVolume, state.axis) / 2,
                                  )
                                : 0,
                            windowCenter: DEFAULT_WINDOW_CENTER,
                            windowWidth: DEFAULT_WINDOW_WIDTH,
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

            <div
                ref={stageRef}
                className="canvasStage"
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
                    <canvas ref={canvasRef} />
                ) : (
                    <div className="emptyViewport">Select a volume</div>
                )}
                {volume && (
                    <div className="voxelInfoPanel" aria-live="polite">
                        <span>X: {hoverVoxel ? hoverVoxel.x : "-"}</span>
                        <span>Y: {hoverVoxel ? hoverVoxel.y : "-"}</span>
                        <span>Z: {hoverVoxel ? hoverVoxel.z : "-"}</span>
                        <span>
                            Value: {formatVoxelValue(hoverVoxel?.value)}
                        </span>
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
