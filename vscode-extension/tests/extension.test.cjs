const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
    class Uri {
        constructor(value) { this.value = value; this.path = new URL(value).pathname; }
        toString() { return this.value; }
        static joinPath(uri, ...parts) { return new Uri(uri.value.replace(/\/$/, '') + '/' + parts.join('/')); }
    }
    const selected = new Uri('vscode-remote://ssh-remote+test/study');
    const fsEntries = new Map([
        [selected.toString(), { type: 2, children: [['b.DCM', 1], ['a.npy', 1], ['nested', 2], ['loop', 66], ['notes.txt', 1]] }],
        [selected + '/b.DCM', { type: 1, bytes: Buffer.from([0, 255, 128]) }],
        [selected + '/a.npy', { type: 1, bytes: Buffer.from('NPY') }],
        [selected + '/nested', { type: 2, children: [['image.nii.gz', 1]] }],
        [selected + '/nested/image.nii.gz', { type: 1, bytes: Buffer.from('NII') }],
        [selected + '/notes.txt', { type: 1, bytes: Buffer.from('ignored') }],
    ]);
    const commands = new Map();
    const messages = [];
    let handler, disposedHandler, provider;
    const disposable = () => ({ dispose() {} });
    const panel = {
        webview: {
            cspSource: 'vscode-webview:',
            onDidReceiveMessage(fn) { handler = fn; return disposable(); },
            postMessage(msg) { messages.push(msg); return Promise.resolve(true); },
            asWebviewUri(uri) { return new Uri('https://webview.test' + uri.path); },
        },
        onDidDispose(fn) { disposedHandler = fn; return disposable(); },
        dispose() { disposedHandler?.(); },
    };
    const mock = {
        env: { remoteName: 'ssh-remote' },
        Uri, FileType: { File: 1, Directory: 2, SymbolicLink: 64 }, ViewColumn: { Active: -1 },
        workspace: { getConfiguration: () => ({ get: (_name, fallback) => fallback }), fs: {
            async stat(uri) { const entry = fsEntries.get(uri.toString()); if (!entry) throw new Error('Missing file'); return { type: entry.type, size: entry.bytes?.length ?? 0, mtime: entry.mtime ?? 1 }; },
            async readDirectory(uri) { return fsEntries.get(uri.toString()).children; },
            async readFile(uri) {
                if (uri.path.endsWith('/manifest.json')) return Buffer.from(JSON.stringify({ 'index.html': { file: 'assets/viewer.js', css: ['assets/viewer.css'] } }));
                return fsEntries.get(uri.toString()).bytes;
            },
        } },
        window: {
            showOpenDialog: async () => [selected],
            showQuickPick: async items => items[1],
            showErrorMessage: async message => { throw new Error(message); },
            createWebviewPanel: () => panel,
            registerCustomEditorProvider(type, value) { provider = value; return disposable(); },
        },
        commands: {
            registerCommand(name, fn) { commands.set(name, fn); return disposable(); },
            async executeCommand() {},
        },
    };
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(path.join(__dirname, '../out/extension.js'), 'utf8'), {
        module, exports: module.exports, TextDecoder, TextEncoder, setTimeout, clearTimeout, Buffer, require: name => name === 'vscode' ? mock : name.startsWith('.') ? require(path.resolve(__dirname, '../out', name)) : require(name),
    });
    module.exports.activate({ extensionUri: new Uri('file:///extension'), subscriptions: [] });
    return { commands, panel, messages, Uri, selected, provider, fsEntries, request: async (method, extra = {}) => {
        messages.length = 0;
        await handler({ id: 1, method, ...extra });
        return messages[0];
    } };
}

test('recursive remote folder selection filters, sorts and skips symlink loops', async () => {
    const h = harness();
    await h.commands.get('dcmviewer.openFolder')(h.selected);
    const { result } = await h.request('initialFiles');
    assert.deepEqual(Array.from(result, x => x.name), ['a.npy', 'b.DCM', 'image.nii.gz']);
    assert.ok(result.every(x => x.path.startsWith('vscode-remote://')));
    const response = await h.request('readFile', { path: result[1].path });
    assert.deepEqual(Buffer.from(response.result.bytes), Buffer.from([0, 255, 128]));
});

