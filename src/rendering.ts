import { labelColor } from "./labels";
import { colorFromMap } from "./colormaps";
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

function writePixel(
    imageData: ImageData,
    pixelIndex: number,
    red: number,
    green: number,
    blue: number,
) {
    imageData.data[pixelIndex] = red;
    imageData.data[pixelIndex + 1] = green;
    imageData.data[pixelIndex + 2] = blue;
    imageData.data[pixelIndex + 3] = 255;
}

function writeDifferencePixel(
    imageData: ImageData,
    pixelIndex: number,
    value: number,
    maxAbsDifference: number,
) {
    const magnitude = Math.min(Math.abs(value) / maxAbsDifference, 1);
    const channelFloor = Math.round(255 * (1 - magnitude));

    if (value > 0) {
        writePixel(imageData, pixelIndex, 255, channelFloor, channelFloor);
        return;
    }

    if (value < 0) {
        writePixel(imageData, pixelIndex, channelFloor, channelFloor, 255);
        return;
    }

    writePixel(imageData, pixelIndex, 255, 255, 255);
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
    const maxAbsDifference = Math.max(
        Math.abs(volume.min),
        Math.abs(volume.max),
        1,
    );

    const hiddenClasses = new Set(overlay?.hiddenClasses);
    const overlayAt = (column: number, row: number) => {
        if (!overlay || column < 0 || row < 0 || column >= size.width || row >= size.height) return 0;
        const voxel = slicePixelToVoxel(volume, axis, slice, column, row,
            visualization.flipHorizontal, visualization.flipVertical);
        return getVoxel(overlay.volume, voxel.x, voxel.y, voxel.z);
    };
    for (let row = 0; row < size.height; row += 1) {
        for (let column = 0; column < size.width; column += 1) {
            const voxel = slicePixelToVoxel(volume, axis, slice, column, row,
                visualization.flipHorizontal, visualization.flipVertical);
            const value = getVoxel(volume, voxel.x, voxel.y, voxel.z);
            const clippedValue = Math.min(Math.max(value, rangeLow), rangeHigh);
            const normalized = (clippedValue - rangeLow) / safeRange;
            const pixelIndex = (row * size.width + column) * 4;

            if (volume.renderMode === "difference") {
                writeDifferencePixel(
                    imageData,
                    pixelIndex,
                    value,
                    maxAbsDifference,
                );
            } else {
                const pixel = colorFromMap(visualization.colorMap, visualization.invertColors ? 1 - normalized : normalized);
                writePixel(
                    imageData,
                    pixelIndex,
                    pixel[0],
                    pixel[1],
                    pixel[2],
                );
            }
            if (overlay) {
                const label = getVoxel(overlay.volume, voxel.x, voxel.y, voxel.z);
                const border = overlay.mode !== "outline" ||
                    overlayAt(column - 1, row) !== label || overlayAt(column + 1, row) !== label ||
                    overlayAt(column, row - 1) !== label || overlayAt(column, row + 1) !== label;
                if (Number.isSafeInteger(label) && label > 0 && !hiddenClasses.has(label) && border) {
                    const color = labelColor(label);
                    const opacity = Math.min(Math.max(overlay.opacity, 0), 1);
                    for (let channel = 0; channel < 3; channel++) {
                        imageData.data[pixelIndex + channel] = Math.round(
                            imageData.data[pixelIndex + channel] * (1 - opacity) + color[channel] * opacity,
                        );
                    }
                }
            }
        }
    }

    context.putImageData(imageData, 0, 0);
}
