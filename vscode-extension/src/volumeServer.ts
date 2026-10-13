import { createHash, randomBytes } from 'node:crypto';
import { loadMedicalFiles } from '../../src/loaders/medicalLoader';
import type { Axis, MedicalFile, RemoteVolumeDescriptor, Volume } from '../../src/types';

const BUDGET = 512 * 1024 * 1024;
// Per-panel snapshots: no voxel data is sent by prepare(). Released on disposal.
export class VolumeServer {
    private entries = new Map<string, Volume>();
    private groups = new Map<string, { volumes: RemoteVolumeDescriptor[]; errors: string[] }>();
    private used = 0;
    clear() { this.entries.clear(); this.groups.clear(); this.used = 0; }
    async prepare(files: MedicalFile[], versions: Array<{ path: string; size: number; mtime: number }>) {
        const version = createHash('sha256').update(JSON.stringify(['slices-v1', versions])).digest('hex');
        const existing = this.groups.get(version);
        if (existing) return existing;
        const result = await loadMedicalFiles(files);
        const bytes = result.volumes.reduce((n, volume) => n + volume.data.byteLength, 0);
        if (this.used + bytes > BUDGET) throw new Error('Remote volume memory limit (512 MiB) reached. Close this viewer or disable streamRemoteVolumes to load larger volumes.');
        const volumes = result.volumes.map(volume => {
            const token = randomBytes(16).toString('hex');
            this.entries.set(token, volume);
            const { data, ...metadata } = volume;
            // Validate once on the server; masks need no full-volume download.
            const classes = new Set<number>();
            let labelError: string | undefined;
            for (const value of data) {
                if (!Number.isSafeInteger(value) || value < 0) { labelError = 'Labels must contain non-negative integer class IDs (0 = background).'; break; }
                if (value > 0) classes.add(value);
                if (classes.size > 4096) { labelError = 'Label contains more than 4096 classes.'; break; }
            }
            return { ...metadata, token, version, labelClasses: labelError ? undefined : [...classes].sort((a, b) => a - b), labelError };
        });
        this.used += bytes;
        const prepared = { volumes, errors: result.errors };
        this.groups.set(version, prepared);
        return prepared;
    }
    slice(token: string, axis: Axis, slice: number) {
        const volume = this.entries.get(token);
        if (!volume) throw new Error('Remote volume expired. Reopen the file.');
        if (!['axial', 'coronal', 'sagittal'].includes(axis)) throw new Error('Invalid slice axis.');
        const [w, h, d] = volume.dimensions;
        const count = axis === 'axial' ? d : axis === 'coronal' ? h : w;
        if (!Number.isSafeInteger(slice) || slice < 0 || slice >= count) throw new Error('Slice is out of bounds.');
        const width = axis === 'sagittal' ? h : w;
        const height = axis === 'axial' ? h : d;
        const pixels = new Float32Array(width * height);
        // Plane rows use increasing voxel coordinates. Rendering handles flips.
        for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
            const x = axis === 'sagittal' ? slice : col;
            const y = axis === 'axial' ? row : axis === 'coronal' ? slice : col;
            const z = axis === 'axial' ? slice : row;
            pixels[row * width + col] = volume.data[z * w * h + y * w + x];
        }
        return new Uint8Array(pixels.buffer);
    }
}
