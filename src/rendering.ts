import type { Axis, Volume } from "./types";

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

export function renderSliceToCanvas(
    canvas: HTMLCanvasElement,
    volume: Volume,
    axis: Axis,
    slice: number,
    windowCenter: number,
    windowWidth: number,
) {
    const size = getSliceSize(volume, axis);
    const context = canvas.getContext("2d");

    if (!context) return;

    canvas.width = size.width;
    canvas.height = size.height;

    const imageData = context.createImageData(size.width, size.height);
    const low = windowCenter - windowWidth / 2;
    const high = windowCenter + windowWidth / 2;
    const safeWindowWidth = Math.max(high - low, 1);
    const scale = 255 / safeWindowWidth;
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
            const clippedValue = Math.min(Math.max(value, low), high);
            const intensity = Math.round((clippedValue - low) * scale);
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

            writePixel(imageData, pixelIndex, intensity, intensity, intensity);
        }
    }

    context.putImageData(imageData, 0, 0);
}
