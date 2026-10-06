import type { Axis, ViewportState, Volume } from './types';
import { getSliceCount } from './rendering';

export function imagePlacement(stageWidth: number, stageHeight: number, width: number, height: number, zoom: number, panX: number, panY: number) {
    const scale = Math.min(stageWidth / width, stageHeight / height) * zoom;
    return { scale, width: width * scale, height: height * scale,
        left: (stageWidth - width * scale) / 2 + panX,
        top: (stageHeight - height * scale) / 2 + panY };
}

export function sliceRatio(volume: Volume | undefined, axis: Axis, slice: number) {
    const max = volume ? getSliceCount(volume, axis) - 1 : 0;
    return max > 0 ? Math.min(Math.max(slice / max, 0), 1) : 0;
}

export function synchronizeViewports(current: ViewportState[], next: ViewportState, volumes: Volume[], compare: boolean): ViewportState[] {
    const previous = current.find(view => view.id === next.id);
    const volumeChanged = previous?.volumeId !== next.volumeId;
    const navigationChanged = previous?.axis !== next.axis || previous?.slice !== next.slice;
    const windowChanged = previous?.windowCenter !== next.windowCenter || previous?.windowWidth !== next.windowWidth;
    const flipChanged = previous?.flipHorizontal !== next.flipHorizontal || previous?.flipVertical !== next.flipVertical;
    const linked = compare || (previous?.linked && next.linked && !volumeChanged);
    const source = volumes.find(volume => volume.id === next.volumeId);
    const ratio = sliceRatio(source, next.axis, next.slice);
    return current.map(view => {
        if (view.id === next.id) return next;
        if (!linked || (!compare && !view.linked)) return view;
        let updated = { ...view };
        if (navigationChanged || (compare && volumeChanged)) {
            const volume = volumes.find(volume => volume.id === view.volumeId);
            updated = { ...updated, axis: next.axis,
                slice: volume ? Math.round(ratio * (getSliceCount(volume, next.axis) - 1)) : 0 };
        }
        if (windowChanged) updated = { ...updated, windowCenter: next.windowCenter, windowWidth: next.windowWidth };
        if (flipChanged) updated = { ...updated, flipHorizontal: next.flipHorizontal, flipVertical: next.flipVertical };
        return updated;
    });
}

export function mergeVolumes(current: Volume[], incoming: Volume[]): Volume[] {
    const ids = new Set(current.map(volume => volume.id));
    const result = [...current];
    for (const volume of incoming) {
        if (ids.has(volume.id)) continue;
        ids.add(volume.id);
        result.push(volume);
    }
    return result;
}

export function matchesVolume(volume: Volume, query: string) {
    return [volume.name, volume.patientId, volume.studyId, volume.seriesId, volume.sourceParentDir ?? '', volume.format]
        .join(' ').toLowerCase().includes(query.trim().toLowerCase());
}
