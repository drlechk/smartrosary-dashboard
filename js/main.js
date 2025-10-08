import { $, u8ToStr, sleep, packKV, le32, setGlobalStatus, globalProgressStart, globalProgressSet, globalProgressDone, progAggregateStart, progAggregateSet, progAggregateEnter, progAggregateLeave, progAggregateDone } from './utils.js';
import { BleClient } from './ble.js';
import { initCharts } from './charts.js';
import { applyI18n, getLang, setLang, updateFromJson, wireLangSelector, updateSettingsOnly, setStatusKey, setStatusText } from './ui.js';
import { doBackup } from './backup.js';
import { restoreFromJson } from './restore.js';
import { requestKeysConsent, backupKeys, restoreKeys } from './auth.js';
import { initRemote } from './remote.js';
import { i18n } from './i18n.js';
import { attachWallpaperFS, resetWallpaperFS, setWallpaperConsent } from './wallpaper.js';
import { initHistory, setHistoryConsent, attachHistoryFS, resetHistory as resetHistoryCard, refreshHistory } from './history.js';
import { initIntentions } from './intentions.js';

const client = new BleClient();

initHistory();
const intentions = initIntentions({ client, setStatus: status });

const CARD_SELECTOR = '.card';
function setCardsMuted(muted) {
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
    card.classList.toggle('card-muted', muted);
  });
}

setCardsMuted(true);

function status(text){
  try { setStatusText(text); } catch { $('status').textContent = text; }
  try { setGlobalStatus(text); } catch {}
}

function isJsonWhitespace(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

function scanLooseJsonValue(text, start) {
  const len = text.length;
  let i = start;
  if (i >= len) return { index: len, ok: false };
  const first = text[i];
  if (first === '"') {
    i++;
    let escape = false;
    while (i < len) {
      const ch = text[i];
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        return { index: i + 1, ok: true };
      }
      i++;
    }
    return { index: i, ok: false };
  }
  if (first === '{' || first === '[') {
    const stack = [first];
    i++;
    let inString = false;
    let escape = false;
    while (i < len && stack.length) {
      const ch = text[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        i++;
        continue;
      }
      if (ch === '"') {
        inString = true;
        i++;
        continue;
      }
      if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}' || ch === ']') {
        const opener = stack[stack.length - 1];
        if ((ch === '}' && opener === '{') || (ch === ']' && opener === '[')) {
          stack.pop();
        } else {
          return { index: i + 1, ok: true };
        }
      }
      i++;
    }
    return { index: i, ok: stack.length === 0 };
  }
  while (i < len && text[i] !== ',' && text[i] !== '}' && text[i] !== ']' && !isJsonWhitespace(text[i])) {
    i++;
  }
  return { index: i, ok: true };
}

function stripJsonPropertyLoose(text, propName) {
  const needle = `"${propName}"`;
  const idx = text.indexOf(needle);
  if (idx === -1) return { text, changed: false, truncated: false };

  let start = idx;
  while (start > 0 && isJsonWhitespace(text[start - 1])) start--;

  let precedingCommaIdx = -1;
  if (start > 0 && text[start - 1] === ',') {
    precedingCommaIdx = start - 1;
  }

  const colonIdx = text.indexOf(':', idx + needle.length);
  if (colonIdx === -1) {
    const cutStart = precedingCommaIdx !== -1 ? precedingCommaIdx : start;
    return { text: text.slice(0, cutStart), changed: true, truncated: true };
  }

  let valueStart = colonIdx + 1;
  while (valueStart < text.length && isJsonWhitespace(text[valueStart])) valueStart++;

  const scan = scanLooseJsonValue(text, valueStart);
  if (!scan.ok) {
    const cutStart = precedingCommaIdx !== -1 ? precedingCommaIdx : start;
    return { text: text.slice(0, cutStart), changed: true, truncated: true };
  }

  let end = scan.index;
  while (end < text.length && isJsonWhitespace(text[end])) end++;

  const hasTrailingComma = end < text.length && text[end] === ',';
  let sliceStart = start;
  if (hasTrailingComma) {
    end++;
    while (end < text.length && isJsonWhitespace(text[end])) end++;
  } else if (precedingCommaIdx !== -1) {
    sliceStart = precedingCommaIdx;
    while (sliceStart > 0 && isJsonWhitespace(text[sliceStart - 1])) sliceStart--;
  }

  return { text: text.slice(0, sliceStart) + text.slice(end), changed: true, truncated: false };
}