function dicomFixture(name = 'scan') {
    function element(group, tag, vr, value) {
        const long = vr === 'OW';
        const header = Buffer.alloc(long ? 12 : 8);
        header.writeUInt16LE(group, 0);
        header.writeUInt16LE(tag, 2);
        header.write(vr, 4);
        if (long) header.writeUInt32LE(value.length, 8);
        else header.writeUInt16LE(value.length, 6);
        return Buffer.concat([header, value]);
    }
    const us = value => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
    const preamble = Buffer.alloc(132);
    preamble.write('DICM', 128);
    const bytes = Buffer.concat([
        preamble,
        element(0x0002, 0x0010, 'UI', Buffer.from('1.2.840.10008.1.2.1\0')),
        element(0x0028, 0x0010, 'US', us(1)),
        element(0x0028, 0x0011, 'US', us(2)),
        element(0x0028, 0x0100, 'US', us(16)),
        element(0x7fe0, 0x0010, 'OW', Buffer.concat([us(42), us(123)])),
    ]);
    return { path: `file:///qa/${name}`, name, bytes };
}

test('folder discovery and remote loading recognize DICOM content without a DICOM extension', async () => {
    const h = harness();
    for (const name of ['scan', 'scan.bin', 'scan.npy']) {
        h.fsEntries.get(h.selected.toString()).children.push([name, 1]);
        h.fsEntries.set(h.selected + '/' + name, { type: 1, bytes: dicomFixture(name).bytes });
    }
    h.fsEntries.get(h.selected.toString()).children.push(['truncated', 1]);
    h.fsEntries.set(h.selected + '/truncated', { type: 1, bytes: Buffer.from('DICM') });
    await h.commands.get('dcmviewer.openFolder')(h.selected);
    const refs = (await h.request('initialFiles')).result;
    assert.deepEqual(Array.from(refs, ref => ref.name), ['a.npy', 'b.DCM', 'image.nii.gz', 'scan', 'scan.bin', 'scan.npy']);
    for (const ref of refs.filter(ref => ref.name.startsWith('scan'))) {
        const read = await h.request('readFile', { path: ref.path });
        assert.deepEqual(Buffer.from(read.result.bytes), dicomFixture(ref.name).bytes);
        const response = await h.request('prepareVolumes', { paths: [ref.path] });
        assert.deepEqual(Array.from(response.result.errors), []);
        assert.equal(response.result.volumes[0].format, 'DICOM');
        assert.deepEqual(Array.from(response.result.volumes[0].dimensions), [2, 1, 1]);
        const plane = await h.request('readSlice', { token: response.result.volumes[0].token, axis: 'axial', slice: 0 });
        const pixels = Buffer.from(plane.result.bytes);
        assert.deepEqual([pixels.readFloatLE(0), pixels.readFloatLE(4)], [42, 123]);
    }
});

test('only explicitly selected files may be read, including across multiple Open operations', async () => {
    const h = harness();
    await h.commands.get('dcmviewer.openViewer')();
    assert.match((await h.request('readFile', { path: h.selected + '/a.npy' })).error, /not selected/);
    assert.equal((await h.request('openFiles')).result.length, 3);
    assert.deepEqual(Buffer.from((await h.request('readFile', { path: h.selected + '/a.npy' })).result.bytes), Buffer.from('NPY'));
    assert.match((await h.request('readFile', { path: 'file:///etc/passwd' })).error, /not selected/);
    assert.match((await h.request('malicious')).error, /Unknown/);
    h.panel.dispose();
    await h.request('initialFiles');
    assert.equal(h.messages.length, 0);
});

