const { encodeFile } = require('../out/transfer');
const { gzipSync, gunzipSync } = require('node:zlib');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
(async () => {
    // Synthetic 16-bit volume: spatial structure plus deterministic pixel noise.
    const data = Buffer.alloc(256 * 256 * 128 * 2);
    let seed = 12345;
    for (let index = 0; index < data.length / 2; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const x = index % 256 - 128, y = Math.floor(index / 256) % 256 - 128;
        const z = Math.floor(index / 65536);
        const value = Math.round((x * x + y * y) / 32) + z * 3 + (seed >>> 24) % 32;
        data.writeUInt16LE(value, index * 2);
    }
    const rows = [];
    for (const [name, original] of [['synthetic.npy', data], ['synthetic.nii.gz', gzipSync(data)]]) {
        const start = performance.now();
        const result = await encodeFile(original, name, true);
        const elapsed = performance.now() - start;
        const restored = result.encoding === 'gzip' ? gunzipSync(Buffer.from(result.bytes)) : Buffer.from(result.bytes);
        assert.deepEqual(restored, original);
        const oldBytes = 4 * Math.ceil(original.length / 3);
        rows.push({ fixture: name, encoding: result.encoding,
            sourceMiB: +(original.length / 1048576).toFixed(2),
            previousBase64MiB: +(oldBytes / 1048576).toFixed(2),
            optimizedMiB: +(result.bytes.byteLength / 1048576).toFixed(2),
            payloadReductionPercent: +(100 * (1 - result.bytes.byteLength / oldBytes)).toFixed(1),
            serverEncodingMs: +elapsed.toFixed(1) });
    }
    const header = Buffer.from("{'descr': '<u2', 'fortran_order': False, 'shape': (128, 256, 256), }\n");
    const prefix = Buffer.from([147, 78, 85, 77, 80, 89, 1, 0, 0, 0]);
    prefix.writeUInt16LE(header.length, 8);
    const file = { path: 'file:///synthetic/volume.npy', name: 'volume.npy', bytes: Buffer.concat([prefix, header, data]) };
    const { VolumeServer } = require('../out/volumeServer');
    const server = new VolumeServer();
    const started = performance.now();
    const result = await server.prepare([file], [{ path: file.path, size: file.bytes.length, mtime: 1 }]);
    const preparedMs = performance.now() - started;
    assert.deepEqual(result.errors, []);
    const volume = result.volumes[0];
    const initialSlice = await encodeFile(server.slice(volume.token, 'axial', 64), 'slice.raw', true);
    const whole = await encodeFile(file.bytes, file.name, true);
    const metadataBytes = Buffer.byteLength(JSON.stringify(result));
    const coldBytes = metadataBytes + initialSlice.bytes.byteLength;
    const slices = { dimensions: volume.dimensions, serverPreparationMs: +preparedMs.toFixed(1),
        wholeFilePayloadBytes: whole.bytes.byteLength, metadataBytes,
        firstSlicePayloadBytes: initialSlice.bytes.byteLength, coldFirstDisplayBytes: coldBytes,
        firstDisplayReductionPercent: +(100 * (1 - coldBytes / whole.bytes.byteLength)).toFixed(1),
        note: 'One axial slice plus metadata; excludes neighboring prefetch and protocol overhead. Server reads and parses the full volume.' };
    console.log(JSON.stringify({ note: 'Synthetic payload comparison, not measured SSH throughput.', files: rows, slices,
        smallFileRequests: { files: 300, previous: 300, optimized: Math.ceil(300 / 8), assumption: 'Each group of eight files fits within 8 MiB.' } }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
