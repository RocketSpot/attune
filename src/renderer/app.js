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
  currentCodename = model.codename || 'espeon';
  buildSwatches();
  const cols = deviceColors();
  const saved = localStorage.getItem(COLOR_PREF);
  const color = cols.includes(saved) ? saved : (cols.includes(model.color) ? model.color : cols[0]);
  setBudColor(color, false);
  applyCapabilities(model.base);
  $('dev-name').textContent = model.name;
  $('tb-device').textContent = model.name;
  setConnectStatus('Connected to ' + model.name, '');
  if (model.base !== 'B172') {
    toast('Connected to ' + model.name + ' — Smart Tuning EQ is optimized for CMF Buds Pro 2');
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
  trayBatt.l = trayBatt.r = trayBatt.c = null;
  pushTrayBattery();
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
 * Earbud colour + dynamic theme (per-device colourways)              *
 * ------------------------------------------------------------------ */
const COLOR_META = {
  black:  { name: 'Dark Grey',  sw: '#3a3b3d', accent: '#8b929c', dim: '#5d636c' },
  white:  { name: 'Light Grey', sw: '#dcdde0', accent: '#d7dbe1', dim: '#a2a8b2' },
  orange: { name: 'Orange',     sw: '#ff6a1a', accent: '#ff6a1a', dim: '#bf4d10' },
  blue:   { name: 'Blue',       sw: '#3f82f7', accent: '#3f82f7', dim: '#295bb5' },
  yellow: { name: 'Yellow',     sw: '#ffcf3f', accent: '#ffcf3f', dim: '#bd9412' }
};
const DEVICE_COLORS = {
  espeon: ['black', 'white', 'orange', 'blue'], donphan: ['black', 'orange', 'white'],
  corsola: ['black', 'white', 'orange'], cleffa: ['black', 'white', 'yellow'],
  entei: ['black', 'white'], two: ['black', 'white'], one: ['black', 'white'],
  flaaffy: ['white'], sticks: ['white']
};
const COLOR_PREF = 'cmf.budColor';
let currentCodename = 'espeon';
let currentColor = 'orange';

function deviceColors() { return DEVICE_COLORS[currentCodename] || ['orange']; }

function buildSwatches() {
  const sw = $('swatches');
  if (!sw) return;
  sw.innerHTML = deviceColors()
    .map((c) => `<button data-color="${c}"><span class="sw" style="background:${COLOR_META[c].sw}"></span>${COLOR_META[c].name}</button>`)
    .join('');
}

function setBudColor(color, persist = true) {
  const cols = deviceColors();
  if (!cols.includes(color)) color = cols[0];
  currentColor = color;
  const m = COLOR_META[color] || COLOR_META.orange;
  const base = `assets/buds/${currentCodename}_${color}_`;
  $('img-l').src = base + 'left.webp';
  $('img-r').src = base + 'right.webp';
  $('img-c').src = base + 'case.webp';
  const cb = $('connect-bud'); if (cb) cb.src = base + 'right.webp';

  document.documentElement.style.setProperty('--accent', m.accent);
  document.documentElement.style.setProperty('--accent-dim', m.dim);

  const nameEl = $('color-name'); if (nameEl) nameEl.textContent = m.name;
  const sw = $('swatches');
  if (sw) sw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.color === color));

  if (persist) localStorage.setItem(COLOR_PREF, color);
}

(function bindSwatches() {
  const sw = $('swatches');
  if (sw) sw.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.color) { setBudColor(b.dataset.color, true); toast((COLOR_META[b.dataset.color] || {}).name + ' theme'); }
  });
})();

/* ------------------------------------------------------------------ *
 * Per-model capabilities — show only the controls a device supports  *
 * ------------------------------------------------------------------ */
const CAPS = {
  bass: ['B171', 'B172', 'B168', 'B162'],
  presets: ['B172', 'B168'],          // named listening-mode EQ presets
  fitTest: ['B155', 'B171', 'B172', 'B162']
};
function showEl(el, visible) { if (el) el.style.display = visible ? '' : 'none'; }
function applyCapabilities(base) {
  showEl($('card-bass'), CAPS.bass.includes(base));
  showEl($('eq-chips'), CAPS.presets.includes(base));
  showEl($('card-fit'), CAPS.fitTest.includes(base));
  showEl($('row-inear'), base !== 'B174');
}

