const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
buildSync({
    entryPoints: ['extension', 'transfer', 'volumeServer'].map(name => resolve(root, `vscode-extension/src/${name}.ts`)),
    outdir: resolve(root, 'vscode-extension/out'), bundle: true, platform: 'node',
    format: 'cjs', target: 'node18', external: ['vscode', './volumeServer', './transfer'],
});