test('custom editor supplies its initial file and webview uses local assets with a CSP', async () => {
    const h = harness();
    const uri = new h.Uri(h.selected + '/a.npy');
    const document = h.provider.openCustomDocument(uri);
    await h.provider.resolveCustomEditor(document, h.panel);
    assert.equal((await h.request('initialFiles')).result[0].name, 'a.npy');
    assert.match(h.panel.webview.html, /default-src 'none'/);
    assert.match(h.panel.webview.html, /connect-src 'none'/);
    assert.match(h.panel.webview.html, /script-src 'nonce-/);
    assert.match(h.panel.webview.html, /assets\/viewer.js/);
    assert.equal(h.panel.webview.options.localResourceRoots[0].path, '/extension/media');
});

test('renderer bridge correlates concurrent replies, decodes bytes and propagates errors', async () => {
    const source = readFileSync(path.join(__dirname, '../../src/vscodeBridge.ts'), 'utf8');
    const code = require('esbuild').buildSync({ stdin: { contents: source, resolveDir: path.resolve(__dirname, '../../src'), loader: 'ts' }, bundle: true, write: false, format: 'cjs' }).outputFiles[0].text;
    const listeners = new Map();
    const sent = [];
    const window = { addEventListener: (name, fn) => listeners.set(name, fn) };
    vm.runInNewContext(code, { exports: {}, window, setTimeout, clearTimeout, Uint8Array, Blob, Response, DecompressionStream, acquireVsCodeApi: () => ({ postMessage: m => sent.push(m) }) });
    const api = window.dcmViewer;
    const initial = api.getInitialFiles();
    const file = api.readMedicalFile('file:///scan.npy');
    listeners.get('message')({ data: { id: sent[1].id, result: { path: 'file:///scan.npy', name: 'scan.npy', bytes: Uint8Array.from([0, 255, 128]), encoding: 'identity', originalSize: 3 } } });
    listeners.get('message')({ data: { id: sent[0].id, result: [] } });
    assert.equal((await initial).length, 0);
    assert.deepEqual(Array.from((await file).bytes), [0, 255, 128]);
    const failed = api.readMedicalFile('denied');
    const rejection = assert.rejects(failed, /not selected/);
    listeners.get('message')({ data: { id: sent.at(-1).id, error: 'not selected' } });
    await rejection;
    const closed = api.openMedicalFiles();
    const closeRejection = assert.rejects(closed, /Viewer closed/);
    listeners.get('pagehide')();
    await closeRejection;
});

const { encodeFile } = require('../out/transfer.js');
const { gzipSync, gunzipSync } = require('node:zlib');
const { randomBytes } = require('node:crypto');

test('remote transfer compression is lossless and bypasses gzipped or incompressible files', async () => {
    const original = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < original.length; index += 2) original.writeUInt16LE(index % 1200, index);
    const encoded = await encodeFile(original, 'volume.npy', true);
    assert.equal(encoded.encoding, 'gzip');
    assert.ok(encoded.bytes.byteLength < original.byteLength / 4);
    assert.deepEqual(gunzipSync(Buffer.from(encoded.bytes)), original);
    const alreadyCompressed = await encodeFile(gzipSync(original), 'volume.nii.gz', true);
    assert.equal(alreadyCompressed.encoding, 'identity');
    const noise = randomBytes(128 * 1024);
    const identity = await encodeFile(noise, 'noise.npy', true);
    assert.equal(identity.encoding, 'identity');
    assert.deepEqual(Buffer.from(identity.bytes), noise);
    assert.equal((await encodeFile(original, 'volume.npy', false)).encoding, 'identity');
});

