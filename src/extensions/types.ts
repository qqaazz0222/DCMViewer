import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Volume } from "../types";

// What the viewer hands an extension on every render.
export type ExtensionHost = {
    // This extension's sidebar panel is open.
    active: boolean;
    volumes: Volume[];
    addVolume: (volume: Volume) => void;
    // Shows the volume in the focused viewport of the View / Compare screen.
    showVolume: (volume: Volume) => void;
};

// A screen that replaces the View / Compare grid while the extension's panel is open.
export type ExtensionWorkspace = {
    rows: number;
    columns: number;
    // Extra grid class for custom layouts (e.g. a pane spanning rows).
    className?: string;
    // Keep the array identity stable while the panes do not change (useMemo): the viewer re-syncs its viewports on every new array.
    panes: { role: string; volume?: Volume; difference?: boolean }[];
    // Derived volumes (differences) shown in panes but not listed under Patients.
    derivedVolumes: Volume[];
    status: string;
    // Pane indices where the PNG grid export leaves an empty cell to mirror a spanning layout.
    exportGaps?: number[];
    // A volume picked in the Patients list while pane `index` is focused.
    assign: (index: number, volume: Volume) => void;
};

export type ExtensionContribution = {
    renderPanel: () => ReactNode;
    workspace?: ExtensionWorkspace;
};

export type ViewerExtension = {
    id: string;
    label: string;
    icon: LucideIcon;
    // A React hook: called on every render, in registry order, whether or not the panel is open.
    use: (host: ExtensionHost) => ExtensionContribution;
};
