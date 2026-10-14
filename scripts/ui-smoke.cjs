const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const assert = require('node:assert/strict');

function npy(name, shape, values) {
    const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`;
    const text = Buffer.from(header + ' '.repeat((64 - (10 + header.length + 1) % 64) % 64) + '\n');
    const prefix = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, 0, 0]);
    prefix.writeUInt16LE(text.length, 8);
    const pixels = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => pixels.writeFloatLE(value, index * 4));
    return { path: 'file:///qa/' + name, name, base64: Buffer.concat([prefix, text, pixels]).toString('base64') };
}

async function run() {
    const root = resolve(__dirname, '..');
    const net = require('node:net');
    const portServer = net.createServer().listen(0, '127.0.0.1');
    await once(portServer, 'listening');
    const port = portServer.address().port;
    await new Promise(resolve => portServer.close(resolve));
    const server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', 'vscode-extension/media'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = await mkdtemp(resolve(tmpdir(), 'dcmviewer-ui-'));
    let browser;
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Preview did not start')), 10000);
            server.stdout.on('data', data => { if (data.toString().includes('Local:')) { clearTimeout(timeout); resolve(); } });
            server.on('exit', code => { clearTimeout(timeout); reject(new Error('Preview exited: ' + code)); });
        });
        browser = await chromium.launch({ channel: process.env.DCMVIEWER_BROWSER_CHANNEL || 'chrome', headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const a = npy('case-a.npy', [4, 8, 12], Array.from({ length: 384 }, (_, index) => index));
        const b = npy('case-b.npy', [8, 8, 12], Array.from({ length: 768 }, (_, index) => index % 384));
        const mask = npy('mask.npy', [4, 8, 12], Array.from({ length: 384 }, (_, index) => {
            const x = index % 12, y = Math.floor(index / 12) % 8;
            return x >= 3 && x <= 8 && y >= 2 && y <= 5 ? 1 : 0;
        }));
        const mismatch = npy('mismatch.npy', [4, 5, 6], Array(120).fill(5));
        const broken = { name: 'broken.npy', path: 'file:///qa/broken.npy', base64: 'YmFk' };
        const missing = { name: 'missing.npy', path: 'file:///qa/missing.npy', error: 'File unavailable' };
        const streaming = process.argv.includes('--remote') || process.env.DCMVIEWER_STREAM_TEST === '1';
        const prepared = {}, slicePayloads = {};
        if (streaming) {
            const { VolumeServer } = require('../vscode-extension/out/volumeServer.js');
            const volumeServer = new VolumeServer();
            for (const file of [a, b, mask, mismatch, broken, missing]) {
                if (file.error) { prepared[file.path] = { volumes: [], errors: [`${file.name}: ${file.error}`] }; continue; }
                const bytes = Buffer.from(file.base64, 'base64');
                const result = await volumeServer.prepare([{ path: file.path, name: file.name, bytes }], [{ path: file.path, size: bytes.length, mtime: 1 }]);
                prepared[file.path] = result;
                for (const volume of result.volumes) for (const [axis, count] of [['axial', volume.dimensions[2]], ['coronal', volume.dimensions[1]], ['sagittal', volume.dimensions[0]]]) {
                    for (let slice = 0; slice < count; slice++) {
                        const bytes = volumeServer.slice(volume.token, axis, slice);
                        slicePayloads[`${volume.token}|${axis}|${slice}`] = { base64: require('node:zlib').gzipSync(bytes).toString('base64'), size: bytes.length };
                    }
                }
            }
        }
        await page.addInitScript(({ initial, selections, files, streaming, prepared, slicePayloads }) => {
            const byPath = new Map(files.map(file => [file.path, file]));
            const references = files => files.map(({ path, name, base64 }) => ({ path, name, size: base64 ? atob(base64).length : 0, mtime: 1 }));
            window.__transferLog = [];
            window.acquireVsCodeApi = () => ({ postMessage: request => {
                window.__transferLog.push(request.method);
                let result, error;
                if (request.method === 'capabilities') result = { streamVolumes: streaming, persistCache: true };
                else if (request.method === 'initialFiles') result = references(initial);
                else if (request.method === 'openFiles') result = references(selections.shift() || []);
                else if (request.method === 'prepareVolumes') result = {
                    volumes: request.paths.flatMap(path => prepared[path].volumes),
                    errors: request.paths.flatMap(path => prepared[path].errors),
                };
                else if (request.method === 'readSlice') {
                    const payload = slicePayloads[`${request.token}|${request.axis}|${request.slice}`];
                    result = { path: request.token, name: 'slice.raw', bytes: Uint8Array.from(atob(payload.base64), char => char.charCodeAt(0)).buffer, encoding: 'gzip', originalSize: payload.size };
                }
                else if (request.method === 'readFiles') {
                    result = request.paths.map(path => {
                        const file = byPath.get(path);
                        if (file.error) return file;
                        const bytes = Uint8Array.from(atob(file.gzipBase64), char => char.charCodeAt(0));
                        return { path, name: file.name, bytes: bytes.buffer, encoding: 'gzip', originalSize: atob(file.base64).length, mtime: 1 };
                    });
                }
                else if (request.method === 'readFile') {
                    const file = byPath.get(request.path);
                    if (file.error) error = file.error; else result = file;
                }
                setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { id: request.id, result, error } })), streaming && request.method === 'readSlice' ? 60 : 0);
            } });
            window.addEventListener('DOMContentLoaded', () => document.body.classList.add('vscodeHost'));
        }, { streaming, prepared, slicePayloads, initial: [a, b], selections: [[mask], [a, b], [broken, missing, mismatch]], files: [a, b, mask, mismatch, broken, missing].map(file => file.base64 ? { ...file, gzipBase64: require('node:zlib').gzipSync(Buffer.from(file.base64, 'base64'), { level: 1 }).toString('base64') } : file) });
        await page.goto(`http://127.0.0.1:${port}`);
        const canvas = page.locator('canvas').first();
        await page.waitForFunction(() => document.querySelector('canvas')?.width === 12 && !document.querySelector('.loadingOverlay'));
        const pixels = async () => {
            await page.waitForFunction(() => document.querySelector('canvas')?.dataset.sliceReady === 'true');
            return canvas.evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data));
        };
        const original = await pixels();
        const activity = name => page.locator('.activityBar').getByRole('button', { name, exact: true });
        assert.equal(await activity('Patients').getAttribute('aria-pressed'), 'true', 'patients panel opens by default');
        assert.equal(await page.locator('.sidebar .windowingPanel').count(), 0, 'one sidebar panel at a time');
        await activity('Label Overlay').click();
        assert.equal(await page.locator('.treePanel').count(), 0, 'switching hides the previous panel');
        await page.getByRole('button', { name: 'Load label', exact: true }).click();
        await page.getByRole('button', { name: 'Show label 1', exact: true }).waitFor();
        await page.waitForFunction(() => !document.querySelector('.loadingOverlay'));
        assert.notDeepEqual(await pixels(), original, 'mask must change visible pixels');
        await page.getByRole('button', { name: 'Show label 1', exact: true }).click();
        assert.deepEqual(await pixels(), original, 'hiding mask class restores base pixels');
        await page.getByRole('button', { name: 'Show label 1', exact: true }).click();
        await page.getByRole('combobox', { name: 'Label display mode' }).selectOption('outline');
        const outline = await pixels();
        assert.deepEqual(outline.slice((3 * 12 + 5) * 4, (3 * 12 + 5) * 4 + 4), original.slice((3 * 12 + 5) * 4, (3 * 12 + 5) * 4 + 4), 'mask interior must be transparent in outline mode');
        const stage = page.locator('.canvasStage').first();
        await stage.focus();
        await page.keyboard.press('End');
        assert.equal(await page.locator('.viewportFooter input[type=range]').first().inputValue(), '3');
        await page.getByRole('spinbutton', { name: 'Slice number' }).fill('3');
        await page.getByRole('spinbutton', { name: 'Slice number' }).press('Enter');
        assert.equal(await page.locator('.viewportFooter input[type=range]').first().inputValue(), '2');
        await page.getByRole('spinbutton', { name: 'Slice number' }).fill('1');
        await page.getByRole('spinbutton', { name: 'Slice number' }).press('Escape');
        assert.equal(await page.locator('.viewportFooter input[type=range]').first().inputValue(), '2', 'Escape cancels a slice edit');
        const before = await canvas.boundingBox();
        await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
        const zoomed = await canvas.boundingBox();
        assert.ok(zoomed.width > before.width, 'zoom must enlarge image');
        const rect = await stage.boundingBox();
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        await page.mouse.down();
        await page.mouse.move(rect.x + rect.width / 2 + 40, rect.y + rect.height / 2 + 20, { steps: 3 });
        await page.mouse.up();
        assert.ok((await canvas.boundingBox()).x > zoomed.x + 30, 'pan must move image');
        const panned = await canvas.boundingBox();
        await page.mouse.move(panned.x + panned.width * 6.5 / 12, panned.y + panned.height * 4.5 / 8);
        await page.locator('.voxelInfoPanel').getByText('X: 6', { exact: true }).waitFor();
        await page.locator('.voxelInfoPanel').getByText('Y: 4', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Fit image', exact: true }).click();
        await stage.focus();
        await page.keyboard.press('h');
        assert.equal(await page.getByRole('button', { name: 'Flip left / right', exact: true }).getAttribute('aria-pressed'), 'true');
        await page.keyboard.press('r');
        assert.equal(await page.getByRole('button', { name: 'Flip left / right', exact: true }).getAttribute('aria-pressed'), 'false');
        assert.equal(await page.locator('.toolbar').getByRole('button', { name: 'Open', exact: true }).count(), 0, 'Open lives in the Patients panel');
        await activity('Patients').click();
        await page.locator('.sidebar').getByRole('button', { name: 'Open', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.loadingOverlay'));
        assert.equal(await page.getByRole('combobox', { name: 'Select volume', exact: true }).locator('option').count(), 3, 're-import must not duplicate volumes');
        await page.getByRole('button', { name: 'Compare', exact: true }).click();
        const selectors = page.getByRole('combobox', { name: 'Select volume', exact: true });
        assert.notEqual(await selectors.nth(0).inputValue(), await selectors.nth(1).inputValue(), 'compare chooses distinct cases');
        assert.ok(await selectors.nth(2).isDisabled());
        await page.locator('.canvasStage').first().focus();
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.locator('.viewport .orientationControls').count(), 0, 'compare panes have no own toolbars');
        assert.equal(await page.locator('.compareControls .orientationControls').count(), 1, 'one shared compare toolbar');
        const slices = page.locator('.viewportSliceLabel');
        assert.equal(await slices.nth(0).textContent(), 'Slice 2/4');
        assert.equal(await slices.nth(1).textContent(), 'Slice 3/8', 'different depth cases use relative slices');
        await page.locator('.compareControls').getByRole('button', { name: 'Zoom in', exact: true }).click();
        const otherSlice = await slices.nth(1).textContent();
        await activity('Label Overlay').click();
        await page.getByRole('slider', { name: 'Label opacity', exact: true }).focus();
        await page.keyboard.press('ArrowRight');
        assert.equal(await slices.nth(1).textContent(), otherSlice, 'label changes must not navigate comparison');
        await page.screenshot({ path: resolve(output, 'compare.png') });
        await activity('Patients').click();
        await page.getByRole('button', { name: 'Open', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.loadingOverlay'));
        await page.getByRole('button', { name: 'Details', exact: true }).click();
        assert.equal(await page.locator('.helpModal li').count(), 2, 'all read and parse errors are retained');
        await page.keyboard.press('Escape');
        const mismatchOption = await selectors.nth(1).locator('option').evaluateAll(options => options.find(option => option.textContent.includes('mismatch.npy')).value);
        await selectors.nth(1).selectOption(mismatchOption);
        await page.locator('.compareStatus').filter({ hasText: 'Difference unavailable' }).waitFor();
        await page.getByRole('button', { name: 'Controls', exact: true }).click();
        await page.getByRole('dialog', { name: 'Viewer controls', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('searchbox', { name: 'Search volumes', exact: true }).fill('not-present');
        await page.getByText('No matching volumes. Try another search.', { exact: true }).waitFor();
        await page.getByRole('searchbox', { name: 'Search volumes', exact: true }).fill('case-a');
        assert.ok(await page.locator('.treePanel .volumeNode').count() >= 1);
        await activity('Patients').click();
        assert.equal(await page.locator('.sidebar').count(), 0, 'clicking the active icon collapses the sidebar');
        await activity('Patients').click();
        assert.equal(await page.locator('.treePanel').count(), 1, 'clicking it again reopens the panel');
        await activity('Settings').click();
        await page.getByRole('radio', { name: 'Teal', exact: true }).click();
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#00897b');
        const label = page.locator('.settingsPanel label').first();
        const smallText = parseFloat(await label.evaluate(el => getComputedStyle(el).fontSize));
        await page.getByRole('slider', { name: 'Text size', exact: true }).fill('1.3');
        assert.ok(parseFloat(await label.evaluate(el => getComputedStyle(el).fontSize)) > smallText, 'text size grows');
        const iconBefore = (await activity('Settings').locator('svg').boundingBox()).width;
        await page.getByRole('slider', { name: 'Icon size', exact: true }).fill('1.5');
        assert.ok((await activity('Settings').locator('svg').boundingBox()).width > iconBefore, 'icon size grows');
        await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('light');
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).backgroundColor), 'rgb(255, 255, 255)', 'light panels');
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.canvasStageImage')).backgroundColor), 'rgb(0, 0, 0)', 'loaded images sit on black in light theme');
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.canvasStageImage .voxelInfoPanel')).color), 'rgb(232, 232, 232)', 'overlay text stays readable on black');
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.canvasStage:not(.canvasStageImage)')).backgroundColor), 'rgb(233, 233, 233)', 'empty stage follows the light theme');
        await page.screenshot({ path: resolve(output, 'settings.png') });
        await page.reload();
        await page.waitForFunction(() => !document.querySelector('.loadingOverlay'));
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim()), '1.3', 'settings survive reload');
        await activity('Settings').click();
        await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click();
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#0078d4');
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'reset restores the dark theme');
        // Link groups: right-click a link button to pick its group.
        await page.getByRole('button', { name: 'View', exact: true }).click();
        await page.locator('.gridControls button').nth(3).click();
        const links = page.locator('.viewport .linkButton');
        assert.equal(await links.count(), 2);
        await links.nth(1).click({ button: 'right' });
        await page.getByRole('menuitemradio', { name: 'Group 2' }).click();
        assert.equal(await page.getByRole('menu', { name: 'Link group' }).count(), 0, 'menu closes after choosing');
        assert.equal(await links.nth(1).getAttribute('aria-label'), 'Disable viewport link (group 2)', 'choosing a group enables the link');
        await links.nth(0).click();
        assert.equal(await links.nth(0).getAttribute('aria-label'), 'Disable viewport link (group 1)');
        const sliceValue = index => page.locator('.viewportFooter input[type=range]').nth(index).inputValue();
        const otherBefore = await sliceValue(1);
        await page.locator('.canvasStage').first().focus();
        await page.keyboard.press('Home');
        assert.equal(await sliceValue(0), '0');
        assert.equal(await sliceValue(1), otherBefore, 'different link groups do not sync');
        await links.nth(0).click({ button: 'right' });
        await page.getByRole('menuitemradio', { name: 'Group 2' }).click();
        await page.locator('.canvasStage').first().focus();
        await page.keyboard.press('End');
        assert.equal(await sliceValue(1), await page.locator('.viewportFooter input[type=range]').nth(1).getAttribute('max'), 'same group syncs');
        await links.nth(0).click({ button: 'right' });
        await page.screenshot({ path: resolve(output, 'link-groups.png') });
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('menu', { name: 'Link group' }).count(), 0, 'Escape closes the menu');
        await activity('Patients').click();
        await page.setViewportSize({ width: 760, height: 640 });
        await page.waitForTimeout(300); // let layout settle before capturing
        await page.screenshot({ path: resolve(output, 'compact.png') });
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight), true, 'compact editor must not overflow vertically');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'compact editor must not overflow the page');
        if (streaming) {
            assert.equal(await page.evaluate(() => window.__transferLog.includes('readFiles') || window.__transferLog.includes('readFile')), false, 'streaming never downloads source files');
            await page.reload();
            await page.waitForFunction(() => document.querySelector('canvas')?.width === 12 && document.querySelector('canvas')?.dataset.sliceReady === 'true' && !document.querySelector('.loadingOverlay'));
            assert.equal(await page.evaluate(() => window.__transferLog.filter(method => method === 'readSlice').length), 0, 'persistent cache survives reload');
            await page.getByRole('button', { name: 'Clear local cache', exact: true }).click();
            await page.getByRole('button', { name: 'Local cache cleared', exact: true }).waitFor();
            await page.reload();
            await page.waitForFunction(() => document.querySelector('canvas')?.width === 12 && document.querySelector('canvas')?.dataset.sliceReady === 'true' && !document.querySelector('.loadingOverlay'));
            assert.ok(await page.evaluate(() => window.__transferLog.includes('readSlice')), 'clearing cache forces a new slice transfer');
        }
        assert.deepEqual(errors, [], 'no renderer exceptions');
        console.log((streaming ? 'Remote streaming ' : '') + 'UI smoke passed: label classes/outline, zoom/pan, keyboard, jump/cancel, deduplication, compare sync, partial read errors, help and compact layout.');
        console.log('Screenshots:', output);
    } finally {
        await browser?.close();
        server.kill();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
