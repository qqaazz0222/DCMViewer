import { getVoxel } from "../rendering";
import { hasDicomPreamble } from "../medicalFileDetection";
import { buildDicomVolumes, parseDicomSlice } from "./dicom";
import { loadNiftiVolume } from "./nifti";
import { loadNpyVolume } from "./npy";
import type { MedicalFile, StudyNode, Volume } from "../types";

type LoadProgress = {
    current: number;
    total: number;
    message: string;
};

type LoadMedicalFilesOptions = {
    onProgress?: (progress: LoadProgress) => void;
};

function normalizeBytes(bytes: Uint8Array | ArrayBuffer | number[]) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    return new Uint8Array(bytes);
}

function extensionOf(fileName: string) {
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith(".nii.gz")) return ".nii.gz";
    const lastDot = lowerName.lastIndexOf(".");
    return lastDot >= 0 ? lowerName.slice(lastDot) : "";
}

function waitForProgressPaint() {
    return new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0);
    });
}

export async function loadMedicalFiles(
    files: MedicalFile[],
    options: LoadMedicalFilesOptions = {},
) {
    const dicomSlices = [];
    const volumes: Volume[] = [];
    const errors: string[] = [];
    const total = files.length;

    for (const [index, file] of files.entries()) {
        const normalizedFile = { ...file, bytes: normalizeBytes(file.bytes) };
        const extension = extensionOf(file.name || file.path);

        try {
            if (hasDicomPreamble(normalizedFile.bytes)) {
                dicomSlices.push(parseDicomSlice(normalizedFile));
            } else if (extension === ".nii" || extension === ".nii.gz") {
                volumes.push(loadNiftiVolume(normalizedFile));
            } else if (extension === ".npy") {
                volumes.push(...loadNpyVolume(normalizedFile));
            } else {
                dicomSlices.push(parseDicomSlice(normalizedFile));
            }
        } catch (error) {
            errors.push(
                `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        options.onProgress?.({
            current: index + 1,
            total,
            message: `Processing ${index + 1} of ${total}`,
        });

        if ((index + 1) % 8 === 0 || index + 1 === total) {
            await waitForProgressPaint();
        }
    }

    try {
        options.onProgress?.({
            current: total,
            total,
            message: "Building volumes...",
        });
        volumes.push(...buildDicomVolumes(dicomSlices));
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
    }

    return { volumes, errors };
}

export function buildStudyTree(volumes: Volume[]): StudyNode[] {
    const patientMap = new Map<string, Map<string, Volume[]>>();

    for (const volume of volumes) {
        const studyMap =
            patientMap.get(volume.patientId) ?? new Map<string, Volume[]>();
        studyMap.set(volume.studyId, [
            ...(studyMap.get(volume.studyId) ?? []),
            volume,
        ]);
        patientMap.set(volume.patientId, studyMap);
    }

    return [...patientMap.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([patientId, studies]) => ({
            patientId,
            studies: [...studies.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([studyId, studyVolumes]) => ({
                    studyId,
                    volumes: [...studyVolumes].sort((left, right) => {
                        const leftChannel = left.channelIndex ?? Number.NaN;
                        const rightChannel = right.channelIndex ?? Number.NaN;

                        if (
                            Number.isFinite(leftChannel) &&
                            Number.isFinite(rightChannel) &&
                            leftChannel !== rightChannel
                        ) {
                            return leftChannel - rightChannel;
                        }

                        if (
                            Number.isFinite(leftChannel) &&
                            !Number.isFinite(rightChannel)
                        ) {
                            return 1;
                        }

                        if (
                            !Number.isFinite(leftChannel) &&
                            Number.isFinite(rightChannel)
                        ) {
                            return -1;
                        }

                        return left.name.localeCompare(right.name);
                    }),
                })),
        }));
}

export function createDifferenceVolume(
    first: Volume,
    second: Volume,
): Volume | undefined {
    const [width, height, depth] = first.dimensions;
    const samePlane =
        width === second.dimensions[0] && height === second.dimensions[1];

    if (!samePlane) {
        return undefined;
    }

    if (first.remote || second.remote) {
        const maxAbs = Math.max(Math.abs(second.max - first.min), Math.abs(second.min - first.max), 1);
        const mapZ = (z: number) => depth > 1 ? Math.round(z / (depth - 1) * (second.dimensions[2] - 1)) : 0;
        const voxel = (x: number, y: number, z: number) => getVoxel(second, x, y, mapZ(z)) - getVoxel(first, x, y, z);
        return {
            id: `diff:${first.id}:${second.id}`, name: `${second.name} - ${first.name}`, format: "NPY",
            patientId: first.patientId, studyId: "Difference", seriesId: "Difference",
            dimensions: first.dimensions, data: new Float32Array(0), windowCenter: 0,
            windowWidth: maxAbs * 2, min: -maxAbs, max: maxAbs, renderMode: "difference", sourceParentDir: "Difference",
            remote: {
                version: `${first.remote?.version ?? first.id}|${second.remote?.version ?? second.id}`,
                getVoxel: voxel,
                ensureSlice: async (axis, slice, signal) => {
                    const [left, right] = await Promise.all([
                        first.remote?.ensureSlice(axis, slice, signal),
                        second.remote?.ensureSlice(axis, axis === "axial" ? mapZ(slice) : slice, signal),
                    ]);
                    return (x, y, z) => (right ? right(x, y, mapZ(z)) : getVoxel(second, x, y, mapZ(z))) -
                        (left ? left(x, y, z) : getVoxel(first, x, y, z));
                },
                prefetch: (axis, slice, signal) => {
                    first.remote?.prefetch?.(axis, slice, signal);
                    second.remote?.prefetch?.(axis, axis === "axial" ? mapZ(slice) : slice, signal);
                },
            },
        };
    }
    const data = new Float32Array(first.data.length);
    let maxAbs = 1;
    const firstMaxSlice = Math.max(depth - 1, 0);
    const secondMaxSlice = Math.max(second.dimensions[2] - 1, 0);
    const planeSize = width * height;

    for (let z = 0; z < depth; z += 1) {
        const sliceRatio = firstMaxSlice > 0 ? z / firstMaxSlice : 0;
        const secondZ = Math.round(sliceRatio * secondMaxSlice);

        for (let index = 0; index < planeSize; index += 1) {
            const firstIndex = z * planeSize + index;
            const secondIndex = secondZ * planeSize + index;
            const value = second.data[secondIndex] - first.data[firstIndex];
            data[firstIndex] = value;
            maxAbs = Math.max(maxAbs, Math.abs(value));
        }
    }

    return {
        id: `diff:${first.id}:${second.id}`,
        name: `${second.name} - ${first.name}`,
        format: "NPY",
        patientId: first.patientId,
        studyId: "Difference",
        seriesId: "Difference",
        dimensions: first.dimensions,
        data,
        windowCenter: 0,
        windowWidth: maxAbs * 2,
        min: -maxAbs,
        max: maxAbs,
        renderMode: "difference",
        sourceParentDir: "Difference",
    };
}