// Launch theme (before any device connects): espeon orange or saved colour.
buildSwatches();
setBudColor(localStorage.getItem(COLOR_PREF) || 'orange', false);

/* ------------------------------------------------------------------ *
 * Battery (callback: setBattery)                                     *
 * ------------------------------------------------------------------ */
const trayBatt = { l: null, r: null, c: null };
function pushTrayBattery() { try { if (window.cmf && window.cmf.setTrayBattery) window.cmf.setTrayBattery(trayBatt); } catch (_) {} }

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
    trayBatt[s] = null;
    pushTrayBattery();
    return;
  }
  card.classList.remove('disc');
  card.classList.toggle('low', percentage <= 20);
  pctEl.textContent = percentage + '%';
  barEl.style.width = percentage + '%';
  chgEl.style.display = charging ? 'inline' : 'none';
  trayBatt[s] = percentage;
  pushTrayBattery();
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
const ringTimers = { l: null, r: null };
const RING_TIMEOUT = 30000; // auto-stop the tone after 30s if left ringing

function setRing(side, on) {
  const isLeft = side === 'l';
  const btn = $('ring-' + side);
  if (isLeft) ringingL = on; else ringingR = on;
  ringBuds(on ? 1 : 0, isLeft);
  btn.textContent = on ? 'Stop' : (isLeft ? 'Ring Left' : 'Ring Right');
  btn.classList.toggle('ringing', on);
  if (ringTimers[side]) { clearTimeout(ringTimers[side]); ringTimers[side] = null; }
  if (on) ringTimers[side] = setTimeout(() => setRing(side, false), RING_TIMEOUT);
}
$('ring-l').addEventListener('click', () => setRing('l', !ringingL));
$('ring-r').addEventListener('click', () => setRing('r', !ringingR));

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
  if (ringTimers.l) { clearTimeout(ringTimers.l); ringTimers.l = null; }
  if (ringTimers.r) { clearTimeout(ringTimers.r); ringTimers.r = null; }
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

// EQ preset names (listening-mode index → label).
const EQ_NAMES = ['Balanced', 'Rock', 'Electronic', 'Pop', 'Enhance Vocals', 'Classical', 'Custom'];

// Genre buckets: keyword match → default {eq, bass}. Users override per bucket.
const GENRE_BUCKETS = [
  { key: 'hiphop',     label: 'Hip-Hop / Rap',             match: ['hip hop', 'hip-hop', 'rap', 'trap', 'grime', 'drill'], def: { eq: 2, bass: true } },
  { key: 'electronic', label: 'Electronic / Dance',        match: ['electronic', 'edm', 'dance', 'house', 'techno', 'dubstep', 'trance', 'drum', 'garage', 'bass'], def: { eq: 2, bass: true } },
  { key: 'rock',       label: 'Rock',                      match: ['rock', 'grunge', 'britpop'], def: { eq: 1, bass: false } },
  { key: 'metal',      label: 'Metal / Punk',              match: ['metal', 'punk', 'hardcore', 'emo'], def: { eq: 1, bass: true } },
  { key: 'pop',        label: 'Pop',                       match: ['pop', 'k-pop', 'indie'], def: { eq: 3, bass: false } },
  { key: 'rnb',        label: 'R&B / Soul / Funk',         match: ['r&b', 'rnb', 'soul', 'funk', 'disco', 'motown'], def: { eq: 3, bass: true } },
  { key: 'jazz',       label: 'Jazz / Blues',              match: ['jazz', 'blues', 'swing', 'bebop'], def: { eq: 4, bass: false } },
  { key: 'classical',  label: 'Classical / Score',         match: ['classical', 'orchestr', 'piano', 'opera', 'soundtrack', 'score'], def: { eq: 5, bass: false } },
  { key: 'acoustic',   label: 'Acoustic / Folk / Country', match: ['acoustic', 'folk', 'singer', 'songwriter', 'country', 'americana'], def: { eq: 4, bass: false } },
  { key: 'latin',      label: 'Latin / Reggae / Afro',     match: ['latin', 'reggae', 'reggaeton', 'salsa', 'afro', 'dancehall'], def: { eq: 3, bass: true } },
  { key: 'chill',      label: 'Lo-fi / Chill / Ambient',   match: ['lo-fi', 'lofi', 'chill', 'ambient', 'new age', 'downtempo'], def: { eq: 0, bass: false } },
  { key: 'spoken',     label: 'Podcast / Spoken',          match: ['podcast', 'spoken', 'speech', 'audiobook', 'talk', 'comedy'], def: { eq: 4, bass: false } },
  { key: 'default',    label: 'Everything else',           match: [], def: { eq: 0, bass: false } }
];

