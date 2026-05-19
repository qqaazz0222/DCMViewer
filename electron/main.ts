import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const supportedExtensions = new Set([".dcm", ".dicom", ".nii", ".gz", ".npy"]);

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

        const lowerPath = targetPath.toLowerCase();
        const extension = extname(lowerPath);
        if (
            supportedExtensions.has(extension) ||
            lowerPath.endsWith(".nii.gz")
        ) {
            collected.push(targetPath);
        }
    }

    return collected.sort((left, right) => left.localeCompare(right));
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
        return Promise.all(
            filePaths.map(async (path) => {
                const buffer = await readFile(path);
                return {
                    path,
                    name: path.split(/[\\/]/).pop() ?? path,
                    bytes: buffer,
                };
            }),
        );
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
