import dicomParser from "dicom-parser";
import type { Volume } from "../types";

type DicomSlice = {
    filePath: string;
    fileName: string;
    patientId: string;
    studyId: string;
    seriesNumber: string;
    seriesDescription: string;
    studyInstanceUid: string;
    seriesInstanceUid: string;
    modality: string;
    studyDate: string;
    pixelSpacing: string;
    sliceThickness: string;
    rows: number;
    columns: number;
    instanceNumber: number;
    sortPosition: number;
    windowCenter?: number;
    windowWidth?: number;
    metadata: Array<{
        tagId: string;
        tagName: string;
        vr: string;
        length: string;
        label: string;
        value: string;
    }>;
    pixels: Float32Array;
};

const tagNames: Record<string, string> = {
    x00020000: "File Meta Information Group Length",
    x00020001: "File Meta Information Version",
    x00020002: "Media Storage SOP Class UID",
    x00020003: "Media Storage SOP Instance UID",
    x00020010: "Transfer Syntax UID",
    x00020012: "Implementation Class UID",
    x00020013: "Implementation Version Name",
    x00080005: "Specific Character Set",
    x00080008: "Image Type",
    x00080012: "Instance Creation Date",
    x00080013: "Instance Creation Time",
    x00080016: "SOP Class UID",
    x00080018: "SOP Instance UID",
    x00080020: "Study Date",
    x00080021: "Series Date",
    x00080022: "Acquisition Date",
    x00080023: "Content Date",
    x00080030: "Study Time",
    x00080031: "Series Time",
    x00080032: "Acquisition Time",
    x00080033: "Content Time",
    x00080050: "Accession Number",
    x00080060: "Modality",
    x00080070: "Manufacturer",
    x00080080: "Institution Name",
    x00080090: "Referring Physician Name",
    x00081010: "Station Name",
    x00081030: "Study Description",
    x0008103e: "Series Description",
    x00081090: "Manufacturer Model Name",
    x00100010: "Patient Name",
    x00100020: "Patient ID",
    x00100030: "Patient Birth Date",
    x00100040: "Patient Sex",
    x00101010: "Patient Age",
    x00180015: "Body Part Examined",
    x00180050: "Slice Thickness",
    x00180060: "KVP",
    x00181030: "Protocol Name",
    x00181100: "Reconstruction Diameter",
    x00181110: "Distance Source to Detector",
    x00181111: "Distance Source to Patient",
    x00181120: "Gantry/Detector Tilt",
    x00181130: "Table Height",
    x00181150: "Exposure Time",
    x00181151: "X-Ray Tube Current",
    x00181152: "Exposure",
    x00181160: "Filter Type",
    x00181170: "Generator Power",
    x00181190: "Focal Spot",
    x00181210: "Convolution Kernel",
    x00185100: "Patient Position",
    x0020000d: "Study Instance UID",
    x0020000e: "Series Instance UID",
    x00200010: "Study ID",
    x00200011: "Series Number",
    x00200012: "Acquisition Number",
    x00200013: "Instance Number",
    x00200032: "Image Position Patient",
    x00200037: "Image Orientation Patient",
    x00200052: "Frame of Reference UID",
    x00201040: "Position Reference Indicator",
    x00201041: "Slice Location",
    x00280002: "Samples per Pixel",
    x00280004: "Photometric Interpretation",
    x00280010: "Rows",
    x00280011: "Columns",
    x00280030: "Pixel Spacing",
    x00280100: "Bits Allocated",
    x00280101: "Bits Stored",
    x00280102: "High Bit",
    x00280103: "Pixel Representation",
    x00280120: "Pixel Padding Value",
    x00281050: "Window Center",
    x00281051: "Window Width",
    x00281052: "Rescale Intercept",
    x00281053: "Rescale Slope",
    x00281054: "Rescale Type",
    x7fe00010: "Pixel Data",
};

