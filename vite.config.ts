import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import { fileURLToPath, URL } from "node:url";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const zlibShimExpression = `({ inflateRawSync: function () { throw new Error("Compressed DICOM transfer syntaxes are not supported yet."); } })`;

const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// Short hash of the commit being built; "-dirty" marks uncommitted changes in the build.
function gitCommit() {
    try {
        const hash = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
        const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() !== "";
        return dirty ? `${hash}-dirty` : hash;
    } catch {
        return "unknown";
    }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
    base: "./",
    root: "app",
    publicDir: "../public",
    define: {
        __APP_VERSION__: JSON.stringify(appVersion),
        __APP_COMMIT__: JSON.stringify(gitCommit()),
    },
    build: mode === "vscode" ? {
        outDir: "../vscode-extension/media",
        emptyOutDir: true,
        manifest: true,
        modulePreload: false,
    } : mode === "web" ? { outDir: "../platform/dist", emptyOutDir: true } : { outDir: "../dist", emptyOutDir: true },
    // `npm run dev:web` serves the viewer with hot reload against a running platform server.
    server: mode === "web" ? { proxy: { "/api": "http://127.0.0.1:8080", "/login": "http://127.0.0.1:8080" } } : undefined,
    resolve: {
        alias: {
            zlib: fileURLToPath(
                new URL("./src/shims/zlib.ts", import.meta.url),
            ),
        },
    },
    plugins: [
        {
            name: "dicom-parser-zlib-shim",
            enforce: "pre",
            transform(code, id) {
                if (!id.includes("dicom-parser")) return null;

                return code.replace(
                    /require\(["']zlib["']\)/g,
                    zlibShimExpression,
                );
            },
        },
        react(),
        ...(mode === "vscode" || mode === "web" ? [] : [electron({
            main: {
                entry: "../electron/main.ts",
                vite: { build: { outDir: "../dist-electron" } },
            },
            preload: {
                input: "electron/preload.ts",
                vite: { build: { outDir: "../dist-electron" } },
            },
            renderer: {},
        })]),
    ],
}));
