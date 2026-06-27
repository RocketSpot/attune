/*
 * app.js — UI wiring for the CMF Buds Pro 2 desktop control.
 *
 * Defines every UI callback that protocol.js invokes (setBattery, setANCStatus,
 * setEQfromRead, setCustomEQ, setBassEnhance, ...) and hooks the on-screen
 * controls up to the protocol send functions. Classic script: shares globals
 * with protocol.js.
 */

'use strict';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * Window chrome                                                      *
 * ------------------------------------------------------------------ */
$('min').addEventListener('click', () => window.cmf.minimize());
$('close').addEventListener('click', () => window.cmf.close());

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ------------------------------------------------------------------ *
 * View switching                                                     *
 * ------------------------------------------------------------------ */
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(id).classList.add('active');
}

/* ------------------------------------------------------------------ *
 * Connect lifecycle (called from protocol.js)                        *
 * ------------------------------------------------------------------ */
const btnConnect = $('btn-connect');

btnConnect.addEventListener('click', () => {
  setConnectStatus('Looking for your buds', 'busy', true);
  btnConnect.disabled = true;
  btnConnect.textContent = 'Connecting…';
  cmfConnect();
});

function setConnectStatus(text, cls = '', busy = false) {
  const el = $('connect-status');
  el.className = cls;
  el.innerHTML = busy ? `<span class="dots">${text}</span>` : text;
}

function resetConnectButton() {
  btnConnect.disabled = false;
  btnConnect.textContent = 'Connect';
}

function onConnectError(kind) {
  const messages = {
    'no-device': 'No device selected. Pair your buds in Windows Bluetooth first, take them out of the case, then try again.',
    'open-failed': "Couldn't open the connection. Re-pair the buds in Windows Bluetooth settings and retry.",
    'not-identified': "Connected, but couldn't identify the buds. Are these CMF Buds Pro 2 (or another supported Nothing/CMF device)?"
  };
  setConnectStatus(messages[kind] || 'Connection failed.', 'err');
  resetConnectButton();
}

let currentModel = null;

function onModelDetected(model, sku) {
  currentModel = model;
  const valid = (c) => ['black', 'white', 'orange', 'blue'].includes(c);
  const saved = localStorage.getItem(COLOR_PREF);
  setBudColor(valid(saved) ? saved : (valid(model.color) ? model.color : 'orange'), false);
  $('dev-name').textContent = model.name;
  $('tb-device').textContent = model.name;
  setConnectStatus('Connected to ' + model.name, '');
  if (model.base !== 'B172') {
    toast('Optimized for CMF Buds Pro 2 — some controls may differ on ' + model.name);
  }
}

function onSessionStart() {
  resetConnectButton();
  $('dev-conn').textContent = 'Connected';
  showView('control-view');
  restoreSmartTuning();
}

function onSessionEnd() {
  $('tb-device').textContent = '';
  showView('connect-view');
  setConnectStatus('Buds disconnected.', '');
  resetConnectButton();
  resetControlState();
  stopSmart(); // keeps the saved preference; just halts watching
}

async function disconnect() {
  const port = SPPsocket;
  SPPsocket = null; // send() bails immediately once this is null
  // Cancel the read loop first so port.readable is unlocked, then close.
  try { if (sessionReader) await sessionReader.cancel(); } catch (_) {}
  try { if (port) await port.close(); } catch (_) {}
}
$('btn-disconnect').addEventListener('click', () => { disconnect(); });

/* ------------------------------------------------------------------ *
 * Earbud colour + dynamic theme                                      *
 * ------------------------------------------------------------------ */
// The four CMF Buds Pro 2 colourways → bud art + matching accent theme.
const COLORS = {
  black:  { name: 'Dark Grey',  accent: '#8b929c', dim: '#5d636c' },
  white:  { name: 'Light Grey', accent: '#d7dbe1', dim: '#a2a8b2' },
  orange: { name: 'Orange',     accent: '#ff6a1a', dim: '#bf4d10' },
  blue:   { name: 'Blue',       accent: '#3f82f7', dim: '#295bb5' }
};
const COLOR_PREF = 'cmf.budColor';
let currentColor = 'orange';

