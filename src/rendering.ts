import type { Axis, VisualizationColorMap, Volume } from "./types";

export type RenderVisualizationOptions = {
    colorMap: VisualizationColorMap;
    clipMin: number;
    clipMax: number;
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
    return volume.data[z * width * height + y * width + x];
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

function lerp(left: number, right: number, ratio: number) {
    return Math.round(left + (right - left) * ratio);
}

function colorFromMap(colorMap: VisualizationColorMap, value: number) {
    const t = Math.min(Math.max(value, 0), 1);

    if (colorMap === "grayscale") {
        const intensity = Math.round(t * 255);
        return { red: intensity, green: intensity, blue: intensity };
    }

    if (colorMap === "hot") {
        if (t < 1 / 3) {
            return {
                red: Math.round((t / (1 / 3)) * 255),
                green: 0,
                blue: 0,
            };
        }

        if (t < 2 / 3) {
            return {
                red: 255,
                green: Math.round(((t - 1 / 3) / (1 / 3)) * 255),
                blue: 0,
            };
        }

        return {
            red: 255,
            green: 255,
            blue: Math.round(((t - 2 / 3) / (1 / 3)) * 255),
        };
    }

    if (colorMap === "viridis") {
        const anchors = [
            { t: 0, rgb: [68, 1, 84] },
            { t: 0.25, rgb: [59, 82, 139] },
            { t: 0.5, rgb: [33, 145, 140] },
            { t: 0.75, rgb: [94, 201, 98] },
            { t: 1, rgb: [253, 231, 37] },
        ];
        const nextIndex = anchors.findIndex((anchor) => anchor.t >= t);

        if (nextIndex <= 0) {
            const [red, green, blue] = anchors[0].rgb;
            return { red, green, blue };
        }

        const left = anchors[nextIndex - 1];
        const right = anchors[nextIndex] ?? anchors[anchors.length - 1];
        const ratio =
            right.t === left.t ? 0 : (t - left.t) / (right.t - left.t);

        return {
            red: lerp(left.rgb[0], right.rgb[0], ratio),
            green: lerp(left.rgb[1], right.rgb[1], ratio),
            blue: lerp(left.rgb[2], right.rgb[2], ratio),
        };
    }

    if (t < 0.25) {
        const ratio = t / 0.25;
        return { red: 0, green: lerp(0, 255, ratio), blue: 255 };
    }

    if (t < 0.5) {
        const ratio = (t - 0.25) / 0.25;
        return { red: 0, green: 255, blue: lerp(255, 0, ratio) };
    }

    if (t < 0.75) {
        const ratio = (t - 0.5) / 0.25;
        return { red: lerp(0, 255, ratio), green: 255, blue: 0 };
    }

    const ratio = (t - 0.75) / 0.25;
    return { red: 255, green: lerp(255, 0, ratio), blue: 0 };
}

export function renderSliceToCanvas(
    canvas: HTMLCanvasElement,
    volume: Volume,
    axis: Axis,
    slice: number,
    windowCenter: number,
    windowWidth: number,
    visualization: RenderVisualizationOptions,
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

    for (let row = 0; row < size.height; row += 1) {
        for (let column = 0; column < size.width; column += 1) {
            const depthRow = volume.dimensions[2] - 1 - row;
            const value =
                axis === "axial"
                    ? getVoxel(volume, column, row, slice)
                    : axis === "coronal"
                      ? getVoxel(volume, column, slice, depthRow)
                      : getVoxel(volume, slice, column, depthRow);
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
                continue;
            }

            const pixel = colorFromMap(visualization.colorMap, normalized);
            writePixel(
                imageData,
                pixelIndex,
                pixel.red,
                pixel.green,
                pixel.blue,
            );
        }
    }

    context.putImageData(imageData, 0, 0);
}
