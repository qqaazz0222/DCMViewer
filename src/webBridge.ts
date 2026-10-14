import { remoteVolume, clearRemoteCache } from './remoteSlices';
import type { MedicalFileReference, RemoteVolumeDescriptor } from './types';

type Entry = { name: string; path: string; type: 'dir' | 'file'; size?: number };

// Server platform build only: volumes stay on the server, slices stream over HTTP.
if (import.meta.env.MODE === 'web') {
    async function call(path: string, body?: unknown): Promise<Response> {
        const response = await fetch(path, body === undefined ? undefined : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (response.status === 401) { location.assign('/login'); throw new Error('Session expired. Sign in again.'); }
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed (${response.status}).`);
        return response;
    }
    const api = async <T>(path: string, body?: unknown) => (await call(path, body)).json() as Promise<T>;
    const formatSize = (bytes = 0) => bytes < 2 ** 20 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 2 ** 20).toFixed(1)} MB`;

    function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: object = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    }

    // Server-side file browser. Selection survives folder navigation.
    function pickFiles(): Promise<MedicalFileReference[]> {
        return new Promise(resolve => {
            const selected = new Set<string>();
            const crumbs = element('nav', { className: 'serverPickerCrumbs' });
            const list = element('ul', { className: 'serverPickerList' });
            const status = element('span', { className: 'serverPickerStatus' });
            const cancel = element('button', { type: 'button', textContent: 'Cancel' });
            const confirm = element('button', { type: 'submit', className: 'primary' });
            const form = element('form', { method: 'dialog' },
                element('header', {}, element('strong', { textContent: 'Server files' }), crumbs), list,
                element('footer', {}, status, cancel, confirm));
            const dialog = element('dialog', { className: 'serverPicker' }, form);
            let current = '';
            let done = false;
            const finish = (refs: MedicalFileReference[]) => { if (done) return; done = true; dialog.close(); dialog.remove(); resolve(refs); };
            const updateConfirm = () => { confirm.textContent = selected.size ? `Open ${selected.size} selected` : 'Open this folder'; };

            async function show(path: string) {
                status.textContent = 'Loading…';
                try {
                    const result = await api<{ path: string; entries: Entry[] }>(`/api/files?path=${encodeURIComponent(path)}`);
                    current = result.path;
                    const parts = current ? current.split('/') : [];
                    crumbs.replaceChildren(element('button', { type: 'button', textContent: 'Data', onclick: () => void show('') }),
                        ...parts.flatMap((part, index) => [document.createTextNode(' / '),
                            element('button', { type: 'button', textContent: part, onclick: () => void show(parts.slice(0, index + 1).join('/')) })]));
                    list.replaceChildren(...result.entries.map(entry => {
                        const box = element('input', { type: 'checkbox', checked: selected.has(entry.path), title: `Select ${entry.name}` });
                        box.onchange = () => { if (box.checked) selected.add(entry.path); else selected.delete(entry.path); updateConfirm(); };
                        const label = entry.type === 'dir'
                            ? element('button', { type: 'button', className: 'serverPickerDir', textContent: `${entry.name}/`, onclick: () => void show(entry.path) })
                            : element('span', { textContent: entry.name });
                        return element('li', {}, box, label, element('small', { textContent: entry.type === 'file' ? formatSize(entry.size) : '' }));
                    }));
                    if (!result.entries.length) list.append(element('li', { className: 'serverPickerEmpty', textContent: 'No folders or medical files here.' }));
                    status.textContent = '';
                } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
            }
            form.onsubmit = async event => {
                event.preventDefault();
                confirm.disabled = true;
                status.textContent = 'Collecting files…';
                try {
                    const refs = await api<MedicalFileReference[]>('/api/collect', { paths: selected.size ? [...selected] : [current] });
                    if (!refs.length) throw new Error('No medical files in the selection.');
                    finish(refs);
                } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); confirm.disabled = false; }
            };
            cancel.onclick = () => finish([]);
            dialog.onclose = () => finish([]);
            document.body.append(dialog);
            updateConfirm();
            dialog.showModal();
            void show('');
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
            const groups = refs.filter(ref => /\.(nii|nii\.gz|npy)$/i.test(ref.name)).map(ref => [ref]);
            const dicom = refs.filter(ref => !/\.(nii|nii\.gz|npy)$/i.test(ref.name));
            if (dicom.length) groups.push(dicom);
            for (const group of groups) {
                try {
                    const result = await api<{ volumes: RemoteVolumeDescriptor[]; errors: string[] }>('/api/volumes', { paths: group.map(ref => ref.path) });
                    yield { errors: result.errors, volumes: result.volumes.map(descriptor => remoteVolume(descriptor, async (token, axis, slice) => {
                        const response = await call(`/api/slice?${new URLSearchParams({ token, axis, slice: String(slice) })}`);
                        return new Uint8Array(await response.arrayBuffer());
                    }, false)) };
                } catch (error) { yield { volumes: [], errors: [error instanceof Error ? error.message : String(error)] }; }
            }
        },
    };
}
