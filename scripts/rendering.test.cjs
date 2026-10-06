const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const ts = require('typescript');
const cache = new Map();
function load(file) {
    const path = resolve(__dirname, '..', file);
    if (cache.has(path)) return cache.get(path);
    const exports = {};
    cache.set(path, exports);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('exports', 'require', code)(exports, name => name.startsWith('.') ? load(resolve(dirname(path), name + '.ts')) : require(name));
    return exports;
}
const { renderSliceToCanvas, slicePixelToVoxel } = load('src/rendering.ts');
const { validateLabelVolume } = load('src/labels.ts');
const { loadNpyVolume } = load('src/loaders/npy.ts');
function volume(values, dimensions = [3, 2, 2]) {
    return { dimensions, data: Float32Array.from(values), min: Math.min(...values), max: Math.max(...values) };
}
function render(image, axis, flipHorizontal = false, flipVertical = false, overlay, slice = 0) {
    let pixels;
    const canvas = { getContext: () => ({
        createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: data => { pixels = Array.from(data.data); },
    }) };
    renderSliceToCanvas(canvas, image, axis, slice, 127.5, 255,
        { colorMap: 'grayscale', clipMin: 0, clipMax: 255, flipHorizontal, flipVertical }, overlay);
    return Array.from({ length: pixels.length / 4 }, (_, i) => pixels.slice(i * 4, i * 4 + 4));
}
const image = volume([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110]);
const expected = {
    axial: { width: 3, rows: [[0, 10, 20], [30, 40, 50]] },
    coronal: { width: 3, rows: [[60, 70, 80], [0, 10, 20]] },
    sagittal: { width: 2, rows: [[60, 90], [0, 30]] },
};
for (const [axis, { rows }] of Object.entries(expected)) {
    for (const horizontal of [false, true]) for (const vertical of [false, true]) {
        test(`${axis}: both flip directions preserve image, label and hover alignment (${horizontal}, ${vertical})`, () => {
            let output = rows.map(row => horizontal ? [...row].reverse() : [...row]);
            if (vertical) output.reverse();
            const expectedPixels = output.flat();
            assert.deepEqual(render(image, axis, horizontal, vertical).map(p => p[0]), expectedPixels);
            const label = volume(Array.from(image.data, value => value === 0 ? 1 : 0));
            const blended = render(image, axis, horizontal, vertical, { volume: label, opacity: 1 });
            expectedPixels.forEach((value, index) => {
                assert.deepEqual(blended[index], value === 0 ? [255, 80, 80, 255] : [value, value, value, 255]);
            });
            const x = expectedPixels.indexOf(0);
            if (x >= 0) assert.deepEqual(slicePixelToVoxel(image, axis, 0, x % rows[0].length, Math.floor(x / rows[0].length), horizontal, vertical), { x: 0, y: 0, z: 0 });
        });
    }
}

test('opacity 0/0.5/1 and zero background use proper alpha blending', () => {
    const base = volume([100, 100], [2, 1, 1]);
    const mask = volume([1, 0], [2, 1, 1]);
    assert.deepEqual(render(base, 'axial', false, false, { volume: mask, opacity: 0 })[0], [100, 100, 100, 255]);
    assert.deepEqual(render(base, 'axial', false, false, { volume: mask, opacity: 0.5 }), [[178, 90, 90, 255], [100, 100, 100, 255]]);
    assert.deepEqual(render(base, 'axial', false, false, { volume: mask, opacity: 1 })[0], [255, 80, 80, 255]);
});

test('incompatible sizes, invalid class values and truncated data are rejected', () => {
    assert.throws(() => validateLabelVolume(volume([1, 0], [2, 1, 1]), image), /dimensions/);
    for (const value of [-1, 0.5, NaN, Infinity]) {
        const label = volume(Array(12).fill(value));
        assert.throws(() => validateLabelVolume(label, image), /integer/);
    }
    assert.throws(() => validateLabelVolume(volume([1]), image), /voxel count/);
    assert.deepEqual(validateLabelVolume(volume([0, 1, 5, 5, 2, 0, 0, 1, 0, 0, 0, 0]), image), [1, 2, 5]);
});

test('NPY mask files are parsed and validated as channel-first label volumes', () => {
    const header = "{'descr': '|u1', 'fortran_order': False, 'shape': (2, 2, 2, 3), }";
    const padding = ' '.repeat((64 - (10 + header.length + 1) % 64) % 64);
    const text = Buffer.from(header + padding + '\n');
    const prefix = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, 0, 0]);
    prefix.writeUInt16LE(text.length, 8);
    const masks = loadNpyVolume({ path: '/labels/mask.npy', name: 'mask.npy', bytes: Buffer.concat([prefix, text, Buffer.from([...Array(12).fill(1), ...Array(12).fill(2)])]) });
    assert.equal(masks.length, 2);
    assert.deepEqual(validateLabelVolume(masks[0], image), [1]);
    assert.deepEqual(validateLabelVolume(masks[1], image), [2]);
});

