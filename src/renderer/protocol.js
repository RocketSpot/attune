/*
 * protocol.js — Bluetooth RFCOMM/SPP protocol for CMF / Nothing earbuds.
 *
 * Ported from the open-source ear (web) project (radiance-project/ear-web,
 * GPL-3.0) — specifically res/js/bluetooth_socket.js and the connect handshake
 * from res/js/nothing_connected.js. The byte-level protocol is kept intact;
 * only the connect orchestration and the page-redirect logic were rewritten so
 * everything runs in a single Electron window.
 *
 * UI callbacks (setBattery, setANCStatus, setEQfromRead, setCustomEQ,
 * setFirmwareText, earTipStateStatus, setInEarCheckbox, setLatencyModeCheckbox,
 * setBassEnhance, setBassLevel, updateGesturesFromArray, ...) are defined in
 * app.js and share this global scope (these are classic, non-module scripts).
 */

'use strict';

const SPP_UUID = 'aeac4a03-dff5-498f-843a-34487cf133eb';
const FASTPAIR_UUID = 'df21fe2c-2515-4fdb-8886-f12c4d67927c';

var SPPsocket = null;
var sessionReader = null; // active read-loop reader, so disconnect() can cancel it
var modelBase = '';
var firmwareVersion = '';

let operationID = 0;
let operationList = {};

/* ------------------------------------------------------------------ *
 * Device identification (SKU -> model)                                *
 * ------------------------------------------------------------------ */

// Compact map distilled from ear-web res/js/control.js.
const SKU_TO_MODEL = (() => {
  const m = {};
  const add = (skus, name, base, codename, color) =>
    skus.forEach((s) => (m[s] = { name, base, codename, color }));

  add(['01', '03', '07'], 'Nothing Ear (1)', 'B181', 'one', 'white');
  add(['02', '04', '06', '08', '10'], 'Nothing Ear (1)', 'B181', 'one', 'black');
  add(['14', '15', '16'], 'Nothing Ear (stick)', 'B157', 'sticks', 'white');
  add(['17', '18', '19'], 'Nothing Ear (2)', 'B155', 'two', 'white');
  add(['27', '28', '29'], 'Nothing Ear (2)', 'B155', 'two', 'black');
  add(['30', '31'], 'CMF Buds Pro', 'B163', 'corsola', 'black');
  add(['32', '33'], 'CMF Buds Pro', 'B163', 'corsola', 'white');
  add(['34', '35'], 'CMF Buds Pro', 'B163', 'corsola', 'orange');
  add(['48', '53'], 'CMF Neckband Pro', 'B164', 'crobat', 'orange');
  add(['49', '52'], 'CMF Neckband Pro', 'B164', 'crobat', 'white');
  add(['50', '51'], 'CMF Neckband Pro', 'B164', 'crobat', 'black');
  add(['54', '55'], 'CMF Buds', 'B168', 'donphan', 'black');
  add(['56', '57'], 'CMF Buds', 'B168', 'donphan', 'white');
  add(['58', '59'], 'CMF Buds', 'B168', 'donphan', 'orange');
  add(['61', '69', '74'], 'Nothing Ear', 'B171', 'entei', 'black');
  add(['62', '70', '75'], 'Nothing Ear', 'B171', 'entei', 'white');
  add(['63', '66', '71'], 'Nothing Ear (a)', 'B162', 'cleffa', 'black');
  add(['64', '67', '72'], 'Nothing Ear (a)', 'B162', 'cleffa', 'white');
  add(['65', '68', '73'], 'Nothing Ear (a)', 'B162', 'cleffa', 'yellow');
  add(['76', '83'], 'CMF Buds Pro 2', 'B172', 'espeon', 'black');
  add(['77', '82'], 'CMF Buds Pro 2', 'B172', 'espeon', 'white');
  add(['78', '81'], 'CMF Buds Pro 2', 'B172', 'espeon', 'orange');
  add(['79', '80'], 'CMF Buds Pro 2', 'B172', 'espeon', 'blue');
  add(['11200005'], 'Nothing Ear (open)', 'B174', 'flaaffy', 'white');
  return m;
})();

