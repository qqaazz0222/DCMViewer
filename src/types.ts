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
    // Server-side id of the full volume (web platform); lets the server register it without a download.
    token?: string;
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

export type RegistrationMethod = "convexadam" | "ants" | "elastix";
export type RegistrationParams = Record<string, string | number | boolean>;
// "queue" waits for other jobs (web platform), "setup" installs packages, "run" reports register.py progress (0..1).
export type RegistrationStatus = { phase: "queue" | "setup" | "run"; message: string; progress?: number };
// Desktop sends the voxels; the web platform sends only the server-side token.
export type RegistrationInput = Pick<Volume, "data" | "dimensions"> & { token?: string };

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
    // Coronal / sagittal: stretch the slice to the pane height instead of keeping voxel proportions.
    stretch?: boolean;
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
            // Hosts that cannot download through the page (VS Code webviews) write the file themselves.
            saveFile?: (name: string, bytes: ArrayBuffer) => Promise<void>;
            logout?: () => Promise<void>;
            checkForUpdates?: () => Promise<void>;
            // Desktop returns the warped voxels; the web platform returns a server-side volume.
            registerVolumes?: (method: RegistrationMethod, fixed: RegistrationInput, moving: RegistrationInput,
                params: RegistrationParams) => Promise<Float32Array | Volume>;
            cancelRegistration?: () => unknown;
            // memory: volumes with voxels in this window; server: volumes held by the platform server.
            registrationSource?: "memory" | "server";
            onRegistrationStatus?: (listener: (status: RegistrationStatus) => void) => () => void;
            getInitialFiles?: () => Promise<MedicalFileReference[]>;
            openMedicalFiles: () => Promise<MedicalFileReference[]>;
            readMedicalFile: (path: string) => Promise<MedicalFile>;
            readMedicalFiles?: (references: MedicalFileReference[]) => AsyncIterable<MedicalFileReadResult>;
        };
    }
}