test('batched reads preserve per-file errors and enforce selection, count and size limits', async () => {
    const h = harness();
    await h.commands.get('dcmviewer.openFolder')(h.selected);
    const refs = (await h.request('initialFiles')).result;
    h.fsEntries.delete(refs[1].path);
    const response = await h.request('readFiles', { paths: refs.map(ref => ref.path) });
    assert.equal(response.result.length, 3);
    assert.equal(response.result[0].encoding, 'identity');
    assert.match(response.result[1].error, /unavailable/);
    assert.ok(response.result[2].bytes);
    assert.match((await h.request('readFiles', { paths: ['file:///etc/passwd'] })).error, /not selected/);
    assert.match((await h.request('readFiles', { paths: Array(9).fill(refs[0].path) })).error, /between 1 and 8/);
    h.fsEntries.get(refs[0].path).bytes = Buffer.alloc(5 * 1024 * 1024);
    h.fsEntries.get(refs[2].path).bytes = Buffer.alloc(5 * 1024 * 1024);
    assert.match((await h.request('readFiles', { paths: [refs[0].path, refs[2].path] })).error, /8 MiB/);
});

function bridgeHarness(responder) {
    const source = readFileSync(path.join(__dirname, '../../src/vscodeBridge.ts'), 'utf8');
    const code = require('esbuild').buildSync({ stdin: { contents: source, resolveDir: path.resolve(__dirname, '../../src'), loader: 'ts' }, bundle: true, write: false, format: 'cjs' }).outputFiles[0].text;
    const listeners = new Map(), sent = [];
    const window = { addEventListener: (name, fn) => listeners.set(name, fn) };
    vm.runInNewContext(code, {
        exports: {}, window, setTimeout, clearTimeout, Uint8Array, Blob, Response, DecompressionStream,
        acquireVsCodeApi: () => ({ postMessage: message => {
            sent.push(message);
            void Promise.resolve().then(() => responder(message)).then(result => listeners.get('message')({ data: { id: message.id, result } }));
        } }),
    });
    return { api: window.dcmViewer, sent, listeners };
}
async function readAll(api, refs) {
    const results = [];
    for await (const result of api.readMedicalFiles(refs)) results.push(result);
    return results;
}

test('bridge batches small files, decodes gzip, reuses cache and invalidates changed versions', async () => {
    const data = Buffer.alloc(16 * 1024, 7);
    const compressed = gzipSync(data);
    const refs = Array.from({ length: 17 }, (_, index) => ({ path: `file:///scan/${index}.dcm`, name: `${index}.dcm`, size: data.length, mtime: 1 }));
    const h = bridgeHarness(message => {
        if (message.method === 'readFiles') return message.paths.map(path => ({ path, name: 'scan.dcm', bytes: compressed, encoding: 'gzip', originalSize: data.length, mtime: refs.find(ref => ref.path === path).mtime }));
        throw new Error('Unexpected request');
    });
    const results = await readAll(h.api, refs);
    assert.equal(h.sent.length, 3, '17 small files require 3 requests rather than 17');
    assert.ok(h.sent.every(message => message.paths.length <= 8));
    results.forEach(result => assert.deepEqual(Buffer.from(result.file.bytes), data));
    const again = await readAll(h.api, refs);
    assert.equal(again.length, 17);
    assert.equal(h.sent.length, 3, 'unchanged cached files require no transfer');
    refs[0].mtime = 2;
    await readAll(h.api, refs);
    assert.equal(h.sent.length, 4);
    assert.deepEqual(Array.from(h.sent.at(-1).paths), [refs[0].path]);
    refs[0].size = data.length + 1;
    const changed = await readAll(h.api, [refs[0]]);
    assert.equal(changed.length, 1);
    assert.equal(h.sent.length, 5, 'size changes invalidate cache even with the same timestamp');
});

test('large volumes are sent alone and per-file decompression errors do not drop neighbors', async () => {
    const refs = [
        { path: 'file:///large.npy', name: 'large.npy', size: 10 * 1024 * 1024 },
        { path: 'file:///bad.npy', name: 'bad.npy', size: 20 },
        { path: 'file:///good.npy', name: 'good.npy', size: 3 },
    ];
    const h = bridgeHarness(message => message.paths.map(path => path.includes('bad')
        ? { path, name: 'bad.npy', bytes: Uint8Array.from([1, 2]), encoding: 'gzip', originalSize: 20 }
        : { path, name: 'good.npy', bytes: Uint8Array.from([0, 255, 128]), encoding: 'identity', originalSize: 3 }));
    const results = await readAll(h.api, refs);
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0].paths.length, 1);
    assert.ok(results[0].file);
    assert.ok(results[1].error);
    assert.deepEqual(Array.from(results[2].file.bytes), [0, 255, 128]);
});