function getModelFromSKU(sku) {
  return SKU_TO_MODEL[sku] || null;
}

/* ------------------------------------------------------------------ *
 * Framing: send / crc16 / command parsing                            *
 * ------------------------------------------------------------------ */

function crc16(buffer) {
  let crc = 0xffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc;
}

function send(command, payload = [], operation = '') {
  if (!SPPsocket || !SPPsocket.writable) return;
  let header = [0x55, 0x60, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];
  operationID++;
  header[7] = operationID;
  let commandBytes = new Uint8Array(new Uint16Array([command]).buffer);
  header[3] = commandBytes[0];
  header[4] = commandBytes[1];
  header[5] = payload.length;
  header.push(...payload);
  let byteArray = new Uint8Array(header);
  let crc = crc16(byteArray);
  byteArray = [...byteArray, crc & 0xff, crc >> 8];
  if (operation !== '') operationList[operationID] = operation;
  const writer = SPPsocket.writable.getWriter();
  writer.write(new Uint8Array(byteArray).buffer);
  writer.releaseLock();
}

function getCommand(header) {
  let commandBytes = new Uint8Array(header.slice(3, 5));
  return new Uint16Array(commandBytes.buffer)[0];
}

function hexStringToUint8Array(hexString) {
  if (hexString.length % 2 !== 0) throw new Error('Invalid hex string');
  const out = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) out[i / 2] = parseInt(hexString.substr(i, 2), 16);
  return out;
}

const toHex = (arr) => arr.reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');

/* ------------------------------------------------------------------ *
 * Connect orchestration                                              *
 * ------------------------------------------------------------------ */

// Read the serial number, identify the model, then start the live session.
async function cmfConnect() {
  let port;
  try {
    port = await navigator.serial.requestPort({
      allowedBluetoothServiceClassIds: [SPP_UUID],
      filters: [{ bluetoothServiceClassId: SPP_UUID }]
    });
  } catch (err) {
    onConnectError('no-device');
    return;
  }
  if (!port) {
    onConnectError('no-device');
    return;
  }

  try {
    if (!port.readable) await port.open({ baudRate: 9600 });
  } catch (err) {
    onConnectError('open-failed');
    return;
  }

  SPPsocket = port;

  // ---- Handshake: request serial number, wait for the reply ----
  let detected = false;
  const reader = port.readable.getReader();
  requestSerialNumber();

  const handshakeTimeout = setTimeout(() => {
    if (!detected) {
      try { reader.cancel(); } catch (_) {}
    }
  }, 6000);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length < 10) continue;
      const rawData = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      if (rawData[0] !== 0x55) continue;
      const command = getCommand(rawData.slice(0, 6));

      if (command === 16390) {
        const serialNum = getSerialNumber(toHex(rawData));
        const model = resolveModel(serialNum);
        if (model) {
          detected = true;
          modelBase = model.base;
          onModelDetected(model, serialNum);
          break;
        } else {
          // Could still be an Ear (1): ask its firmware to disambiguate.
          requestFirmwareEarOne();
        }
      } else if (command === 16450) {
        const fw = readFirmwareFromData(toHex(rawData));
        const parts = fw.split('.');
        if (parts[1] === '6700') {
          const model = getModelFromSKU('01');
          detected = true;
          modelBase = model.base;
          onModelDetected(model, '01');
          break;
        }
      }
    }
  } catch (_) {
    /* reader cancelled or stream error */
  } finally {
    clearTimeout(handshakeTimeout);
    try { reader.releaseLock(); } catch (_) {}
  }

  if (!detected) {
    onConnectError('not-identified');
    try { await port.close(); } catch (_) {}
    SPPsocket = null;
    return;
  }

  // ---- Live session on the same (already open) port ----
  startSession(port);
}

