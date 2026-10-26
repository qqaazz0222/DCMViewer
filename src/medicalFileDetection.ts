export function hasDicomPreamble(bytes: Uint8Array): boolean {
    return bytes.length >= 132 &&
        bytes[128] === 0x44 && bytes[129] === 0x49 &&
        bytes[130] === 0x43 && bytes[131] === 0x4d;
}

export function hasMedicalExtension(path: string): boolean {
    return /\.(dcm|dicom|nii|nii\.gz|npy|npz)$/i.test(path);
}
