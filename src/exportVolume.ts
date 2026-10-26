import type { Volume } from "./types";

// Every voxel in memory; streamed volumes are gathered one axial plane at a time.
async function volumeVoxels(volume: Volume) {
    const remote = volume.remote;
    if (!remote) return volume.data;
    const [width, height, depth] = volume.dimensions;
    const data = new Float32Array(width * height * depth);
    for (let z = 0; z < depth; z += 1) {
        const read = (await remote.ensureSlice("axial", z)) || remote.getVoxel;
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) data[(z * height + y) * width + x] = read(x, y, z);
        }
    }
    return data;
}

// Float32 C-order (depth, height, width) NPY, the layout loadNpyVolume reads back.
export async function volumeToNpy(volume: Volume) {
    const [width, height, depth] = volume.dimensions;
    const data = await volumeVoxels(volume);
    const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${depth}, ${height}, ${width}), }`;
    const text = header + " ".repeat((64 - ((10 + header.length + 1) % 64)) % 64) + "\n";
    const prefix = new Uint8Array(10);
    prefix.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
    new DataView(prefix.buffer).setUint16(8, text.length, true);
    // ponytail: assumes a little-endian host, true for every supported platform.
    return new Blob([prefix, text, data], { type: "application/octet-stream" });
}
