export function inflateRawSync() {
    throw new Error(
        "Compressed DICOM transfer syntaxes are not supported yet.",
    );
}

export default {
    inflateRawSync,
};
