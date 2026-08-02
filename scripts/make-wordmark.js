// Renders the "turtle talks" wordmark (Quicksand, one colour) to a transparent
// PNG via Electron's offscreen renderer. Run: npx electron scripts/make-wordmark.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const COLOR = process.env.WORDMARK_COLOR || '#f5ecd3';
const OUT = path.join(__dirname, '..', 'assets', 'wordmark.png');
const TMP = path.join(__dirname, '..', 'assets', '__wordmark.html');

const html = `<!doctype html><html><head><style>
  @font-face { font-family: Q; src: url('fonts/Quicksand.woff2') format('woff2-variations'); font-weight: 300 700; }
  html, body { margin: 0; background: transparent; }
  #w {
    font-family: Q, sans-serif; font-weight: 620; font-size: 160px;
    letter-spacing: -2px; color: ${COLOR};
    padding: 20px 30px; display: inline-block; white-space: nowrap;
  }
</style></head><body><span id="w">turtle talks</span></body></html>`;

app.whenReady().then(async () => {
  fs.writeFileSync(TMP, html);
  const win = new BrowserWindow({
    width: 1400,
    height: 300,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(TMP);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 300));
  const rect = await win.webContents.executeJavaScript(
    `(() => { const r = document.getElementById('w').getBoundingClientRect();
       return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`,
  );
  const img = await win.webContents.capturePage(rect);
  fs.writeFileSync(OUT, img.toPNG());
  fs.rmSync(TMP, { force: true });
  console.log('wrote', OUT, JSON.stringify(rect));
  app.exit(0);
});
