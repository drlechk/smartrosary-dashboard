import { $, u8ToStr, sleep, packKV, le32, setGlobalStatus, globalProgressStart, globalProgressSet, globalProgressDone, progAggregateStart, progAggregateSet, progAggregateEnter, progAggregateLeave, progAggregateDone, progAggregateActive, platformFlags } from './utils.js';
import { BleClient } from './ble.js';
import { initCharts } from './charts.js';
import { applyI18n, getLang, setLang, updateFromJson, wireLangSelector, updateSettingsOnly, setStatusKey, setStatusText, initThemeToggle } from './ui.js';
import { doBackup } from './backup.js';
import { restoreFromJson } from './restore.js';
import { requestKeysConsent, backupKeys, restoreKeys } from './auth.js';
import { initRemote } from './remote.js';
import { i18n } from './i18n.js';
import { attachWallpaperFS, resetWallpaperFS, setWallpaperConsent } from './wallpaper.js';
import { initHistory, setHistoryConsent, attachHistoryFS, resetHistory as resetHistoryCard, refreshHistory, primeHistoryServer, setHistoryProgressDelegated, setHistoryProgressReporter, getHistoryData, restoreHistoryData, resetHistoryData } from './history.js';
import { initIntentions } from './intentions.js';
import { initUnifiedBackup } from './unified-backup.js';
import { getBackupData } from './backup.js';

const client = new BleClient();

const standaloneProgress = {
  active: false,
  label: null,
  max: 100,
};

function standaloneProgressBegin(label, max = 100, initialValue = 0) {
  if (progAggregateActive()) return false;
  const safeLabel = label || 'Working…';
  const safeMax = Number(max) > 0 ? Number(max) : 100;
  const safeInitial = Math.max(0, Math.min(Number(initialValue) || 0, safeMax));
  try {
    globalProgressStart(safeLabel, safeMax);
    globalProgressSet(safeInitial, safeLabel);
    standaloneProgress.active = true;
    standaloneProgress.label = safeLabel;
    standaloneProgress.max = safeMax;
    return true;
  } catch {
    standaloneProgress.active = false;
    standaloneProgress.label = null;
    standaloneProgress.max = 100;
    return false;
  }
}

function standaloneProgressUpdate(value, label) {
  if (!standaloneProgress.active || progAggregateActive()) return;
  const safeLabel = label || standaloneProgress.label || 'Working…';
  const safeMax = standaloneProgress.max || 100;
  const clamped = Math.max(0, Math.min(Number(value) || 0, safeMax));
  try { globalProgressSet(clamped, safeLabel); } catch { }
}

function standaloneProgressComplete(delayMs = 400, finalValue) {
  if (!standaloneProgress.active) return;
  if (!progAggregateActive()) {
    const safeLabel = standaloneProgress.label || 'Working…';
    const safeMax = standaloneProgress.max || 100;
    const finalVal = finalValue != null
      ? Math.max(0, Math.min(Number(finalValue) || 0, safeMax))
      : safeMax;
    try { globalProgressSet(finalVal, safeLabel); } catch { }
    try { globalProgressDone(delayMs); } catch { }
  }
  standaloneProgress.active = false;
  standaloneProgress.label = null;
  standaloneProgress.max = 100;
}

initHistory();
const intentions = initIntentions({ client, setStatus: status });

const unifiedBackup = initUnifiedBackup({
  getStatsData: async () => getBackupData({
    chSettings: client.chSettings,
    chParts: client.chParts,
    chStats: client.chStats,
    robustRead: client.robustRead.bind(client)
  }),
  restoreStatsData: async (data) => {
    await restoreFromJson(data, {
      chCtrl: client.chCtrl,
      waitReady: client.waitReady.bind(client),
      writePrefKey,
      writeStatKey,
      onProgress: (step, total) => {
        const pct = Math.round((step / total) * 100);
        try { globalProgressSet(pct, 'Restoring Stats...'); } catch { }
      }
    });
    setTimeout(refreshOnce, 500);
  },
  resetStatsData: async () => {
    await client.chCtrl.writeValue(new Uint8Array([0x01]));
    await client.waitReady();
    setTimeout(refreshOnce, 500);
  },
  getHistoryData,
  restoreHistoryData,
  resetHistoryData,
  getIntentionsData: intentions.getIntentionsData,
  restoreIntentionsData: async (data) => {
    await intentions.restoreIntentionsData(data);
    await intentions.refresh();
  },
  resetIntentionsData: async () => {
    await intentions.resetIntentionsData();
    await intentions.refresh();
  },
  setStatus: status
});

