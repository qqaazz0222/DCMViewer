// Runs scripts/register.py for the desktop app (Electron main) and the web platform server.
// Hosts supply where packages live, how to confirm an install, and where progress goes.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RegistrationStatus } from "../src/types";

export type RegistrationVolume = { data: Float32Array; dimensions: [number, number, number] };
export type RegistrationHost = {
    // Holds uv, the managed Python, the venv and the package cache; deleting it removes everything.
    root: string;
    script: string;
    status: (status: RegistrationStatus) => void;
    // Omitted: install without asking (the server operator opted in by enabling registration).
    confirmInstall?: (info: { label: string; size: string; packages: string[]; root: string }) => Promise<boolean>;
    signal?: AbortSignal;
};

// Pinned uv release; checksums come from the GitHub release's asset digests.
const UV_VERSION = "0.13.0";
const UV_ARCHIVES: Record<string, { name: string; sha256: string }> = {
    "darwin-arm64": { name: "uv-aarch64-apple-darwin.tar.gz", sha256: "a9c1b29002cf3c83f07fa9cd8a887a3be0107d90e23189721221e7257db8e3d6" },
    "darwin-x64": { name: "uv-x86_64-apple-darwin.tar.gz", sha256: "5f44dcbde809b632f47c36fadb241cb4d6f9af71d0c8f172b5d2026d3dde742c" },
    "win32-x64": { name: "uv-x86_64-pc-windows-msvc.zip", sha256: "088962f9e7b7bd9ea740c04c650b2a21c8928c345bd99ac24350dc924dba656c" },
    "win32-arm64": { name: "uv-aarch64-pc-windows-msvc.zip", sha256: "cb54028b59aa87f11cf6dec293ce000420043a49a8aea522e822a671321f8932" },
    "linux-x64": { name: "uv-x86_64-unknown-linux-gnu.tar.gz", sha256: "1468ebd5a5541121837c5a2817b9972ba6090fa6caa3d142620850a47fb75154" },
    "linux-arm64": { name: "uv-aarch64-unknown-linux-gnu.tar.gz", sha256: "3ccfb6af6e242433eb552f7d9676abd5412c6595c497e990d9c8cb7b5bd4d2c3" },
};
const PYTHON_VERSION = "3.12";
// Each method installs only its own packages, so ANTs or elastix users never download PyTorch.
export const REGISTRATION_PACKAGES: Record<string, { label: string; packages: string[]; size: string }> = {
    convexadam: { label: "ConvexAdam", packages: ["convexAdam==0.2.0"], size: "about 1 GB (includes PyTorch)" },
    ants: { label: "ANTs", packages: ["antspyx==0.6.3"], size: "about 200 MB" },
    elastix: { label: "elastix", packages: ["itk-elastix==0.25.4"], size: "about 1 GB (includes ITK)" },
};

const execFileAsync = promisify(execFile);
const exists = (path: string) => access(path).then(() => true, () => false);
const cancelled = () => new Error("Registration was cancelled.");

// Surfaces the tool's last stderr lines instead of Node's generic "Command failed".
async function run(command: string, args: string[], signal?: AbortSignal, env?: NodeJS.ProcessEnv) {
    try {
        await execFileAsync(command, args, { env, signal, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
        if (signal?.aborted) throw cancelled();
        const stderr = (error as { stderr?: string }).stderr?.trim().split("\n").slice(-3).join("\n");
        throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
    }
}

// Streams register.py's "@progress <0..1> <message>" stderr lines; other stderr lines feed the error message.
function runRegistrationScript(python: string, args: string[], host: RegistrationHost) {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(python, args, { stdio: ["ignore", "ignore", "pipe"], signal: host.signal });
        let pending = "";
        let tail: string[] = [];
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            const lines = (pending + chunk).split(/\r?\n/);
            pending = lines.pop() ?? "";
            for (const line of lines) {
                const match = /^@progress (\S+) ?(.*)$/.exec(line);
                if (match) host.status({ phase: "run", progress: Number(match[1]), message: match[2] });
                else if (line.trim()) tail = [...tail.slice(-2), line];
            }
        });
        child.on("error", error => reject(host.signal?.aborted ? cancelled() : error));
        child.on("close", code => host.signal?.aborted ? reject(cancelled())
            : code === 0 ? resolve() : reject(new Error(tail.join("\n") || `Registration exited with code ${code}.`)));
    });
}

