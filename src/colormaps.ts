import { COLORMAP_HEX } from './colormapData';

export const COLOR_MAPS = [
    { id: 'grayscale', label: 'Grayscale', group: 'Grayscale' },
    { id: 'bone', label: 'Bone', group: 'Grayscale' },
    { id: 'viridis', label: 'Viridis', group: 'Perceptual sequential' },
    { id: 'plasma', label: 'Plasma', group: 'Perceptual sequential' },
    { id: 'inferno', label: 'Inferno', group: 'Perceptual sequential' },
    { id: 'magma', label: 'Magma', group: 'Perceptual sequential' },
    { id: 'cividis', label: 'Cividis', group: 'Perceptual sequential' },
    { id: 'hot', label: 'Hot', group: 'Sequential' },
    { id: 'copper', label: 'Copper', group: 'Sequential' },
    { id: 'blues', label: 'Blues', group: 'Sequential' },
    { id: 'greens', label: 'Greens', group: 'Sequential' },
    { id: 'coolwarm', label: 'Coolwarm', group: 'Diverging' },
    { id: 'turbo', label: 'Turbo', group: 'Spectrum' },
    { id: 'jet', label: 'Jet', group: 'Spectrum' },
    { id: 'cool', label: 'Cool', group: 'Spectrum' },
] as const;

export type VisualizationColorMap = (typeof COLOR_MAPS)[number]['id'];
export const COLOR_MAP_GROUPS = [...new Set(COLOR_MAPS.map(map => map.group))];
type RGB = [number, number, number];
function mixRGB(left: readonly number[], right: readonly number[], ratio: number): RGB {
    return [
        Math.round(left[0] + (right[0] - left[0]) * ratio),
        Math.round(left[1] + (right[1] - left[1]) * ratio),
        Math.round(left[2] + (right[2] - left[2]) * ratio),
    ];
}
const tables = Object.fromEntries(Object.entries(COLORMAP_HEX).map(([name, hex]) =>
    [name, Uint8Array.from(hex.match(/../g)!.map(value => parseInt(value, 16)))],
)) as Record<keyof typeof COLORMAP_HEX, Uint8Array>;

// Preserve the original Hot and Jet ramps while sharing their colorbar definitions.
const ramps = {
    hot: [[0, 0, 0], [255, 0, 0], [255, 255, 0], [255, 255, 255]],
    jet: [[0, 0, 255], [0, 255, 255], [0, 255, 0], [255, 255, 0], [255, 0, 0]],
} as const;

export function colorFromMap(map: VisualizationColorMap, value: number): RGB {
    const t = Number.isNaN(value) ? 0 : Math.min(Math.max(value, 0), 1);
    if (map === 'grayscale') {
        const level = Math.round(t * 255);
        return [level, level, level];
    }
    if (map === 'hot' || map === 'jet') {
        const stops = ramps[map];
        const position = t * (stops.length - 1);
        const index = Math.min(Math.floor(position), stops.length - 2);
        return mixRGB(stops[index], stops[index + 1], position - index);
    }
    const table = tables[map];
    const position = t * 255;
    const index = Math.min(Math.floor(position), 254);
    const offset = index * 3;
    const ratio = position - index;
    return [
        Math.round(table[offset] + (table[offset + 3] - table[offset]) * ratio),
        Math.round(table[offset + 1] + (table[offset + 4] - table[offset + 1]) * ratio),
        Math.round(table[offset + 2] + (table[offset + 5] - table[offset + 2]) * ratio),
    ];
}

// The legend and viewport sample exactly the same RGB function.
const gradients = new Map(COLOR_MAPS.map(({ id }) => {
    const count = id === 'grayscale' ? 2 : id === 'hot' ? 4 : id === 'jet' ? 5 : 256;
    const stops = Array.from({ length: count }, (_, index) => {
        const t = index / (count - 1);
        return `rgb(${colorFromMap(id, t).join(',')}) ${t * 100}%`;
    });
    return [id, `linear-gradient(to top, ${stops.join(', ')})`] as const;
}));
export function colorBarGradient(map: VisualizationColorMap) {
    return gradients.get(map)!;
}
