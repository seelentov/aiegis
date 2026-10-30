// Unpackaged macOS runs take the Dock/menu-bar name from Electron.app's Info.plist; rename it to productName.
// Packaged builds are named by electron-builder. Runs from postinstall.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const bundle = path.join('node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(bundle, 'Contents', 'Info.plist');
// The Electron binary may not be downloaded yet (CI installs it lazily); dev branding is optional.
if (process.platform === 'darwin' && existsSync(plist)) {
  const { productName } = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execFileSync('plutil', ['-replace', key, '-string', productName, plist]);
  }
  // Editing Info.plist breaks the bundle's ad-hoc signature; re-sign so arm64 still launches it.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle]);
}
