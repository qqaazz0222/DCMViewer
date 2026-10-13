import * as vscode from 'vscode';
import { encodeFile, MAX_BATCH_BYTES, MAX_BATCH_FILES } from './transfer';
import { VolumeServer } from './volumeServer';
import type { Axis } from '../../src/types';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { hasDicomPreamble, hasMedicalExtension } from '../../src/medicalFileDetection';

const viewType = 'dcmviewer.volume';
async function supported(uri: vscode.Uri) {
    if (hasMedicalExtension(uri.path)) return true;
    return hasDicomPreamble(await vscode.workspace.fs.readFile(uri));
}

type FileReference = { path: string; name: string; size: number; mtime: number };

// Use the workspace filesystem API so SSH, containers and virtual filesystems work too.
async function collectFiles(uris: readonly vscode.Uri[]): Promise<vscode.Uri[]> {
    const files = new Map<string, vscode.Uri>();
    const visited = new Set<string>();
    async function visit(uri: vscode.Uri) {
        const key = uri.toString();
        if (visited.has(key)) return;
        visited.add(key);
        const info = await vscode.workspace.fs.stat(uri);
        if (info.type & vscode.FileType.SymbolicLink) return;
        if (info.type & vscode.FileType.Directory) {
            for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
                if (type & vscode.FileType.SymbolicLink) continue;
                await visit(vscode.Uri.joinPath(uri, name));
            }
        } else if ((info.type & vscode.FileType.File) && await supported(uri)) {
            files.set(key, uri);
        }
    }
    for (const uri of uris) await visit(uri);
    return [...files.values()].sort((a, b) => a.toString().localeCompare(b.toString()));
}

async function pickFiles(folder: boolean) {
    return await vscode.window.showOpenDialog({
        title: folder ? 'Open medical folder / DICOM series' : 'Open medical files',
        canSelectFiles: !folder, canSelectFolders: folder, canSelectMany: true,
        ...(folder ? {} : { filters: { 'All files': ['*'], 'Medical volumes': ['dcm', 'dicom', 'nii', 'gz', 'npy'] } }),
    });
}