function requestSerialNumber() {
  send(0xc006);
}
function requestFirmwareEarOne() {
  send(49218);
}

function getSerialNumber(hexPayload) {
  const payload = hexStringToUint8Array(hexPayload);
  const configurations = [];
  const lines = new TextDecoder().decode(payload.subarray(7)).split('\n');
  lines.forEach((line) => {
    const parts = line.split(',');
    if (parts.length === 3) {
      const device = parseInt(parts[0], 10);
      const type = parseInt(parts[1], 10);
      const valueStr = parts[2];
      if (!isNaN(device) && !isNaN(type) && valueStr) configurations.push({ device, type, value: valueStr });
    }
  });
  const serialConfigs = configurations.filter((c) => c.type === 4 && c.value.length > 0);
  return serialConfigs.length > 0 ? serialConfigs[0].value : null;
}

function readFirmwareFromData(hexstring) {
  let fw = '';
  const hexArray = hexStringToUint8Array(hexstring);
  const size = hexArray[5];
  for (let i = 0; i < size; i++) fw += String.fromCharCode(hexArray[8 + i]);
  return fw;
}

// Map a raw serial string to a model entry (mirrors processSerial in ear-web).
function resolveModel(serial) {
  if (serial === null || serial === undefined) return null;
  if (serial === '12345678901234567') return getModelFromSKU('01');
  const head = serial.substring(0, 2);
  let sku = '';
  if (head === 'MA') {
    const year = serial.substring(6, 8);
    if (year === '22' || year === '23') sku = '14';
    else if (year === '24') sku = '11200005';
  } else if (head === 'SH' || head === '13') {
    sku = serial.substring(4, 6);
  } else {
    return null;
  }
  return getModelFromSKU(sku);
}

/* ------------------------------------------------------------------ *
 * Live session: read loop + initial state pull                       *
 * ------------------------------------------------------------------ */

async function startSession(port) {
  SPPsocket = port;
  const reader = port.readable.getReader();
  sessionReader = reader;
  onSessionStart();
  initDevice();

  try {
    while (port.readable) {
      const { value, done } = await reader.read();
      if (done) { try { reader.releaseLock(); } catch (_) {} break; }
      if (!value) continue;
      const rawData = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      if (rawData[0] !== 0x55 || rawData.length < 10) continue;
      const command = getCommand(rawData.slice(0, 6));
      dispatch(command, rawData);
      if (operationID >= 250) { operationID = 1; operationList = {}; }
    }
  } catch (_) {
    /* device disconnected */
  }
  try { reader.releaseLock(); } catch (_) {}
  sessionReader = null;
  SPPsocket = null;
  onSessionEnd();
}

function dispatch(command, rawData) {
  const hex = toHex(rawData);
  if (command === 57345 || command === 16391) readBattery(hex);
  else if (command === 57347) readANC(hex);
  else if (command === 16452) readCustomEQ(rawData);
  else if (command === 16415 || command === 16464) readEQ(hex);
  else if (command === 16450) readFirmware(hex);
  else if (command === 57357) readEarFitTestResult(hex);
  else if (command === 16416) readPersonalizedANC(rawData);
  else if (command === 16398) readInEar(hex);
  else if (command === 16449) readLatency(hex);
  else if (command === 16407) readLEDCaseColor(hex);
  else if (command === 16408) readGesture(hex);
  else if (command === 16414) readANC(hex);
  else if (command === 16460) read_advanced_eq_status(hex);
  else if (command === 16462) read_enhanced_bass(hex);
}

async function initDevice() {
  const step = (fn) => new Promise((r) => { try { fn(); } catch (_) {} setTimeout(r, 110); });
  await step(sendBattery);
  await step(getEQ);
  await step(getListeningMode);
  await step(getFirmware);
  await step(sendInEarRead);
  await step(sendLatencyModeRead);
  await step(getPersonalizedANCStatus);
  await step(sendGetGesture);
  await step(sendANCread);
  await step(getAdvancedEQ);
  await step(get_enhanced_bass);
}