function setBudColor(color, persist = true) {
  if (!COLORS[color]) color = 'orange';
  currentColor = color;
  const base = `assets/buds/espeon_${color}_`;
  $('img-l').src = base + 'left.webp';
  $('img-r').src = base + 'right.webp';
  $('img-c').src = base + 'case.webp';
  const cb = $('connect-bud'); if (cb) cb.src = base + 'right.webp';

  document.documentElement.style.setProperty('--accent', COLORS[color].accent);
  document.documentElement.style.setProperty('--accent-dim', COLORS[color].dim);

  const nameEl = $('color-name'); if (nameEl) nameEl.textContent = COLORS[color].name;
  const sw = $('swatches');
  if (sw) sw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.color === color));

  if (persist) localStorage.setItem(COLOR_PREF, color);
}

(function bindSwatches() {
  const sw = $('swatches');
  if (sw) sw.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.color) { setBudColor(b.dataset.color, true); toast(COLORS[b.dataset.color].name + ' theme'); }
  });
})();

// Apply the saved theme at launch so the look is consistent before connecting.
setBudColor(localStorage.getItem(COLOR_PREF) || 'orange', false);

/* ------------------------------------------------------------------ *
 * Battery (callback: setBattery)                                     *
 * ------------------------------------------------------------------ */
function setBattery(side, percentage, charging = false) {
  const map = { l: 'l', r: 'r', c: 'c' };
  const s = map[side];
  if (!s) return;
  const card = $('batt-' + s);
  const pctEl = $('pct-' + s);
  const barEl = $('bar-' + s);
  const chgEl = $('chg-' + s);
  const disconnected = percentage === undefined || percentage === 'DISCONNECTED' || isNaN(percentage);
  if (disconnected) {
    card.classList.add('disc');
    pctEl.textContent = '—';
    barEl.style.width = '0%';
    chgEl.style.display = 'none';
    return;
  }
  card.classList.remove('disc');
  card.classList.toggle('low', percentage <= 20);
  pctEl.textContent = percentage + '%';
  barEl.style.width = percentage + '%';
  chgEl.style.display = charging ? 'inline' : 'none';
}

/* ------------------------------------------------------------------ *
 * Noise control (callback: setANCStatus)                             *
 * ------------------------------------------------------------------ */
// canonical ANC level: 1=Off 2=Transparency 3=NC-Low 4=NC-High 5=NC-Mid 6=NC-Adaptive
let lastNcLevel = 4; // default to High when switching into NC

const ANC_LEVEL = { off: 1, trans: 2, low: 3, high: 4, mid: 5, adaptive: 6 };
const STRENGTH_OF = { 3: 'low', 4: 'high', 5: 'mid', 6: 'adaptive' };

function applyAnc(level) {
  setANC_BT(level);
  setANCStatus(level); // optimistic
}

$('anc-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const mode = b.dataset.mode;
  if (mode === 'off') applyAnc(ANC_LEVEL.off);
  else if (mode === 'trans') applyAnc(ANC_LEVEL.trans);
  else if (mode === 'nc') applyAnc(lastNcLevel);
});

$('anc-strength').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const level = ANC_LEVEL[b.dataset.s];
  lastNcLevel = level;
  applyAnc(level);
});

