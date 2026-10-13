import type { Axis, RemoteVolumeDescriptor, Volume, VoxelReader } from './types';
import { clearSliceCache, getCachedSlice, putCachedSlice } from './sliceCache';

const MEMORY_BUDGET = 64 * 1024 * 1024;
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
    return new Promise<T>((resolve, reject) => {
        queue.push({ foreground, run: async () => {
            try { signal?.throwIfAborted(); resolve(await work()); } catch (error) { reject(error); }
        } });
        pump();
    });
}
function pump() {
    while (running < 2 && queue.length) {
        const priority = queue.findIndex(job => job.foreground);
        const job = queue.splice(priority < 0 ? 0 : priority, 1)[0];
        running++;
        void job.run().finally(() => { running--; pump(); });
    }
}
export function remoteVolume(
    descriptor: RemoteVolumeDescriptor,
    read: (token: string, axis: Axis, slice: number) => Promise<Uint8Array>,
    persist: boolean,
): Volume {
    const { token, version, ...metadata } = descriptor;
    const [w, h, d] = descriptor.dimensions;
    const prefix = `${version}|${descriptor.id}|`;
    const key = (axis: Axis, slice: number) => `${prefix}${axis}|${slice}`;
    const inflight = new Map<string, Promise<void>>();
    async function ensure(axis: Axis, slice: number, signal?: AbortSignal, foreground = true): Promise<VoxelReader> {
        signal?.throwIfAborted();
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
                void work.finally(() => { if (inflight.get(id) === work) inflight.delete(id); }).catch(() => {});
            }
            try { await work; }
            catch (error) {
                if (!signal?.aborted && error instanceof DOMException && error.name === 'AbortError') return ensure(axis, slice, signal, foreground);
                throw error;
            }
            signal?.throwIfAborted();
            plane = retained(id);
            if (!plane) return ensure(axis, slice, signal, foreground);
        }
        const ready = plane;
        return (x, y, z) => axis === "axial" ? ready[y * w + x] : axis === "coronal" ? ready[z * w + x] : ready[z * h + y];
    }
    return { ...metadata, data: new Float32Array(0), remote: {
        version,
        ensureSlice: ensure,
        getVoxel: (x, y, z) => {
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
            // Start after interaction settles. At most two neighboring planes.
            void (async () => {
                for (const next of [slice + 1, slice - 1]) {
                    if (signal.aborted) return;
                    if (next >= 0 && next < count) {
                        try { await ensure(axis, next, signal, false); } catch { return; }
                    }
                }
            })();
        },
    } };
}
