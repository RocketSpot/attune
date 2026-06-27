/*
 * media.js — "Smart Tuning" backend (main process).
 *
 *  • Detects the currently playing track from ANY app via Windows System Media
 *    Transport Controls (SMTC), polled through a long-lived PowerShell process.
 *  • Enriches it with a music genre — via the free iTunes Search API (no key),
 *    or via a connected Spotify account (richer artist genres) when available.
 *  • Streams { source, title, artist, app, playing, genre } to the renderer,
 *    which decides how to adjust the buds.
 *
 * All network / OS access lives here so the renderer stays sandboxed.
 */

'use strict';

const { ipcMain, shell, app } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let win = null;
let psProc = null;
let watching = false;
let lastKey = '';
const genreCache = new Map(); // "artist|title" -> genre string|null

// --- Spotify (optional enrichment) -------------------------------------------
const SPOTIFY_PORT = 8888;
const SPOTIFY_REDIRECT = `http://127.0.0.1:${SPOTIFY_PORT}/callback`;
const SPOTIFY_SCOPE = 'user-read-currently-playing user-read-playback-state';
let spotify = { clientId: '', tokens: null }; // tokens: { access, refresh, expires }
let oauthServer = null;
let oauthVerifier = '';
let oauthState = '';
let oauthTimer = null;

function closeOauthServer() {
  if (oauthTimer) { clearTimeout(oauthTimer); oauthTimer = null; }
  if (oauthServer) {
    try { if (oauthServer.closeAllConnections) oauthServer.closeAllConnections(); } catch (_) {}
    try { oauthServer.close(); } catch (_) {}
    oauthServer = null;
  }
}

const cfgPath = () => path.join(app.getPath('userData'), 'cmf-config.json');