function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function attachViewer(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, initialUris: readonly vscode.Uri[]) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const allowedFiles = new Map<string, vscode.Uri>();
    async function references(uris: readonly vscode.Uri[]): Promise<FileReference[]> {
        const result: FileReference[] = [];
        for (const uri of await collectFiles(uris)) {
            const path = uri.toString();
            const info = await vscode.workspace.fs.stat(uri);
            allowedFiles.set(path, uri);
            result.push({ path, name: posix.basename(uri.path), size: info.size, mtime: info.mtime });
        }
        return result;
    }

    const initialFiles = await references(initialUris);
    let disposed = false;
    const volumeServer = new VolumeServer();
    let prepareQueue: Promise<unknown> = Promise.resolve();
    const receiver = panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const request = message as { id?: unknown; method?: unknown; path?: unknown; paths?: unknown; token?: unknown; axis?: unknown; slice?: unknown };
        if (!Number.isSafeInteger(request.id) || typeof request.method !== 'string') return;
        try {
            let result: unknown;
            switch (request.method) {
                case 'capabilities': result = {
                    streamVolumes: Boolean(vscode.env.remoteName) && vscode.workspace.getConfiguration('dcmviewer').get('streamRemoteVolumes', true),
                    persistCache: vscode.workspace.getConfiguration('dcmviewer').get('persistSliceCache', true),
                }; break;
                case 'prepareVolumes': {
                    if (!Array.isArray(request.paths) || !request.paths.length || request.paths.some(path => typeof path !== 'string' || !allowedFiles.has(path))) {
                        throw new Error('The requested file was not selected in this viewer.');
                    }
                    const uris = request.paths.map(path => allowedFiles.get(path as string)!);
                    // Serialize preparation to bound server memory and duplicate work.
                    const prepare = async () => {
                        if (disposed) throw new Error('Viewer closed.');
                        const infos = await Promise.all(uris.map(async uri => { try { return await vscode.workspace.fs.stat(uri); } catch { return undefined; } }));
                        if (infos.reduce((n, info) => n + (info?.size ?? 0), 0) > 512 * 1024 * 1024) throw new Error('Source files exceed the 512 MiB remote preparation limit. Disable streamRemoteVolumes to use whole-file loading.');
                        const files = [];
                        const versions = [];
                        const readErrors: string[] = [];
                        for (const [index, uri] of uris.entries()) {
                            if (disposed) throw new Error('Viewer closed.');
                            try {
                                const before = infos[index];
                                if (!before) throw new Error('The file is unavailable.');
                                const bytes = await vscode.workspace.fs.readFile(uri);
                                const after = await vscode.workspace.fs.stat(uri);
                                if (before.mtime !== after.mtime || before.size !== after.size || bytes.byteLength !== after.size) throw new Error('The file changed while reading. Select it again.');
                                files.push({ path: uri.toString(), name: posix.basename(uri.path), bytes });
                                versions.push({ path: uri.toString(), size: after.size, mtime: after.mtime });
                            } catch (error) { readErrors.push(`${posix.basename(uri.path)}: ${error instanceof Error ? error.message : String(error)}`); }
                        }
                        const prepared = await volumeServer.prepare(files, versions);
                        if (disposed) { volumeServer.clear(); throw new Error('Viewer closed.'); }
                        return { volumes: prepared.volumes, errors: [...readErrors, ...prepared.errors] };
                    };
                    const task = prepareQueue.then(prepare);
                    prepareQueue = task.catch(() => {});
                    result = await task;
                    break;
                }
                case 'readSlice': {
                    if (typeof request.token !== 'string') throw new Error('Invalid volume token.');
                    const bytes = volumeServer.slice(request.token, request.axis as Axis, request.slice as number);
                    const compress = vscode.workspace.getConfiguration('dcmviewer').get<boolean>('compressRemoteFiles', true);
                    result = { path: request.token, name: 'slice.raw', ...await encodeFile(bytes, 'slice.raw', compress) };
                    break;
                }
                case 'initialFiles': result = initialFiles; break;
                case 'openFiles': {
                    const kind = await vscode.window.showQuickPick([
                        { label: 'Files', folder: false, description: 'DICOM, NIfTI or NPY files' },
                        { label: 'Folder / DICOM series', folder: true, description: 'Recursively load supported files' },
                    ], { placeHolder: 'Select medical files or a folder' });
                    const uris = kind ? await pickFiles(kind.folder) : undefined;
                    result = uris ? await references(uris) : [];
                    break;
                }
                case 'readFile':
                case 'readFiles': {
                    const paths = request.method === 'readFile' ? [request.path] : request.paths;
                    if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_BATCH_FILES || paths.some(path => typeof path !== 'string')) {
                        throw new Error(`Select between 1 and ${MAX_BATCH_FILES} files per request.`);
                    }
                    // Authorize before any filesystem read. A batch cannot bypass the picker.
                    const uris = paths.map(path => {
                        const uri = allowedFiles.get(path);
                        if (!uri) throw new Error('The requested file was not selected in this viewer.');
                        return uri;
                    });
                    const infos = await Promise.all(uris.map(async uri => {
                        try { return await vscode.workspace.fs.stat(uri); }
                        catch { return undefined; }
                    }));
                    if (uris.length > 1 && infos.reduce((sum, info) => sum + (info?.size ?? 0), 0) > MAX_BATCH_BYTES) {
                        throw new Error('The selected files exceed the 8 MiB batch limit. Select the files again to refresh their sizes.');
                    }
                    const compress = Boolean(vscode.env.remoteName) && vscode.workspace.getConfiguration('dcmviewer').get<boolean>('compressRemoteFiles', true);
                    const files = [];
                    // Two files at a time bound filesystem and zlib concurrency.
                    for (let index = 0; index < uris.length; index += 2) {
                        const pair = await Promise.all(uris.slice(index, index + 2).map(async (uri, offset) => {
                            const path = paths[index + offset];
                            const name = posix.basename(uri.path);
                            try {
                                const before = infos[index + offset];
                                if (!before) throw new Error('The file is unavailable.');
                                const bytes = await vscode.workspace.fs.readFile(uri);
                                const after = await vscode.workspace.fs.stat(uri);
                                if (before.mtime !== after.mtime || before.size !== after.size || after.size !== bytes.byteLength) {
                                    throw new Error('The file changed while reading. Select it again.');
                                }
                                return { path, name, mtime: after.mtime, ...await encodeFile(bytes, name, compress) };
                            } catch (error) {
                                return { path, name, error: error instanceof Error ? error.message : String(error) };
                            }
                        }));
                        files.push(...pair);
                    }
                    result = request.method === 'readFile' ? files[0] : files;
                    if (request.method === 'readFile' && 'error' in files[0]) throw new Error(files[0].error);
                    break;
                }
                default: throw new Error('Unknown viewer request.');
            }
            if (!disposed) await panel.webview.postMessage({ id: request.id, result });
        } catch (error) {
            if (!disposed) await panel.webview.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
        }
    });
    const disposal = panel.onDidDispose(() => { disposed = true; volumeServer.clear(); allowedFiles.clear(); receiver.dispose(); disposal.dispose(); });
    try {
        const manifest = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, '.vite', 'manifest.json'))).toString());
        const entry = manifest['index.html'] as { file: string; css?: string[] };
        if (!entry?.file) throw new Error('Missing viewer build. Run npm run build:vscode.');
        const asset = (path: string) => escapeHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(media, path)).toString());
        const nonce = randomBytes(24).toString('base64');
        const source = panel.webview.cspSource;
        panel.webview.html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${source} 'unsafe-inline'; img-src ${source} data:; font-src ${source}; connect-src 'none';">
