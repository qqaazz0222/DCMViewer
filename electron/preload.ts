import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dcmViewer", {
    openMedicalFiles: () => ipcRenderer.invoke("dialog:open-medical-files"),
});
