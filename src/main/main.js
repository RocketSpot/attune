const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const media = require('./media');

// CMF / Nothing earbuds RFCOMM service class IDs used by ear (web).
const SPP_UUID = 'aeac4a03-dff5-498f-843a-34487cf133eb';
const FASTPAIR_UUID = 'df21fe2c-2515-4fdb-8886-f12c4d67927c';

// Web Serial over Bluetooth RFCOMM is enabled by default in Chromium 117+
// (Electron 33 ships Chromium 130), so no extra feature flag is required.

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: '#0d0d0d',
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icons', 'app_256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  const ses = mainWindow.webContents.session;

  // Smart Tuning backend (system media detection, genre lookup, Spotify).
  media.register(mainWindow);

  // --- Web Serial permission wiring -------------------------------------------------
  // Grant the 'serial' permission so navigator.serial works without a prompt.
  ses.setPermissionCheckHandler((wc, permission) => {
    return permission === 'serial' || permission === 'serial-port';
  });

  // Persist/allow device access for serial (and bluetooth, used for RFCOMM discovery).
  ses.setDevicePermissionHandler((details) => {
    return details.deviceType === 'serial' || details.deviceType === 'bluetooth';
  });

  // When the renderer calls navigator.serial.requestPort(), Chromium asks us which
  // port to hand back. We auto-select the paired Bluetooth port that exposes the
  // CMF/Nothing RFCOMM service, falling back to the first Bluetooth/serial port.
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();

    const isOurs = (p) => {
      const id = (p.bluetoothServiceClassId || '').toLowerCase();
      return id === SPP_UUID || id === FASTPAIR_UUID;
    };

    let chosen =
      portList.find(isOurs) ||
      portList.find((p) => !!p.bluetoothServiceClassId) ||
      portList[0];

    // Let the renderer surface what we found / didn't find.
    try {
      webContents.send('serial:portlist', {
        ports: portList.map((p) => ({
          portId: p.portId,
          portName: p.portName,
          displayName: p.displayName,
          bluetoothServiceClassId: p.bluetoothServiceClassId || null
        })),
        chosen: chosen ? chosen.portId : null
      });
    } catch (_) {}

    callback(chosen ? chosen.portId : '');
  });

  ses.on('serial-port-added', (event, port) => {
    try { mainWindow.webContents.send('serial:added', port.portName || port.displayName || ''); } catch (_) {}
  });

  // Open external links (e.g. GitHub) in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Forward renderer console + load failures to the main process stdout
  // (useful when launched from a terminal for debugging).
  mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
    console.log(`[renderer] ${message}`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    console.error(`[preload-error] ${p}: ${err}`);
  });

  const q = {};
  if (process.env.CMF_DEMO) q.demo = '1';
  if (process.env.CMF_BLUE) q.blue = '1';
  const loadOpts = Object.keys(q).length ? { query: q } : undefined;
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), loadOpts);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Smoke test: optionally capture a screenshot, then auto-quit.
    if (process.env.CMF_SMOKE || process.env.CMF_SHOT) {
      const delay = process.env.CMF_SHOT ? 1600 : 4000;
      setTimeout(async () => {
        if (process.env.CMF_SHOT) {
          try {
            if (process.env.CMF_SCROLL) {
              await mainWindow.webContents.executeJavaScript(
                `document.getElementById('control-view').scrollTop = ${parseInt(process.env.CMF_SCROLL, 10) || 0}`
              );
              await new Promise((r) => setTimeout(r, 300));
            }
            const img = await mainWindow.webContents.capturePage();
            require('fs').writeFileSync(process.env.CMF_SHOT, img.toPNG());
            console.log('[shot] saved ' + process.env.CMF_SHOT);
          } catch (e) { console.error('[shot] failed', e); }
        }
        console.log('[smoke] window rendered OK, quitting');
        app.quit();
      }, delay);
    }
  });
  mainWindow.on('closed', () => { media.dispose(); mainWindow = null; });
}

// --- Window control IPC (custom frameless titlebar) ---------------------------------
ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:close', () => mainWindow && mainWindow.close());
ipcMain.handle('app:version', () => app.getVersion());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