test('cache is bounded and batch cache hits remain usable during LRU eviction', async () => {
    const size = 8 * 1024 * 1024;
    const refs = Array.from({ length: 9 }, (_, index) => ({ path: `file:///large/${index}.npy`, name: `${index}.npy`, size, mtime: 1 }));
    const h = bridgeHarness(message => message.paths.map(path => ({ path, name: 'scan.npy', bytes: new Uint8Array(size), encoding: 'identity', originalSize: size, mtime: 1 })));
    await readAll(h.api, refs);
    assert.equal(h.sent.length, 9);
    await readAll(h.api, [refs[1]]);
    assert.equal(h.sent.length, 9, 'a retained cache entry is reused');
    await readAll(h.api, [refs[0]]);
    assert.equal(h.sent.length, 10, 'the oldest entry exceeded the 64 MiB budget and was evicted');
    h.listeners.get('pagehide')();
    await readAll(h.api, [refs[0]]);
    assert.equal(h.sent.length, 11, 'pagehide releases cached bytes');
});

function npyFixture(shape, values, name = 'volume.npy') {
    const header = Buffer.from(`{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')},), }\n`);
    const prefix = Buffer.from([147, 78, 85, 77, 80, 89, 1, 0, 0, 0]);
    prefix.writeUInt16LE(header.length, 8);
    const pixels = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => pixels.writeFloatLE(value, index * 4));
    return { path: `file:///qa/${name}`, name, bytes: Buffer.concat([prefix, header, pixels]) };
}
const { VolumeServer } = require('../out/volumeServer.js');
const version = file => [{ path: file.path, size: file.bytes.length, mtime: 1 }];
function browserModule(relative) {
    const code = require('esbuild').buildSync({ entryPoints: [path.resolve(__dirname, '../../src', relative)], bundle: true, write: false, format: 'cjs', platform: 'node' }).outputFiles[0].text;
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, require, Uint8Array, Float32Array, ArrayBuffer, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout });
    return module.exports;
}

test('local loading uses DICOM content for extensionless and differently named files', async () => {
    const { loadMedicalFiles } = browserModule('loaders/medicalLoader.ts');
    for (const name of ['scan', 'scan.bin', 'scan.npy', 'scan.nii.gz']) {
        const result = await loadMedicalFiles([dicomFixture(name)]);
        assert.deepEqual(Array.from(result.errors), []);
        assert.equal(result.volumes[0].format, 'DICOM');
        assert.deepEqual(Array.from(result.volumes[0].data), [42, 123]);
    }
});

test('remote NPY planes preserve all voxel values in all axes, channels and snapshot versions', async () => {
    const file = npyFixture([2, 4, 3, 5], Array.from({ length: 120 }, (_, n) => n - 40));
    const server = new VolumeServer();
    const result = await server.prepare([file], version(file));
    assert.equal(result.errors.length, 0);
    assert.equal(result.volumes.length, 2);
    assert.ok(result.volumes.every(volume => !('data' in volume)));
    const { remoteVolume } = browserModule('remoteSlices.ts');
    let requests = 0;
    for (const [channel, descriptor] of result.volumes.entries()) {
        const image = remoteVolume(descriptor, async (token, axis, slice) => { requests++; return server.slice(token, axis, slice); }, false);
        for (const [axis, count] of [['axial', 4], ['coronal', 3], ['sagittal', 5]]) {
            const slice = count - 1;
            const reader = await image.remote.ensureSlice(axis, slice);
            for (let z = 0; z < 4; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) {
                if (axis === 'axial' ? z === slice : axis === 'coronal' ? y === slice : x === slice) assert.equal(reader(x, y, z), channel * 60 + z * 15 + y * 5 + x - 40);
            }
            const before = requests;
            await image.remote.ensureSlice(axis, slice);
            assert.equal(requests, before, 'memory hit avoids transport');
        }
    }
    assert.equal((await server.prepare([file], version(file))).volumes[0].token, result.volumes[0].token);
    const changed = await server.prepare([file], [{ ...version(file)[0], mtime: 2 }]);
    assert.notEqual(changed.volumes[0].version, result.volumes[0].version);
    assert.throws(() => server.slice(result.volumes[0].token, 'invalid', 0), /axis/);
    assert.throws(() => server.slice(result.volumes[0].token, 'axial', 4), /bounds/);
    server.clear();
    assert.throws(() => server.slice(result.volumes[0].token, 'axial', 0), /expired/);
});

