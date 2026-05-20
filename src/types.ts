export type Axis = "axial" | "coronal" | "sagittal";

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
};

declare global {
    interface Window {
        dcmViewer?: {
            openMedicalFiles: () => Promise<MedicalFileReference[]>;
            readMedicalFile: (path: string) => Promise<MedicalFile>;
        };
    }
}
