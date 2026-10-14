// Appearance settings: applied as CSS variables, remembered per browser.
export type UiTheme = "dark" | "light" | "system";
export type UiSettings = { theme: UiTheme; accent: string; iconScale: number; textScale: number };

export const DEFAULT_UI_SETTINGS: UiSettings = { theme: "dark", accent: "#0078d4", iconScale: 1, textScale: 1 };
export const THEMES: Array<{ value: UiTheme; label: string }> = [
    { value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" },
];
export const ICON_SCALE_RANGE = [0.75, 1.5] as const;
export const TEXT_SCALE_RANGE = [0.85, 1.3] as const;
export const ACCENT_PRESETS = [
    { label: "Blue", value: "#0078d4" },
    { label: "Teal", value: "#00897b" },
    { label: "Green", value: "#2e9d4f" },
    { label: "Purple", value: "#7c4dff" },
    { label: "Orange", value: "#e8710a" },
    { label: "Red", value: "#d13438" },
] as const;

const STORAGE_KEY = "dcmviewer.uiSettings";
const clamp = (value: unknown, [min, max]: readonly [number, number], fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;

export function sanitizeUiSettings(value: unknown): UiSettings {
    const input = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof UiSettings, unknown>>;
    return {
        theme: THEMES.some(item => item.value === input.theme) ? input.theme as UiTheme : DEFAULT_UI_SETTINGS.theme,
        accent: typeof input.accent === "string" && /^#[0-9a-f]{6}$/i.test(input.accent) ? input.accent.toLowerCase() : DEFAULT_UI_SETTINGS.accent,
        iconScale: clamp(input.iconScale, ICON_SCALE_RANGE, DEFAULT_UI_SETTINGS.iconScale),
        textScale: clamp(input.textScale, TEXT_SCALE_RANGE, DEFAULT_UI_SETTINGS.textScale),
    };
}

export function loadUiSettings(): UiSettings {
    try { return sanitizeUiSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")); }
    catch { return DEFAULT_UI_SETTINGS; }
}

export function applyUiSettings(settings: UiSettings) {
    const systemLight = settings.theme === "system" && window.matchMedia?.("(prefers-color-scheme: light)").matches;
    document.documentElement.dataset.theme = settings.theme === "light" || systemLight ? "light" : "dark";
    const root = document.documentElement.style;
    root.setProperty("--accent", settings.accent);
    root.setProperty("--icon-scale", String(settings.iconScale));
    root.setProperty("--text-scale", String(settings.textScale));
    // Storage can be blocked (private windows, some webviews); defaults still apply.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}
