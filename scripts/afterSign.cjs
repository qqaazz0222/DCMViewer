const { execFileSync } = require('child_process')
const path = require('path')

// ponytail: no paid Apple Developer ID, so we deep ad-hoc sign instead of
// notarizing. This stops Gatekeeper from flagging the app as damaged/malicious
// due to a partial signature, but a first launch still needs right-click > Open.
// Upgrade path: set CSC_LINK/CSC_KEY_PASSWORD + a notarize hook when a Developer ID exists.
module.exports = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  execFileSync('codesign', [
    '--force',
    '--deep',
    '--sign', '-',
    appPath,
  ], { stdio: 'inherit' })

  execFileSync('xattr', ['-cr', appPath])
}