function repairLooseJsonStructure(text) {
  let out = text;
  let inString = false;
  let escape = false;
  const stack = [];
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      if (stack.length) {
        const opener = stack[stack.length - 1];
        if ((ch === '}' && opener === '{') || (ch === ']' && opener === '[')) {
          stack.pop();
        }
      }
    }
  }

  if (inString) {
    out += '"';
  }

  while (stack.length) {
    const opener = stack.pop();
    out += opener === '{' ? '}' : ']';
  }

  return out;
}

function parseJsonWithFallback(str, context, { dropEntries } = {}) {
  if (!str) throw new Error(`${context} JSON empty`);
  const trimmed = str.replace(/\u0000/g, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    console.warn(`${context} JSON parse failed`, err);
    console.log(`${context} JSON raw:`, trimmed);
    let working = trimmed;
    let lastErr = err;

    if (dropEntries) {
      const result = stripJsonPropertyLoose(working, 'entries');
      if (result.changed) {
        working = result.text;
        console.warn(`${context} JSON: trimming entries payload${result.truncated ? ' (truncated)' : ''}`);
        try {
          return JSON.parse(working);
        } catch (errTrim) {
          console.warn(`${context} JSON trim parse failed`, errTrim);
          lastErr = errTrim;
        }
      }
    }

    const repaired = repairLooseJsonStructure(working);
    if (repaired !== working) {
      try {
        console.warn(`${context} JSON recovered by repairing structure`);
        return JSON.parse(repaired);
      } catch (errRepair) {
        lastErr = errRepair;
        working = repaired;
      }
    } else {
      working = repaired;
    }

    let lastBrace = working.lastIndexOf('}');
    while (lastBrace > -1) {
      const candidate = working.slice(0, lastBrace + 1);
      try {
        console.warn(`${context} JSON recovered by truncating tail`);
        return JSON.parse(candidate);
      } catch (errCandidate) {
        lastErr = errCandidate;
        lastBrace = working.lastIndexOf('}', lastBrace - 1);
      }
    }

    throw lastErr;
  }
}

async function refreshOnce() {
  const L = i18n[getLang()];
  try {
    if (!client.chStats || !client.chSettings) return false;
    console.log('[stats] refreshOnce: starting read');
    await sleep(200);

    const vSettings = await client.robustRead(client.chSettings);
    console.debug('Settings read bytes', vSettings?.byteLength ?? (vSettings?.buffer?.byteLength));

    let vPartsMaybe = null;
    if (client.chParts) {
      try {
        vPartsMaybe = await client.robustRead(client.chParts);
        console.debug('Parts read bytes', vPartsMaybe?.byteLength ?? (vPartsMaybe?.buffer?.byteLength));
      } catch (errParts) {
        console.warn('Parts characteristic read skipped:', errParts);
      }
    }

    await sleep(80);
    const vStats = await client.robustRead(client.chStats);
    console.debug('Stats read bytes', vStats?.byteLength ?? (vStats?.buffer?.byteLength));

    const rawSettings = u8ToStr(vSettings);
    const rawStats    = u8ToStr(vStats);
    const rawParts    = vPartsMaybe ? u8ToStr(vPartsMaybe) : null;
    console.debug('Raw settings text', rawSettings);
    console.debug('Raw stats text', rawStats);
    if (rawParts != null) console.debug('Raw parts text', rawParts);
    const cleanedSettings = rawSettings ? rawSettings.split('\0')[0] : '';
    const cleanedStats    = rawStats    ? rawStats.split('\0')[0]    : '';
    const cleanedParts    = rawParts   ? rawParts.split('\0')[0]   : null;
    if (!cleanedSettings?.trim() || cleanedSettings.trim()==='{}') return false;
    if (!cleanedStats?.trim()    || cleanedStats.trim()==='{}')    return false;

    let jsSettings, jsStats, jsParts=null;
    try { jsSettings = parseJsonWithFallback(cleanedSettings, 'Settings', { dropEntries: true }); }
    catch (parseErr) { console.warn('Settings JSON failed after recovery', parseErr); return false; }

    try { jsStats    = parseJsonWithFallback(cleanedStats, 'Stats'); }
    catch (parseErr) { console.warn('Stats JSON failed after recovery', parseErr); return false; }

    // Firmware may signal consent requirement in-band
    if (jsSettings?.requireConsent || jsStats?.requireConsent) {
      status('Awaiting on-device consent…');
      console.warn('Device reports consent required for info reads.');
      return false;
    }

    if (cleanedParts != null) {
      try { jsParts = parseJsonWithFallback(cleanedParts, 'Parts'); }
      catch (parseErr) { console.warn('Parts JSON failed after recovery', parseErr); jsParts = null; }
    }

    console.debug('Settings JSON', jsSettings);
    console.debug('Stats JSON', jsStats);
    if (jsParts) console.debug('Parts JSON', jsParts);

    updateFromJson({ jsStats, jsSettings, jsParts });
    try { setStatusKey('statusUpdated', L.statusUpdated); } catch { status(L.statusUpdated); }
    return true;
  } catch (e) {
    console.error(e);
    status('Read failed: ' + e.message);
    return false;
  }
}