const { imagePlacement, synchronizeViewports, mergeVolumes, matchesVolume } = load('src/viewport.ts');
test('zoom and pan placement preserves image aspect and maps the zoomed image correctly', () => {
    assert.deepEqual(imagePlacement(400, 300, 100, 50, 1, 0, 0), { scale: 4, width: 400, height: 200, left: 0, top: 50 });
    assert.deepEqual(imagePlacement(400, 300, 100, 50, 2, 30, -10), { scale: 8, width: 800, height: 400, left: -170, top: -60 });
});

test('linked slices use relative position for different volume depths', () => {
    const a = { ...image, id: 'a', dimensions: [3, 2, 5] };
    const b = { ...image, id: 'b', dimensions: [3, 2, 9] };
    const current = [{ id: '1', volumeId: 'a', linked: true, axis: 'axial', slice: 0 }, { id: '2', volumeId: 'b', linked: true, axis: 'axial', slice: 0 }];
    const updated = synchronizeViewports(current, { ...current[0], slice: 2 }, [a, b], false);
    assert.equal(updated[1].slice, 4);
    const unlinked = synchronizeViewports([{ ...current[0] }, { ...current[1], linked: false }], { ...current[0], slice: 2 }, [a, b], false);
    assert.equal(unlinked[1].slice, 0);
});

test('local overlay and zoom changes never move other comparison panes', () => {
    const a = { ...image, id: 'a', dimensions: [3, 2, 5] };
    const b = { ...image, id: 'b', dimensions: [3, 2, 9] };
    const current = [{ id: '1', volumeId: 'a', axis: 'axial', slice: 2, labelOpacity: 0.4 }, { id: '2', volumeId: 'b', axis: 'axial', slice: 4, labelOpacity: 0.8 }];
    const next = { ...current[0], labelOpacity: 0.6, zoom: 2 };
    const updated = synchronizeViewports(current, next, [a, b], true);
    assert.deepEqual(updated[1], current[1]);
    assert.equal(updated[0].labelOpacity, 0.6);
    assert.equal(updated[0].zoom, 2);
});

test('repeated imports are deduplicated and searches match patient, path and format', () => {
    const a = { id: 'a', name: 'brain.npy', patientId: 'Patient A', studyId: 'Study', seriesId: 'Series', format: 'NPY', sourceParentDir: 'case01' };
    const b = { ...a, id: 'b', name: 'lung.npy' };
    assert.deepEqual(mergeVolumes([a], [a, b, b]), [a, b]);
    assert.ok(matchesVolume(a, ' patient a '));
    assert.ok(matchesVolume(a, 'CASE01'));
    assert.ok(matchesVolume(a, 'npy'));
    assert.equal(matchesVolume(a, 'missing'), false);
});

test('outline masks leave interiors untouched and class filtering hides only selected classes', () => {
    const base = volume(Array(25).fill(100), [5, 5, 1]);
    const mask = volume(Array(25).fill(1), [5, 5, 1]);
    const outline = render(base, 'axial', false, false, { volume: mask, opacity: 1, mode: 'outline' });
    assert.deepEqual(outline[12], [100, 100, 100, 255]);
    assert.deepEqual(outline[0], [255, 80, 80, 255]);
    const mixed = volume([1, 2], [2, 1, 1]);
    const filtered = render(volume([100, 100], [2, 1, 1]), 'axial', false, false, { volume: mixed, opacity: 1, hiddenClasses: [1] });
    assert.deepEqual(filtered, [[100, 100, 100, 255], [80, 220, 120, 255]]);
});

test('window/flip changes sync without changing slices or per-pane overlay settings', () => {
    const current = [
        { id: '1', volumeId: 'a', linked: true, axis: 'axial', slice: 1, windowCenter: 10, windowWidth: 100, flipHorizontal: false, flipVertical: false },
        { id: '2', volumeId: 'b', linked: true, axis: 'axial', slice: 3, windowCenter: 10, windowWidth: 100, flipHorizontal: false, flipVertical: false, labelOverlayId: 'mask-b' },
    ];
    const updated = synchronizeViewports(current, { ...current[0], windowWidth: 150, flipHorizontal: true }, [], true);
    assert.equal(updated[1].windowWidth, 150);
    assert.equal(updated[1].flipHorizontal, true);
    assert.equal(updated[1].slice, 3);
    assert.equal(updated[1].labelOverlayId, 'mask-b');
});
