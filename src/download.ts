// Webviews block <a download>, so hosts that can write files expose saveFile instead.
export async function saveBlob(blob: Blob, name: string) {
    const bridge = window.dcmViewer?.saveFile;
    if (bridge) {
        await bridge(name, await blob.arrayBuffer());
        return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeFileName(name: string) {
    // eslint-disable-next-line no-control-regex -- strip control characters from file names
    return name.replace(/\.(nii\.gz|nii|npy|npz|dcm|dicom)$/i, "").replace(/[\\/:*?"<>|\0-\x1f]+/g, "_").trim() || "image";
}