function setANCStatus(level) {
  let mode = 'off';
  if (level === 1) mode = 'off';
  else if (level === 2) mode = 'trans';
  else { mode = 'nc'; lastNcLevel = level; }

  $('anc-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));

  const wrap = $('anc-strength-wrap');
  if (mode === 'nc') {
    wrap.classList.add('open');
    const s = STRENGTH_OF[level];
    $('anc-strength').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
  } else {
    wrap.classList.remove('open');
  }
}
function setANCDisplayUI() {}
function displayANC() {}
function setPersonalAncCheckbox() {}
function getCaseColor() {}

/* ------------------------------------------------------------------ *
 * Equalizer (callbacks: setEQfromRead, setCustomEQ,                  *
 *            setAdvancedEQfromRead)                                   *
 * ------------------------------------------------------------------ */
let customValues = [0, 0, 0]; // [bass, mid, treble]

$('eq-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const level = parseInt(b.dataset.eq, 10);
  setListeningMode(level);
  setEQfromRead(level);
  if (level === 6) getCustomEQ();
});

function setEQfromRead(level) {
  $('eq-chips').querySelectorAll('button').forEach((b) => b.classList.toggle('on', parseInt(b.dataset.eq, 10) === level));
  const custom = $('eq-custom');
  if (level === 6) {
    custom.classList.add('open');
    getCustomEQ();
  } else {
    custom.classList.remove('open');
  }
}

function setCustomEQ(array) {
  customValues = [Math.round(array[0]), Math.round(array[1]), Math.round(array[2])];
  $('eq-bass').value = clamp6(customValues[0]);
  $('eq-mid').value = clamp6(customValues[1]);
  $('eq-treble').value = clamp6(customValues[2]);
  $('eq-bass-v').textContent = signed(customValues[0]);
  $('eq-mid-v').textContent = signed(customValues[1]);
  $('eq-treble-v').textContent = signed(customValues[2]);
}
const clamp6 = (v) => Math.max(-6, Math.min(6, v));
const signed = (v) => (v > 0 ? '+' + v : '' + v);

function pushCustomEQ() {
  customValues = [parseInt($('eq-bass').value, 10), parseInt($('eq-mid').value, 10), parseInt($('eq-treble').value, 10)];
  $('eq-bass-v').textContent = signed(customValues[0]);
  $('eq-mid-v').textContent = signed(customValues[1]);
  $('eq-treble-v').textContent = signed(customValues[2]);
  // device band order: [mid, treble, bass]
  setCustomEQ_BT([customValues[1], customValues[2], customValues[0]]);
}
['eq-bass', 'eq-mid', 'eq-treble'].forEach((id) => {
  $(id).addEventListener('input', () => {
    $(id + '-v').textContent = signed(parseInt($(id).value, 10));
  });
  $(id).addEventListener('change', pushCustomEQ);
});

$('adv-eq').addEventListener('change', (e) => setAdvancedEQenabled(e.target.checked));
function setAdvancedEQfromRead(status) { $('adv-eq').checked = status === 1; }

/* ------------------------------------------------------------------ *
 * Bass enhance (callbacks: setBassEnhance, setBassLevel)             *
 * ------------------------------------------------------------------ */
let bassEnabled = false;
let bassLevel = 1;

$('bass-on').addEventListener('change', (e) => {
  bassEnabled = e.target.checked;
  $('bass-wrap').classList.toggle('open', bassEnabled);
  set_enhanced_bass(bassEnabled, bassLevel);
});
$('bass-level').addEventListener('input', () => {
  $('bass-level-v').textContent = $('bass-level').value;
});
$('bass-level').addEventListener('change', () => {
  bassLevel = parseInt($('bass-level').value, 10);
  set_enhanced_bass(bassEnabled, bassLevel);
});

function setBassEnhance(state) {
  bassEnabled = state === 1 || state === true;
  $('bass-on').checked = bassEnabled;
  $('bass-wrap').classList.toggle('open', bassEnabled);
}
function setBassLevel(level) {
  bassLevel = Math.max(1, Math.min(5, Math.round(level)));
  $('bass-level').value = bassLevel;
  $('bass-level-v').textContent = bassLevel;
}

/* ------------------------------------------------------------------ *
 * Quick settings (callbacks: setInEarCheckbox, setLatencyModeCheckbox)*
 * ------------------------------------------------------------------ */
