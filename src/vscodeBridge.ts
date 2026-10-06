import type { MedicalFileReference } from './types';

type VsCodeApi = { postMessage(message: unknown): void };
declare const acquireVsCodeApi: undefined | (() => VsCodeApi);

// Acquire once and keep the VS Code API private to this module.
if (typeof acquireVsCodeApi === 'function') {
    const api = acquireVsCodeApi();
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    function request<T>(method: string, path?: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve: value => resolve(value as T), reject });
            api.postMessage({ id, method, path });
        });
    }
    window.addEventListener('message', (event: MessageEvent) => {
        const message = event.data;
        if (!message || !Number.isSafeInteger(message.id)) return;
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        if (typeof message.error === 'string') call.reject(new Error(message.error));
        else call.resolve(message.result);
    });
    window.addEventListener('pagehide', () => {
        for (const call of pending.values()) call.reject(new Error('Viewer closed.'));
        pending.clear();
    });
    window.dcmViewer = {
        getInitialFiles: () => request<MedicalFileReference[]>('initialFiles'),
        openMedicalFiles: () => request<MedicalFileReference[]>('openFiles'),
        readMedicalFile: async path => {
            const file = await request<{ path: string; name: string; base64: string }>('readFile', path);
            const binary = atob(file.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return { path: file.path, name: file.name, bytes };
        },
    };
}
