import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';

const viewType = 'dcmviewer.volume';
const supported = (uri: vscode.Uri) => /\.(dcm|dicom|nii|nii\.gz|npy)$/i.test(uri.path);

type FileReference = { path: string; name: string; size: number };

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
        } else if ((info.type & vscode.FileType.File) && supported(uri)) {
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
        ...(folder ? {} : { filters: { 'Medical volumes': ['dcm', 'dicom', 'nii', 'gz', 'npy'] } }),
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
            result.push({ path, name: posix.basename(uri.path), size: info.size });
        }
        return result;
    }

    const initialFiles = await references(initialUris);
    let disposed = false;
    const receiver = panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const request = message as { id?: unknown; method?: unknown; path?: unknown };
        if (!Number.isSafeInteger(request.id) || typeof request.method !== 'string') return;
        try {
            let result: unknown;
            switch (request.method) {
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
                case 'readFile': {
                    const uri = typeof request.path === 'string' ? allowedFiles.get(request.path) : undefined;
                    if (!uri) throw new Error('The requested file was not selected in this viewer.');
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    // Webview messages are JSON serializable; base64 avoids huge number arrays.
                    result = { path: request.path, name: posix.basename(uri.path), base64: Buffer.from(bytes).toString('base64') };
                    break;
                }
                default: throw new Error('Unknown viewer request.');
            }
            if (!disposed) await panel.webview.postMessage({ id: request.id, result });
        } catch (error) {
            if (!disposed) await panel.webview.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
        }
    });
    const disposal = panel.onDidDispose(() => { disposed = true; allowedFiles.clear(); receiver.dispose(); disposal.dispose(); });
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
            if (uri instanceof vscode.Uri && supported(uri)) await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
        })),
        vscode.window.registerCustomEditorProvider(viewType, {
            openCustomDocument(uri) { return { uri, dispose() {} }; },
            async resolveCustomEditor(document, panel) { await attachViewer(context, panel, [document.uri]); },
        } satisfies vscode.CustomReadonlyEditorProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    );
}
