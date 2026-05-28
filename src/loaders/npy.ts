import type { Volume } from "../types";

type NpyHeader = {
    descriptor: string;
    fortranOrder: boolean;
    shape: number[];
    dataOffset: number;
};

const textDecoder = new TextDecoder("latin1");

function parseHeader(bytes: Uint8Array): NpyHeader {
    if (
        bytes[0] !== 0x93 ||
        bytes[1] !== 0x4e ||
        bytes[2] !== 0x55 ||
        bytes[3] !== 0x4d ||
        bytes[4] !== 0x50 ||
        bytes[5] !== 0x59
    ) {
        throw new Error("Invalid NPY file.");
    }

    const majorVersion = bytes[6];
    const headerLength =
        majorVersion === 1
            ? bytes[8] | (bytes[9] << 8)
            : bytes[8] |
              (bytes[9] << 8) |
              (bytes[10] << 16) |
              (bytes[11] << 24);
    const headerStart = majorVersion === 1 ? 10 : 12;
    const headerText = textDecoder.decode(
        bytes.slice(headerStart, headerStart + headerLength),
    );

    const descriptor = /'descr':\s*'([^']+)'/.exec(headerText)?.[1];
    const fortranOrder =
        /'fortran_order':\s*(True|False)/.exec(headerText)?.[1] === "True";
    const shapeText = /'shape':\s*\(([^)]*)\)/.exec(headerText)?.[1];

    if (!descriptor || !shapeText) {
        throw new Error("Unable to parse the NPY header.");
    }

    const shape = shapeText
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map(Number);

    if (
        shape.length < 2 ||
        shape.length > 4 ||
        shape.some((value) => !Number.isFinite(value))
    ) {
        throw new Error("Only 2D, 3D, or 4D NPY volumes are supported.");
    }

    return {
        descriptor,
        fortranOrder,
        shape,
        dataOffset: headerStart + headerLength,
    };
}

function readNumericData(bytes: Uint8Array, header: NpyHeader): Float32Array {
    if (header.fortranOrder) {
        throw new Error("Fortran-order NPY files are not supported yet.");
    }

    const buffer = bytes.buffer.slice(
        bytes.byteOffset + header.dataOffset,
        bytes.byteOffset + bytes.byteLength,
    );
    const littleEndian =
        header.descriptor.startsWith("<") || header.descriptor.startsWith("|");
    const type = header.descriptor.replace(/[<>=|]/, "");
    const view = new DataView(buffer);
    const elementCount = header.shape.reduce(
        (total, value) => total * value,
        1,
    );
    const output = new Float32Array(elementCount);

    for (let index = 0; index < elementCount; index += 1) {
        const offset = index * Number(type.slice(1));

        switch (type) {
            case "u1":
                output[index] = view.getUint8(offset);
                break;
            case "i1":
                output[index] = view.getInt8(offset);
                break;
            case "u2":
                output[index] = view.getUint16(offset, littleEndian);
                break;
            case "i2":
                output[index] = view.getInt16(offset, littleEndian);
                break;
            case "u4":
                output[index] = view.getUint32(offset, littleEndian);
                break;
            case "i4":
                output[index] = view.getInt32(offset, littleEndian);
                break;
            case "f4":
                output[index] = view.getFloat32(offset, littleEndian);
                break;
            case "f8":
                output[index] = view.getFloat64(offset, littleEndian);
                break;
            default:
                throw new Error(
                    `${header.descriptor} NPY data type is not supported.`,
                );
        }
    }

    return output;
}

function getMinMax(data: Float32Array) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (const value of data) {
        if (value < min) min = value;
        if (value > max) max = value;
    }

    return { min, max };
}

function parentFolderName(path: string) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : "Imported Files";
}

export function loadNpyVolume(file: {
    path: string;
    name: string;
    bytes: Uint8Array;
}): Volume[] {
    const header = parseHeader(file.bytes);
    const data = readNumericData(file.bytes, header);
    const parentDir = parentFolderName(file.path);

    if (header.shape.length === 4) {
        const [channelCount, depth, height, width] = header.shape;
        const channelVoxelCount = depth * height * width;

        return Array.from({ length: channelCount }, (_, channelIndex) => {
            const channelOffset = channelIndex * channelVoxelCount;
            const channelData = data.slice(
                channelOffset,
                channelOffset + channelVoxelCount,
            );
            const { min, max } = getMinMax(channelData);
            const center = (min + max) / 2;
            const windowWidth = Math.max(max - min, 1);
            const channelLabel = `Channel ${channelIndex + 1}`;

            return {
                id: `npy:${file.path}:ch${channelIndex}`,
                name: `${file.name} [${channelLabel}]`,
                format: "NPY",
                patientId: parentDir,
                studyId: file.name,
                seriesId: `${file.path}:ch${channelIndex}`,
                dimensions: [width, height, depth],
                data: channelData,
                windowCenter: center,
                windowWidth,
                min,
                max,
                sourcePath: file.path,
                sourceFileName: file.name,
                sourceParentDir: parentDir,
                channelIndex,
                channelLabel,
            };
        });
    }

    const [depthOrHeight, heightOrWidth, maybeWidth] = header.shape;
    const dimensions: [number, number, number] =
        header.shape.length === 3
            ? [maybeWidth, heightOrWidth, depthOrHeight]
            : [heightOrWidth, depthOrHeight, 1];
    const { min, max } = getMinMax(data);
    const center = (min + max) / 2;
    const width = Math.max(max - min, 1);

    return [
        {
            id: `npy:${file.path}`,
            name: file.name,
            format: "NPY",
            patientId: parentDir,
            studyId: file.name,
            seriesId: file.path,
            dimensions,
            data,
            windowCenter: center,
            windowWidth: width,
            min,
            max,
            sourcePath: file.path,
            sourceFileName: file.name,
            sourceParentDir: parentDir,
        },
    ];
}
