import { getSliceCount, renderSliceToCanvas } from "./rendering";
import { safeFileName, saveBlob } from "./download";
import type { LabelOverlay, ViewportState, Volume } from "./types";

const TARGET_SIDE = 768;
const MAX_SIDE = 4096;

function formatNumber(value: number) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export type ViewportImage = { canvas: HTMLCanvasElement; fileName: string };

// The whole slice at native resolution (no zoom or pan), upscaled so small slices stay legible,
// with patient id, slice index and window printed at the lower left.
export async function renderViewportImage(
    state: ViewportState, volumes: Volume[], overlays: LabelOverlay[],
): Promise<ViewportImage | undefined> {
    const volume = volumes.find(item => item.id === state.volumeId);
    if (!volume) return undefined;
    const sliceCount = getSliceCount(volume, state.axis);
    const slice = Math.min(Math.max(state.slice, 0), sliceCount - 1);
    const label = state.showLabel
        ? overlays.find(item => item.id === state.labelOverlayId && item.targetVolumeId === volume.id)?.volume : undefined;
    // Streamed volumes expose voxels through a per-slice reader.
    const snapshot = async (item: Volume) => {
        if (!item.remote) return item;
        const reader = await item.remote.ensureSlice(state.axis, slice);
        return reader ? { ...item, remote: { ...item.remote, getVoxel: reader } } : item;
    };
    const [image, overlay] = await Promise.all([snapshot(volume), label && snapshot(label)]);

    const source = document.createElement("canvas");
    renderSliceToCanvas(source, image, state.axis, slice, state.windowCenter, state.windowWidth, {
        colorMap: state.colorMap, invertColors: state.invertColors, clipMin: state.clipMin, clipMax: state.clipMax,
        flipHorizontal: state.flipHorizontal, flipVertical: state.flipVertical,
    }, overlay ? { volume: overlay, opacity: state.labelOpacity, mode: state.labelMode, hiddenClasses: state.hiddenLabelClasses } : undefined);

    const scale = Math.max(1, Math.min(Math.round(TARGET_SIDE / Math.max(source.width, source.height)), Math.floor(MAX_SIDE / Math.max(source.width, source.height)) || 1));
    const canvas = document.createElement("canvas");
    canvas.width = source.width * scale;
    canvas.height = source.height * scale;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available.");
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    const axisName = state.axis[0].toUpperCase() + state.axis.slice(1);
    const lines = [
        `ID: ${volume.patientId}`,
        `${axisName} ${slice + 1}/${sliceCount}`,
        volume.renderMode === "difference"
            ? `Range: ${formatNumber(state.clipMin)} to ${formatNumber(state.clipMax)}`
            : `WL ${formatNumber(state.windowCenter)} / WW ${formatNumber(state.windowWidth)}`,
    ];
    const fontSize = Math.max(12, Math.round(Math.min(canvas.width, canvas.height) / 28));
    const pad = Math.round(fontSize / 2);
    context.font = `${fontSize}px system-ui, sans-serif`;
    context.textBaseline = "alphabetic";
    const boxWidth = Math.max(...lines.map(line => context.measureText(line).width)) + pad * 2;
    const boxHeight = lines.length * fontSize * 1.25 + pad;
    context.fillStyle = "rgba(0, 0, 0, 0.55)";
    context.fillRect(0, canvas.height - boxHeight, Math.min(boxWidth, canvas.width), boxHeight);
    context.fillStyle = "#fff";
    lines.forEach((line, index) => context.fillText(line, pad, canvas.height - boxHeight + pad / 2 + fontSize * 1.25 * (index + 0.85)));

    return { canvas, fileName: `${safeFileName(volume.name)}_${state.axis}_${slice + 1}.png` };
}

const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not encode the image.")), "image/png"));

export async function saveCanvas(canvas: HTMLCanvasElement, fileName: string) {
    await saveBlob(await toBlob(canvas), fileName);
}

// Row-major cells of equal size; images are centered, empty cells stay black.
export function composeGrid(images: Array<HTMLCanvasElement | undefined>, columns: number) {
    const present = images.filter((image): image is HTMLCanvasElement => Boolean(image));
    const cellWidth = Math.max(...present.map(image => image.width));
    const cellHeight = Math.max(...present.map(image => image.height));
    const rows = Math.ceil(images.length / columns);
    const grid = document.createElement("canvas");
    grid.width = cellWidth * columns;
    grid.height = cellHeight * rows;
    const context = grid.getContext("2d");
    if (!context) throw new Error("Canvas is not available.");
    context.fillStyle = "#000";
    context.fillRect(0, 0, grid.width, grid.height);
    images.forEach((image, index) => image && context.drawImage(image,
        (index % columns) * cellWidth + (cellWidth - image.width) / 2,
        Math.floor(index / columns) * cellHeight + (cellHeight - image.height) / 2));
    return grid;
}

export async function saveViewportImage(state: ViewportState, volumes: Volume[], overlays: LabelOverlay[]) {
    const image = await renderViewportImage(state, volumes, overlays);
    if (!image) throw new Error("Select a volume before saving an image.");
    await saveCanvas(image.canvas, image.fileName);
}
