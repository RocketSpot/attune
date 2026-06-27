/*
 * make-icon.js — generates a custom app icon (no external deps).
 * Renders an SVG with Electron, downscales to standard sizes via nativeImage,
 * and assembles a multi-resolution .ico (+ a 512px .png).
 *
 * Run:  npx electron build/make-icon.js
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = __dirname;

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff9a4d"/>
      <stop offset="0.55" stop-color="#ff6a1a"/>
      <stop offset="1" stop-color="#e9540a"/>
    </linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.18"/>
    </filter>
  </defs>
  <rect x="56" y="56" width="912" height="912" rx="224" fill="url(#bg)"/>
  <g fill="#ffffff" filter="url(#sh)">
    <rect x="192" y="362" width="96" height="300" rx="48"/>
    <rect x="328" y="262" width="96" height="500" rx="48"/>
    <rect x="464" y="202" width="96" height="620" rx="48"/>
    <rect x="600" y="292" width="96" height="440" rx="48"/>
    <rect x="736" y="342" width="96" height="340" rx="48"/>
  </g>
</svg>`;

function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const datas = [];
  images.forEach((im, i) => {
    const b = i * 16;
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, b + 0);
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, b + 1);
    dir.writeUInt8(0, b + 2);
    dir.writeUInt8(0, b + 3);
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(im.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += im.png.length;
    datas.push(im.png);
  });
  return Buffer.concat([header, dir, ...datas]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', useContentSize: true,
    webPreferences: { offscreen: false }
  });
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(
    `<!doctype html><html><body style="margin:0;background:transparent">${SVG}</body></html>`
  );
  await win.loadURL(dataUrl);
  await new Promise((r) => setTimeout(r, 600));

  const full = await win.webContents.capturePage();
  const base = full.resize({ width: 1024, height: 1024, quality: 'best' });

  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), base.resize({ width: 512, height: 512, quality: 'best' }).toPNG());

  const sizes = [256, 128, 64, 48, 32, 16];
  const images = sizes.map((size) => ({ size, png: base.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(images));

  // App-internal PNGs for in-window icon use.
  const rdIcons = path.join(OUT_DIR, '..', 'src', 'renderer', 'assets', 'icons');
  [256, 512, 1024].forEach((s) => {
    fs.writeFileSync(path.join(rdIcons, `app_${s}.png`), base.resize({ width: s, height: s, quality: 'best' }).toPNG());
  });

  console.log('[icon] wrote build/icon.ico (' + sizes.join(',') + '), build/icon.png, app_*.png');
  app.quit();
});
