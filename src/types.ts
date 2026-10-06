export type Axis = "axial" | "coronal" | "sagittal";

export type VisualizationColorMap = "grayscale" | "hot" | "viridis" | "jet";

export type MedicalFile = {
    path: string;
    name: string;
    bytes: Uint8Array;
};

export type MedicalFileReference = {
    path: string;
    name: string;
    size: number;
};

export type VolumeFormat = "DICOM" | "NIfTI" | "NPY";

export type VolumeMetadataEntry = {
    tagId: string;
    tagName: string;
    vr: string;
    length: string;
    label: string;
    value: string;
};

export type Volume = {
    id: string;
    name: string;
    format: VolumeFormat;
    patientId: string;
    studyId: string;
    seriesId: string;
    dimensions: [number, number, number];
    data: Float32Array;
    windowCenter: number;
    windowWidth: number;
    min: number;
    max: number;
    metadata?: VolumeMetadataEntry[];
    renderMode?: "grayscale" | "difference";
    sourcePath?: string;
    sourceFileName?: string;
    sourceParentDir?: string;
    channelIndex?: number;
    channelLabel?: string;
};

export type LabelOverlay = {
    id: string;
    volume: Volume;
    targetVolumeId: string;
    classes: number[];
};

export type StudyNode = {
    patientId: string;
    studies: Array<{
        studyId: string;
        volumes: Volume[];
    }>;
};

export type ViewportState = {
    id: string;
    volumeId?: string;
    linked: boolean;
    axis: Axis;
    slice: number;
    windowCenter: number;
    windowWidth: number;
    colorMap: VisualizationColorMap;
    clipMin: number;
    clipMax: number;
    showColorbar: boolean;
    flipHorizontal: boolean;
    flipVertical: boolean;
    labelOverlayId?: string;
    labelOpacity: number;
    showLabel: boolean;
    labelMode: "fill" | "outline";
    hiddenLabelClasses: number[];
    zoom: number;
    panX: number;
    panY: number;
};

declare global {
    interface Window {
        dcmViewer?: {
            getInitialFiles?: () => Promise<MedicalFileReference[]>;
            openMedicalFiles: () => Promise<MedicalFileReference[]>;
            readMedicalFile: (path: string) => Promise<MedicalFile>;
        };
    }
}