$('in-ear').addEventListener('change', (e) => setInEar_BT(e.target.checked ? 1 : 0));
function setInEarCheckbox(status) { $('in-ear').checked = status === 1; }

$('low-lat').addEventListener('change', (e) => setLatency(e.target.checked ? 1 : 0));
function setLatencyModeCheckbox(status) {
  if (status === 1) $('low-lat').checked = true;
  else if (status === 2) $('low-lat').checked = false;
}

/* ------------------------------------------------------------------ *
 * Gestures (callback: updateGesturesFromArray)                       *
 * ------------------------------------------------------------------ */
const G = {
  double: ['Play/Pause', 'Skip Back', 'Skip Forward', 'Voice Assistant', 'No action'],
  triple: ['Skip Back', 'Skip Forward', 'Voice Assistant', 'No action'],
  hold: ['Noise control', 'Voice Assistant', 'No action'],
  dhold: ['Volume up', 'Volume down', 'Voice Assistant', 'No action']
};
// index -> device operation code, per gesture type
const OP = {
  double: [2, 8, 9, 11, 1],
  triple: [8, 9, 11, 1],
  dhold: [18, 19, 11, 1]
  // hold handled specially (index 0 depends on anc cycle)
};
const TYPE = { double: 2, triple: 3, hold: 7, dhold: 9 };
const DEVICE = { l: 2, r: 3 };

let currentSide = 'l';
const gState = { l: { double: 0, triple: 0, hold: 0, dhold: 0 }, r: { double: 0, triple: 0, hold: 0, dhold: 0 } };
let ancSelectorTap = [1, 1, 0]; // [transparency, NC, off]

function ancToggleFn(list) {
  const s = JSON.stringify(list);
  if (s === JSON.stringify([1, 1, 1])) return 10;
  if (s === JSON.stringify([0, 1, 1])) return 20;
  if (s === JSON.stringify([1, 0, 1])) return 21;
  if (s === JSON.stringify([1, 1, 0])) return 22;
  return 10;
}

function fillSelect(el, options) {
  el.innerHTML = options.map((o, i) => `<option value="${i}">${o}</option>`).join('');
}
function initGestureSelects() {
  fillSelect($('g-double'), G.double);
  fillSelect($('g-triple'), G.triple);
  fillSelect($('g-hold'), G.hold);
  fillSelect($('g-dhold'), G.dhold);
}
initGestureSelects();

function renderGestures(side) {
  currentSide = side;
  $('g-double').value = gState[side].double;
  $('g-triple').value = gState[side].triple;
  $('g-hold').value = gState[side].hold;
  $('g-dhold').value = gState[side].dhold;
  $('gest-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.side === side));
  syncAncSub();
}
function syncAncSub() {
  const showAnc = parseInt($('g-hold').value, 10) === 0; // "Noise control"
  $('anc-sub').classList.toggle('show', showAnc);
  document.querySelectorAll('#anc-sub input').forEach((c, i) => (c.checked = ancSelectorTap[i] === 1));
}

$('gest-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) renderGestures(b.dataset.side);
});

function bindGestureSelect(id, kind) {
  $(id).addEventListener('change', () => {
    const idx = parseInt($(id).value, 10);
    gState[currentSide][kind] = idx;
    let op;
    if (kind === 'hold') op = idx === 0 ? ancToggleFn(ancSelectorTap) : idx === 1 ? 11 : 1;
    else op = OP[kind][idx];
    sendGestures(DEVICE[currentSide], TYPE[kind], op);
    if (kind === 'hold') syncAncSub();
  });
}
bindGestureSelect('g-double', 'double');
bindGestureSelect('g-triple', 'triple');
bindGestureSelect('g-hold', 'hold');
bindGestureSelect('g-dhold', 'dhold');