const CARD_SELECTOR = '.card';
function setCardsMuted(muted) {
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
    card.classList.toggle('card-muted', muted);
  });
}

setCardsMuted(true);

function status(value) {
  let resolver = null;
  let text = '';
  if (typeof value === 'function') {
    resolver = value;
    try {
      const result = value();
      text = result != null ? String(result) : '';
    } catch (err) {
      console.warn('Status resolver failed', err);
      resolver = null;
      text = '';
    }
  } else if (value && typeof value === 'object' && typeof value.text === 'string') {
    text = value.text;
    if (typeof value.resolver === 'function') resolver = value.resolver;
  } else if (value != null) {
    text = String(value);
  }
  try { setStatusText(text, resolver); } catch { $('status').textContent = text; }
  try { setGlobalStatus(text); } catch { }
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
  const progressLabel = L?.statusRefreshing || 'Refreshing…';
  const standaloneActive = standaloneProgressBegin(progressLabel, 100, 4);
  const updateStandaloneProgress = (pct) => {
    if (!standaloneActive) return;
    standaloneProgressUpdate(Math.max(0, Math.min(100, pct)), progressLabel);
  };
  let jsSettings = null;
  let jsStats = null;
  let jsParts = null;
  try {
    if (!client.chStats || !client.chSettings) return false;
    console.log('[stats] refreshOnce: starting read');
    await sleep(200);
    updateStandaloneProgress(12);

    const vSettings = await client.robustRead(client.chSettings);
    console.log('[stats] settings characteristic length', vSettings?.byteLength ?? (vSettings?.buffer?.byteLength));
    updateStandaloneProgress(28);

    let vPartsMaybe = null;
    if (client.chParts) {
      try {
        vPartsMaybe = await client.robustRead(client.chParts);
        console.log('[stats] parts characteristic length', vPartsMaybe?.byteLength ?? (vPartsMaybe?.buffer?.byteLength));
        updateStandaloneProgress(40);
      } catch (errParts) {
        console.warn('Parts characteristic read skipped:', errParts);
      }
    }

    const rawSettings = u8ToStr(vSettings);
    const rawParts = vPartsMaybe ? u8ToStr(vPartsMaybe) : null;
    console.debug('Raw settings text', rawSettings);
    if (rawParts != null) console.debug('Raw parts text', rawParts);
    const cleanedSettings = rawSettings ? rawSettings.split('\0')[0] : '';
    const cleanedParts = rawParts ? rawParts.split('\0')[0] : null;
    if (!cleanedSettings?.trim() || cleanedSettings.trim() === '{}') return false;

    try { jsSettings = parseJsonWithFallback(cleanedSettings, 'Settings', { dropEntries: true }); }
    catch (parseErr) { console.warn('Settings JSON failed after recovery', parseErr); return false; }

    if (cleanedParts != null) {
      try { jsParts = parseJsonWithFallback(cleanedParts, 'Parts'); }
      catch (parseErr) { console.warn('Parts JSON failed after recovery', parseErr); jsParts = null; }
    }

    await sleep(80);
    let rawStats = '';
    try {
      const vStats = await client.robustRead(client.chStats);
      console.log('[stats] stats characteristic length', vStats?.byteLength ?? (vStats?.buffer?.byteLength));
      updateStandaloneProgress(58);
      rawStats = u8ToStr(vStats);
    } catch (statsReadErr) {
      console.warn('[stats] Stats characteristic read failed; applying settings-only update', statsReadErr);
      if (jsSettings) {
        try { updateSettingsOnly(jsSettings); } catch { }
      }
      return false;
    }

    console.debug('Raw stats text', rawStats);
    const cleanedStats = rawStats ? rawStats.split('\0')[0] : '';
    if (!cleanedStats?.trim() || cleanedStats.trim() === '{}') {
      if (jsSettings) {
        try { updateSettingsOnly(jsSettings); } catch { }
      }
      return false;
    }

    try { jsStats = parseJsonWithFallback(cleanedStats, 'Stats'); }
    catch (parseErr) {
      console.warn('Stats JSON failed after recovery', parseErr);
      if (jsSettings) {
        try { updateSettingsOnly(jsSettings); } catch { }
      }
      return false;
    }

    // Firmware may signal consent requirement in-band
    if (jsSettings?.requireConsent || jsStats?.requireConsent) {
      status(() => {
        const Ln = i18n[getLang()] || i18n.en;
        return Ln.statusAwaitingConsent || 'Awaiting on-device consent…';
      });
      console.warn('Device reports consent required for info reads.');
      return false;
    }

    console.log('[stats] settings parsed keys', Object.keys(jsSettings || {}));
    console.log('[stats] stats parsed keys', Object.keys(jsStats || {}));
    if (jsParts) console.log('[stats] parts parsed keys', Object.keys(jsParts || {}));
    updateStandaloneProgress(78);

    updateFromJson({ jsStats, jsSettings, jsParts });
    updateStandaloneProgress(100);
    try { setStatusKey('statusUpdated', L?.statusUpdated); } catch {
      status(() => {
        const Ln = i18n[getLang()] || i18n.en;
        return Ln.statusUpdated || 'Ready.';
      });
    }
    return true;
  } catch (e) {
    console.error(e);
    const errMsg = e?.message || String(e);
    status(() => {
      const Ln = i18n[getLang()] || i18n.en;
      const formatter = Ln.statusReadFailed || ((msg) => `Read failed: ${msg}`);
      return formatter(errMsg);
    });
    return false;
  } finally {
    if (standaloneActive) {
      standaloneProgressComplete(400);
    }
  }
}