/* ------------------------------------------------------------------ *
 * Battery                                                            *
 * ------------------------------------------------------------------ */

function sendBattery() { send(49159, [], 'readBattery'); }

function readBattery(hexString) {
  const batteryStatus = { left: 'DISCONNECTED', right: 'DISCONNECTED', case: 'DISCONNECTED' };
  const deviceIdToKey = { 0x02: 'left', 0x03: 'right', 0x04: 'case' };
  const BATTERY_MASK = 127;
  const RECHARGING_MASK = 128;
  const hexArray = hexString.match(/.{2}/g).map((b) => parseInt(b, 16));
  const connectedDevices = hexArray[8];
  for (let i = 0; i < connectedDevices; i++) {
    const deviceId = hexArray[9 + i * 2];
    const key = deviceIdToKey[deviceId];
    if (!key) continue;
    batteryStatus[key] = {
      batteryLevel: hexArray[10 + i * 2] & BATTERY_MASK,
      isCharging: (hexArray[10 + i * 2] & RECHARGING_MASK) === RECHARGING_MASK
    };
  }
  setBattery('l', batteryStatus.left.batteryLevel, batteryStatus.left.isCharging);
  setBattery('r', batteryStatus.right.batteryLevel, batteryStatus.right.isCharging);
  setBattery('c', batteryStatus.case.batteryLevel, batteryStatus.case.isCharging);
}

/* ------------------------------------------------------------------ *
 * ANC (noise control)                                               *
 * ------------------------------------------------------------------ */

function readANC(hexString) {
  const hexArray = hexString.match(/.{2}/g).map((b) => parseInt(b, 16));
  const ancStatus = hexArray[9];
  let level = 0;
  if (ancStatus === 5) level = 1;       // NC High
  else if (ancStatus === 7) level = 2;  // NC ? (kept from source)
  else if (ancStatus === 3) level = 3;  // NC Low
  else if (ancStatus === 1) level = 4;  // NC (high in display)
  else if (ancStatus === 2) level = 5;  // Transparency
  else if (ancStatus === 4) level = 6;  // Off
  setANCStatus(level);
}

function setANCDisplay(level) { setANCStatus(level); }

function sendANCread() {
  const isAnc = firmwareVersion.split('.');
  if (modelBase === 'B157' && isAnc[2] !== '2') return;
  send(49182, [], 'readANC');
}

function setANC_BT(level) {
  let byteArray = [0x01, 0x01, 0x00];
  if (level === 1) byteArray[1] = 0x05;
  else if (level === 2) byteArray[1] = 0x07;
  else if (level === 3) byteArray[1] = 0x03;
  else if (level === 4) byteArray[1] = 0x01;
  else if (level === 5) byteArray[1] = 0x02;
  else if (level === 6) byteArray[1] = 0x04;
  send(61455, byteArray, 'setANC');
}

/* ------------------------------------------------------------------ *
 * EQ / Listening mode + custom + advanced                            *
 * ------------------------------------------------------------------ */

function getEQ() {
  if (modelBase !== 'B172' && modelBase !== 'B168') send(49183, [], 'readEQ');
}
function getListeningMode() {
  if (modelBase === 'B172' || modelBase === 'B168') send(49232, [], 'readListeningMode');
}
function readEQ(hexString) {
  const hexArray = hexString.match(/.{1,2}/g).map((b) => parseInt(b, 16));
  setEQfromRead(hexArray[8]);
}
function setEQ(level) {
  send(61456, [level, 0x00], 'setEQ');
}
function setListeningMode(level) {
  if (modelBase !== 'B172' && modelBase !== 'B168') return;
  send(61469, [level, 0x00], 'setListeningMode');
}