test('remote NIfTI gzip is decoded server-side with scaling preserved', async () => {
    const bytes = Buffer.alloc(352 + 24);
    bytes.writeInt32LE(348, 0);
    [3, 3, 2, 2, 1, 1, 1, 1].forEach((v, i) => bytes.writeInt16LE(v, 40 + 2 * i));
    bytes.writeInt16LE(4, 70); bytes.writeInt16LE(16, 72);
    bytes.writeFloatLE(352, 108); bytes.writeFloatLE(2, 112); bytes.writeFloatLE(-100, 116);
    bytes.write('n+1\0', 344, 'ascii');
    for (let n = 0; n < 12; n++) bytes.writeInt16LE(n, 352 + n * 2);
    const file = { path: 'file:///qa/image.nii.gz', name: 'image.nii.gz', bytes: gzipSync(bytes) };
    const server = new VolumeServer();
    const result = await server.prepare([file], version(file));
    assert.deepEqual(result.errors, []);
    const descriptor = result.volumes[0];
    assert.deepEqual(descriptor.dimensions, [3, 2, 2]);
    const plane = server.slice(descriptor.token, 'axial', 1);
    assert.deepEqual(Array.from(new Float32Array(plane.buffer)), [-88, -86, -84, -82, -80, -78]);
});

test('remote preparation and slice requests enforce selection and volume tokens', async () => {
    const h = harness();
    await h.commands.get('dcmviewer.openFolder')(h.selected);
    assert.equal((await h.request('capabilities')).result.streamVolumes, true);
    assert.match((await h.request('prepareVolumes', { paths: ['file:///etc/passwd'] })).error, /not selected/);
    const path = h.selected + '/a.npy';
    h.fsEntries.get(path).bytes = npyFixture([2, 3, 4], Array.from({ length: 24 }, (_, n) => n)).bytes;
    const prepared = (await h.request('prepareVolumes', { paths: [path] })).result;
    assert.equal(prepared.volumes.length, 1);
    assert.ok(!('data' in prepared.volumes[0]));
    const response = await h.request('readSlice', { token: prepared.volumes[0].token, axis: 'axial', slice: 1 });
    assert.equal(response.result.originalSize, 3 * 4 * 4);
    assert.match((await h.request('readSlice', { token: 'forged', axis: 'axial', slice: 0 })).error, /expired/);
});

test('remote difference uses relative depth, and independent pane readers remain stable', async () => {
    const { remoteVolume } = browserModule('remoteSlices.ts');
    const { createDifferenceVolume } = browserModule('loaders/medicalLoader.ts');
    const server = new VolumeServer();
    const a = npyFixture([2, 2, 3], Array.from({ length: 12 }, (_, n) => n), 'a.npy');
    const b = npyFixture([4, 2, 3], Array.from({ length: 24 }, (_, n) => n + 10), 'b.npy');
    const left = (await server.prepare([a], version(a))).volumes[0];
    const right = (await server.prepare([b], version(b))).volumes[0];
    const read = async (token, axis, slice) => server.slice(token, axis, slice);
    const first = remoteVolume(left, read, false), second = remoteVolume(right, read, false);
    const oldReader = await first.remote.ensureSlice('axial', 0);
    await first.remote.ensureSlice('axial', 1);
    assert.equal(oldReader(2, 1, 0), 5, 'another viewport cannot overwrite the displayed plane');
    const difference = createDifferenceVolume(first, second);
    for (const axis of ['axial', 'coronal', 'sagittal']) {
        const reader = await difference.remote.ensureSlice(axis, 1);
        assert.equal(reader(1, 1, 1), 22);
    }
});

