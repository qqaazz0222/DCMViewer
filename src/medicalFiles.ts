import type { MedicalFileReadResult, MedicalFileReference } from './types';

// The VS Code bridge batches transfers. Electron keeps its existing IPC API.
export async function* readMedicalFiles(
    references: MedicalFileReference[], api: NonNullable<Window['dcmViewer']>,
): AsyncGenerator<MedicalFileReadResult> {
    if (api.readMedicalFiles) { yield* api.readMedicalFiles(references); return; }
    for (const reference of references) {
        try { yield { reference, file: await api.readMedicalFile(reference.path) }; }
        catch (error) { yield { reference, error: error instanceof Error ? error.message : String(error) }; }
    }
}