function numberValue(dataSet: dicomParser.DataSet, tag: string, fallback = 0) {
    const numericValues = [
        dataSet.floatString(tag, 0),
        dataSet.intString(tag, 0),
        dataSet.uint16(tag, 0),
        dataSet.int16(tag, 0),
        dataSet.uint32(tag, 0),
        dataSet.int32(tag, 0),
        dataSet.float(tag, 0),
        dataSet.double(tag, 0),
    ];
    const numericValue = numericValues.find(
        (value) => typeof value === "number" && Number.isFinite(value),
    );

    if (numericValue !== undefined) {
        return numericValue;
    }

    const value = dataSet.string(tag) ?? dataSet.text(tag);
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

function numberTextValue(
    dataSet: dicomParser.DataSet,
    tag: string,
    fallback: string,
) {
    const numericValues = [
        dataSet.intString(tag, 0),
        dataSet.uint16(tag, 0),
        dataSet.int16(tag, 0),
        dataSet.uint32(tag, 0),
        dataSet.int32(tag, 0),
    ];
    const numericValue = numericValues.find(
        (value) => typeof value === "number" && Number.isFinite(value),
    );

    if (numericValue !== undefined) {
        return String(numericValue);
    }

    return textValue(dataSet, tag, fallback);
}

function fileNameWithoutExtension(fileName: string) {
    return fileName.replace(/\.(dcm|dicom)$/i, "");
}

function displayTextValue(
    dataSet: dicomParser.DataSet,
    tag: string,
    fallback = "-",
) {
    const value = dataSet.string(tag) ?? dataSet.text(tag);
    return value?.trim() || fallback;
}

function displayTagId(tag: string) {
    return `(${tag.slice(1, 5).toUpperCase()},${tag.slice(5).toUpperCase()})`;
}

function tagName(tag: string) {
    return (
        tagNames[tag] ??
        (dicomParser.isPrivateTag(tag) ? "Private Tag" : "Unknown Tag")
    );
}

function elementValue(
    dataSet: dicomParser.DataSet,
    element: dicomParser.Element,
) {
    if (element.tag === "x7fe00010") {
        return `[Pixel Data: ${element.length.toLocaleString()} bytes]`;
    }

    if (element.items) {
        return `[Sequence: ${element.items.length.toLocaleString()} item${element.items.length === 1 ? "" : "s"}]`;
    }

    try {
        const value = element.vr
            ? dicomParser.explicitElementToString(dataSet, element)
            : (dataSet.string(element.tag) ?? dataSet.text(element.tag));
        return value?.trim() || `[${element.length.toLocaleString()} bytes]`;
    } catch {
        return `[${element.length.toLocaleString()} bytes]`;
    }
}

function collectMetadata(dataSet: dicomParser.DataSet) {
    return Object.entries(dataSet.elements)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([tag, element]) => {
            const elementWithTag = { ...element, tag };
            const id = displayTagId(tag);
            const name = tagName(tag);

            return {
                tagId: id,
                tagName: name,
                vr: element.vr ?? "-",
                length: element.length.toLocaleString(),
                label: `${id} ${name}`,
                value: elementValue(dataSet, elementWithTag),
            };
        });
}

function decimalValues(
    dataSet: dicomParser.DataSet,
    tag: string,
    expectedCount: number,
) {
    const values = Array.from({ length: expectedCount }, (_, index) => {
        const value = dataSet.floatString(tag, index);
        return typeof value === "number" && Number.isFinite(value)
            ? value
            : Number.NaN;
    });

    if (values.every(Number.isFinite)) {
        return values;
    }

    const rawValue = dataSet.string(tag) ?? dataSet.text(tag);
    if (!rawValue) return undefined;

    const parsedValues = rawValue
        .split("\\")
        .slice(0, expectedCount)
        .map((value) => Number.parseFloat(value));

    return parsedValues.length === expectedCount &&
        parsedValues.every(Number.isFinite)
        ? parsedValues
        : undefined;
}

function crossProduct(left: number[], right: number[]) {
    return [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ];
}

