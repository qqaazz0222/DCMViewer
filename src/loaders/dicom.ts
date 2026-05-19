import dicomParser from "dicom-parser";
import type { Volume } from "../types";

type DicomSlice = {
    filePath: string;
    fileName: string;
    patientId: string;
    studyId: string;
    seriesId: string;
    rows: number;
    columns: number;
    instanceNumber: number;
    position: number;
    windowCenter?: number;
    windowWidth?: number;
    pixels: Float32Array;
};

function numberValue(dataSet: dicomParser.DataSet, tag: string, fallback = 0) {
    const value = dataSet.string(tag);
    const parsed = value ? Number.parseFloat(value.split("\\")[0]) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
}

function textValue(
    dataSet: dicomParser.DataSet,
    tag: string,
    fallback: string,
) {
    const value = dataSet.string(tag)?.trim();
    return value && value.length > 0 ? value : fallback;
}

function pixelArray(
    dataSet: dicomParser.DataSet,
    rows: number,
    columns: number,
) {
    const pixelElement = dataSet.elements.x7fe00010;
    if (!pixelElement) {
        throw new Error("DICOM pixel data was not found.");
    }

    const bitsAllocated = numberValue(dataSet, "x00280100", 16);
    const pixelRepresentation = numberValue(dataSet, "x00280103", 0);
    const slope = numberValue(dataSet, "x00281053", 1);
    const intercept = numberValue(dataSet, "x00281052", 0);
    const pixelCount = rows * columns;
    const output = new Float32Array(pixelCount);
    const view = new DataView(
        dataSet.byteArray.buffer,
        dataSet.byteArray.byteOffset + pixelElement.dataOffset,
        pixelElement.length,
    );

    for (let index = 0; index < pixelCount; index += 1) {
        const offset = bitsAllocated === 8 ? index : index * 2;
        const stored =
            bitsAllocated === 8
                ? pixelRepresentation === 1
                    ? view.getInt8(offset)
                    : view.getUint8(offset)
                : pixelRepresentation === 1
                  ? view.getInt16(offset, true)
                  : view.getUint16(offset, true);
        output[index] = stored * slope + intercept;
    }

    return output;
}

export function parseDicomSlice(file: {
    path: string;
    name: string;
    bytes: Uint8Array;
}): DicomSlice {
    const dataSet = dicomParser.parseDicom(file.bytes);
    const rows = numberValue(dataSet, "x00280010");
    const columns = numberValue(dataSet, "x00280011");

    if (!rows || !columns) {
        throw new Error("DICOM row/column metadata was not found.");
    }

    return {
        filePath: file.path,
        fileName: file.name,
        patientId: textValue(dataSet, "x00100020", "Unknown Patient"),
        studyId: textValue(
            dataSet,
            "x0020000d",
            textValue(dataSet, "x00080020", "Unknown Study"),
        ),
        seriesId: textValue(
            dataSet,
            "x0020000e",
            textValue(dataSet, "x0008103e", "Series"),
        ),
        rows,
        columns,
        instanceNumber: numberValue(dataSet, "x00200013"),
        position: numberValue(
            dataSet,
            "x00201041",
            numberValue(dataSet, "x00200013"),
        ),
        windowCenter: numberValue(dataSet, "x00281050", Number.NaN),
        windowWidth: numberValue(dataSet, "x00281051", Number.NaN),
        pixels: pixelArray(dataSet, rows, columns),
    };
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

export function buildDicomVolumes(slices: DicomSlice[]): Volume[] {
    const groups = new Map<string, DicomSlice[]>();

    for (const slice of slices) {
        const key = `${slice.patientId}\u0000${slice.studyId}\u0000${slice.seriesId}`;
        groups.set(key, [...(groups.get(key) ?? []), slice]);
    }

    return [...groups.entries()].map(([key, group]) => {
        const [patientId, studyId, seriesId] = key.split("\u0000");
        const sorted = [...group].sort((left, right) => {
            if (left.position !== right.position)
                return left.position - right.position;
            return left.instanceNumber - right.instanceNumber;
        });
        const first = sorted[0];
        const pixelsPerSlice = first.rows * first.columns;
        const volumeData = new Float32Array(pixelsPerSlice * sorted.length);

        sorted.forEach((slice, index) => {
            if (slice.rows !== first.rows || slice.columns !== first.columns) {
                throw new Error(
                    `${slice.fileName} has a different row/column size than other slices in the same series.`,
                );
            }
            volumeData.set(slice.pixels, index * pixelsPerSlice);
        });

        const { min, max } = getMinMax(volumeData);
        const storedCenter = first.windowCenter;
        const storedWidth = first.windowWidth;
        const windowCenter =
            typeof storedCenter === "number" && Number.isFinite(storedCenter)
                ? storedCenter
                : (min + max) / 2;
        const windowWidth =
            typeof storedWidth === "number" && Number.isFinite(storedWidth)
                ? Math.max(storedWidth, 1)
                : Math.max(max - min, 1);

        return {
            id: `dicom:${patientId}:${studyId}:${seriesId}`,
            name: `${patientId} / ${seriesId}`,
            format: "DICOM",
            patientId,
            studyId,
            seriesId,
            dimensions: [first.columns, first.rows, sorted.length],
            data: volumeData,
            windowCenter,
            windowWidth,
            min,
            max,
        };
    });
}
