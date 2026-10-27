import type { ExtensionHost, ViewerExtension } from "./types";
import { registrationExtension } from "./registration";

// Sidebar features beyond the core panels. Order sets the activity bar order.
export const EXTENSIONS: readonly ViewerExtension[] = [registrationExtension];

export function useExtensions(host: Omit<ExtensionHost, "active">, openPanel: string | null) {
    // ponytail: EXTENSIONS is fixed at build time, so the hook order never changes between renders.
    // Loading extensions at runtime must finish before the first render to keep that true.
    return EXTENSIONS.map(extension => ({ ...extension, ...extension.use({ ...host, active: openPanel === extension.id }) }));
}
