import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const supportedExtensions = new Set([".dcm", ".dicom", ".nii", ".npy"]);
const selectedMedicalFiles = new Set<string>();

function isSupportedMedicalPath(path: string) {
    const lowerPath = path.toLowerCase();
    return (
        supportedExtensions.has(extname(lowerPath)) ||
        lowerPath.endsWith(".nii.gz")
    );
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

        if (isSupportedMedicalPath(targetPath)) {
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
}

app.whenReady().then(() => {
    ipcMain.handle("dialog:open-medical-files", async () => {
        const result = await dialog.showOpenDialog({
            title: "Select CT image files or folders",
            properties: ["openFile", "openDirectory", "multiSelections"],
            filters: [
                {
                    name: "Medical volumes",
                    extensions: ["dcm", "dicom", "nii", "nii.gz", "npy"],
                },
                { name: "All files", extensions: ["*"] },
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
        if (!selectedMedicalFiles.has(path) || !isSupportedMedicalPath(path)) {
            throw new Error("The requested file was not selected.");
        }

        return readMedicalFile(path);
    });

    createWindow();

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