function read_advanced_eq_status(hexString) {
  const hexArray = hexString.match(/.{2}/g).map((b) => parseInt(b, 16));
  const advancedStatus = hexArray[8];
  setAdvancedEQfromRead(advancedStatus);
  if (modelBase === 'B157' || modelBase === 'B155' || modelBase === 'B171' || modelBase === 'B174') {
    if (advancedStatus === 1) setEQfromRead(6);
  }
}
function getAdvancedEQ() { send(49228, [], 'readAdvancedEQ'); }
function setAdvancedEQenabled(enabled) { send(61519, [enabled ? 0x01 : 0x00, 0x00]); }

function set_enhanced_bass(enabled, level) {
  if (['B171', 'B172', 'B168', 'B162'].includes(modelBase)) {
    level *= 2;
    send(61521, [enabled ? 0x01 : 0x00, level]);
  }
}
function get_enhanced_bass() {
  if (['B171', 'B172', 'B168', 'B162'].includes(modelBase)) send(49230, [], 'readEnhancedBass');
}
function read_enhanced_bass(hexString) {
  if (['B171', 'B172', 'B168', 'B162'].includes(modelBase)) {
    const hexArray = hexString.match(/.{1,2}/g).map((b) => parseInt(b, 16));
    setBassEnhance(hexArray[8]);
    setBassLevel(hexArray[9] / 2);
  }
}

/* ---- Custom EQ float (de)encoding (verbatim from ear-web) ---- */

function formatFloatForEQ(f, total) {
  var array = new ArrayBuffer(4);
  var view = new DataView(array);
  view.setFloat32(0, f, false);
  array = new Uint8Array(array);
  if (f !== 0.0 && array[0] === 0 && array[1] === 0 && array[2] === 0) array[3] = (array[3] | 0x80) & 0xff;
  for (var i = 0; i < array.length / 2; i++) {
    var j = array.length - i - 1;
    var tmp = array[i]; array[i] = array[j]; array[j] = tmp;
  }
  if (total && f >= 0) array = new Uint8Array([0x00, 0x00, 0x00, 0x80]);
  return array;
}

function fromFormatFloatForEQ(array) {
  for (let i = 0; i < Math.floor(array.length / 2); i++) {
    let j = array.length - i - 1;
    [array[i], array[j]] = [array[j], array[i]];
  }
  const buffer = new ArrayBuffer(array.length);
  const view = new Uint8Array(buffer);
  if (array[0] === 0 && array[1] === 0 && array[2] === 0 && array[3] & 0x80) {
    array[3] = array[3] & 0x7f;
    for (let i = 0; i < array.length; i++) view[i] = array[i];
    return -new DataView(buffer).getFloat32(0, false);
  }
  for (let i = 0; i < array.length; i++) view[i] = array[i];
  return new DataView(buffer).getFloat32(0, false);
}