document.querySelectorAll('#anc-sub input').forEach((chk) => {
  chk.addEventListener('change', (e) => {
    const checked = document.querySelectorAll('#anc-sub input:checked').length;
    if (checked < 2) { e.target.checked = !e.target.checked; return; } // need at least 2
    const idx = parseInt(e.target.dataset.anc, 10);
    ancSelectorTap[idx] = ancSelectorTap[idx] === 1 ? 0 : 1;
    const op = ancToggleFn(ancSelectorTap);
    sendGestures(DEVICE.l, TYPE.hold, op);
    sendGestures(DEVICE.r, TYPE.hold, op);
  });
});

function updateGesturesFromArray(array) {
  const A2I = {
    double: { 2: 0, 8: 1, 9: 2, 11: 3, 1: 4 },
    triple: { 8: 0, 9: 1, 11: 2, 1: 3 },
    dhold: { 18: 0, 19: 1, 11: 2, 1: 3 }
  };
  const ANC_FROM_ACTION = { 10: [1, 1, 1], 20: [0, 1, 1], 21: [1, 0, 1], 22: [1, 1, 0] };
  array.forEach((g) => {
    const side = g.gestureDevice === 2 ? 'l' : g.gestureDevice === 3 ? 'r' : null;
    if (!side) return;
    const a = g.gestureAction;
    switch (g.gestureType) {
      case 2: if (a in A2I.double) gState[side].double = A2I.double[a]; break;
      case 3: if (a in A2I.triple) gState[side].triple = A2I.triple[a]; break;
      case 9: if (a in A2I.dhold) gState[side].dhold = A2I.dhold[a]; break;
      case 7:
        if ([10, 20, 21, 22].includes(a)) { gState[side].hold = 0; ancSelectorTap = ANC_FROM_ACTION[a].slice(); }
        else if (a === 11) gState[side].hold = 1;
        else if (a === 1) gState[side].hold = 2;
        break;
    }
  });
  renderGestures(currentSide);
}

/* ------------------------------------------------------------------ *
 * Ear-tip fit test (callback: earTipStateStatus)                     *
 * ------------------------------------------------------------------ */
$('btn-fit').addEventListener('click', () => {
  $('fit-msg').textContent = 'Testing… keep both buds in your ears.';
  ['fit-l', 'fit-r'].forEach((id) => { $(id).className = 'e'; });
  launchEarFitTest();
});

function earTipStateStatus(left, right) {
  applyFit('fit-l', left);
  applyFit('fit-r', right);
  let msg;
  if (left === 0 && right === 0) msg = 'Perfect fit — you’re good to go.';
  else if (left === 2 || right === 2) msg = 'Make sure both buds are in your ears.';
  else msg = 'Adjust the buds or try another ear-tip size.';
  $('fit-msg').textContent = msg;
}
function applyFit(id, state) {
  const el = $(id);
  el.className = 'e';
  const ring = el.querySelector('.ring');
  if (state === 0) { el.classList.add('good'); ring.textContent = '✓'; }
  else if (state === 1) { el.classList.add('poor'); ring.textContent = '!'; }
  else { el.classList.add('bad'); ring.textContent = '×'; }
}

/* ------------------------------------------------------------------ *
 * Find my buds                                                       *
 * ------------------------------------------------------------------ */
let ringingL = false, ringingR = false;
$('ring-l').addEventListener('click', () => {
  ringingL = !ringingL;
  ringBuds(ringingL ? 1 : 0, true);
  $('ring-l').textContent = ringingL ? 'Stop' : 'Ring Left';
  $('ring-l').classList.toggle('ringing', ringingL);
});
$('ring-r').addEventListener('click', () => {
  ringingR = !ringingR;
  ringBuds(ringingR ? 1 : 0, false);
  $('ring-r').textContent = ringingR ? 'Stop' : 'Ring Right';
  $('ring-r').classList.toggle('ringing', ringingR);
});

/* ------------------------------------------------------------------ *
 * Firmware (callback: setFirmwareText)                               *
 * ------------------------------------------------------------------ */
