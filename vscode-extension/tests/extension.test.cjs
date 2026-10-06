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
        Uri, FileType: { File: 1, Directory: 2, SymbolicLink: 64 }, ViewColumn: { Active: -1 },
        workspace: { fs: {
            async stat(uri) { const entry = fsEntries.get(uri.toString()); if (!entry) throw new Error('Missing file'); return { type: entry.type, size: entry.bytes?.length ?? 0 }; },
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
        exports, Buffer, require: name => name === 'vscode' ? mock : require(name),
    });
    exports.activate({ extensionUri: new Uri('file:///extension'), subscriptions: [] });
    return { commands, panel, messages, Uri, selected, provider, request: async (method, extra = {}) => {
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
    assert.deepEqual(Buffer.from(response.result.base64, 'base64'), Buffer.from([0, 255, 128]));
});

test('only explicitly selected files may be read, including across multiple Open operations', async () => {
    const h = harness();
    await h.commands.get('dcmviewer.openViewer')();
    assert.match((await h.request('readFile', { path: h.selected + '/a.npy' })).error, /not selected/);
    assert.equal((await h.request('openFiles')).result.length, 3);
    assert.equal((await h.request('readFile', { path: h.selected + '/a.npy' })).result.base64, Buffer.from('NPY').toString('base64'));
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
    vm.runInNewContext(code, { exports: {}, window, Uint8Array, atob, acquireVsCodeApi: () => ({ postMessage: m => sent.push(m) }) });
    const api = window.dcmViewer;
    const initial = api.getInitialFiles();
    const file = api.readMedicalFile('file:///scan.npy');
    listeners.get('message')({ data: { id: sent[1].id, result: { path: 'file:///scan.npy', name: 'scan.npy', base64: 'AP+A' } } });
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
