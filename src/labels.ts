import type { Volume } from './types';

const palette: Array<[number, number, number]> = [
    [255, 80, 80], [80, 220, 120], [80, 160, 255], [255, 210, 60],
    [200, 100, 255], [50, 220, 220], [255, 140, 50], [255, 100, 190],
];

export function labelColor(value: number): [number, number, number] {
    return palette[(value - 1) % palette.length];
}

export function validateLabelVolume(label: Volume, image: Volume): number[] {
    if (label.dimensions.some((size, index) => size !== image.dimensions[index])) {
        throw new Error(`Label dimensions (${label.dimensions.join(' × ')}) must match the image (${image.dimensions.join(' × ')}). Use a label on the same voxel grid.`);
    }
    if (label.data.length !== image.data.length) throw new Error('Label voxel count must match the image.');
    const classes = new Set<number>();
    for (const value of label.data) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error('Labels must contain non-negative integer class IDs (0 = background).');
        }
        if (value > 0) classes.add(value);
    }
    return [...classes].sort((a, b) => a - b);
}
