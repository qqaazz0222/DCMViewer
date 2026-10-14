const { mkdirSync, copyFileSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
mkdirSync(resolve(root, 'vscode-extension/assets'), { recursive: true });
mkdirSync(resolve(root, 'release'), { recursive: true });
copyFileSync(resolve(root, 'assets/icon.png'), resolve(root, 'vscode-extension/assets/icon.png'));
copyFileSync(resolve(root, 'third-party/matplotlib-LICENSE.txt'), resolve(root, 'vscode-extension/assets/matplotlib-LICENSE.txt'));
