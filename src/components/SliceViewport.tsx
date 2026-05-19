import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import { Link2, Unlink2 } from "lucide-react";
import type { Axis, ViewportState, Volume } from "../types";
import { getSliceCount, renderSliceToCanvas } from "../rendering";
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
        );
    }, [
        boundedSlice,
        state.axis,
        state.windowCenter,
        state.windowWidth,
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
                        });
                    }}
                >
                    <option value="">No volume</option>
                    {volumes.map((item) => (
                        <option key={item.id} value={item.id}>
                            {item.name}
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
                onPointerMove={handlePointerMove}
                onPointerUp={stopWindowDrag}
                onPointerCancel={stopWindowDrag}
                onContextMenu={(event) => event.preventDefault()}
            >
                {volume ? (
                    <canvas ref={canvasRef} />
                ) : (
                    <div className="emptyViewport">Select a volume</div>
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
