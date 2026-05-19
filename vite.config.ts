import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import { fileURLToPath, URL } from "node:url";

const zlibShimExpression = `({ inflateRawSync: function () { throw new Error("Compressed DICOM transfer syntaxes are not supported yet."); } })`;

// https://vite.dev/config/
export default defineConfig({
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
        electron({
            main: {
                entry: "electron/main.ts",
            },
            preload: {
                input: "electron/preload.ts",
            },
            renderer: {},
        }),
    ],
});