function setFirmwareText(txt) { $('dev-fw').textContent = txt || '—'; }
function setMacAdressText() {}

/* ------------------------------------------------------------------ *
 * Reset on disconnect                                                *
 * ------------------------------------------------------------------ */
function resetControlState() {
  ringingL = ringingR = false;
  $('ring-l').textContent = 'Ring Left'; $('ring-l').classList.remove('ringing');
  $('ring-r').textContent = 'Ring Right'; $('ring-r').classList.remove('ringing');
  ['fit-l', 'fit-r'].forEach((id) => { $(id).className = 'e'; });
  $('fit-msg').textContent = 'Put both buds in and run the test.';
  $('dev-fw').textContent = '—';
}

/* ------------------------------------------------------------------ *
 * Smart Tuning (auto EQ) + Music Sources                             *
 * ------------------------------------------------------------------ */
const SMART_PREF = 'cmf.smartTuning';
const SMART_BASS_PREF = 'cmf.smartBass';
let smartOn = localStorage.getItem(SMART_PREF) === '1';
let smartBass = localStorage.getItem(SMART_BASS_PREF) === '1';
let smartLastKey = '';   // track we last auto-applied
let mediaWatching = false;

// Map a genre string to an EQ preset (+ whether to boost bass).
function tuningForGenre(genre) {
  if (!genre) return null;
  const g = genre.toLowerCase();
  const has = (...k) => k.some((x) => g.includes(x));
  if (has('hip hop', 'hip-hop', 'rap', 'trap', 'grime', 'drill')) return { eq: 2, bass: true, label: 'Electronic' };
  if (has('electronic', 'edm', 'dance', 'house', 'techno', 'dubstep', 'trance', 'drum', 'bass', 'garage')) return { eq: 2, bass: true, label: 'Electronic' };
  if (has('rock', 'metal', 'punk', 'grunge')) return { eq: 1, bass: false, label: 'Rock' };
  if (has('classical', 'orchestr', 'piano', 'instrumental', 'soundtrack', 'score', 'ambient', 'new age')) return { eq: 5, bass: false, label: 'Classical' };
  if (has('jazz', 'blues', 'soul', 'acoustic', 'folk', 'country', 'singer', 'songwriter')) return { eq: 4, bass: false, label: 'Enhance Vocals' };
  if (has('podcast', 'spoken', 'speech', 'audiobook', 'talk')) return { eq: 4, bass: false, label: 'Enhance Vocals' };
  if (has('pop', 'indie', 'r&b', 'rnb', 'latin', 'reggae', 'disco', 'funk', 'k-pop')) return { eq: 3, bass: false, label: 'Pop' };
  return { eq: 0, bass: false, label: 'Balanced' };
}

function applyBass(enabled, level) {
  bassEnabled = enabled;
  $('bass-on').checked = enabled;
  $('bass-wrap').classList.toggle('open', enabled);
  if (enabled && level) { bassLevel = level; $('bass-level').value = level; $('bass-level-v').textContent = level; }
  set_enhanced_bass(enabled, bassLevel);
}

const SMART_BASS_LEVEL = 3; // bass level Smart Tuning sets for bass-forward genres
function applyTuning(genre) {
  const t = tuningForGenre(genre);
  if (!t) return null;
  setListeningMode(t.eq);
  setEQfromRead(t.eq);
  let bassApplied = null; // null = not managed, 0 = turned off, >0 = level set
  if (smartBass) {
    applyBass(t.bass, t.bass ? SMART_BASS_LEVEL : bassLevel);
    bassApplied = t.bass ? SMART_BASS_LEVEL : 0;
  }
  return { label: t.label, bassApplied };
}

function setSmartState(on) {
  smartOn = on;
  $('smart-on').checked = on;
  $('smart-state').textContent = on ? 'On' : 'Off';
  $('smart-body').classList.toggle('open', on);
  localStorage.setItem(SMART_PREF, on ? '1' : '0');
  if (on) startSmart(); else stopSmart();
}

