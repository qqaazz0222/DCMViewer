import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dcmViewer", {
    openMedicalFiles: () => ipcRenderer.invoke("dialog:open-medical-files"),
    readMedicalFile: (path: string) =>
        ipcRenderer.invoke("medical-file:read", path),
});
