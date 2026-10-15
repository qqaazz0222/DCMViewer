export type Axis = "axial" | "coronal" | "sagittal";

import type { VisualizationColorMap } from './colormaps';
export type { VisualizationColorMap } from './colormaps';

export type MedicalFile = {
    path: string;
    name: string;
    bytes: Uint8Array;
};

export type MedicalFileReference = {
    path: string;
    name: string;
    size: number;
    mtime?: number;
};

export type MedicalFileReadResult = {
    reference: MedicalFileReference;
    file?: MedicalFile;
    error?: string;
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

export type VoxelReader = (x: number, y: number, z: number) => number;

export type SliceSource = {
    version?: string;
    ensureSlice: (axis: Axis, slice: number, signal?: AbortSignal) => Promise<VoxelReader | void>;
    getVoxel: (x: number, y: number, z: number) => number;
    prefetch?: (axis: Axis, slice: number, signal: AbortSignal) => void;
    // Synchronous reader when the slice is already in memory: no async hop while scrolling.
    peekSlice?: (axis: Axis, slice: number) => VoxelReader | undefined;
};

export type RemoteVolumeDescriptor = Omit<Volume, "data" | "remote"> & { token: string; version: string; labelClasses?: number[]; labelError?: string };

export type Volume = {
    remote?: SliceSource;
    labelClasses?: number[];
    labelError?: string;
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
    // Linked panes sync only with panes in the same group.
    linkGroup: number;
    axis: Axis;
    slice: number;
    windowCenter: number;
    windowWidth: number;
    colorMap: VisualizationColorMap;
    invertColors?: boolean;
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
            loadRemoteVolumes?: (references: MedicalFileReference[]) => AsyncIterable<{ volumes: Volume[]; errors: string[] }>;
            clearLocalCache?: () => Promise<void>;
            logout?: () => Promise<void>;
            getInitialFiles?: () => Promise<MedicalFileReference[]>;
            openMedicalFiles: () => Promise<MedicalFileReference[]>;
            readMedicalFile: (path: string) => Promise<MedicalFile>;
            readMedicalFiles?: (references: MedicalFileReference[]) => AsyncIterable<MedicalFileReadResult>;
        };
    }
}
