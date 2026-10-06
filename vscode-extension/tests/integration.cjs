const assert = require('node:assert/strict');
const vscode = require('vscode');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
exports.run = async () => {
    const extension = vscode.extensions.getExtension('qqaazz0222.dcmviewer');
    assert.ok(extension, 'Extension must be discovered');
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['openViewer', 'openFiles', 'openFolder', 'openInViewer']) {
        assert.ok(commands.includes('dcmviewer.' + id), id + ' must be registered');
    }
    await vscode.commands.executeCommand('dcmviewer.openViewer');
    assert.ok(vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.label === 'DCMViewer'));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const folder = await mkdtemp(join(tmpdir(), 'dcmviewer-test-'));
    try {
        // A valid small NPY volume, generated without patient data.
        const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 2), }";
        const padding = ' '.repeat((64 - ((10 + header.length + 1) % 64)) % 64);
        const headerBytes = Buffer.from(header + padding + '\n');
        const prefix = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, 0, 0]);
        prefix.writeUInt16LE(headerBytes.length, 8);
        const pixels = Buffer.alloc(16);
        [0, 100, 200, 300].forEach((value, index) => pixels.writeFloatLE(value, index * 4));
        const file = join(folder, 'test.npy');
        await writeFile(file, Buffer.concat([prefix, headerBytes, pixels]));
        const uri = vscode.Uri.file(file);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'dcmviewer.volume');
        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
        assert.ok(tabs.some(t => t.input instanceof vscode.TabInputCustom && t.input.viewType === 'dcmviewer.volume' && t.input.uri.toString() === uri.toString()), 'NPY must open with the custom editor');
        await vscode.commands.executeCommand('dcmviewer.openFolder', vscode.Uri.file(folder));
        assert.ok(vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.label === 'DCMViewer'));
        console.log('DCMViewer integration passed: activation, commands, NPY custom editor and folder viewer.');
    } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await rm(folder, { recursive: true, force: true });
    }
};
