import { $, u8ToStr, sleep, packKV, le32 } from './utils.js';
import { BleClient } from './ble.js';
import { initCharts } from './charts.js';
import { applyI18n, getLang, setLang, updateFromJson, wireLangSelector, updateSettingsOnly } from './ui.js';
import { doBackup } from './backup.js';
import { restoreFromJson } from './restore.js';
import { requestKeysConsent, backupKeys, restoreKeys } from './auth.js';
import { initRemote } from './remote.js';
import { i18n } from './i18n.js';
import { attachWallpaperFS, resetWallpaperFS, setWallpaperConsent } from './wallpaper.js';
import { initHistory, setHistoryConsent, attachHistoryFS, resetHistory as resetHistoryCard, refreshHistory } from './history.js';

const client = new BleClient();

initHistory();

function status(text){ $('status').textContent = text; }

async function refreshOnce() {
  const L = i18n[getLang()];
  try {
    if (!client.chStats || !client.chSettings) return false;
    console.log('[stats] refreshOnce: starting read');
    await sleep(200);
    const [vSettings, vPartsMaybe] = await Promise.all([
      client.robustRead(client.chSettings),
      client.chParts ? client.robustRead(client.chParts).catch(()=>null) : Promise.resolve(null)
    ]);
    await sleep(80);
    const vStats = await client.robustRead(client.chStats);

    const rawSettings = u8ToStr(vSettings);
    const rawStats    = u8ToStr(vStats);
    const rawParts    = vPartsMaybe ? u8ToStr(vPartsMaybe) : null;
    console.log('[stats] raw settings payload', rawSettings);
    console.log('[stats] raw stats payload', rawStats);
    if (rawParts != null) console.log('[stats] raw parts payload', rawParts);
    if (!rawSettings?.trim() || rawSettings.trim()==='{}') return false;
    if (!rawStats?.trim()    || rawStats.trim()==='{}')    return false;

    let jsSettings, jsStats, jsParts=null;
    let settingsPayload = rawSettings;

    const healers = [
      (raw) => {
        if (!raw) return null;
        const marker = '"entries":"';
        const idx = raw.indexOf(marker);
        if (idx < 0) return null;
        const prefix = raw.slice(0, idx + marker.length);
        return `${prefix}""}}`;
      },
      (raw) => {
        if (!raw) return null;
        const marker = ',"intentions"';
        const idx = raw.indexOf(marker);
        if (idx < 0) return null;
        const prefix = raw.slice(0, idx);
        return `${prefix}}`;
      }
    ];

    let parseOk = false;
    for (let step = 0; step <= healers.length; step++) {
      try {
        jsSettings = JSON.parse(settingsPayload);
        parseOk = true;
        break;
      } catch (err) {
        if (step === healers.length) {
          console.warn('[stats] settings JSON parse failed', err);
          return false;
        }
        const healed = healers[step](rawSettings);
        if (!healed) {
          console.warn('[stats] settings healer', step + 1, 'not applicable');
          return false;
        }
        console.warn(`[stats] applying settings healer #${step + 1}`, err);
        settingsPayload = healed;
        console.log(`[stats] healed settings payload #${step + 1}`, settingsPayload);
      }
    }

    if (!parseOk) return false;

    try { jsStats    = JSON.parse(rawStats);    } catch (err) {
      console.warn('[stats] stats JSON parse failed', err);
      return false;
    }
    if (rawParts != null) {
      try { jsParts = JSON.parse(rawParts); } catch (err) {
        console.warn('[stats] parts JSON parse failed', err);
        jsParts=null;
      }
    }

    console.log('[stats] parsed settings', jsSettings);
    console.log('[stats] parsed stats', jsStats);
    updateFromJson({ jsStats, jsSettings, jsParts });
    status(L.statusUpdated);
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
    status('Requesting device…');
    await client.connect();

    setWallpaperConsent(!!client.consentOk);
    setHistoryConsent(!!client.consentOk);
    try {
      await attachWallpaperFS(client.server);
    } catch (e) {
      console.warn('WallpaperFS attach skipped:', e);
    }

    $('refreshBtn').disabled = false;
    $('resetBtn').disabled = false;
    $('backupBtn').disabled = false;
    $('restoreBtn').disabled = false;
    $('disconnectBtn').disabled = true;
    $('slDispBright').disabled = false;
    $('slWallBright').disabled = false;

    // key mgmt buttons depend on auth chars
    $('keysBackupBtn').disabled  = !(client.consentOk && client.chAuthCtrl && client.chAuthInfo);
    $('keysRestoreBtn').disabled = !(client.consentOk && client.chAuthCtrl && client.chAuthInfo);

    // remote availability UI
    remoteAPI.onRemoteAvailability({ touch: !!client.touchChar, keys: !!client.keysChar });

    status(L.statusConnected);

    const statsOk = await refreshUntilValid({ tries: 12, delay: 250 });
    if (!statsOk) {
      await refreshOnce();
    }

    if (client.consentOk) {
      try {
        await attachHistoryFS(client.server);
        await refreshHistory();
      } catch (e) {
        console.warn('History attach skipped:', e);
      }
    }

    // Live updates for settings
    if (client.chSettings) {
      await client.chSettings.startNotifications();
    client.chSettings.addEventListener('characteristicvaluechanged', (ev) => {
        try {
            const u8 = new Uint8Array(ev.target.value.buffer, ev.target.value.byteOffset, ev.target.value.byteLength);
            const js = JSON.parse(new TextDecoder().decode(u8));
            console.log('[stats] settings notification', js);
            updateSettingsOnly(js);               // only tweak settings UI
            // leave charts/KPIs untouched
        } catch (e) {
            console.warn('settings notif parse failed', e);
        }
        });
    }

    $('disconnectBtn').disabled = false;
    $('swHaptic').disabled = false;
    $('swPreset').disabled = false;
    $('swAutosave').disabled = false;

  } catch (err) {
    console.error(err);
    status('Error: ' + err.message);
    setHistoryConsent(false);
    try { await resetHistoryCard(); } catch {}
  }
}

async function handleDisconnect() {
  try { resetWallpaperFS(); } catch {}
  try { await resetHistoryCard(); } catch {}
  await client.disconnect();
  const L = i18n[getLang()];
  status(L.statusDisconnected);
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
      status(L.statusResetReq);
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
    const prog = $('restoreProg'); prog.hidden = false; prog.value = 0;
    try {
      const js = JSON.parse(await file.text());
      status(L.restoreStart);
      const onProgress = (step,total)=>{ prog.value = Math.floor(step*100/total); };
      await restoreFromJson(js, {
        chCtrl: client.chCtrl,
        waitReady: (...a)=>client.waitReady(...a),
        writePrefKey,
        writeStatKey,
        onProgress
      });
      await refreshUntilValid({ tries: 12, delay: 250 });
      status(L.restoreDone);
    } catch (err) {
      console.error(err);
      status('Restore failed: ' + err.message);
    } finally {
      setTimeout(()=>{ prog.hidden = true; }, 600);
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
  $('keysBackupBtn').addEventListener('click', async () => {
    try {
      await requestKeysConsent({ chCtrl: client.chCtrl, statusChar: client.statusChar, mode:'export' });
      await backupKeys({ chAuthInfo: client.chAuthInfo, statusEl: $('status'), i18nL: i18n[getLang()] });
    } catch (e) {
      console.error(e);
      status('Keys backup failed: ' + e.message);
    }
  });

  $('keysRestoreBtn').addEventListener('click', () => $('keysRestoreFile').click());
  $('keysRestoreFile').addEventListener('change', async (e) => {
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
