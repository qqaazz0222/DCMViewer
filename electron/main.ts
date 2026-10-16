import { app, BrowserWindow, dialog, ipcMain, net, shell } from "electron";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasDicomPreamble, hasMedicalExtension } from "../src/medicalFileDetection";

const selectedMedicalFiles = new Set<string>();

async function isSupportedMedicalPath(path: string) {
    if (hasMedicalExtension(path)) return true;
    const file = await open(path, "r");
    try {
        const header = new Uint8Array(132);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        return hasDicomPreamble(header.subarray(0, bytesRead));
    } finally {
        await file.close();
    }
}

async function collectFiles(paths: string[]): Promise<string[]> {
    const collected: string[] = [];

    for (const targetPath of paths) {
        const info = await stat(targetPath);

        if (info.isDirectory()) {
            const entries = await readdir(targetPath);
            const nested = entries.map((entry) => join(targetPath, entry));
            collected.push(...(await collectFiles(nested)));
            continue;
        }

        if (info.isFile() && await isSupportedMedicalPath(targetPath)) {
            collected.push(targetPath);
        }
    }

    return collected.sort((left, right) => left.localeCompare(right));
}

async function readMedicalFile(path: string) {
    const buffer = await readFile(path);
    return {
        path,
        name: basename(path),
        bytes: buffer,
    };
}

const LATEST_RELEASE_URL = "https://api.github.com/repos/qqaazz0222/DCMViewer/releases/latest";

function isNewerVersion(latest: string, current: string) {
    const a = latest.replace(/^v/, "").split(".").map(Number);
    const b = current.split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff) return diff > 0;
    }
    return false;
}

async function checkForUpdates(window: BrowserWindow) {
    try {
        const response = await net.fetch(LATEST_RELEASE_URL, {
            headers: { Accept: "application/vnd.github+json" },
        });
        if (!response.ok) return;
        const release = (await response.json()) as { tag_name: string; html_url: string };
        if (!isNewerVersion(release.tag_name, app.getVersion())) return;

        const { response: choice } = await dialog.showMessageBox(window, {
            type: "info",
            title: "Update available",
            message: `DCMViewer ${release.tag_name} is available.`,
            detail: `Current version: v${app.getVersion()}`,
            buttons: ["Download", "Later"],
            defaultId: 0,
            cancelId: 1,
        });
        if (choice === 0) await shell.openExternal(release.html_url);
    } catch {
        // ponytail: offline or rate-limited, skip silently until next launch
    }
}

function createWindow() {
    const currentDirectory = dirname(fileURLToPath(import.meta.url));
    const window = new BrowserWindow({
        width: 1480,
        height: 960,
        minWidth: 1120,
        minHeight: 720,
        title: "DCMViewer",
        backgroundColor: "#101316",
        icon: join(currentDirectory, "../assets/icon.png"),
        webPreferences: {
            preload: join(currentDirectory, "preload.mjs"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (process.env.VITE_DEV_SERVER_URL) {
        window.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
        window.loadFile(join(currentDirectory, "../dist/index.html"));
    }

    return window;
}

app.whenReady().then(() => {
    ipcMain.handle("dialog:open-medical-files", async () => {
        const result = await dialog.showOpenDialog({
            title: "Select CT image files or folders",
            properties: ["openFile", "openDirectory", "multiSelections"],
            filters: [
                { name: "All files", extensions: ["*"] },
                {
                    name: "Medical volumes",
                    extensions: ["dcm", "dicom", "nii", "nii.gz", "npy"],
                },
            ],
        });

        if (result.canceled) {
            return [];
        }

        const filePaths = await collectFiles(result.filePaths);
        selectedMedicalFiles.clear();
        filePaths.forEach((path) => selectedMedicalFiles.add(path));

        return Promise.all(
            filePaths.map(async (path) => {
                const info = await stat(path);
                return {
                    path,
                    name: basename(path),
                    size: info.size,
                };
            }),
        );
    });

    ipcMain.handle("medical-file:read", async (_event, path: string) => {
        if (!selectedMedicalFiles.has(path)) {
            throw new Error("The requested file was not selected.");
        }

        return readMedicalFile(path);
    });

    const window = createWindow();
    window.webContents.once("did-finish-load", () => void checkForUpdates(window));

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
