import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import { fileURLToPath, URL } from "node:url";

const zlibShimExpression = `({ inflateRawSync: function () { throw new Error("Compressed DICOM transfer syntaxes are not supported yet."); } })`;

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
    base: "./",
    build: mode === "vscode" ? {
        outDir: "vscode-extension/media",
        emptyOutDir: true,
        manifest: true,
        modulePreload: false,
    } : mode === "web" ? { outDir: "platform/dist", emptyOutDir: true } : undefined,
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
                entry: "electron/main.ts",
            },
            preload: {
                input: "electron/preload.ts",
            },
            renderer: {},
        })]),
    ],
}));
