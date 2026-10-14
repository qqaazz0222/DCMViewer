const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function component(mode) {
    const file = resolve(__dirname, 'slice-loading-' + mode + '.cjs');
    const output = buildSync({
        entryPoints: [resolve(__dirname, '../src/components/SliceViewport.tsx')],
        bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
        external: ['react'], define: { 'import.meta.env.MODE': JSON.stringify(mode) },
    });
    const compiled = new Module(file, module);
    compiled.paths = module.paths;
    compiled._compile(output.outputFiles[0].text, file);
    return compiled.exports.SliceViewport;
}

function markup(Component, remote) {
    const volume = { id: 'sample', name: 'sample.npy', patientId: 'Synthetic', format: 'NPY',
        dimensions: [2, 2, 2], data: new Float32Array(8), min: 0, max: 100,
        windowCenter: 50, windowWidth: 100,
        ...(remote ? { remote: { version: '1', ensureSlice: () => { throw new Error('Render must not fetch'); }, getVoxel: () => 0 } } : {}) };
    const state = { id: 'view-1', volumeId: volume.id, axis: 'axial', slice: 1,
        windowCenter: 50, windowWidth: 100, clipMin: 0, clipMax: 100, colorMap: 'grayscale',
        showColorbar: true, showLabel: false, zoom: 1, panX: 0, panY: 0,
        flipHorizontal: false, flipVertical: false, labelOpacity: 0.4, labelMode: 'fill', hiddenLabelClasses: [] };
    return renderToStaticMarkup(React.createElement(Component, { state, volumes: [volume], overlays: [],
        active: true, linkEnabled: false, onActivate() {}, onChange() {}, onOpenFiles() {} }));
}

test('platform remote slices load without a visible loading screen or a false ready state', () => {
    const html = markup(component('web'), true);
    assert.doesNotMatch(html, /Loading slice|Fetching full-resolution pixels|remoteSliceStatus/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /data-slice-ready="false"/);
    assert.match(html, /visibility:hidden/);
});

test('VS Code retains its loading notice and local slices are immediately ready', () => {
    const Component = component('vscode');
    assert.match(markup(Component, true), /Loading slice/);
    const local = markup(Component, false);
    assert.doesNotMatch(local, /Loading slice|remoteSliceStatus/);
    assert.match(local, /data-slice-ready="true"/);
    assert.match(local, /visibility:visible/);
});
