import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dcmViewer", {
    openMedicalFiles: () => ipcRenderer.invoke("dialog:open-medical-files"),
    readMedicalFile: (path: string) =>
        ipcRenderer.invoke("medical-file:read", path),
    registerVolumes: (method: string, fixed: unknown, moving: unknown, params: unknown) =>
        ipcRenderer.invoke("registration:run", method, fixed, moving, params),
    cancelRegistration: () => ipcRenderer.invoke("registration:cancel"),
    registrationSource: "memory",
    onRegistrationStatus: (listener: (status: unknown) => void) => {
        const handler = (_event: unknown, status: unknown) => listener(status);
        ipcRenderer.on("registration:status", handler);
        return () => void ipcRenderer.off("registration:status", handler);
    },
    checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates"),
});
