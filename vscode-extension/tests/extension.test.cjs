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
    const exports = {};
    vm.runInNewContext(readFileSync(path.join(__dirname, '../out/extension.js'), 'utf8'), {
        exports, Buffer, require: name => name === 'vscode' ? mock : name.startsWith('.') ? require(path.resolve(__dirname, '../out', name)) : require(name),
    });
    exports.activate({ extensionUri: new Uri('file:///extension'), subscriptions: [] });
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
    const ts = require('typescript');
    const source = readFileSync(path.join(__dirname, '../../src/vscodeBridge.ts'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const listeners = new Map();
    const sent = [];
    const window = { addEventListener: (name, fn) => listeners.set(name, fn) };
    vm.runInNewContext(code, { exports: {}, window, Uint8Array, Blob, Response, DecompressionStream, acquireVsCodeApi: () => ({ postMessage: m => sent.push(m) }) });
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
    const ts = require('typescript');
    const source = readFileSync(path.join(__dirname, '../../src/vscodeBridge.ts'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const listeners = new Map(), sent = [];
    const window = { addEventListener: (name, fn) => listeners.set(name, fn) };
    vm.runInNewContext(code, {
        exports: {}, window, Uint8Array, Blob, Response, DecompressionStream,
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