async function refreshUntilValid({ tries=8, delay=250 } = {}) {
  for (let i=0;i<tries;i++){
    const ok = await refreshOnce();
    if (ok) return true;
    await sleep(delay * Math.pow(1.4, i));
    if (i === 2) { try { await client.reacquire(); } catch {} }
  }
  return false;
}

// Pref/stat writers using pacing
async function writePrefKey(key, type, value){
  let valBytes;
  switch (type){
    case 0x01: valBytes = new Uint8Array([value?1:0]); break;
    case 0x11: valBytes = new Uint8Array([Number(value)&0xff]); break;
    case 0x12: { const v=Number(value)>>>0; valBytes=new Uint8Array([v&0xff,(v>>8)&0xff]); } break;
    case 0x14: valBytes = le32(value); break;
    case 0x21: valBytes = le32(value); break;
    case 0x18: valBytes = le32(value).concat(le32(0)); break; // not used here; kept simple
    case 0x31: valBytes = new TextEncoder().encode(String(value)); break;
    default: throw new Error('bad type');
  }
  const payload = packKV(0x50, type, key, valBytes);
  await client.chCtrl.writeValue(payload);
  await client.waitReady();
}
async function writeStatKey(key, type, value){
  let valBytes;
  switch (type){
    case 0x11: valBytes = new Uint8Array([Number(value)&0xff]); break;
    case 0x12: { const v=Number(value)>>>0; valBytes=new Uint8Array([v&0xff,(v>>8)&0xff]); } break;
    case 0x14: valBytes = le32(value); break;
    case 0x18: { // u64
      const hi = (BigInt(value) >> 32n) & 0xffffffffn;
      const lo = BigInt(value) & 0xffffffffn;
      const b = new Uint8Array(8);
      const le32x = (n) => { const a=new Uint8Array(4); const x=Number(n)&0xffffffff; a[0]=x&255;a[1]=(x>>8)&255;a[2]=(x>>16)&255;a[3]=(x>>24)&255; return a; };
      b.set(le32x(lo),0); b.set(le32x(hi),4);
      valBytes = b;
    } break;
    default: throw new Error('bad type');
  }
  const payload = packKV(0x53, type, key, valBytes);
  await client.chCtrl.writeValue(payload);
  await client.waitReady();
}

