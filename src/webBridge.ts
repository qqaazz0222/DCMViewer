import { remoteVolume, clearRemoteCache, remoteLoadGroups } from './remoteSlices';
import { loadMedicalFiles } from './loaders/medicalLoader';
import { hasDicomPreamble, hasMedicalExtension } from './medicalFileDetection';
import type { MedicalFileReference, RemoteVolumeDescriptor } from './types';

type Entry = { name: string; path: string; type: 'dir' | 'file'; size?: number };

// Server platform build only: volumes stay on the server, slices stream over HTTP.
if (import.meta.env.MODE === 'web') {
    async function call(path: string, init?: RequestInit): Promise<Response> {
        const response = await fetch(path, init);
        if (response.status === 401) { location.assign('/login'); throw new Error('Session expired. Sign in again.'); }
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed (${response.status}).`);
        return response;
    }
    const api = async <T>(path: string, body?: unknown) => (await call(path, body === undefined ? undefined : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json() as Promise<T>;
    const formatSize = (bytes = 0) => bytes < 2 ** 20 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 2 ** 20).toFixed(1)} MB`;

    function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: object = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    }

    // Local files opened in view-only mode stay in this tab: parsed in the browser, never sent to the server.
    const LOCAL = 'local:';
    const localFiles = new Map<string, File>();
    let localCount = 0;
    const isMedicalFile = async (file: File) => !file.name.startsWith('.')
        && (hasMedicalExtension(file.name) || hasDicomPreamble(new Uint8Array(await file.slice(0, 132).arrayBuffer())));

    // Lucide outlines; constant markup only, never user data.
    const ICONS = {
        folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
        file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
        chevron: '<path d="m9 18 6-6-6-6"/>',
        server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
    };
    const icon = (name: keyof typeof ICONS) => {
        const span = element('span', { className: `pickerIcon pickerIcon-${name}` });
        span.setAttribute('aria-hidden', 'true');
        span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
        return span;
    };
    const kind = (name: string) => /\.nii(\.gz)?$/i.test(name) ? 'NIfTI volume' : /\.npy$/i.test(name) ? 'NumPy array' : 'DICOM image';

    // Server-side file browser in Finder's column layout: each opened folder adds a column to the right.
    // Selection survives navigation; with nothing selected, the deepest open folder is opened.
    function pickFiles(): Promise<MedicalFileReference[]> {
        return new Promise(resolve => {
            const selected = new Set<string>();
            const columns = element('div', { className: 'pickerColumns' });
            const pathBar = element('nav', { className: 'pickerPath' });
            pathBar.setAttribute('aria-label', 'Folder path');
            const status = element('span', { className: 'serverPickerStatus' });
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const cancel = element('button', { type: 'button', textContent: 'Cancel' });
            const fileInput = element('input', { type: 'file', multiple: true, hidden: true });
            const folderInput = element('input', { type: 'file', webkitdirectory: true, hidden: true });
            const mode = (value: string, text: string, title: string, checked = false) => {
                const input = element('input', { type: 'radio', name: 'local-mode', value, checked });
                return { input, label: element('label', { title }, input, element('span', { textContent: text })) };
            };
            const viewMode = mode('view', 'View only', 'Read in this browser tab. Nothing is sent to the server.', true);
            const uploadMode = mode('upload', 'Upload', 'Save to your folder on the server, then open.');
            const segmented = element('div', { className: 'pickerSegmented' }, viewMode.label, uploadMode.label);
            segmented.setAttribute('role', 'radiogroup');
            segmented.setAttribute('aria-label', 'How to open local files');
            const local = element('fieldset', { className: 'pickerLocal' },
                element('legend', { textContent: 'This computer' }),
                element('button', { type: 'button', textContent: 'Files…', onclick: () => fileInput.click() }),
                element('button', { type: 'button', textContent: 'Folder…', onclick: () => folderInput.click() }),
                segmented, fileInput, folderInput);
            const confirm = element('button', { type: 'submit', className: 'primary' });
            const form = element('form', { method: 'dialog' },
                element('header', {}, element('strong', { id: 'server-picker-title', textContent: 'Open medical images' }), local),
                columns, pathBar,
                element('footer', {}, status, cancel, confirm));
            const dialog = element('dialog', { className: 'serverPicker' }, form);
            dialog.setAttribute('aria-labelledby', 'server-picker-title');
            // Open folder path per column; the last one is the current folder.
            const open: string[] = [];
            const listings = new Map<string, Entry[]>();
            // A selected folder covers everything below it, so children show as checked too.
            const ancestors = (path: string) => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
            const selectedAncestor = (path: string) => ancestors(path).find(ancestor => selected.has(ancestor));
            const sync = () => {
                for (const box of columns.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
                    const path = box.dataset.path!;
                    box.checked = selected.has(path) || selectedAncestor(path) !== undefined;
                    box.indeterminate = !box.checked && [...selected].some(item => item.startsWith(`${path}/`));
                }
            };
            function toggle(path: string, on: boolean) {
                const top = selectedAncestor(path);
                if (on) {
                    for (const item of [...selected]) if (item.startsWith(`${path}/`)) selected.delete(item);
                    selected.add(path);
                } else if (top === undefined) selected.delete(path);
                else {
                    // Unchecking inside a selected folder: select its siblings at each level instead.
                    selected.delete(top);
                    for (const dir of [top, ...ancestors(path).filter(ancestor => ancestor.startsWith(`${top}/`))]) {
                        for (const entry of listings.get(dir) ?? []) {
                            if (entry.path !== path && !path.startsWith(`${entry.path}/`)) selected.add(entry.path);
                        }
                    }
                }
                sync();
                updateConfirm();
            }
            let done = false;
            let navigation = 0;
            let listing = false;
            let collecting = false;
            const current = () => open[open.length - 1] ?? '';
            const finish = (refs: MedicalFileReference[]) => { if (done) return; done = true; dialog.close(); dialog.remove(); resolve(refs); };
            const updateConfirm = () => {
                confirm.textContent = selected.size ? `Open ${selected.size} selected` : 'Open this folder';
                if (!listing && !collecting) status.textContent = selected.size ? `${selected.size} selected across folders` : '';
            };
            const renderPath = () => {
                const parts = current() ? current().split('/') : [];
                pathBar.replaceChildren(...[{ name: 'Data', depth: 0 }, ...parts.map((name, index) => ({ name, depth: index + 1 }))].flatMap(({ name, depth }, index) => [
                    ...(index ? [icon('chevron')] : []),
                    element('button', { type: 'button', onclick: () => trim(depth) }, icon(depth ? 'folder' : 'server'), element('span', { textContent: name })),
                ]));
            };
            // Keep columns 0..depth, which are already loaded.
            function trim(depth: number) {
                navigation++;
                listing = false;
                open.splice(depth + 1);
                while (columns.children.length > depth + 1) columns.lastElementChild!.remove();
                columns.children[depth]?.querySelector('[aria-current]')?.removeAttribute('aria-current');
                renderPath();
                confirm.disabled = false;
                updateConfirm();
            }
            const preview = (entry: Entry) => {
                columns.querySelector('.pickerPreview')?.remove();
                columns.append(element('section', { className: 'pickerColumn pickerPreview' }, icon('file'),
                    element('strong', { textContent: entry.name }),
                    element('dl', {}, element('dt', { textContent: 'Kind' }), element('dd', { textContent: kind(entry.name) }),
                        element('dt', { textContent: 'Size' }), element('dd', { textContent: formatSize(entry.size) }))));
                columns.scrollLeft = columns.scrollWidth;
            };
            function row(entry: Entry, depth: number) {
                const box = element('input', { type: 'checkbox', title: `Select ${entry.name}` });
                box.dataset.path = entry.path;
                box.setAttribute('aria-label', `Select ${entry.name}`);
                box.onchange = () => {
                    toggle(entry.path, box.checked);
                    if (entry.type === 'file') preview(entry);
                };
                if (entry.type === 'file') {
                    return element('li', { className: 'pickerRow' }, element('label', {}, box, icon('file'),
                        element('span', { className: 'pickerName', textContent: entry.name }), element('small', { textContent: formatSize(entry.size) })));
                }
                const button = element('button', { type: 'button', onclick: () => {
                    columns.children[depth].querySelector('[aria-current]')?.removeAttribute('aria-current');
                    button.setAttribute('aria-current', 'true');
                    void show(entry.path, depth + 1);
                } }, icon('folder'), element('span', { className: 'pickerName', textContent: entry.name }), icon('chevron'));
                if (open[depth + 1] === entry.path) button.setAttribute('aria-current', 'true');
                return element('li', { className: 'pickerRow' }, box, button);
            }
            async function show(path: string, depth: number) {
                const request = ++navigation;
                listing = true;
                confirm.disabled = true;
                open.splice(depth, Infinity, path);
                while (columns.children.length > depth) columns.lastElementChild!.remove();
                const list = element('ul', {});
                const column = element('section', { className: 'pickerColumn' }, list);
                column.setAttribute('aria-label', path.split('/').pop() || 'Data');
                column.setAttribute('aria-busy', 'true');
                list.append(element('li', { className: 'pickerEmpty', textContent: 'Loading…' }));
                columns.append(column);
                columns.scrollLeft = columns.scrollWidth;
                renderPath();
                status.textContent = 'Loading…';
                try {
                    const result = await api<{ path: string; entries: Entry[] }>(`/api/files?path=${encodeURIComponent(path)}`);
                    if (done || request !== navigation) return;
                    listings.set(path, result.entries);
                    list.replaceChildren(...result.entries.map(entry => row(entry, depth)));
                    sync();
                    if (!result.entries.length) list.append(element('li', { className: 'pickerEmpty', textContent: 'No folders or medical files' }));
                    listing = false;
                    confirm.disabled = false;
                    updateConfirm();
                } catch (error) {
                    if (done || request !== navigation) return;
                    list.replaceChildren(element('li', { className: 'pickerEmpty', textContent: 'Could not open this folder' }));
                    status.textContent = error instanceof Error ? error.message : String(error);
                } finally { column.removeAttribute('aria-busy'); }
            }
            async function openLocal(input: HTMLInputElement) {
                const picked = [...input.files ?? []];
                input.value = '';
                if (!picked.length || collecting) return;
                collecting = true;
                local.disabled = confirm.disabled = true;
                try {
                    const files = (await Promise.all(picked.map(async file => await isMedicalFile(file) ? file : undefined))).filter(file => file !== undefined);
                    if (!files.length) throw new Error('No medical files in the selection.');
                    const refs: MedicalFileReference[] = [];
                    for (const [index, file] of files.entries()) {
                        if (done) return;
                        if (viewMode.input.checked) {
                            const path = `${LOCAL}${++localCount}/${file.webkitRelativePath || file.name}`;
                            localFiles.set(path, file);
                            refs.push({ path, name: file.name, size: file.size, mtime: file.lastModified });
                            continue;
                        }
                        status.textContent = `Uploading ${index + 1} of ${files.length}: ${file.name}`;
                        try {
                            refs.push(await (await call(`/api/upload?name=${encodeURIComponent(file.name)}`, {
                                method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
                            })).json() as MedicalFileReference);
                        } catch (error) { throw new Error(`Uploaded ${index} of ${files.length}. ${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
                    }
                    finish(refs);
                } catch (error) {
                    status.textContent = error instanceof Error ? error.message : String(error);
                    local.disabled = confirm.disabled = false;
                    collecting = false;
                }
            }
            fileInput.onchange = () => void openLocal(fileInput);
            folderInput.onchange = () => void openLocal(folderInput);
            form.onsubmit = async event => {
                event.preventDefault();
                if (listing || collecting) return;
                collecting = true;
                confirm.disabled = true;
                status.textContent = 'Collecting files…';
                try {
                    const refs = await api<MedicalFileReference[]>('/api/collect', { paths: selected.size ? [...selected] : [current()] });
                    if (!refs.length) throw new Error('No medical files in the selection.');
                    finish(refs);
                } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); confirm.disabled = false; collecting = false; }
            };
            cancel.onclick = () => finish([]);
            dialog.onclose = () => finish([]);
            document.body.append(dialog);
            updateConfirm();
            dialog.showModal();
            void show('', 0);
        });
    }

    window.dcmViewer = {
        openMedicalFiles: pickFiles,
        readMedicalFile: () => Promise.reject(new Error('Whole-file reads are not available on the server platform.')),
        clearLocalCache: clearRemoteCache,
        logout: async () => {
            await clearRemoteCache();
            await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            location.assign('/login');
        },
        loadRemoteVolumes: async function* (refs) {
            for (const group of remoteLoadGroups(refs)) {
                if (group[0].path.startsWith(LOCAL)) {
                    try {
                        yield await loadMedicalFiles(await Promise.all(group.map(async ref => {
                            const file = localFiles.get(ref.path);
                            if (!file) throw new Error(`${ref.name}: open the local file again.`);
                            return { path: ref.path, name: ref.name, bytes: new Uint8Array(await file.arrayBuffer()) };
                        })));
                    } catch (error) { yield { volumes: [], errors: [error instanceof Error ? error.message : String(error)] }; }
                    finally { for (const ref of group) localFiles.delete(ref.path); }
                    continue;
                }
                try {
                    const result = await api<{ volumes: RemoteVolumeDescriptor[]; errors: string[] }>('/api/volumes', { paths: group.map(ref => ref.path) });
                    yield { errors: result.errors, volumes: result.volumes.map(descriptor => remoteVolume(descriptor, async (token, axis, slice) => {
                        const response = await call(`/api/slice?${new URLSearchParams({ token, axis, slice: String(slice) })}`);
                        return new Uint8Array(await response.arrayBuffer());
                    }, false, { prefetchRadius: 8, readVolume: async token => {
                        const response = await call(`/api/volume?${new URLSearchParams({ token })}`);
                        return response.arrayBuffer();
                    } })) };
                } catch (error) { yield { volumes: [], errors: [error instanceof Error ? error.message : String(error)] }; }
            }
        },
    };
}
