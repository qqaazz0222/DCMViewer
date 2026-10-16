import { labelColor } from "./labels";
import { COLOR_MAPS, colorFromMap } from "./colormaps";
import type { Axis, VisualizationColorMap, Volume } from "./types";

export type RenderVisualizationOptions = {
    colorMap: VisualizationColorMap;
    clipMin: number;
    clipMax: number;
    invertColors?: boolean;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
};

export function getSliceCount(volume: Volume, axis: Axis) {
    const [width, height, depth] = volume.dimensions;
    if (axis === "axial") return depth;
    if (axis === "coronal") return height;
    return width;
}

export function getSliceSize(volume: Volume, axis: Axis) {
    const [width, height, depth] = volume.dimensions;
    if (axis === "axial") return { width, height };
    if (axis === "coronal") return { width, height: depth };
    return { width: height, height: depth };
}

export function getVoxel(volume: Volume, x: number, y: number, z: number) {
    const [width, height] = volume.dimensions;
    if (volume.remote) return volume.remote.getVoxel(x, y, z);
    return volume.data[z * width * height + y * width + x];
}

// One screen-to-voxel mapping drives image pixels, label pixels and hover values.
export function slicePixelToVoxel(
    volume: Volume, axis: Axis, slice: number, column: number, row: number,
    flipHorizontal = false, flipVertical = false,
) {
    const size = getSliceSize(volume, axis);
    const x = flipHorizontal ? size.width - 1 - column : column;
    const y = flipVertical ? size.height - 1 - row : row;
    const z = volume.dimensions[2] - 1 - y;
    return axis === "axial" ? { x, y, z: slice }
        : axis === "coronal" ? { x, y: slice, z }
        : { x: slice, y: x, z };
}

const DIVERGING_MAPS = new Set<VisualizationColorMap>(COLOR_MAPS.filter(map => map.group === "Diverging").map(map => map.id));

// Colormap position of a difference value: Min/Max clip it, diverging maps keep zero at their center color.
export function differenceColorPosition(value: number, clipLow: number, clipHigh: number, map: VisualizationColorMap) {
    const clipped = Math.min(Math.max(value, clipLow), clipHigh);
    const t = DIVERGING_MAPS.has(map)
        ? 0.5 + clipped / (2 * (Math.max(Math.abs(clipLow), Math.abs(clipHigh)) || 1))
        : (clipped - clipLow) / (clipHigh - clipLow || 1);
    return Number.isNaN(t) ? (DIVERGING_MAPS.has(map) ? 0.5 : 0) : t;
}

// Every voxel value of one slice, row by row (flips do not change the distribution).
export function sliceValues(volume: Volume, axis: Axis, slice: number) {
    const { width, height } = getSliceSize(volume, axis);
    const values = new Float32Array(width * height);
    for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
            const { x, y, z } = slicePixelToVoxel(volume, axis, slice, column, row);
            values[row * width + column] = getVoxel(volume, x, y, z);
        }
    }
    return values;
}

// ponytail: 4096 steps keep LUT colors within one level of colorFromMap.
const LUT_STEPS = 4096;
const colorTables = new Map<VisualizationColorMap, Uint8Array>();
function colorTable(map: VisualizationColorMap) {
    let table = colorTables.get(map);
    if (!table) {
        table = new Uint8Array(LUT_STEPS * 3);
        for (let index = 0; index < LUT_STEPS; index++) table.set(colorFromMap(map, index / (LUT_STEPS - 1)), index * 3);
        colorTables.set(map, table);
    }
    return table;
}