// Use Windows PowerShell 5.1 explicitly — it projects WinRT types (SMTC).
// PowerShell 7 (pwsh.exe) does not, so never rely on PATH resolution here.
function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { return fs.existsSync(full) ? full : 'powershell.exe'; } catch (_) { return 'powershell.exe'; }
}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf-8'));
    spotify.clientId = c.spotifyClientId || '';
    spotify.tokens = c.spotifyTokens || null;
  } catch (_) { /* first run */ }
}
function saveConfig() {
  try {
    fs.writeFileSync(cfgPath(), JSON.stringify({ spotifyClientId: spotify.clientId, spotifyTokens: spotify.tokens }, null, 2));
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * SMTC watcher (PowerShell)                                          *
 * ------------------------------------------------------------------ */

// PowerShell that reports the active media session as JSON, once every 3s.
const SMTC_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$ext = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' }
$asTaskGeneric = $ext[0]
function Await($op, $type) { $m = $asTaskGeneric.MakeGenericMethod($type); $t = $m.Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
try { $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }
catch { Write-Output '{"status":-2}'; exit }
while ($true) {
  try {
    $s = $mgr.GetCurrentSession()
    if ($s -ne $null) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $pb = $s.GetPlaybackInfo()
      $o = [ordered]@{ title = "$($p.Title)"; artist = "$($p.Artist)"; album = "$($p.AlbumTitle)"; app = "$($s.SourceAppUserModelId)"; status = [int]$pb.PlaybackStatus }
      Write-Output ($o | ConvertTo-Json -Compress)
    } else { Write-Output '{"status":0}' }
  } catch { Write-Output '{"status":-1}' }
  [Console]::Out.Flush()
  Start-Sleep -Seconds 3
}
`;

function startWatch() {
  if (watching) return;
  watching = true;
  lastKey = '';
  const encoded = Buffer.from(SMTC_SCRIPT, 'utf16le').toString('base64');
  try {
    psProc = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true });
  } catch (e) {
    sendErr('Could not start media detection (PowerShell unavailable).');
    watching = false;
    return;
  }

  let buf = '';
  psProc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleSmtcLine(line);
    }
  });
  psProc.stderr.on('data', () => {});
  psProc.on('error', () => { sendErr('Media detection failed to start.'); });
  psProc.on('close', () => { psProc = null; if (watching) { /* unexpected exit */ } });
}

function stopWatch() {
  watching = false;
  lastKey = '';
  if (psProc) { try { psProc.kill(); } catch (_) {} psProc = null; }
}

async function handleSmtcLine(line) {
  let data;
  try { data = JSON.parse(line); } catch (_) { return; }
  const status = data.status;
  const playing = status === 4;

  if (!data.title || status === 0 || status < 0) {
    send({ source: 'system', playing: false, title: '', artist: '' });
    lastKey = '';
    return;
  }

  const title = (data.title || '').trim();
  const artist = (data.artist || '').trim();
  const key = (artist + '|' + title).toLowerCase();

  // Same track as last time → just update play state, skip genre lookup.
  if (key === lastKey) {
    send({ source: 'system', playing, title, artist, app: data.app, album: data.album, genre: genreCache.get(key) || null });
    return;
  }
  lastKey = key;

  // Push immediately (without genre), then enrich.
  send({ source: 'system', playing, title, artist, app: data.app, album: data.album, genre: null });

  const genre = await resolveGenre(artist, title);
  if (key === lastKey) {
    send({ source: spotify.tokens ? 'spotify' : 'system', playing, title, artist, app: data.app, album: data.album, genre });
  }
}

/* ------------------------------------------------------------------ *
 * Genre resolution                                                  *
 * ------------------------------------------------------------------ */

async function resolveGenre(artist, title) {
  const key = (artist + '|' + title).toLowerCase();
  if (genreCache.has(key)) return genreCache.get(key);
  let genre = null;
  if (spotify.tokens) {
    try { genre = await spotifyGenre(artist, title); } catch (_) {}
  }
  if (!genre) {
    try { genre = await itunesGenre(artist, title); } catch (_) {}
  }
  genreCache.set(key, genre);
  return genre;
}

async function itunesGenre(artist, title) {
  const term = encodeURIComponent(`${artist} ${title}`.trim());
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;
  const res = await fetchJson(url, {}, 6000);
  if (res && res.results && res.results[0]) return res.results[0].primaryGenreName || null;
  return null;
}

/* ------------------------------------------------------------------ *
 * Spotify (PKCE OAuth + genre enrichment)                            *
 * ------------------------------------------------------------------ */

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function spotifyStatus() {
  return { connected: !!spotify.tokens, hasClientId: !!spotify.clientId, redirect: SPOTIFY_REDIRECT };
}

async function spotifyConnect() {
  if (!spotify.clientId) return { ok: false, error: 'no-client-id' };
  closeOauthServer();

  oauthVerifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(oauthVerifier).digest());
  oauthState = b64url(crypto.randomBytes(16));

  await new Promise((resolve, reject) => {
    oauthServer = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/callback')) { res.writeHead(404); res.end(); return; }
      const u = new URL(req.url, SPOTIFY_REDIRECT);
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (!code || state !== oauthState) {
        res.end('<h2>Authorization failed.</h2><p>You can close this tab.</p>');
      } else {
        res.end('<body style="background:#0c0c0c;color:#fff;font-family:sans-serif;text-align:center;padding-top:80px"><h2 style="color:#ff6a1a">Connected!</h2><p>You can close this tab and return to the app.</p></body>');
        try { await spotifyExchange(code); sendSpotify(); } catch (e) { sendErr('Spotify token exchange failed.'); }
      }
      setTimeout(closeOauthServer, 800);
    });
    oauthServer.on('error', (e) => reject(e));
    oauthServer.listen(SPOTIFY_PORT, '127.0.0.1', resolve);
  }).catch((e) => { oauthServer = null; throw e; });

  // Watchdog: if the user never completes the login, free the port after 5 min.
  oauthTimer = setTimeout(closeOauthServer, 5 * 60 * 1000);
  if (oauthTimer.unref) oauthTimer.unref();

  const auth = new URL('https://accounts.spotify.com/authorize');
  auth.searchParams.set('client_id', spotify.clientId);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('redirect_uri', SPOTIFY_REDIRECT);
  auth.searchParams.set('scope', SPOTIFY_SCOPE);
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('state', oauthState);
  shell.openExternal(auth.toString());
  return { ok: true };
}

async function spotifyExchange(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: SPOTIFY_REDIRECT,
    client_id: spotify.clientId,
    code_verifier: oauthVerifier
  });
  const res = await fetchJson('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }, 8000);
  if (!res || !res.access_token) throw new Error('no token');
  spotify.tokens = { access: res.access_token, refresh: res.refresh_token, expires: Date.now() + (res.expires_in - 60) * 1000 };
  saveConfig();
}

async function spotifyRefresh() {
  if (!spotify.tokens || !spotify.tokens.refresh) return false;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: spotify.tokens.refresh, client_id: spotify.clientId });
  const res = await fetchJson('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
  }, 8000);
  if (!res || !res.access_token) return false;
  spotify.tokens.access = res.access_token;
  if (res.refresh_token) spotify.tokens.refresh = res.refresh_token;
  spotify.tokens.expires = Date.now() + (res.expires_in - 60) * 1000;
  saveConfig();
  return true;
}

async function spotifyToken() {
  if (!spotify.tokens) return null;
  if (Date.now() >= spotify.tokens.expires) { if (!(await spotifyRefresh())) return null; }
  return spotify.tokens.access;
}

async function spotifyGenre(artist, title) {
  const token = await spotifyToken();
  if (!token) return null;
  const q = encodeURIComponent(`track:${title} artist:${artist}`);
  const search = await fetchJson(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
    { headers: { Authorization: 'Bearer ' + token } }, 6000);
  const track = search && search.tracks && search.tracks.items && search.tracks.items[0];
  if (!track || !track.artists || !track.artists[0]) return null;
  const artistData = await fetchJson('https://api.spotify.com/v1/artists/' + track.artists[0].id,
    { headers: { Authorization: 'Bearer ' + token } }, 6000);
  if (artistData && artistData.genres && artistData.genres.length) return artistData.genres[0];
  return null;
}

function spotifyDisconnect() {
  spotify.tokens = null;
  saveConfig();
  sendSpotify();
}

/* ------------------------------------------------------------------ *
 * Helpers + IPC                                                     *
 * ------------------------------------------------------------------ */

async function fetchJson(url, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function send(payload) { try { if (win && !win.isDestroyed()) win.webContents.send('media:update', payload); } catch (_) {} }
function sendErr(message) { try { if (win && !win.isDestroyed()) win.webContents.send('media:error', message); } catch (_) {} }
function sendSpotify() { try { if (win && !win.isDestroyed()) win.webContents.send('spotify:status', spotifyStatus()); } catch (_) {} }

let registered = false;
function register(mainWindow) {
  win = mainWindow;
  if (registered) return; // ipcMain.handle throws if a channel is registered twice
  registered = true;
  loadConfig();

  ipcMain.handle('media:start', () => { startWatch(); return true; });
  ipcMain.handle('media:stop', () => { stopWatch(); return true; });

  ipcMain.handle('spotify:status', () => spotifyStatus());
  ipcMain.handle('spotify:setClientId', (_e, id) => { spotify.clientId = (id || '').trim(); saveConfig(); return spotifyStatus(); });
  ipcMain.handle('spotify:connect', async () => { try { return await spotifyConnect(); } catch (e) { return { ok: false, error: String(e && e.code || e) }; } });
  ipcMain.handle('spotify:disconnect', () => { spotifyDisconnect(); return spotifyStatus(); });
}

function dispose() {
  stopWatch();
  closeOauthServer();
}

module.exports = { register, dispose };