<title>DCMViewer</title>${(entry.css ?? []).map(path => `<link rel="stylesheet" href="${asset(path)}">`).join('')}
</head><body class="vscodeHost"><div id="root"></div><script type="module" nonce="${nonce}" src="${asset(entry.file)}"></script></body></html>`;
    } catch (error) {
        receiver.dispose(); disposal.dispose();
        throw error;
    }
}

export function activate(context: vscode.ExtensionContext) {
    async function openViewer(uris: readonly vscode.Uri[] = []) {
        const panel = vscode.window.createWebviewPanel(viewType, 'DCMViewer', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
        try { await attachViewer(context, panel, uris); }
        catch (error) { panel.dispose(); throw error; }
        return panel;
    }
    const guarded = (action: (...args: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => {
        try { return await action(...args); }
        catch (error) { await vscode.window.showErrorMessage(`DCMViewer: ${error instanceof Error ? error.message : String(error)}`); }
    };
    context.subscriptions.push(
        vscode.commands.registerCommand('dcmviewer.openViewer', guarded(() => openViewer())),
        vscode.commands.registerCommand('dcmviewer.openFiles', guarded(async () => {
            const uris = await pickFiles(false);
            if (uris?.length) await openViewer(uris);
        })),
        vscode.commands.registerCommand('dcmviewer.openFolder', guarded(async (uri) => {
            const uris = uri instanceof vscode.Uri ? [uri] : await pickFiles(true);
            if (uris?.length) await openViewer(uris);
        })),
        vscode.commands.registerCommand('dcmviewer.openInViewer', guarded(async (uri) => {
            if (uri instanceof vscode.Uri && await supported(uri)) await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
        })),
        vscode.window.registerCustomEditorProvider(viewType, {
            openCustomDocument(uri) { return { uri, dispose() {} }; },
            async resolveCustomEditor(document, panel) { await attachViewer(context, panel, [document.uri]); },
        } satisfies vscode.CustomReadonlyEditorProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    );
}