async function handleConnect() {
  const L = i18n[getLang()];
  try {
    // --- Overall progress across connection + sync steps ---
    // Plan weights sum to ~100; adjust as needed.
    const PLAN = [
      { id: 'connect',    weight: 35 },
      { id: 'wallpaper',  weight: 10 },
      { id: 'info',       weight: 20 },
      { id: 'intentions', weight: 10 },
      { id: 'history',    weight: 25 },
    ];
    try { globalProgressStart('Syncing…', 100); } catch {}
    progAggregateStart(PLAN);
    let connectStep = 0;
    const CONNECT_STEPS = 5;
    const bumpConnect = () => progAggregateSet('connect', Math.floor(++connectStep * 100 / CONNECT_STEPS));

    // 1) Request device and connect
    setStatusKey('statusRequestingDevice', 'Requesting device…');
    await client.connect();
    setStatusKey('statusDeviceConnected', 'Device connected'); bumpConnect();

    // 2) Prepare UI and consent-dependent flags
    setCardsMuted(false);
    intentions.onConnected();
    setWallpaperConsent(!!client.consentOk);
    setHistoryConsent(!!client.consentOk);
    setStatusKey('statusPreparingUi', 'Preparing UI…'); bumpConnect();

    // 3) Bind Wallpaper FS service (optional)
    try {
      setStatusKey('statusBindingWallpaper', 'Binding wallpaper service…');
      await attachWallpaperFS(client.server);
    } catch (e) {
      console.warn('WallpaperFS attach skipped:', e);
    }
    setStatusKey('statusWallpaperReady', 'Wallpaper ready');
    progAggregateSet('wallpaper', 100);
    bumpConnect();

    // 4) Enable controls
    $('refreshBtn').disabled = false;
    $('resetBtn').disabled = false;
    $('backupBtn').disabled = false;
    $('restoreBtn').disabled = false;
    $('disconnectBtn').disabled = true;
    $('slDispBright').disabled = false;
    $('slWallBright').disabled = false;
    setStatusKey('statusEnablingControls', 'Enabling controls…'); bumpConnect();

    // 5) Remote availability indicators
    remoteAPI.onRemoteAvailability({ touch: !!client.touchChar, keys: !!client.keysChar });
    setStatusKey('statusRemoteReady', 'Remote ready'); bumpConnect();

    // 6) Read device info (settings/stats)
    setStatusKey('statusReadingInfo', 'Reading device info…');
    const statsOk = await refreshUntilValid({ tries: 12, delay: 250 });
    if (!statsOk) { await refreshOnce(); }
    setStatusKey('statusInfoLoaded', 'Device info loaded');
    progAggregateSet('info', 100);

    // 7) Load intentions
    try {
      setStatusKey('statusLoadingIntentions', 'Loading intentions…');
      await intentions.refresh({ silent: true });
    } catch (e) {
      console.warn('Intentions load skipped:', e);
    }
    setStatusKey('statusIntentionsReady', 'Intentions ready');
    progAggregateSet('intentions', 100);

    // 8) Attach History FS if consent
    if (client.consentOk) {
      try {
        setStatusKey('statusLoadingHistory', 'Loading history…');
        // Map history module's own progress into the overall bar segment
        progAggregateEnter('history');
        await attachHistoryFS(client.server);
        await refreshHistory();
        progAggregateLeave('history');
      } catch (e) {
        console.warn('History attach skipped:', e);
        // Consider history segment completed when skipped due to consent/other reasons
        progAggregateSet('history', 100);
      }
    }
    setStatusKey('statusHistoryReady', 'History ready');
    // If consent not granted, mark as complete so the overall bar can finish
    if (!client.consentOk) progAggregateSet('history', 100);

    // 9) Subscribe to settings live updates
    if (client.chSettings) {
      await client.chSettings.startNotifications();
      client.chSettings.addEventListener('characteristicvaluechanged', (ev) => {
        try {
          const u8 = new Uint8Array(ev.target.value.buffer, ev.target.value.byteOffset, ev.target.value.byteLength);
          const textPayload = new TextDecoder().decode(u8).split('\0')[0];
          const js = parseJsonWithFallback(textPayload, 'Settings-notif', { dropEntries: true });
          updateSettingsOnly(js);
        } catch (e) { console.warn('settings notif parse failed', e); }
      });
    }
    setStatusKey('statusReady', (L.statusReady || L.statusUpdated || 'Ready.'));
    progAggregateSet('connect', 100);

    $('disconnectBtn').disabled = false;
    $('swHaptic').disabled = false;
    $('swPreset').disabled = false;
    $('swAutosave').disabled = false;
    progAggregateDone();

  } catch (err) {
    console.error(err);
    status('Error: ' + err.message);
    setCardsMuted(true);
    setHistoryConsent(false);
    intentions.onDisconnected();
    try { await resetHistoryCard(); } catch {}
    try { globalProgressDone(400); } catch {}
  }
}