test('aborted navigation skips obsolete queued transfers and failed slices are retryable', async () => {
    const { remoteVolume } = browserModule('remoteSlices.ts');
    const server = new VolumeServer();
    const file = npyFixture([4, 2, 3], Array.from({ length: 24 }, (_, n) => n));
    const descriptor = (await server.prepare([file], version(file))).volumes[0];
    const requests = [];
    const image = remoteVolume(descriptor, async (token, axis, slice) => {
        requests.push(slice);
        await new Promise(resolve => setTimeout(resolve, 15));
        if (slice === 3 && requests.filter(n => n === 3).length === 1) throw new Error('Connection interrupted');
        return server.slice(token, axis, slice);
    }, false);
    const a = image.remote.ensureSlice('axial', 0), b = image.remote.ensureSlice('axial', 1);
    const controller = new AbortController();
    const obsolete = image.remote.ensureSlice('axial', 2, controller.signal);
    controller.abort();
    await Promise.all([a, b, assert.rejects(obsolete, { name: 'AbortError' })]);
    assert.deepEqual(requests, [0, 1]);
    await assert.rejects(image.remote.ensureSlice('axial', 3), /interrupted/);
    const reader = await image.remote.ensureSlice('axial', 3);
    assert.equal(reader(2, 1, 3), 23);
});

function prefetchHarness(dimensions = [2, 2, 32]) {
    const { remoteVolume } = browserModule('remoteSlices.ts');
    const requests = [], pending = [];
    let active = 0, peak = 0;
    const image = remoteVolume({ id: 'prefetch', token: 'token', version: '1', dimensions }, async (_token, axis, slice) => {
        requests.push([axis, slice]);
        peak = Math.max(peak, ++active);
        await new Promise(resolve => pending.push(resolve));
        active--;
        const [w, h, d] = dimensions;
        return new Uint8Array(new Float32Array(axis === 'axial' ? w * h : axis === 'coronal' ? w * d : h * d).buffer);
    }, false, { prefetchRadius: 8 });
    return { image, requests, pending, peak: () => peak };
}
const settlePrefetch = () => new Promise(resolve => setImmediate(resolve));
async function releasePrefetch(harness) {
    harness.pending.splice(0).forEach(resolve => resolve());
    await settlePrefetch();
}

test('prefetch caches eight slices in each direction, nearest first, with two transfers maximum', async () => {
    const h = prefetchHarness();
    h.image.remote.prefetch('axial', 16, new AbortController().signal);
    for (let distance = 1; distance <= 8; distance++) {
        assert.deepEqual(h.requests.slice(-2), [['axial', 16 + distance], ['axial', 16 - distance]]);
        await releasePrefetch(h);
    }
    assert.equal(h.requests.length, 16);
    assert.equal(h.peak(), 2);
    for (const [, slice] of h.requests) await h.image.remote.ensureSlice('axial', slice);
    assert.equal(h.requests.length, 16, 'foreground navigation reuses prefetched pixels');
});

test('prefetch respects axis boundaries and cancellation when navigation changes', async () => {
    for (const axis of ['axial', 'coronal', 'sagittal']) {
        const h = prefetchHarness([5, 5, 5]);
        h.image.remote.prefetch(axis, 0, new AbortController().signal);
        for (let distance = 1; distance <= 8; distance++) await releasePrefetch(h);
        assert.deepEqual(h.requests, [1, 2, 3, 4].map(slice => [axis, slice]));
    }
    const h = prefetchHarness();
    const controller = new AbortController();
    h.image.remote.prefetch('axial', 16, controller.signal);
    controller.abort();
    await releasePrefetch(h);
    assert.equal(h.requests.length, 2, 'started transfers finish without requesting farther slices');
});