export function renderSliceToCanvas(
    canvas: HTMLCanvasElement,
    volume: Volume,
    axis: Axis,
    slice: number,
    windowCenter: number,
    windowWidth: number,
    visualization: RenderVisualizationOptions,
    overlay?: { volume: Volume; opacity: number; mode?: "fill" | "outline"; hiddenClasses?: readonly number[] },
) {
    const size = getSliceSize(volume, axis);
    const context = canvas.getContext("2d");

    if (!context) return;

    canvas.width = size.width;
    canvas.height = size.height;

    const imageData = context.createImageData(size.width, size.height);
    const low = windowCenter - windowWidth / 2;
    const high = windowCenter + windowWidth / 2;
    const clipLow = Math.min(visualization.clipMin, visualization.clipMax);
    const clipHigh = Math.max(visualization.clipMin, visualization.clipMax);
    const effectiveLow = Math.max(low, clipLow);
    const effectiveHigh = Math.min(high, clipHigh);
    const rangeLow =
        effectiveLow < effectiveHigh ? effectiveLow : Math.min(low, high);
    const rangeHigh =
        effectiveLow < effectiveHigh ? effectiveHigh : Math.max(low, high);
    const safeRange = Math.max(rangeHigh - rangeLow, 1);
    // Difference images ignore WL/WW: Min/Max alone set the color range.
    const difference = volume.renderMode === "difference";

    const hiddenClasses = new Set(overlay?.hiddenClasses);
    const overlayAt = (column: number, row: number) => {
        if (!overlay || column < 0 || row < 0 || column >= size.width || row >= size.height) return 0;
        const voxel = slicePixelToVoxel(volume, axis, slice, column, row,
            visualization.flipHorizontal, visualization.flipVertical);
        return getVoxel(overlay.volume, voxel.x, voxel.y, voxel.z);
    };
    // Hot loop: same mapping as slicePixelToVoxel, without per-pixel allocations.
    const [volumeWidth, volumeHeight, volumeDepth] = volume.dimensions;
    const plane = volumeWidth * volumeHeight;
    const local = volume.remote ? undefined : volume.data;
    const remoteVoxel = volume.remote?.getVoxel;
    const pixels = imageData.data;
    const grayscale = visualization.colorMap === "grayscale";
    const table = colorTable(visualization.colorMap);
    for (let row = 0; row < size.height; row += 1) {
        const y = visualization.flipVertical ? size.height - 1 - row : row;
        for (let column = 0; column < size.width; column += 1) {
            const x = visualization.flipHorizontal ? size.width - 1 - column : column;
            const vx = axis === "sagittal" ? slice : x;
            const vy = axis === "axial" ? y : axis === "coronal" ? slice : x;
            const vz = axis === "axial" ? slice : volumeDepth - 1 - y;
            const value = local ? local[vz * plane + vy * volumeWidth + vx] : remoteVoxel!(vx, vy, vz);
            const pixelIndex = (row * size.width + column) * 4;
            let t: number;
            if (difference) {
                t = differenceColorPosition(value, clipLow, clipHigh, visualization.colorMap);
            } else {
                const clippedValue = Math.min(Math.max(value, rangeLow), rangeHigh);
                const normalized = (clippedValue - rangeLow) / safeRange;
                t = Number.isNaN(normalized) ? 0 : visualization.invertColors ? 1 - normalized : normalized;
            }

            if (grayscale) {
                const level = Math.round(t * 255);
                pixels[pixelIndex] = level; pixels[pixelIndex + 1] = level; pixels[pixelIndex + 2] = level; pixels[pixelIndex + 3] = 255;
            } else {
                const entry = Math.round(t * (LUT_STEPS - 1)) * 3;
                pixels[pixelIndex] = table[entry]; pixels[pixelIndex + 1] = table[entry + 1]; pixels[pixelIndex + 2] = table[entry + 2]; pixels[pixelIndex + 3] = 255;
            }
            if (overlay) {
                const label = getVoxel(overlay.volume, vx, vy, vz);
                const border = overlay.mode !== "outline" ||
                    overlayAt(column - 1, row) !== label || overlayAt(column + 1, row) !== label ||
                    overlayAt(column, row - 1) !== label || overlayAt(column, row + 1) !== label;
                if (Number.isSafeInteger(label) && label > 0 && !hiddenClasses.has(label) && border) {
                    const color = labelColor(label);
                    const opacity = Math.min(Math.max(overlay.opacity, 0), 1);
                    for (let channel = 0; channel < 3; channel++) {
                        pixels[pixelIndex + channel] = Math.round(
                            pixels[pixelIndex + channel] * (1 - opacity) + color[channel] * opacity,
                        );
                    }
                }
            }
        }
    }

    context.putImageData(imageData, 0, 0);
}