function startSmart() {
  if (mediaWatching) return;
  mediaWatching = true;
  smartLastKey = '';
  try { window.cmf.mediaStart(); } catch (_) {}
}
// Show the album cover (data URL) as the now-playing thumbnail, or fall back
// to the note icon when there's no art.
function setNowPlayingArt(art) {
  const el = $('np-art');
  if (!el) return;
  if (art) { el.style.backgroundImage = `url("${art}")`; el.classList.add('has-art'); }
  else { el.style.backgroundImage = ''; el.classList.remove('has-art'); }
}

function stopSmart() {
  mediaWatching = false;
  try { window.cmf.mediaStop(); } catch (_) {}
  const np = document.querySelector('.np');
  if (np) np.classList.remove('playing');
  $('np-title').textContent = 'Nothing playing';
  $('np-sub').textContent = 'Play a song in Spotify or any app to begin';
  $('np-eq').textContent = '';
  setNowPlayingArt(null);
}

function restoreSmartTuning() {
  $('smart-bass').checked = smartBass;
  setSmartState(smartOn);
}

$('smart-on').addEventListener('change', (e) => setSmartState(e.target.checked));
$('smart-bass').addEventListener('change', (e) => {
  smartBass = e.target.checked;
  localStorage.setItem(SMART_BASS_PREF, smartBass ? '1' : '0');
});

if (window.cmf && window.cmf.onMediaUpdate) {
  window.cmf.onMediaUpdate((d) => {
    if (!smartOn) return;
    const np = document.querySelector('.np');
    if (!d || !d.title) {
      if (np) np.classList.remove('playing');
      $('np-title').textContent = 'Nothing playing';
      $('np-sub').textContent = 'Play a song in Spotify or any app to begin';
      $('np-eq').textContent = '';
      setNowPlayingArt(null);
      smartLastKey = '';
      return;
    }
    $('np-title').textContent = d.title;
    $('np-sub').textContent = (d.artist || 'Unknown artist') + (d.genre ? ' · ' + d.genre : '');
    if (np) np.classList.toggle('playing', !!d.playing);
    setNowPlayingArt(d.art || null);

    const key = ((d.artist || '') + '|' + (d.title || '')).toLowerCase();
    if (d.playing && d.genre && SPPsocket && key !== smartLastKey) {
      smartLastKey = key;
      const r = applyTuning(d.genre);
      if (r) {
        let txt = '→ ' + r.label;
        if (r.bassApplied !== null) txt += r.bassApplied > 0 ? ' · Bass ' + r.bassApplied : ' · Bass off';
        $('np-eq').textContent = txt;
        toast('Smart Tuning · ' + r.label + (r.bassApplied > 0 ? ' + Bass ' + r.bassApplied : '') + ' · ' + d.genre);
      }
    }
  });
}
if (window.cmf && window.cmf.onMediaError) {
  window.cmf.onMediaError((msg) => { if (smartOn) toast(msg); });
}

/* ---- Spotify connect ---- */
let spotifyState = { connected: false, hasClientId: false };

function renderSpotify(s) {
  if (s) spotifyState = s;
  const btn = $('sp-btn');
  if (spotifyState.connected) {
    btn.textContent = 'Disconnect';
    btn.classList.add('connected');
    $('sp-desc').textContent = 'Connected — using Spotify for genre tuning';
    $('sp-setup').classList.remove('open');
  } else {
    btn.textContent = 'Connect';
    btn.classList.remove('connected');
    $('sp-desc').textContent = 'Connect for more accurate genre-based tuning';
  }
  if (spotifyState.hasClientId && $('sp-clientid') && !$('sp-clientid').value) {
    $('sp-clientid').placeholder = 'Client ID saved ✓';
  }
}

