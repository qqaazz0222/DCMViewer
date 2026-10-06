import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
export const MAX_BATCH_FILES = 8;
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;

// Only compress when the sample and the full result save at least 5%.
// Level 1 limits server CPU cost; already-gzipped NIfTI is sent unchanged.
export async function encodeFile(bytes: Uint8Array, name: string, compress: boolean) {
    let payload = bytes;
    let encoding: 'identity' | 'gzip' = 'identity';
    if (compress && bytes.byteLength >= 4096 && !name.toLowerCase().endsWith('.gz')) {
        const sample = bytes.subarray(0, 64 * 1024);
        const compressedSample = await gzipAsync(sample, { level: 1 });
        if (compressedSample.byteLength < sample.byteLength * 0.95) {
            const compressed = sample.byteLength === bytes.byteLength
                ? compressedSample : await gzipAsync(bytes, { level: 1 });
            if (compressed.byteLength < bytes.byteLength * 0.95) {
                payload = compressed;
                encoding = 'gzip';
            }
        }
    }
    // Use an exact ArrayBuffer, never Buffer's pooled backing allocation.
    const data = payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength
        ? payload.buffer : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    return { encoding, bytes: data, originalSize: bytes.byteLength };
}
