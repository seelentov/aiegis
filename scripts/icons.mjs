// Renders build/icon.svg into platform icons. Run: npm run icons
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

const SRC = 'build/icon.svg';
const svg = readFileSync(SRC, 'utf8');
// macOS keeps the 100px grid inset; Windows/Linux icons are drawn near full-bleed.
const variants = { mac: svg, full: svg.replace('viewBox="0 0 1024 1024"', 'viewBox="76 76 872 872"') };

async function render(markup) {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent">${markup.replace('<svg ', '<svg style="display:block" ')}</body></html>`;
  // Offscreen windows cannot capturePage; take a painted frame after load instead.
  let loaded = false;
  const frame = new Promise((resolve) =>
    win.webContents.on('paint', (_e, _dirty, image) => loaded && !image.isEmpty() && resolve(image)),
  );
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  loaded = true;
  win.webContents.invalidate();
  const img = await frame;
  win.destroy();
  const out = img.resize({ width: 1024, height: 1024, quality: 'best' });
  const corner = out.toBitmap().readUInt8(3); // BGRA alpha of pixel (0,0)
  if (corner !== 0) throw new Error(`icon corner is not transparent (alpha ${corner})`);
  return out;
}

const png = (img, size) => img.resize({ width: size, height: size, quality: 'best' }).toPNG();

function ico(img, sizes) {
  const pngs = sizes.map((s) => png(img, s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e);
    head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}

// Each render destroys its window; do not quit between renders.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const mac = await render(variants.mac);
  const full = await render(variants.full);

  writeFileSync('build/icon.png', png(mac, 1024));

  const set = path.join(mkdtempSync(path.join(tmpdir(), 'aiegis-icon-')), 'icon.iconset');
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(set, `icon_${s}x${s}.png`), png(mac, s));
    writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), png(mac, s * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', 'build/icon.icns']);
  rmSync(path.dirname(set), { recursive: true, force: true });

  writeFileSync('build/icon.ico', ico(full, [16, 24, 32, 48, 64, 128, 256]));

  mkdirSync('build/icons', { recursive: true });
  for (const s of [16, 32, 48, 64, 128, 256, 512]) writeFileSync(`build/icons/${s}x${s}.png`, png(full, s));

  console.log('icons written to build/');
  app.quit();
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