async function refreshUntilValid({ tries = 8, delay = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const ok = await refreshOnce();
    if (ok) return true;
    await sleep(delay * Math.pow(1.4, i));
    if (i === 2) { try { await client.reacquire(); } catch { } }
  }
  return false;
}

// Pref/stat writers using pacing
async function writePrefKey(key, type, value) {
  let valBytes;
  switch (type) {
    case 0x01: valBytes = new Uint8Array([value ? 1 : 0]); break;
    case 0x11: valBytes = new Uint8Array([Number(value) & 0xff]); break;
    case 0x12: { const v = Number(value) >>> 0; valBytes = new Uint8Array([v & 0xff, (v >> 8) & 0xff]); } break;
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
async function writeStatKey(key, type, value) {
  let valBytes;
  switch (type) {
    case 0x11: valBytes = new Uint8Array([Number(value) & 0xff]); break;
    case 0x12: { const v = Number(value) >>> 0; valBytes = new Uint8Array([v & 0xff, (v >> 8) & 0xff]); } break;
    case 0x14: valBytes = le32(value); break;
    case 0x18: { // u64
      const hi = (BigInt(value) >> 32n) & 0xffffffffn;
      const lo = BigInt(value) & 0xffffffffn;
      const b = new Uint8Array(8);
      const le32x = (n) => { const a = new Uint8Array(4); const x = Number(n) & 0xffffffff; a[0] = x & 255; a[1] = (x >> 8) & 255; a[2] = (x >> 16) & 255; a[3] = (x >> 24) & 255; return a; };
      b.set(le32x(lo), 0); b.set(le32x(hi), 4);
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
  const segTimers = new Map();
  let aggStarted = false;
  try {
    stopSettingsPolling();
    // --- Overall progress across connection + sync steps ---
    // Plan weights sum to ~100; adjust as needed.
    const PLAN = [
      { id: 'connect', weight: 20 },
      { id: 'wallpaper', weight: 20 },
      { id: 'overview', weight: 20 },
      { id: 'intentions', weight: 20 },
      { id: 'history', weight: 20 },
    ];
    try { globalProgressStart('Syncing…', 100); } catch { }
    progAggregateStart(PLAN);
    aggStarted = true;
    const updateSegment = (id, value) => {
      const seg = segTimers.get(id);
      if (!seg) return;
      const clamped = Math.min(seg.peak, value);
      const next = Math.max(seg.current, clamped);
      seg.current = next;
      progAggregateSet(id, next);
    };

    const beginSegment = (id, { initial = 10, peak = 85, duration = 15000 } = {}) => {
      const clampedInitial = Math.max(0, Math.min(initial, peak));
      progAggregateEnter(id);
      progAggregateSet(id, clampedInitial);
      const start = Date.now();
      const seg = {
        initial: clampedInitial,
        peak,
        duration,
        current: clampedInitial,
        timer: null,
      };
      seg.timer = setInterval(() => {
        const elapsed = Date.now() - start;
        const ratio = Math.min(1, elapsed / duration);
        const computed = clampedInitial + (peak - clampedInitial) * ratio;
        const next = Math.max(seg.current, computed);
        seg.current = next;
        progAggregateSet(id, next);
        if (ratio >= 1 && seg.timer) {
          clearInterval(seg.timer);
          seg.timer = null;
        }
      }, 400);
      segTimers.set(id, seg);
      if (id === 'history') {
        setHistoryProgressDelegated(true);
        setHistoryProgressReporter((pct) => {
          const normalized = Math.max(0, Math.min(100, pct));
          const mapped = seg.initial + (seg.peak - seg.initial) * (normalized / 100);
          updateSegment('history', mapped);
        });
      }
    };

    const finishSegment = (id, completeValue = 100) => {
      const seg = segTimers.get(id);
      if (seg?.timer) {
        clearInterval(seg.timer);
        seg.timer = null;
      }
      if (seg) {
        segTimers.delete(id);
        progAggregateLeave(id);
        progAggregateSet(id, completeValue);
      } else {
        // Segment may not have been started (e.g., skipped). Ensure final value set.
        progAggregateSet(id, completeValue);
      }
      if (id === 'history') {
        setHistoryProgressReporter(null);
        setHistoryProgressDelegated(false);
      }
    };
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
    beginSegment('wallpaper', { initial: 10, peak: 85, duration: 12000 });
    try {
      setStatusKey('statusBindingWallpaper', 'Binding wallpaper service…');
      updateSegment('wallpaper', 45);
      await attachWallpaperFS(client.server);
      updateSegment('wallpaper', 75);
    } catch (e) {
      console.warn('WallpaperFS attach skipped:', e);
    }
    finishSegment('wallpaper');
    setStatusKey('statusWallpaperReady', 'Wallpaper ready');
    bumpConnect();

    // 4) Enable controls
    $('refreshBtn').disabled = false;
    unifiedBackup.updateButtons(false, true);
    $('disconnectBtn').disabled = true;
    $('slDispBright').disabled = false;
    $('slWallBright').disabled = false;
    setStatusKey('statusEnablingControls', 'Enabling controls…'); bumpConnect();

    // 5) Remote availability indicators
    remoteAPI.onRemoteAvailability({ touch: !!client.touchChar, keys: !!client.keysChar });
    setStatusKey('statusRemoteReady', 'Remote ready'); bumpConnect();

    // 6) Read device info (settings/stats)
    beginSegment('overview', { initial: 15, peak: 85, duration: 14000 });
    setStatusKey('statusReadingInfo', 'Reading device info…');
    const statsOk = await refreshUntilValid({ tries: 12, delay: 250 });
    updateSegment('overview', statsOk ? 70 : 45);
    if (!statsOk) {
      await refreshOnce();
      updateSegment('overview', 80);
    }
    finishSegment('overview');
    setStatusKey('statusInfoLoaded', 'Device info loaded');

    // 7) Load intentions
    try {
      beginSegment('intentions', { initial: 15, peak: 85, duration: 8000 });
      setStatusKey('statusLoadingIntentions', 'Loading intentions…');
      await intentions.refresh({ silent: true });
      updateSegment('intentions', 70);
    } catch (e) {
      console.warn('Intentions load skipped:', e);
    } finally {
      finishSegment('intentions');
    }
    setStatusKey('statusIntentionsReady', 'Intentions ready');

    // 8) Attach History FS if consent
    const ua = navigator.userAgent || '';
    const touchPoints = Number(navigator.maxTouchPoints || 0);
    const isiOS = /iPad|iPhone|iPod/i.test(ua) || (/(Macintosh|Mac OS X)/.test(ua) && touchPoints > 1);
    const isBluefy = /bluefy/i.test(ua);
    const shouldAutoHistory = true;
    if (client.consentOk) {
      try { primeHistoryServer(client.server); } catch { }
      try {
        if (shouldAutoHistory) {
          setStatusKey('statusLoadingHistory', 'Loading history…');
          // Map history module's own progress into the overall bar segment
          beginSegment('history', { initial: 10, peak: 85, duration: 16000 });
          await attachHistoryFS(client.server, { autoFetch: false });
          updateSegment('history', 60);
          await refreshHistory();
          updateSegment('history', 90);
          finishSegment('history');
        } else {
          finishSegment('history', 100);
        }
      } catch (e) {
        console.warn('History attach skipped:', e);
        finishSegment('history', 100);
      }
    } else {
      finishSegment('history', 100);
    }
    setStatusKey('statusHistoryReady', 'History ready');

    // 9) Subscribe to settings live updates
    const needsSettingsPoll = platformFlags?.isBluefy || platformFlags?.isLikelyIOS;
    if (client.chSettings) {
      let notifReady = false;
      try {
        await client.chSettings.startNotifications();
        notifReady = true;
      } catch (err) {
        console.warn('Settings startNotifications failed', err);
      }
      client.chSettings.addEventListener('characteristicvaluechanged', (ev) => {
        try {
          const u8 = new Uint8Array(ev.target.value.buffer, ev.target.value.byteOffset, ev.target.value.byteLength);
          const textPayload = new TextDecoder().decode(u8);
          applySettingsPayload(textPayload, 'Settings-notif');
        } catch (e) { console.warn('settings notif parse failed', e); }
      });
      if (!notifReady || needsSettingsPoll) {
        startSettingsPolling(!notifReady ? 'notifications failed' : 'ios/bluefy safeguard');
      }
      // Always kick off a one-shot poll for freshness; timer will no-op if running
      if (!settingsRealtime.timer) startSettingsPolling('post-subscribe');
      else {
        // Immediate poll attempt without waiting interval
        (async () => {
          try {
            const v = await client.robustRead(client.chSettings);
            const raw = u8ToStr(v);
            applySettingsPayload(raw, 'Settings-poll-instant');
          } catch (err) {
            console.warn('Immediate settings poll failed', err?.message || err);
          }
        })();
      }
    }
    setStatusKey('statusReady', (L.statusReady || L.statusUpdated || 'Ready.'));
    progAggregateSet('connect', 100);

    $('disconnectBtn').disabled = false;
    $('swHaptic').disabled = false;
    $('swPreset').disabled = false;
    $('swAutosave').disabled = false;

  } catch (err) {
    console.error(err);
    const errMsg = err?.message || String(err);
    status(() => {
      const Ln = i18n[getLang()] || i18n.en;
      const formatter = Ln.statusGenericError || ((msg) => `Error: ${msg}`);
      return formatter(errMsg);
    });
    setCardsMuted(true);
    setHistoryConsent(false);
    intentions.onDisconnected();
    try { await resetHistoryCard(); } catch { }
    try { globalProgressDone(400); } catch { }
  } finally {
    if (!client.consentOk) {
      progAggregateSet('history', 100);
    }
    setHistoryProgressDelegated(false);
    setHistoryProgressReporter(null);
    for (const [id, seg] of segTimers) {
      if (seg.timer) clearInterval(seg.timer);
      progAggregateLeave(id);
      progAggregateSet(id, 100);
    }
    segTimers.clear();
    if (aggStarted) progAggregateDone();
  }
}

async function handleDisconnect() {
  try { resetWallpaperFS(); } catch { }
  try { await resetHistoryCard(); } catch { }
  stopSettingsPolling();
  await client.disconnect();
  intentions.onDisconnected();
  setCardsMuted(true);
  const L = i18n[getLang()];
  try { setStatusKey('statusDisconnected', L?.statusDisconnected); } catch {
    status(() => {
      const Ln = i18n[getLang()] || i18n.en;
      return Ln.statusDisconnected || 'Disconnected.';
    });
  }
  $('refreshBtn').disabled = true;
  unifiedBackup.updateButtons(false, false);
  $('disconnectBtn').disabled = true;
  $('swHaptic').disabled = true;
  $('swAutosave').disabled = true;
  $('swPreset').disabled = true;
  $('slDispBright').disabled = true;
  $('slWallBright').disabled = true;
  remoteAPI.onRemoteAvailability({ touch: false, keys: false });
  setHistoryConsent(false);
}

// UI handlers
let updatingFromDevice = false;
const settingsRealtime = { timer: null, inFlight: false };
let settingsFailCount = 0;

function applySettingsPayload(textPayload, contextLabel) {
  if (!textPayload) return;
  const trimmed = textPayload.split('\0')[0];
  if (!trimmed.trim() || trimmed.trim() === '{}') return;
  try {
    const js = parseJsonWithFallback(trimmed, contextLabel, { dropEntries: true });
    updatingFromDevice = true;
    updateSettingsOnly(js);
  } catch (err) {
    console.warn(`${contextLabel} parse failed`, err);
  } finally {
    updatingFromDevice = false;
  }
}

function stopSettingsPolling() {
  if (settingsRealtime.timer) {
    clearInterval(settingsRealtime.timer);
    settingsRealtime.timer = null;
  }
  settingsRealtime.inFlight = false;
  settingsFailCount = 0;
}

function startSettingsPolling(reason = 'fallback') {
  if (settingsRealtime.timer) return;
  console.log('[settings] starting poll loop', reason);
  const interval = (platformFlags?.isBluefy || platformFlags?.isLikelyIOS) ? 1200 : 2200;
  settingsRealtime.timer = setInterval(async () => {
    if (!client?.chSettings || settingsRealtime.inFlight) return;
    settingsRealtime.inFlight = true;
    try {
      const v = await client.robustRead(client.chSettings);
      const raw = u8ToStr(v);
      applySettingsPayload(raw, 'Settings-poll');
      settingsFailCount = 0;
    } catch (err) {
      console.warn('Settings poll read failed', err?.message || err);
      settingsFailCount++;
      if (settingsFailCount >= 3) {
        settingsFailCount = 0;
        try {
          console.warn('Settings poll triggering characteristic reacquire');
          await client.reacquire();
        } catch (reErr) {
          console.warn('Settings poll reacquire failed', reErr?.message || reErr);
        }
      }
    } finally {
      settingsRealtime.inFlight = false;
    }
  }, interval);
}
function wireControls() {
  $('connectBtn').addEventListener('click', handleConnect);
  $('disconnectBtn').addEventListener('click', handleDisconnect);
  $('refreshBtn').addEventListener('click', async () => {
    if (progAggregateActive()) {
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
      return;
    }

    const L = i18n[getLang()];
    const plan = [
      { id: 'stats', weight: 45 },
      { id: 'history', weight: 35 },
      { id: 'intentions', weight: 20 },
    ];
    const segTimers = new Map();

    const updateSegment = (id, value) => {
      const seg = segTimers.get(id);
      const clamped = Math.max(0, Math.min(100, Number(value) || 0));
      if (seg) seg.current = Math.max(seg.current, clamped);
      progAggregateSet(id, clamped);
    };

    const beginSegment = (id, { initial = 10, peak = 85, duration = 8000 } = {}) => {
      const safeInitial = Math.max(0, Math.min(initial, peak));
      progAggregateEnter(id);
      progAggregateSet(id, safeInitial);
      const seg = {
        initial: safeInitial,
        peak,
        duration,
        current: safeInitial,
        timer: null,
      };
      const startTs = Date.now();
      seg.timer = setInterval(() => {
        const elapsed = Date.now() - startTs;
        const ratio = Math.min(1, elapsed / seg.duration);
        const computed = seg.initial + (seg.peak - seg.initial) * ratio;
        if (computed > seg.current) {
          seg.current = computed;
          progAggregateSet(id, computed);
        }
        if (ratio >= 1 && seg.timer) {
          clearInterval(seg.timer);
          seg.timer = null;
        }
      }, 420);
      segTimers.set(id, seg);
      return seg;
    };

    const finishSegment = (id, finalValue = 100) => {
      const seg = segTimers.get(id);
      if (seg?.timer) {
        clearInterval(seg.timer);
        seg.timer = null;
      }
      if (id === 'history') {
        try { setHistoryProgressReporter(null); } catch { }
        try { setHistoryProgressDelegated(false); } catch { }
      }
      segTimers.delete(id);
      progAggregateLeave(id);
      progAggregateSet(id, Math.max(0, Math.min(100, Number(finalValue) || 0)));
    };

    try { globalProgressStart(L?.statusRefreshing || 'Refreshing…', 100); } catch { }
    progAggregateStart(plan);

    try {
      let statsError = null;
      const statsSeg = beginSegment('stats', { initial: 12, peak: 85, duration: 6500 });
      let statsOk = false;
      try {
        statsOk = await refreshOnce();
      } catch (err) {
        statsError = err;
        console.warn('Stats refresh during manual refresh failed:', err);
      } finally {
        const target = statsOk ? Math.max(statsSeg.initial + 30, 72) : statsSeg.initial + 20;
        updateSegment('stats', Math.min(100, target));
        finishSegment('stats');
      }

      const historySeg = beginSegment('history', { initial: 10, peak: 88, duration: 8000 });
      try {
        setHistoryProgressDelegated(true);
        setHistoryProgressReporter((pct) => {
          const normalized = Math.max(0, Math.min(100, Number(pct) || 0));
          const mapped = historySeg.initial + (historySeg.peak - historySeg.initial) * (normalized / 100);
          if (mapped > historySeg.current) {
            historySeg.current = mapped;
            progAggregateSet('history', mapped);
          }
        });
        let historySucceeded = false;
        try {
          await refreshHistory();
          historySucceeded = true;
        } catch (e) {
          console.warn('History refresh failed:', e);
        } finally {
          const target = historySucceeded ? Math.max(historySeg.initial + 40, 92) : historySeg.initial + 20;
          updateSegment('history', Math.min(100, target));
        }
      } finally {
        finishSegment('history');
      }

      const intentSeg = beginSegment('intentions', { initial: 12, peak: 85, duration: 6000 });
      let intentionsSucceeded = false;
      try {
        await intentions.refresh({ silent: true });
        intentionsSucceeded = true;
      } catch (e) {
        console.warn('Intentions refresh failed:', e);
      } finally {
        const target = intentionsSucceeded ? Math.max(intentSeg.initial + 35, 88) : intentSeg.initial + 18;
        updateSegment('intentions', Math.min(100, target));
        finishSegment('intentions');
      }

      if (statsError) throw statsError;
    } finally {
      try { setHistoryProgressReporter(null); } catch { }
      try { setHistoryProgressDelegated(false); } catch { }
      for (const [id, seg] of segTimers) {
        if (seg.timer) clearInterval(seg.timer);
        progAggregateLeave(id);
        progAggregateSet(id, 100);
      }
      segTimers.clear();
      progAggregateDone();
    }
  });



  // Settings switches and sliders
  $('swPreset').addEventListener('change', async (e) => {
    if (updatingFromDevice) return;
    try {
      $('swAutosave').disabled = e.target.checked;
      await writePrefKey("m-preset-en", 0x01, e.target.checked ? 1 : 0);
      status(() => {
        const Ln = i18n[getLang()] || i18n.en;
        return Ln.settingsSaved || Ln.statusUpdated || 'Settings updated.';
      });
    } catch (err) {
      console.error(err);
      const errMsg = err?.message || String(err);
      status(() => {
        const Ln = i18n[getLang()] || i18n.en;
        const formatter = Ln.statusWriteFailed || ((msg) => `Write failed: ${msg}`);
        return formatter(errMsg);
      });
    }
  });
  $('swAutosave').addEventListener('change', async (e) => {
    if (updatingFromDevice) return;
    try {
      $('swPreset').disabled = e.target.checked;
      await writePrefKey("m-autosave-en", 0x01, e.target.checked ? 1 : 0);
      status(() => {
        const Ln = i18n[getLang()] || i18n.en;
        return Ln.settingsSaved || Ln.statusUpdated || 'Settings updated.';
      });
    } catch (err) {
      console.error(err);
      const errMsg = err?.message || String(err);
      status(() => {
        const Ln = i18n[getLang()] || i18n.en;
        const formatter = Ln.statusWriteFailed || ((msg) => `Write failed: ${msg}`);
        return formatter(errMsg);
      });
    }
  });
  $('swHaptic').addEventListener('change', async (e) => {
    if (updatingFromDevice) return;
    try {
      await writePrefKey("haptic-en", 0x01, e.target.checked ? 1 : 0);
      status(() => {
        const Ln = i18n[getLang()] || i18n.en;
        return Ln.settingsSaved || Ln.statusUpdated || 'Settings updated.';
      });
    } catch (err) {
      console.error(err);
      const errMsg = err?.message || String(err);
      status(() => {
        const Ln = i18n[getLang()] || i18n.en;
        const formatter = Ln.statusWriteFailed || ((msg) => `Write failed: ${msg}`);
        return formatter(errMsg);
      });
    }
  });

  let brDebounce = null;
  $('slDispBright').addEventListener('input', (e) => {
    $('slDispBrightVal').textContent = e.target.value + '%';
    if (updatingFromDevice) return;
    const val = Math.max(0, Math.min(100, Number(e.target.value | 0)));
    if (brDebounce) clearTimeout(brDebounce);
    brDebounce = setTimeout(async () => {
      try {
        await writePrefKey("disp-bright", 0x21, val);
        status(() => {
          const Ln = i18n[getLang()] || i18n.en;
          return Ln.settingsSaved || Ln.statusUpdated || 'Settings updated.';
        });
      } catch (err) {
        console.error(err);
        const errMsg = err?.message || String(err);
        status(() => {
          const Ln = i18n[getLang()] || i18n.en;
          const formatter = Ln.statusWriteFailed || ((msg) => `Write failed: ${msg}`);
          return formatter(errMsg);
        });
      }
    }, 140);
  });

  let wbDebounce = null;
  $('slWallBright').addEventListener('input', (e) => {
    $('wallBrightVal').textContent = e.target.value + '%';
    if (updatingFromDevice) return;
    const val = Math.max(0, Math.min(100, Number(e.target.value | 0)));
    if (wbDebounce) clearTimeout(wbDebounce);
    wbDebounce = setTimeout(async () => {
      try {
        await writePrefKey("wall-bright", 0x21, val);
        status(() => {
          const Ln = i18n[getLang()] || i18n.en;
          return Ln.settingsSaved || Ln.statusUpdated || 'Settings updated.';
        });
      } catch (err) {
        console.error(err);
        const errMsg = err?.message || String(err);
        status(() => {
          const Ln = i18n[getLang()] || i18n.en;
          const formatter = Ln.statusWriteFailed || ((msg) => `Write failed: ${msg}`);
          return formatter(errMsg);
        });
      }
    }, 140);
  });

  // Keys backup/restore
  const keysBackupBtn = $('keysBackupBtn');
  const keysRestoreBtn = $('keysRestoreBtn');
  const keysRestoreFile = $('keysRestoreFile');
  if (keysBackupBtn && keysRestoreBtn && keysRestoreFile) {
    keysBackupBtn.addEventListener('click', async () => {
      try {
        await requestKeysConsent({ chCtrl: client.chCtrl, statusChar: client.statusChar, mode: 'export' });
        await backupKeys({ chAuthInfo: client.chAuthInfo, statusEl: $('status'), i18nL: i18n[getLang()] });
      } catch (e) {
        console.error(e);
        const errMsg = e?.message || String(e);
        status(() => {
          const Ln = i18n[getLang()] || i18n.en;
          const formatter = Ln.statusKeysBackupFailed || ((msg) => `Keys backup failed: ${msg}`);
          return formatter(errMsg);
        });
      }
    });

    keysRestoreBtn.addEventListener('click', () => keysRestoreFile.click());
    keysRestoreFile.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const js = JSON.parse(await f.text());
        const id = js.id, pub = js.pubKey, priv = js.privKey;
        if (!id || !pub || !priv) throw new Error('File must contain {id, pubKey, privKey}');
        await requestKeysConsent({ chCtrl: client.chCtrl, statusChar: client.statusChar, mode: 'restore' });
        await restoreKeys({ chAuthCtrl: client.chAuthCtrl, statusEl: $('status'), waitReady: (...a) => client.waitReady(...a), id, pubKey: pub, privKey: priv, i18nL: i18n[getLang()] });
      } catch (e2) {
        console.error(e2);
        const errMsg = e2?.message || String(e2);
        status(() => {
          const Ln = i18n[getLang()] || i18n.en;
          const formatter = Ln.statusKeysRestoreCancelled || ((msg) => `Keys restore cancelled: ${msg}`);
          return formatter(errMsg);
        });
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
const remoteAPI = (function () {
  let api = { onRemoteAvailability: () => { } };
  return api;
})();

// Boot
(function init() {
  initThemeToggle();
  initCharts();
  setLang('pl'); // default
  applyI18n();

  // remote module setup
  const r = initRemote({
    getTouchChar: () => client.touchChar,
    getKeysChar: () => client.keysChar,
    i18nL: i18n[getLang()],
  });
  remoteAPI.onRemoteAvailability = r.onRemoteAvailability;

  wireControls();
})();