function dotProduct(left: number[], right: number[]) {
    return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function int8Value(value: number) {
    return value > 127 ? value - 256 : value;
}

function sliceSortPosition(dataSet: dicomParser.DataSet) {
    const imagePosition = decimalValues(dataSet, "x00200032", 3);
    const imageOrientation = decimalValues(dataSet, "x00200037", 6);

    if (imagePosition && imageOrientation) {
        const rowDirection = imageOrientation.slice(0, 3);
        const columnDirection = imageOrientation.slice(3, 6);
        return dotProduct(
            imagePosition,
            crossProduct(rowDirection, columnDirection),
        );
    }

    return numberValue(dataSet, "x00201041", numberValue(dataSet, "x00200013"));
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

    const samplesPerPixel = numberValue(dataSet, "x00280002", 1);
    const bitsAllocated = numberValue(dataSet, "x00280100", 16);
    const pixelRepresentation = numberValue(dataSet, "x00280103", 0);
    const slope = numberValue(dataSet, "x00281053", 1);
    const intercept = numberValue(dataSet, "x00281052", 0);
    const pixelCount = rows * columns;
    const output = new Float32Array(pixelCount);

    if (samplesPerPixel !== 1) {
        throw new Error("Only single-channel DICOM pixel data is supported.");
    }

    if (bitsAllocated !== 8 && bitsAllocated !== 16) {
        throw new Error(`Unsupported DICOM bits allocated: ${bitsAllocated}.`);
    }

    if (pixelElement.encapsulatedPixelData || pixelElement.fragments) {
        throw new Error("Compressed DICOM pixel data is not supported yet.");
    }

    const bytesPerPixel = bitsAllocated / 8;
    const expectedLength = pixelCount * bytesPerPixel;

    if (pixelElement.length < expectedLength) {
        throw new Error(
            "DICOM pixel data is smaller than row/column metadata.",
        );
    }

    for (let index = 0; index < pixelCount; index += 1) {
        const offset = bitsAllocated === 8 ? index : index * 2;
        const dataOffset = pixelElement.dataOffset + offset;
        const stored =
            bitsAllocated === 8
                ? pixelRepresentation === 1
                    ? int8Value(dataSet.byteArray[dataOffset])
                    : dataSet.byteArray[dataOffset]
                : pixelRepresentation === 1
                  ? dataSet.byteArrayParser.readInt16(
                        dataSet.byteArray,
                        dataOffset,
                    )
                  : dataSet.byteArrayParser.readUint16(
                        dataSet.byteArray,
                        dataOffset,
                    );
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
            "x00200010",
            textValue(
                dataSet,
                "x0020000d",
                textValue(dataSet, "x00080020", "Unknown Study"),
            ),
        ),
        seriesNumber: numberTextValue(dataSet, "x00200011", file.path),
        seriesDescription: textValue(
            dataSet,
            "x0008103e",
            fileNameWithoutExtension(file.name),
        ),
        studyInstanceUid: displayTextValue(dataSet, "x0020000d"),
        seriesInstanceUid: displayTextValue(dataSet, "x0020000e"),
        modality: displayTextValue(dataSet, "x00080060"),
        studyDate: displayTextValue(dataSet, "x00080020"),
        pixelSpacing: displayTextValue(dataSet, "x00280030"),
        sliceThickness: displayTextValue(dataSet, "x00180050"),
        rows,
        columns,
        instanceNumber: numberValue(dataSet, "x00200013"),
        sortPosition: sliceSortPosition(dataSet),
        windowCenter: numberValue(dataSet, "x00281050", Number.NaN),
        windowWidth: numberValue(dataSet, "x00281051", Number.NaN),
        metadata: collectMetadata(dataSet),
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
        const key = `${slice.patientId}\u0000${slice.studyId}\u0000${slice.seriesNumber}`;
        groups.set(key, [...(groups.get(key) ?? []), slice]);
    }

    return [...groups.entries()].map(([key, group]) => {
        const [patientId, studyId, seriesNumber] = key.split("\u0000");
        const sorted = [...group].sort((left, right) => {
            if (left.sortPosition !== right.sortPosition)
                return left.sortPosition - right.sortPosition;
            return left.instanceNumber - right.instanceNumber;
        });
        const first = sorted[0];
        const seriesName = first.seriesDescription || `Series ${seriesNumber}`;
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
        const metadata = first.metadata;

        return {
            id: `dicom:${patientId}:${studyId}:${seriesNumber}`,
            name: seriesName,
            format: "DICOM",
            patientId,
            studyId,
            seriesId: seriesNumber,
            dimensions: [first.columns, first.rows, sorted.length],
            data: volumeData,
            windowCenter,
            windowWidth,
            min,
            max,
            metadata,
        };
    });
}
