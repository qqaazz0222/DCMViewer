// Best-effort local cache. Quota, disabled storage and private mode never block viewing.
const BUDGET = 256 * 1024 * 1024;
type Entry = { key: string; size: number; touched: number };
let database: Promise<IDBDatabase | undefined> | undefined;
function open() {
    if (!database) database = new Promise(resolve => {
        if (typeof indexedDB === 'undefined') { resolve(undefined); return; }
        const request = indexedDB.open('dcmviewer-slices-v1', 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore('pixels');
            const store = request.result.createObjectStore('slices', { keyPath: 'key' });
            store.createIndex('touched', 'touched');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
        request.onblocked = () => resolve(undefined);
    });
    return database;
}
export async function getCachedSlice(key: string): Promise<Uint8Array | undefined> {
    try {
        const db = await open();
        if (!db) return;
        return await new Promise(resolve => {
            const tx = db.transaction(['slices', 'pixels'], 'readwrite');
            const store = tx.objectStore('slices');
            const request = store.get(key);
            let entry: Entry | undefined;
            let bytes: ArrayBuffer | undefined;
            request.onsuccess = () => {
                entry = request.result;
                if (entry) {
                    store.put({ ...entry, touched: Date.now() });
                    const pixels = tx.objectStore('pixels').get(key);
                    pixels.onsuccess = () => { bytes = pixels.result; };
                }
            };
            tx.oncomplete = () => resolve(bytes ? new Uint8Array(bytes) : undefined);
            tx.onerror = tx.onabort = () => resolve(undefined);
        });
    } catch { return undefined; }
}
export async function putCachedSlice(key: string, bytes: Uint8Array) {
    if (bytes.byteLength > BUDGET) return;
    try {
        const db = await open();
        if (!db) return;
        await new Promise<void>(resolve => {
            const tx = db.transaction(['slices', 'pixels'], 'readwrite');
            const store = tx.objectStore('slices');
            // Metadata only: never load all cached pixel buffers to enforce LRU.
            let total = bytes.byteLength;
            const entries: Array<{ key: IDBValidKey; size: number }> = [];
            const cursor = store.index('touched').openCursor();
            cursor.onsuccess = () => {
                const item = cursor.result;
                if (item) {
                    const entry = item.value as Entry;
                    if (entry.key !== key) { total += entry.size; entries.push({ key: entry.key, size: entry.size }); }
                    item.continue();
                } else {
                    for (const entry of entries) {
                        if (total <= BUDGET) break;
                        store.delete(entry.key); tx.objectStore('pixels').delete(entry.key); total -= entry.size;
                    }
                    tx.objectStore('pixels').put(bytes.slice().buffer, key);
                    store.put({ key, size: bytes.byteLength, touched: Date.now() });
                }
            };
            tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
        });
    } catch { /* Storage unavailable; keep the in-memory plane. */ }
}
export async function clearSliceCache() {
    const db = await open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['slices', 'pixels'], 'readwrite');
        tx.objectStore('slices').clear();
        tx.objectStore('pixels').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error('Could not clear local cache.'));
    });
}