$('sp-btn').addEventListener('click', async () => {
  if (spotifyState.connected) {
    renderSpotify(await window.cmf.spotifyDisconnect());
    toast('Spotify disconnected');
    return;
  }
  if (!spotifyState.hasClientId) { $('sp-setup').classList.toggle('open'); return; }
  const r = await window.cmf.spotifyConnect();
  if (r && r.ok) toast('Opening Spotify login in your browser…');
  else if (r && r.error === 'no-client-id') $('sp-setup').classList.add('open');
  else toast('Could not start Spotify connect (is port 8888 free?).');
});

$('sp-save').addEventListener('click', async () => {
  const id = $('sp-clientid').value.trim();
  if (!id) { toast('Paste your Spotify Client ID first.'); return; }
  renderSpotify(await window.cmf.spotifySetClientId(id));
  const r = await window.cmf.spotifyConnect();
  if (r && r.ok) toast('Opening Spotify login…');
});

if (window.cmf && window.cmf.onSpotifyStatus) window.cmf.onSpotifyStatus((s) => renderSpotify(s));
if (window.cmf && window.cmf.spotifyStatus) window.cmf.spotifyStatus().then(renderSpotify).catch(() => {});

/* ------------------------------------------------------------------ *
 * Diagnostics from main process                                      *
 * ------------------------------------------------------------------ */
if (window.cmf && window.cmf.onPortList) {
  window.cmf.onPortList((data) => {
    if (data && data.chosen == null) {
      setConnectStatus('No Bluetooth buds found. Pair them in Windows first.', 'err');
    }
  });
}

window.cmf.version().then((v) => { $('tb-device').dataset.v = v; }).catch(() => {});

console.log('[boot] renderer scripts loaded; serial=' + (navigator.serial ? 'available' : 'MISSING'));

/* ------------------------------------------------------------------ *
 * Demo mode (?demo=1) — populate the control panel without hardware   *
 * so the UI can be previewed / screenshotted. No-op in normal use.    *
 * ------------------------------------------------------------------ */
if (new URLSearchParams(location.search).get('demo')) {
  onModelDetected({ name: 'CMF Buds Pro 2', base: 'B172', codename: 'espeon', color: 'orange' }, '78');
  onSessionStart();
  setBattery('l', 82, false);
  setBattery('r', 76, true);
  setBattery('c', 54, false);
  setANCStatus(6);            // NC + Adaptive
  setEQfromRead(0);          // Balanced
  setBassEnhance(1); setBassLevel(3);
  setInEarCheckbox(1);
  setLatencyModeCheckbox(2);
  setFirmwareText('1.0.2.30');
  updateGesturesFromArray([
    { gestureDevice: 2, gestureType: 2, gestureAction: 2 },
    { gestureDevice: 2, gestureType: 3, gestureAction: 9 },
    { gestureDevice: 2, gestureType: 7, gestureAction: 22 },
    { gestureDevice: 2, gestureType: 9, gestureAction: 18 }
  ]);
  earTipStateStatus(0, 1);
  // Smart Tuning showcase (no real watching in demo)
  mediaWatching = true; smartOn = true; smartBass = true;
  $('smart-on').checked = true; $('smart-state').textContent = 'On'; $('smart-body').classList.add('open');
  $('smart-bass').checked = true;
  $('np-title').textContent = 'DNA.';
  $('np-sub').textContent = 'Kendrick Lamar · Hip-Hop/Rap';
  $('np-eq').textContent = '→ Electronic · Bass 3';
  document.querySelector('.np').classList.add('playing');
  setNowPlayingArt('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7b3ff2"/><stop offset="0.5" stop-color="#ff2e63"/><stop offset="1" stop-color="#ff8a1a"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/><circle cx="60" cy="60" r="15" fill="#0d0d0d"/><circle cx="60" cy="60" r="4" fill="#fff"/></svg>'));
  renderSpotify({ connected: false, hasClientId: false });
  if (new URLSearchParams(location.search).get('blue')) setBudColor('blue', false);
}
