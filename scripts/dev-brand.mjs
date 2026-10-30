// Unpackaged macOS runs take the Dock/menu-bar name from Electron.app's Info.plist; rename it to productName.
// Packaged builds are named by electron-builder. Runs from postinstall.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

if (process.platform === 'darwin') {
  const { productName } = JSON.parse(readFileSync('package.json', 'utf8'));
  const bundle = path.join('node_modules', 'electron', 'dist', 'Electron.app');
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execFileSync('plutil', ['-replace', key, '-string', productName, plist]);
  }
  // Editing Info.plist breaks the bundle's ad-hoc signature; re-sign so arm64 still launches it.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle]);
}
