const { runTests } = require('@vscode/test-electron');
const { resolve } = require('node:path');
const { existsSync } = require('node:fs');
// Codex may inherit Electron's Node-only mode; the test host needs the GUI.
delete process.env.ELECTRON_RUN_AS_NODE;
const installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
runTests({
    extensionDevelopmentPath: resolve(__dirname, '..'),
    extensionTestsPath: resolve(__dirname, 'integration.cjs'),
    ...(existsSync(installed) ? { vscodeExecutablePath: installed } : {}),
    launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
}).catch(error => { console.error(error); process.exitCode = 1; });