async function handleDisconnect() {
  try { resetWallpaperFS(); } catch {}
  try { await resetHistoryCard(); } catch {}
  await client.disconnect();
  intentions.onDisconnected();
  setCardsMuted(true);
  const L = i18n[getLang()];
  try { setStatusKey('statusDisconnected', L.statusDisconnected); } catch { status(L.statusDisconnected); }
  $('refreshBtn').disabled = true;
  $('resetBtn').disabled   = true;
  $('disconnectBtn').disabled = true;
  $('backupBtn').disabled  = true;
  $('restoreBtn').disabled = true;
  $('swHaptic').disabled   = true;
  $('swAutosave').disabled = true;
  $('swPreset').disabled   = true;
  $('slDispBright').disabled = true;
  $('slWallBright').disabled = true;
  remoteAPI.onRemoteAvailability({ touch:false, keys:false });
  setHistoryConsent(false);
}

// UI handlers
let updatingFromDevice = false;
function wireControls() {
  $('connectBtn').addEventListener('click', handleConnect);
  $('disconnectBtn').addEventListener('click', handleDisconnect);
  $('refreshBtn').addEventListener('click', async () => {
    try {
      await refreshOnce();
    } finally {
      try {
        await refreshHistory();
      } catch (e) {
        console.warn('History refresh failed:', e);
      }
      try {
        await intentions.refresh({ silent: true });
      } catch (e) {
        console.warn('Intentions refresh failed:', e);
      }
    }
  });

  $('resetBtn').addEventListener('click', async () => {
    const L = i18n[getLang()];
    try{
      if (!client.chCtrl) return;
      if (!confirm(L.confirmReset)) return;
      await client.chCtrl.writeValue(new Uint8Array([0x01]));
      await client.waitReady();
      setTimeout(refreshOnce, 300);
      try { setStatusKey('statusResetReq', L.statusResetReq); } catch { status(L.statusResetReq); }
    } catch(err){
      console.error(err);
      status('Reset failed: ' + err.message);
    }
  });

  $('backupBtn').addEventListener('click', async () => {
    try {
      await doBackup({
        chSettings: client.chSettings,
        chParts: client.chParts,
        chStats: client.chStats,
        statusEl: $('status'),
        i18nL: i18n[getLang()],
        robustRead: (ch) => client.robustRead(ch),
      });
    } catch (e) {
      console.error(e);
      status('Backup failed: ' + e.message);
    }
  });

  $('restoreBtn').addEventListener('click', () => $('restoreFile').click());
  $('restoreFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const L = i18n[getLang()];
    const prog = $('restoreProg'); if (prog) { prog.hidden = false; prog.value = 0; }
    try { globalProgressStart('Restoring…', 100); } catch {}
    try {
      const js = JSON.parse(await file.text());
      status(L.restoreStart);
      const onProgress = (step,total)=>{
        const pct = Math.floor(step*100/total);
        if (prog) prog.value = pct;
        try { globalProgressSet(pct, 'Restoring…'); } catch {}
      };
      await restoreFromJson(js, {
        chCtrl: client.chCtrl,
        waitReady: (...a)=>client.waitReady(...a),
        writePrefKey,
        writeStatKey,
        onProgress
      });
      await refreshUntilValid({ tries: 12, delay: 250 });
      try { setStatusKey('statusUpdated', L.restoreDone); } catch { status(L.restoreDone); }
      try { globalProgressDone(800); } catch {}
    } catch (err) {
      console.error(err);
      status('Restore failed: ' + err.message);
    } finally {
      if (prog) setTimeout(()=>{ prog.hidden = true; }, 600);
      try { globalProgressDone(600); } catch {}
      e.target.value = '';
    }
  });

  // Settings switches and sliders
  $('swPreset').addEventListener('change', async (e) => {
    if (updatingFromDevice) return;
    try {
      $('swAutosave').disabled = e.target.checked;
      await writePrefKey("m-preset-en", 0x01, e.target.checked ? 1 : 0);
      status(i18n[getLang()].settingsSaved || i18n[getLang()].statusUpdated);
    } catch (err) { console.error(err); status('Write failed: ' + err.message); }
  });
  $('swAutosave').addEventListener('change', async (e) => {
    if (updatingFromDevice) return;
    try {
      $('swPreset').disabled = e.target.checked;
      await writePrefKey("m-autosave-en", 0x01, e.target.checked ? 1 : 0);
      status(i18n[getLang()].settingsSaved || i18n[getLang()].statusUpdated);
    } catch (err) { console.error(err); status('Write failed: ' + err.message); }
  });
  $('swHaptic').addEventListener('change', async (e) => {
    if (updatingFromDevice) return;
    try {
      await writePrefKey("haptic-en", 0x01, e.target.checked ? 1 : 0);
      status(i18n[getLang()].settingsSaved || i18n[getLang()].statusUpdated);
    } catch (err) { console.error(err); status('Write failed: ' + err.message); }
  });

  let brDebounce = null;
  $('slDispBright').addEventListener('input', (e) => {
    $('slDispBrightVal').textContent = e.target.value + '%';
    if (updatingFromDevice) return;
    const val = Math.max(0, Math.min(100, Number(e.target.value|0)));
    if (brDebounce) clearTimeout(brDebounce);
    brDebounce = setTimeout(async () => {
      try {
        await writePrefKey("disp-bright", 0x21, val);
        status(i18n[getLang()].settingsSaved || i18n[getLang()].statusUpdated);
      } catch (err) { console.error(err); status('Write failed: ' + err.message); }
    }, 140);
  });

  let wbDebounce = null;
  $('slWallBright').addEventListener('input', (e) => {
    $('wallBrightVal').textContent = e.target.value + '%';
    if (updatingFromDevice) return;
    const val = Math.max(0, Math.min(100, Number(e.target.value|0)));
    if (wbDebounce) clearTimeout(wbDebounce);
    wbDebounce = setTimeout(async () => {
      try {
        await writePrefKey("wall-bright", 0x21, val);
        status(i18n[getLang()].settingsSaved || i18n[getLang()].statusUpdated);
      } catch (err) { console.error(err); status('Write failed: ' + err.message); }
    }, 140);
  });

  // Keys backup/restore
  const keysBackupBtn = $('keysBackupBtn');
  const keysRestoreBtn = $('keysRestoreBtn');
  const keysRestoreFile = $('keysRestoreFile');
  if (keysBackupBtn && keysRestoreBtn && keysRestoreFile) {
    keysBackupBtn.addEventListener('click', async () => {
      try {
        await requestKeysConsent({ chCtrl: client.chCtrl, statusChar: client.statusChar, mode:'export' });
        await backupKeys({ chAuthInfo: client.chAuthInfo, statusEl: $('status'), i18nL: i18n[getLang()] });
      } catch (e) {
        console.error(e);
        status('Keys backup failed: ' + e.message);
      }
    });

    keysRestoreBtn.addEventListener('click', () => keysRestoreFile.click());
    keysRestoreFile.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const js = JSON.parse(await f.text());
        const id  = js.id, pub = js.pubKey, priv = js.privKey;
        if (!id || !pub || !priv) throw new Error('File must contain {id, pubKey, privKey}');
        await requestKeysConsent({ chCtrl: client.chCtrl, statusChar: client.statusChar, mode:'restore' });
        await restoreKeys({ chAuthCtrl: client.chAuthCtrl, statusEl: $('status'), waitReady: (...a)=>client.waitReady(...a), id, pubKey:pub, privKey:priv, i18nL: i18n[getLang()] });
      } catch (e2) {
        console.error(e2);
        status('Keys restore cancelled: ' + e2.message);
      } finally {
        e.target.value = '';
      }
    });
  }

  // Lang selector
  wireLangSelector(() => {
    // refresh labels + charts when language changes
  });
}

// Remote control init (needs to read chars on connection)
const remoteAPI = (function(){
  let api = { onRemoteAvailability: ()=>{} };
  return api;
})();

// Boot
(function init(){
  initCharts();
  setLang('pl'); // default
  applyI18n();

  // remote module setup
  const r = initRemote({
    getTouchChar: () => client.touchChar,
    getKeysChar:  () => client.keysChar,
    i18nL: i18n[getLang()],
  });
  remoteAPI.onRemoteAvailability = r.onRemoteAvailability;

  wireControls();
})();
