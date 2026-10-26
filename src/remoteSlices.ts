import type { Axis, MedicalFileReference, RemoteVolumeDescriptor, Volume, VoxelReader } from './types';
import { clearSliceCache, getCachedSlice, putCachedSlice } from './sliceCache';

const MEMORY_BUDGET = 64 * 1024 * 1024;
const PREFETCH_BUDGET = 16 * 1024 * 1024;
// ponytail: whole-volume download capped here; larger volumes stay on per-slice transfers.
const PRELOAD_BUDGET = 1024 * 1024 * 1024;
const planes = new Map<string, Float32Array>();
let memorySize = 0;
let cacheEpoch = 0;
export async function clearRemoteCache() {
    cacheEpoch++;
    planes.clear(); memorySize = 0;
    await clearSliceCache();
}
function retained(key: string) {
    const plane = planes.get(key);
    if (plane) { planes.delete(key); planes.set(key, plane); }
    return plane;
}
function keep(key: string, plane: Float32Array) {
    const old = planes.get(key);
    if (old) { planes.delete(key); memorySize -= old.byteLength; }
    while (memorySize + plane.byteLength > MEMORY_BUDGET && planes.size) {
        const oldest = planes.keys().next().value!;
        memorySize -= planes.get(oldest)!.byteLength; planes.delete(oldest);
    }
    // A single exceptionally large plane is retained for the active render.
    planes.set(key, plane); memorySize += plane.byteLength;
}
// Two transfers maximum, foreground ahead of speculative requests.
let running = 0;
const queue: Array<{ foreground: boolean; run: () => Promise<void> }> = [];
function schedule<T>(foreground: boolean, work: () => Promise<T>, signal?: AbortSignal) {
    let job: (typeof queue)[number];
    const promise = new Promise<T>((resolve, reject) => {
        job = { foreground, run: async () => {
            try { signal?.throwIfAborted(); resolve(await work()); } catch (error) { reject(error); }
        } };
        queue.push(job);
        pump();
    });
    return { promise, promote: () => { job.foreground = true; pump(); } };
}
function pump() {
    while (running < 2 && queue.length) {
        const priority = queue.findIndex(job => job.foreground);
        const job = queue.splice(priority < 0 ? 0 : priority, 1)[0];
        running++;
        void job.run().finally(() => { running--; pump(); });
    }
}
// Bridges prepare and yield one result per group, in this order; the app lists them as pending.
export function remoteLoadGroups(refs: MedicalFileReference[]) {
    const groups = refs.filter(ref => /\.(nii|nii\.gz|npy|npz)$/i.test(ref.name)).map(ref => [ref]);
    const dicom = refs.filter(ref => !/\.(nii|nii\.gz|npy|npz)$/i.test(ref.name));
    if (dicom.length) groups.push(dicom);
    return groups;
}
export function remoteVolume(
    descriptor: RemoteVolumeDescriptor,
    read: (token: string, axis: Axis, slice: number) => Promise<Uint8Array>,
    persist: boolean,
    options: { prefetchRadius?: number; readVolume?: (token: string) => Promise<ArrayBuffer> } = {},
): Volume {
    const { token, version, ...metadata } = descriptor;
    const [w, h, d] = descriptor.dimensions;
    const prefix = `${version}|${descriptor.id}|`;
    const key = (axis: Axis, slice: number) => `${prefix}${axis}|${slice}`;
    const inflight = new Map<string, ReturnType<typeof schedule<void>>>();
    // Whole volume arrives in one transfer, then serves all three axes locally.
    let full: Float32Array | undefined;
    const fullReader: VoxelReader = (x, y, z) => full![z * w * h + y * w + x];
    if (options.readVolume && w * h * d * 4 <= PRELOAD_BUDGET) {
        // Outside the slice queue: per-slice navigation keeps working while this downloads. Failure keeps per-slice mode.
        void options.readVolume(token).then(buffer => {
            if (buffer.byteLength === w * h * d * 4) full = new Float32Array(buffer);
        }).catch(() => {});
    }
    function planeReader(axis: Axis, ready: Float32Array): VoxelReader {
        return (x, y, z) => axis === "axial" ? ready[y * w + x] : axis === "coronal" ? ready[z * w + x] : ready[z * h + y];
    }
    async function ensure(axis: Axis, slice: number, signal?: AbortSignal, foreground = true): Promise<VoxelReader> {
        signal?.throwIfAborted();
        if (full) return fullReader;
        const id = key(axis, slice);
        let plane = retained(id);
        if (!plane) {
            let work = inflight.get(id);
            if (!work) {
                const epoch = cacheEpoch;
                work = schedule(foreground, async () => {
                    let bytes = persist ? await getCachedSlice(id) : undefined;
                    const count = axis === 'axial' ? w * h : axis === 'coronal' ? w * d : h * d;
                    if (bytes?.byteLength !== count * 4) bytes = undefined;
                    if (!bytes) {
                        bytes = await read(token, axis, slice);
                        if (bytes.byteLength !== count * 4) throw new Error('Incomplete remote slice.');
                        if (persist && epoch === cacheEpoch) void putCachedSlice(id, bytes);
                    }
                    keep(id, new Float32Array(bytes.slice().buffer));
                }, signal);
                inflight.set(id, work);
                void work.promise.finally(() => { if (inflight.get(id) === work) inflight.delete(id); }).catch(() => {});
            }
            if (foreground) work.promote();
            try { await work.promise; }
            catch (error) {
                if (!signal?.aborted && error instanceof DOMException && error.name === 'AbortError') return ensure(axis, slice, signal, foreground);
                throw error;
            }
            signal?.throwIfAborted();
            if (full) return fullReader;
            plane = retained(id);
            if (!plane) return ensure(axis, slice, signal, foreground);
        }
        return planeReader(axis, plane);
    }
    return { ...metadata, data: new Float32Array(0), remote: {
        version,
        token,
        ensureSlice: ensure,
        peekSlice: (axis, slice) => {
            if (full) return fullReader;
            const plane = retained(key(axis, slice));
            return plane && planeReader(axis, plane);
        },
        getVoxel: (x, y, z) => {
            if (full) return fullReader(x, y, z);
            const axial = planes.get(key('axial', z));
            if (axial) return axial[y * w + x];
            const coronal = planes.get(key('coronal', y));
            if (coronal) return coronal[z * w + x];
            const sagittal = planes.get(key('sagittal', x));
            if (sagittal) return sagittal[z * h + y];
            return NaN;
        },
        prefetch: (axis, slice, signal) => {
            const count = axis === 'axial' ? d : axis === 'coronal' ? h : w;
            const planeBytes = (axis === 'axial' ? w * h : axis === 'coronal' ? w * d : h * d) * 4;
            const radius = Math.max(0, Math.min(8, Math.floor(options.prefetchRadius ?? 1), Math.floor(PREFETCH_BUDGET / (2 * planeBytes))));
            const epoch = cacheEpoch;
            // Fetch equally near neighbors together before moving farther away.
            void (async () => {
                for (let distance = 1; distance <= radius; distance++) {
                    if (signal.aborted || epoch !== cacheEpoch) return;
                    const neighbors = [slice + distance, slice - distance].filter(next => next >= 0 && next < count);
                    const results = await Promise.allSettled(neighbors.map(next => ensure(axis, next, signal, false)));
                    if (results.some(result => result.status === 'rejected')) return;
                }
            })();
        },
    } };
}
