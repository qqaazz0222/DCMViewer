import * as nifti from "nifti-reader-js";
import type { Volume } from "../types";

function toArrayBuffer(bytes: Uint8Array) {
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    );
}

function getTypedArray(
    header: nifti.NIFTI1 | nifti.NIFTI2,
    imageBuffer: ArrayBuffer,
) {
    switch (header.datatypeCode) {
        case nifti.NIFTI1.TYPE_UINT8:
            return new Uint8Array(imageBuffer);
        case nifti.NIFTI1.TYPE_INT16:
            return new Int16Array(imageBuffer);
        case nifti.NIFTI1.TYPE_INT32:
            return new Int32Array(imageBuffer);
        case nifti.NIFTI1.TYPE_FLOAT32:
            return new Float32Array(imageBuffer);
        case nifti.NIFTI1.TYPE_FLOAT64:
            return new Float64Array(imageBuffer);
        case nifti.NIFTI1.TYPE_INT8:
            return new Int8Array(imageBuffer);
        case nifti.NIFTI1.TYPE_UINT16:
            return new Uint16Array(imageBuffer);
        case nifti.NIFTI1.TYPE_UINT32:
            return new Uint32Array(imageBuffer);
        default:
            throw new Error(
                `NIfTI datatype ${header.datatypeCode} is not supported.`,
            );
    }
}

function toFloat32(data: ArrayLike<number>, slope: number, intercept: number) {
    const output = new Float32Array(data.length);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < data.length; index += 1) {
        const value = data[index] * slope + intercept;
        output[index] = value;
        if (value < min) min = value;
        if (value > max) max = value;
    }

    return { data: output, min, max };
}

function parentFolderName(path: string) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : "Imported Files";
}

export function loadNiftiVolume(file: {
    path: string;
    name: string;
    bytes: Uint8Array;
}): Volume {
    let buffer = toArrayBuffer(file.bytes);

    if (nifti.isCompressed(buffer)) {
        buffer = nifti.decompress(buffer);
    }

    if (!nifti.isNIFTI(buffer)) {
        throw new Error("Invalid NIfTI file.");
    }

    const header = nifti.readHeader(buffer);
    const image = nifti.readImage(header, buffer);
    const typed = getTypedArray(header, image);
    const slope = header.scl_slope || 1;
    const intercept = header.scl_inter || 0;
    const { data, min, max } = toFloat32(typed, slope, intercept);
    const width = Math.max(max - min, 1);

    return {
        id: `nifti:${file.path}`,
        name: file.name,
        format: "NIfTI",
        patientId: parentFolderName(file.path),
        studyId: file.name,
        seriesId: file.path,
        dimensions: [
            header.dims[1],
            header.dims[2],
            Math.max(header.dims[3], 1),
        ],
        data,
        windowCenter: (min + max) / 2,
        windowWidth: width,
        min,
        max,
    };
}