const GENRE_RULES_PREF = 'attune.genreRules';
const ARTIST_RULES_PREF = 'attune.artistRules';
let genreRules = (() => { try { return JSON.parse(localStorage.getItem(GENRE_RULES_PREF)) || {}; } catch (_) { return {}; } })();
let artistRules = (() => { try { return JSON.parse(localStorage.getItem(ARTIST_RULES_PREF)) || []; } catch (_) { return []; } })();
function saveGenreRules() { localStorage.setItem(GENRE_RULES_PREF, JSON.stringify(genreRules)); }
function saveArtistRules() { localStorage.setItem(ARTIST_RULES_PREF, JSON.stringify(artistRules)); }

function bucketForGenre(genre) {
  if (!genre) return null;
  const g = genre.toLowerCase();
  for (const b of GENRE_BUCKETS) {
    if (b.key === 'default') continue;
    if (b.match.some((k) => g.includes(k))) return b;
  }
  return GENRE_BUCKETS.find((b) => b.key === 'default');
}
function ruleForBucket(b) { const r = genreRules[b.key] || b.def; return { eq: r.eq, bass: !!r.bass }; }

function tuningForGenre(genre) {
  const b = bucketForGenre(genre);
  if (!b) return null;
  const r = ruleForBucket(b);
  return { eq: r.eq, bass: r.bass, label: EQ_NAMES[r.eq] || 'Balanced' };
}

function findArtistOverride(artist) {
  if (!artist) return null;
  const a = artist.trim().toLowerCase();
  if (!a) return null;
  return artistRules.find((r) => r.artist && (a === r.artist.toLowerCase() || a.includes(r.artist.toLowerCase()))) || null;
}

function resolveTuning(artist, genre) {
  const ov = findArtistOverride(artist);
  if (ov) return { eq: ov.eq, bass: !!ov.bass, label: EQ_NAMES[ov.eq] || 'Balanced', source: 'artist' };
  const g = tuningForGenre(genre);
  return g ? { ...g, source: 'genre' } : null;
}

function applyBass(enabled, level) {
  bassEnabled = enabled;
  $('bass-on').checked = enabled;
  $('bass-wrap').classList.toggle('open', enabled);
  if (enabled && level) { bassLevel = level; $('bass-level').value = level; $('bass-level-v').textContent = level; }
  set_enhanced_bass(enabled, bassLevel);
}