async function ensureUv(host: RegistrationHost) {
    const name = process.platform === "win32" ? "uv.exe" : "uv";
    const binary = join(host.root, "uv", name);
    if (await exists(binary)) return binary;
    const archive = UV_ARCHIVES[`${process.platform}-${process.arch}`];
    if (!archive) throw new Error(`Automatic setup is not available on ${process.platform}-${process.arch}. Set DCMVIEWER_PYTHON instead.`);

    host.status({ phase: "setup", message: "Step 1/3 · Downloading uv…" });
    const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${archive.name}`, { signal: host.signal });
    if (!response.ok) throw new Error(`uv download failed: GitHub responded with ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256) throw new Error("uv download failed its checksum.");

    await mkdir(host.root, { recursive: true });
    const temp = await mkdtemp(join(host.root, "uv-download-"));
    try {
        const archivePath = join(temp, archive.name);
        await writeFile(archivePath, bytes);
        // bsdtar ships with macOS and Windows 10+ and reads both .tar.gz and .zip; GNU tar covers Linux.
        await run("tar", ["-xf", archivePath, "-C", temp], host.signal);
        const nested = join(temp, archive.name.replace(/\.(tar\.gz|zip)$/, ""), name);
        await mkdir(dirname(binary), { recursive: true });
        await rename(await exists(nested) ? nested : join(temp, name), binary);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
    return binary;
}

// DCMVIEWER_PYTHON skips setup; otherwise a private uv-managed Python lives under host.root.
async function registrationPython(method: string, host: RegistrationHost) {
    if (process.env.DCMVIEWER_PYTHON) return process.env.DCMVIEWER_PYTHON;
    const spec = REGISTRATION_PACKAGES[method];
    const venv = join(host.root, "venv");
    const python = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
    const marker = join(host.root, `${method}.installed`);
    // scipy 1.15 wheels fail to load on macOS 27 (dyld rejects their __thread_bss section); antspyx caps scipy below 1.16.
    const requirement = ["numpy", "scipy!=1.15.*", ...spec.packages].join(" ");
    if (await readFile(marker, "utf8").catch(() => "") === requirement && await exists(python)) return python;
    if (host.confirmInstall && !await host.confirmInstall({ ...spec, root: host.root })) throw new Error("Package installation was cancelled.");

    const uv = await ensureUv(host);
    const env = { ...process.env, UV_CACHE_DIR: join(host.root, "cache"), UV_PYTHON_INSTALL_DIR: join(host.root, "python"), UV_PYTHON_PREFERENCE: "only-managed" };
    if (!await exists(python)) {
        host.status({ phase: "setup", message: `Step 2/3 · Installing Python ${PYTHON_VERSION}…` });
        await run(uv, ["venv", "--clear", "--python", PYTHON_VERSION, venv], host.signal, env);
    }
    host.status({ phase: "setup", message: `Step 3/3 · Installing ${spec.label} packages, ${spec.size}…` });
    // auto: CUDA build when an NVIDIA driver is present, CPU build otherwise (Linux PyPI torch would pull CUDA regardless).
    await run(uv, ["pip", "install", "--python", python, "--torch-backend", "auto", ...requirement.split(" ")], host.signal, env);
    await writeFile(marker, requirement);
    return python;
}

export async function registerVolumes(method: string, fixed: RegistrationVolume, moving: RegistrationVolume,
    params: Record<string, unknown>, host: RegistrationHost) {
    if (!(method in REGISTRATION_PACKAGES)) throw new Error(`Unknown registration method: ${method}`);
    const python = await registrationPython(method, host);
    const directory = await mkdtemp(join(tmpdir(), "dcmviewer-registration-"));
    try {
        const [fixedPath, movingPath, outPath, paramsPath] = ["fixed.f32", "moving.f32", "warped.f32", "params.json"].map(name => join(directory, name));
        await writeFile(paramsPath, JSON.stringify(params));
        await writeFile(fixedPath, Buffer.from(fixed.data.buffer, fixed.data.byteOffset, fixed.data.byteLength));
        await writeFile(movingPath, Buffer.from(moving.data.buffer, moving.data.byteOffset, moving.data.byteLength));
        host.status({ phase: "run", progress: 0, message: `Starting ${REGISTRATION_PACKAGES[method].label}…` });
        await runRegistrationScript(python, [host.script, method, fixedPath, movingPath, outPath,
            fixed.dimensions.join(","), moving.dimensions.join(","), paramsPath], host);
        // Copy into a fresh, aligned buffer for the Float32Array view.
        return new Float32Array(new Uint8Array(await readFile(outPath)).buffer);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
