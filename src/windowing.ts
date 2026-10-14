import { getSliceCount, getSliceSize, getVoxel, slicePixelToVoxel } from './rendering';
import type { Axis, Volume, VoxelReader } from './types';

export const DEFAULT_WINDOW_CENTER = 40;
export const DEFAULT_WINDOW_WIDTH = 400;

// A bounded sample keeps auto-windowing inexpensive even for very large planes.
export function computeSliceWindow(volume: Volume, axis: Axis, slice: number, reader?: VoxelReader) {
    const { width, height } = getSliceSize(volume, axis);
    const boundedSlice = Math.min(Math.max(slice, 0), getSliceCount(volume, axis) - 1);
    const step = Math.max(1, Math.ceil(width * height / 65536));
    const values: number[] = [];
    for (let index = 0; index < width * height; index += step) {
        const voxel = slicePixelToVoxel(volume, axis, boundedSlice, index % width, Math.floor(index / width));
        const value = reader ? reader(voxel.x, voxel.y, voxel.z) : getVoxel(volume, voxel.x, voxel.y, voxel.z);
        if (Number.isFinite(value)) values.push(value);
    }
    if (!values.length) throw new Error('This slice has no finite values to window.');
    values.sort((a, b) => a - b);
    let low = values[Math.floor((values.length - 1) * 0.02)];
    let high = values[Math.ceil((values.length - 1) * 0.98)];
    if (high === low) { low = values[0]; high = values[values.length - 1]; }
    return { windowCenter: (low + high) / 2, windowWidth: Math.max(high - low, 1) };
}