const SMART_BASS_LEVEL = 3; // bass level Smart Tuning sets for bass-forward genres
function applyTuningObj(t) {
  setListeningMode(t.eq);
  setEQfromRead(t.eq);
  let bassApplied = null; // null = not managed, 0 = turned off, >0 = level set
  if (smartBass) {
    applyBass(t.bass, t.bass ? SMART_BASS_LEVEL : bassLevel);
    bassApplied = t.bass ? SMART_BASS_LEVEL : 0;
  }
  return { label: t.label, bassApplied, source: t.source };
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
    const t = resolveTuning(d.artist, d.genre);
    // Apply once per track while playing & connected (artist overrides work even with no genre).
    if (d.playing && SPPsocket && t && key !== smartLastKey && (t.source === 'artist' || d.genre)) {
      smartLastKey = key;
      const r = applyTuningObj(t);
      let txt = '→ ' + r.label;
      if (r.bassApplied !== null) txt += r.bassApplied > 0 ? ' · Bass ' + r.bassApplied : ' · Bass off';
      $('np-eq').textContent = txt;
      const why = r.source === 'artist' ? d.artist : (d.genre || '');
      toast('Smart Tuning · ' + r.label + (r.bassApplied > 0 ? ' + Bass ' + r.bassApplied : '') + (why ? ' · ' + why : ''));
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
 * Music providers (Apple / Deezer toggles, Last.fm key)              *
 * ------------------------------------------------------------------ */
function renderProviders(s) {
  if (!s || !s.providers) return;
  if ($('prov-apple')) $('prov-apple').checked = !!s.providers.apple;
  if ($('prov-deezer')) $('prov-deezer').checked = !!s.providers.deezer;
  if ($('lfm-key') && s.hasLastfmKey) $('lfm-key').placeholder = 'API key saved ✓';
  if ($('lfm-desc')) $('lfm-desc').textContent = (s.providers.lastfm && s.hasLastfmKey) ? 'Active — using Last.fm tags' : 'Add a free API key for richer genre tags';
  if ($('lfm-btn')) $('lfm-btn').textContent = s.hasLastfmKey ? 'Change key' : 'Set key';
}
if ($('prov-apple')) $('prov-apple').addEventListener('change', async (e) => renderProviders(await window.cmf.providersSet({ apple: e.target.checked })));
if ($('prov-deezer')) $('prov-deezer').addEventListener('change', async (e) => renderProviders(await window.cmf.providersSet({ deezer: e.target.checked })));
if ($('lfm-btn')) $('lfm-btn').addEventListener('click', () => $('lfm-setup').classList.toggle('open'));
if ($('lfm-save')) $('lfm-save').addEventListener('click', async () => {
  const key = $('lfm-key').value.trim();
  await window.cmf.lastfmSetKey(key);
  const s = await window.cmf.providersSet({ lastfm: !!key });
  renderProviders(s);
  $('lfm-setup').classList.remove('open');
  toast(key ? 'Last.fm key saved' : 'Last.fm key cleared');
});
if (window.cmf && window.cmf.providersGet) window.cmf.providersGet().then(renderProviders).catch(() => {});

/* ------------------------------------------------------------------ *
 * Genre rules editor + artist overrides                              *
 * ------------------------------------------------------------------ */
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function eqOptions(selected) {
  let o = '';
  for (let i = 0; i <= 5; i++) o += `<option value="${i}" ${i === selected ? 'selected' : ''}>${EQ_NAMES[i]}</option>`;
  return o;
}

function renderGenreRules() {
  const host = $('genre-rules');
  if (!host) return;
  host.innerHTML = GENRE_BUCKETS.map((b) => {
    const r = ruleForBucket(b);
    return `<div class="grule" data-key="${b.key}">
      <span class="gname">${b.label}</span>
      <select class="grule-eq">${eqOptions(r.eq)}</select>
      <label class="mini-chk"><input type="checkbox" class="grule-bass" ${r.bass ? 'checked' : ''}> Bass</label>
    </div>`;
  }).join('');
  host.querySelectorAll('.grule').forEach((row) => {
    const key = row.dataset.key;
    const eqSel = row.querySelector('.grule-eq');
    const bassChk = row.querySelector('.grule-bass');
    const save = () => { genreRules[key] = { eq: parseInt(eqSel.value, 10), bass: bassChk.checked }; saveGenreRules(); };
    eqSel.addEventListener('change', save);
    bassChk.addEventListener('change', save);
  });
}
if ($('genre-reset')) $('genre-reset').addEventListener('click', () => { genreRules = {}; saveGenreRules(); renderGenreRules(); toast('Genre rules reset to defaults'); });

function renderArtistRules() {
  const host = $('artist-list');
  if (!host) return;
  if (!artistRules.length) { host.innerHTML = '<div class="empty-line">No artist overrides yet.</div>'; return; }
  host.innerHTML = artistRules.map((r, i) => `<div class="arow">
    <span class="aname">${escapeHtml(r.artist)}</span>
    <span class="atag">${EQ_NAMES[r.eq]}${r.bass ? ' · Bass' : ''}</span>
    <span class="arm" data-i="${i}">×</span>
  </div>`).join('');
  host.querySelectorAll('.arm').forEach((b) => b.addEventListener('click', () => {
    artistRules.splice(parseInt(b.dataset.i, 10), 1); saveArtistRules(); renderArtistRules();
  }));
}
if ($('artist-eq')) $('artist-eq').innerHTML = eqOptions(0);
if ($('artist-add-btn')) $('artist-add-btn').addEventListener('click', () => {
  const name = $('artist-name').value.trim();
  if (!name) { toast('Enter an artist name'); return; }
  artistRules.push({ artist: name, eq: parseInt($('artist-eq').value, 10), bass: $('artist-bass').checked });
  saveArtistRules(); renderArtistRules();
  $('artist-name').value = ''; $('artist-bass').checked = false;
  toast('Override added for ' + name);
});
renderGenreRules();
renderArtistRules();

// Collapsible cards (Genre Rules / Artist Overrides headers)
document.querySelectorAll('.card-head[data-toggle]').forEach((h) => {
  h.addEventListener('click', () => {
    const body = $(h.dataset.toggle);
    if (!body) return;
    h.classList.toggle('open', body.classList.toggle('open'));
  });
});

/* ------------------------------------------------------------------ *
 * Settings (run in background) + Feedback                            *
 * ------------------------------------------------------------------ */
let appVersion = '';
if (window.cmf && window.cmf.settingsGet) {
  window.cmf.settingsGet().then((s) => {
    if ($('set-tray')) $('set-tray').checked = s.closeToTray !== false;
    if ($('set-startup')) $('set-startup').checked = !!s.openAtLogin;
    if ($('fb-repo') && s.githubRepo) $('fb-repo').value = s.githubRepo;
  }).catch(() => {});
}
if ($('set-tray')) $('set-tray').addEventListener('change', (e) => window.cmf.settingsSet({ closeToTray: e.target.checked }));
if ($('set-startup')) $('set-startup').addEventListener('change', (e) => window.cmf.settingsSet({ openAtLogin: e.target.checked }));

if ($('fb-send')) $('fb-send').addEventListener('click', async () => {
  const text = $('fb-text').value.trim();
  const cat = $('fb-category').value;
  if (!text) { toast('Write some feedback first'); return; }
  const ts = new Date().toISOString();
  await window.cmf.feedbackSave({ ts, category: cat, text });
  const s = await window.cmf.settingsGet();
  const repo = ((s && s.githubRepo) || '').trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent('[' + cat + '] ')}&body=${encodeURIComponent(text + '\n\n— Attune v' + appVersion)}`;
    window.open(url, '_blank');
    toast('Opening a GitHub issue…');
  } else {
    $('fb-repo-setup').classList.add('open');
    toast('Saved locally. Set your GitHub repo to file an issue.');
  }
  $('fb-text').value = '';
});
if ($('fb-open')) $('fb-open').addEventListener('click', () => window.cmf.feedbackOpen());
if ($('fb-repo-save')) $('fb-repo-save').addEventListener('click', async () => {
  const repo = $('fb-repo').value.trim();
  await window.cmf.settingsSet({ githubRepo: repo });
  $('fb-repo-setup').classList.remove('open');
  toast(repo ? 'GitHub repo saved' : 'Repo cleared');
});

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

window.cmf.version().then((v) => { appVersion = v; $('tb-device').dataset.v = v; }).catch(() => {});

console.log('[boot] renderer scripts loaded; serial=' + (navigator.serial ? 'available' : 'MISSING'));

/* ------------------------------------------------------------------ *
 * Auto-reconnect — silently reconnect to already-granted buds on      *
 * launch and whenever they wake (e.g. taken out of the case).         *
 * ------------------------------------------------------------------ */
if (navigator.serial && !new URLSearchParams(location.search).get('demo')) {
  navigator.serial.addEventListener('connect', () => { tryAutoConnect(); });
  setTimeout(async () => {
    if (SPPsocket) return;
    setConnectStatus('Looking for paired buds', 'busy', true);
    const ok = await tryAutoConnect();
    if (!ok && !SPPsocket) setConnectStatus('', '');
  }, 600);
}

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
  // Expand the editor cards + seed an example artist override for preview.
  artistRules = [{ artist: 'Kendrick Lamar', eq: 2, bass: true }, { artist: 'Bon Iver', eq: 4, bass: false }];
  renderArtistRules();
  ['genre-body', 'artist-body'].forEach((id) => {
    const b = $(id); if (b) b.classList.add('open');
    const h = document.querySelector(`.card-head[data-toggle="${id}"]`); if (h) h.classList.add('open');
  });
}