function setCustomEQ_BT(level) {
  if (modelBase === 'B181') return;
  var byteArray = [0x03, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x75, 0x44, 0xc3, 0xf5, 0x28, 0x3f, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x5a, 0x45, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x43, 0xcd, 0xcc, 0x4c, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  var highestValue = 0;
  for (var i = 0; i < 3; i++) if (level[i] > highestValue) highestValue = level[i];
  highestValue = highestValue / -1;
  var array = formatFloatForEQ(highestValue, true);
  for (var j = 0; j < 4; j++) byteArray[1 + j] = array[j];
  for (var k = 0; k < 3; k++) {
    array = formatFloatForEQ(level[k], false);
    for (var l = 0; l < 4; l++) byteArray[6 + k * 13 + l] = array[l];
  }
  send(61505, byteArray, 'setCustomEQ');
}

function getCustomEQ() {
  if (modelBase !== 'B181') send(49220, [], 'readCustomEQ');
}

function readCustomEQ(hexString) {
  if (modelBase === 'B181') return;
  var level = [];
  for (var i = 0; i < 3; i++) {
    var array = [];
    for (var j = 0; j < 4; j++) array.push(hexString[14 + i * 13 + j]);
    level.push(fromFormatFloatForEQ(array));
  }
  // formatedArray = [bass, mid, treble]
  setCustomEQ([level[2], level[0], level[1]]);
}

/* ------------------------------------------------------------------ *
 * Firmware                                                           *
 * ------------------------------------------------------------------ */

function getFirmware() { send(49218, [], 'readFirmware'); }
function readFirmware(hexstring) {
  const hexArray = hexStringToUint8Array(hexstring);
  const size = hexArray[5];
  firmwareVersion = '';
  for (let i = 0; i < size; i++) firmwareVersion += String.fromCharCode(hexArray[8 + i]);
  setFirmwareText(firmwareVersion);
}

/* ------------------------------------------------------------------ *
 * Ear-tip fit test                                                  *
 * ------------------------------------------------------------------ */

function launchEarFitTest() {
  if (['B155', 'B171', 'B172', 'B162'].includes(modelBase)) send(61460, [0x01]);
}
function readEarFitTestResult(hexstring) {
  const a = hexStringToUint8Array(hexstring);
  earTipStateStatus(a[8], a[9]);
}

/* ------------------------------------------------------------------ *
 * In-ear detection + low-latency mode                                *
 * ------------------------------------------------------------------ */

function sendInEarRead() { if (modelBase !== 'B174') send(49166, [], 'readInEar'); }
function readInEar(hexString) {
  const a = hexStringToUint8Array(hexString);
  setInEarCheckbox(a[10]);
}
function setInEar_BT(status) {
  send(61444, [0x01, 0x01, status == 1 ? 0x01 : 0x00]);
}

function sendLatencyModeRead() { send(49217, [], 'readLatency'); }
function readLatency(hexString) {
  const a = hexStringToUint8Array(hexString);
  setLatencyModeCheckbox(a[8]);
}
function setLatency(status) {
  send(61504, [status == 1 ? 0x01 : 0x02, 0x00]);
}

/* ------------------------------------------------------------------ *
 * Personalized ANC (B155 only) + LED case (B181 only) — kept for     *
 * completeness; harmless no-ops on CMF Buds Pro 2.                    *
 * ------------------------------------------------------------------ */

function getPersonalizedANCStatus() { if (modelBase === 'B155') send(49184, [], 'readPersonalizedANC'); }
function readPersonalizedANC(hexString) { setPersonalAncCheckbox(hexString[8]); }
function setPersonalizedANC(enabled) {
  if (modelBase === 'B155') send(61457, [enabled == 1 ? 0x01 : 0x00], '');
}

function readLEDCaseColor() { /* B181 only — unused for CMF Buds Pro 2 */ }
function getLEDCaseColor() {}

/* ------------------------------------------------------------------ *
 * Find my earbuds (ring)                                             *
 * ------------------------------------------------------------------ */

function ringBuds(isRing, isLeft = false) {
  if (modelBase === 'B181') {
    send(61442, [isRing ? 0x01 : 0x00]);
  } else {
    send(61442, [isLeft ? 0x02 : 0x03, isRing ? 0x01 : 0x00]);
  }
}

/* ------------------------------------------------------------------ *
 * Gestures                                                           *
 * ------------------------------------------------------------------ */

function sendGetGesture() { send(49176, [], 'getGesture'); }
function readGesture(hexString) {
  const a = hexStringToUint8Array(hexString);
  const count = a[8];
  const gestures = [];
  for (let i = 0; i < count; i++) {
    gestures.push({
      gestureDevice: a[9 + i * 4],
      gestureCommon: a[10 + i * 4],
      gestureType: a[11 + i * 4],
      gestureAction: a[12 + i * 4]
    });
  }
  updateGesturesFromArray(gestures);
}
function sendGestures(device, typeog, action) {
  send(61443, [0x01, parseInt(device), 0x01, parseInt(typeog), parseInt(action)]);
}