test('foreground requests promote an existing queued prefetch without duplicate transfers', async () => {
    const h = prefetchHarness();
    const first = h.image.remote.ensureSlice('axial', 0);
    const second = h.image.remote.ensureSlice('axial', 1);
    h.image.remote.prefetch('axial', 16, new AbortController().signal);
    const requested = h.image.remote.ensureSlice('axial', 15);
    h.pending.shift()();
    await settlePrefetch();
    assert.deepEqual(h.requests[2], ['axial', 15], 'requested backward neighbor overtakes queued forward neighbor');
    for (let round = 0; round < 10; round++) await releasePrefetch(h);
    await Promise.all([first, second, requested]);
    assert.equal(h.requests.filter(([, slice]) => slice === 15).length, 1);
    assert.equal(h.peak(), 2);
});

test('large planes reduce the prefetch range to the per-volume memory budget', async () => {
    const h = prefetchHarness([1024, 1024, 32]);
    h.image.remote.prefetch('axial', 16, new AbortController().signal);
    for (let round = 0; round < 8; round++) await releasePrefetch(h);
    assert.deepEqual(h.requests.map(([, slice]) => slice), [17, 15, 18, 14]);
    const oversized = prefetchHarness([2048, 2048, 32]);
    oversized.image.remote.prefetch('axial', 16, new AbortController().signal);
    assert.equal(oversized.requests.length, 0);
});

test('DICOM series is sorted and rescaled on the server before plane retrieval', async () => {
    function tag(group, element, vr, value) {
        let data = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (data.length % 2) data = Buffer.concat([data, Buffer.from([vr === 'UI' ? 0 : 32])]);
        const long = vr === 'OW';
        const header = Buffer.alloc(long ? 12 : 8);
        header.writeUInt16LE(group, 0); header.writeUInt16LE(element, 2); header.write(vr, 4);
        if (long) header.writeUInt32LE(data.length, 8); else header.writeUInt16LE(data.length, 6);
        return Buffer.concat([header, data]);
    }
    const us = n => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(n); return bytes; };
    function slice(index) {
        const pixels = Buffer.alloc(12);
        for (let n = 0; n < 6; n++) pixels.writeUInt16LE(index * 6 + n, n * 2);
        const bytes = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'),
            tag(2, 0x10, 'UI', '1.2.840.10008.1.2.1'),
            tag(0x10, 0x20, 'LO', 'QA'), tag(0x20, 0x10, 'SH', 'Study'), tag(0x20, 0x11, 'IS', '1'),
            tag(0x20, 0x13, 'IS', String(index + 1)), tag(0x20, 0x32, 'DS', `0\\0\\${index}`),
            tag(0x28, 0x10, 'US', us(2)), tag(0x28, 0x11, 'US', us(3)),
            tag(0x28, 0x100, 'US', us(16)), tag(0x28, 0x103, 'US', us(0)),
            tag(0x28, 0x1052, 'DS', '-100'), tag(0x28, 0x1053, 'DS', '2'),
            tag(0x7fe0, 0x10, 'OW', pixels),
        ]);
        return { path: `file:///qa/${index}.dcm`, name: `${index}.dcm`, bytes };
    }
    const files = [slice(1), slice(0)];
    const server = new VolumeServer();
    const result = await server.prepare(files, files.map(file => version(file)[0]));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.volumes[0].dimensions, [3, 2, 2]);
    const plane = server.slice(result.volumes[0].token, 'axial', 0);
    assert.deepEqual(Array.from(new Float32Array(plane.buffer)), [-100, -98, -96, -94, -92, -90]);
});
