import type { MedicalFile, MedicalFileReadResult, MedicalFileReference } from './types';

type VsCodeApi = { postMessage(message: unknown): void };
declare const acquireVsCodeApi: undefined | (() => VsCodeApi);
type WireFile = {
    path: string; name: string; bytes?: ArrayBuffer | Uint8Array;
    encoding?: 'identity' | 'gzip'; originalSize?: number; mtime?: number;
    error?: string;
};
const MAX_BATCH_FILES = 8;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;

if (typeof acquireVsCodeApi === 'function') {
    const api = acquireVsCodeApi();
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const references = new Map<string, MedicalFileReference>();
    const cache = new Map<string, MedicalFile>();
    let cacheSize = 0;
    const versionKey = (ref: MedicalFileReference) => `${ref.path}|${ref.mtime}|${ref.size}`;

    function request<T>(method: string, args: { path?: string; paths?: string[] } = {}): Promise<T> {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve: value => resolve(value as T), reject });
            api.postMessage({ id, method, ...args });
        });
    }
    window.addEventListener('message', (event: MessageEvent) => {
        const message = event.data;
        if (!message || !Number.isSafeInteger(message.id)) return;
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        if (typeof message.error === 'string') call.reject(new Error(message.error));
        else call.resolve(message.result);
    });
    window.addEventListener('pagehide', () => {
        for (const call of pending.values()) call.reject(new Error('Viewer closed.'));
        pending.clear(); cache.clear(); references.clear(); cacheSize = 0;
    });

    function remember(refs: MedicalFileReference[]) {
        for (const ref of refs) {
            const previous = references.get(ref.path);
            if (previous && versionKey(previous) !== versionKey(ref)) {
                const key = versionKey(previous);
                const stale = cache.get(key);
                if (stale) { cacheSize -= stale.bytes.byteLength; cache.delete(key); }
            }
            references.set(ref.path, ref);
        }
        return refs;
    }
    function cached(ref: MedicalFileReference) {
        if (ref.mtime === undefined) return;
        const key = versionKey(ref), file = cache.get(key);
        if (file) { cache.delete(key); cache.set(key, file); }
        return file;
    }
    function store(ref: MedicalFileReference, file: MedicalFile, wire: WireFile) {
        if (ref.mtime === undefined || wire.mtime !== ref.mtime || file.bytes.byteLength !== ref.size || file.bytes.byteLength > CACHE_BYTES) return;
        const key = versionKey(ref);
        const previous = cache.get(key);
        if (previous) { cacheSize -= previous.bytes.byteLength; cache.delete(key); }
        while (cacheSize + file.bytes.byteLength > CACHE_BYTES && cache.size) {
            const oldest = cache.keys().next().value!;
            cacheSize -= cache.get(oldest)!.bytes.byteLength;
            cache.delete(oldest);
        }
        cache.set(key, file); cacheSize += file.bytes.byteLength;
    }
    async function decode(wire: WireFile): Promise<MedicalFile> {
        if (wire.error) throw new Error(wire.error);
        if (!wire.bytes) throw new Error('Missing file bytes. Update DCMViewer on the remote host and reload the window.');
        let bytes = wire.bytes instanceof Uint8Array ? wire.bytes : new Uint8Array(wire.bytes);
        if (wire.encoding === 'gzip') {
            // Native decompression is asynchronous and restores the exact source bytes.
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
            bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        } else if (wire.encoding && wire.encoding !== 'identity') throw new Error('Unsupported file encoding.');
        if (wire.originalSize !== undefined && wire.originalSize !== bytes.byteLength) throw new Error('Incomplete file transfer. Select the file again.');
        return { path: wire.path, name: wire.name, bytes };
    }
    async function* readMedicalFiles(refs: MedicalFileReference[]): AsyncGenerator<MedicalFileReadResult> {
        remember(refs);
        for (let index = 0; index < refs.length;) {
            const batch: MedicalFileReference[] = [];
            let size = 0;
            while (index < refs.length && batch.length < MAX_BATCH_FILES) {
                const ref = refs[index];
                if (batch.length && size + ref.size > MAX_BATCH_BYTES) break;
                batch.push(ref); size += ref.size; index++;
                if (size >= MAX_BATCH_BYTES) break; // Large standalone volumes travel alone.
            }
            // Pin cache hits for this batch; inserting new files may evict them.
            const hits = new Map<string, MedicalFile>();
            for (const ref of batch) { const file = cached(ref); if (file) hits.set(ref.path, file); }
            const missing = batch.filter(ref => !hits.has(ref.path));
            let received = new Map<string, WireFile>();
            let batchError: string | undefined;
            if (missing.length) {
                try {
                    const files = await request<WireFile[]>('readFiles', { paths: missing.map(ref => ref.path) });
                    received = new Map(files.map(file => [file.path, file]));
                } catch (error) { batchError = error instanceof Error ? error.message : String(error); }
            }
            for (const reference of batch) {
                try {
                    let file = hits.get(reference.path);
                    if (!file) {
                        if (batchError) throw new Error(batchError);
                        const wire = received.get(reference.path);
                        if (!wire) throw new Error('File missing from transfer response.');
                        file = await decode(wire);
                        store(reference, file, wire);
                    }
                    yield { reference, file };
                } catch (error) {
                    yield { reference, error: error instanceof Error ? error.message : String(error) };
                }
            }
        }
    }
    window.dcmViewer = {
        getInitialFiles: async () => remember(await request<MedicalFileReference[]>('initialFiles')),
        openMedicalFiles: async () => remember(await request<MedicalFileReference[]>('openFiles')),
        readMedicalFiles,
        readMedicalFile: async path => {
            const ref = references.get(path);
            if (ref) {
                for await (const result of readMedicalFiles([ref])) {
                    if (result.file) return result.file;
                    throw new Error(result.error);
                }
            }
            return decode(await request<WireFile>('readFile', { path }));
        },
    };
}
