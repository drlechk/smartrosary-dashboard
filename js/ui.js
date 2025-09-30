import { $, u8ToStr, safeNum } from './utils.js';
import { setChartLabels, updateAverages, updateDonut, updateParts } from './charts.js';
import { applyWallpaperI18n, setWallpaperLang } from './wallpaper.js';
import { applyHistoryI18n } from './history.js';
import { i18n } from './i18n.js';

let lang = 'pl';
let lastStats = null;
let lastSettings = null;

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function mergeSettings(base, patch) {
  if (!isPlainObject(patch)) return patch ?? base ?? null;
  const target = isPlainObject(base) ? { ...base } : {};
  for (const [key, val] of Object.entries(patch)) {
    target[key] = isPlainObject(val)
      ? mergeSettings(target[key], val)
      : val;
  }
  return target;
}

function cacheSettings(patch) {
  if (!patch) return lastSettings;
  lastSettings = mergeSettings(lastSettings, patch);
  return lastSettings;
}

export function getLang() { return lang; }
export function setLang(v){ lang = v; applyI18n(); }

export function applyI18n() {
  const L = i18n[lang] || i18n.en;
  $('titleTxt').textContent   = L.title;
  $('connectBtn').textContent = L.connect;
  $('refreshBtn').textContent = L.refresh;
  $('resetBtn').textContent   = L.reset;
  $('disconnectBtn').textContent = L.disconnect;
  $('backupBtn').textContent  = L.backup;
  $('restoreBtn').textContent = L.restore;
  $('status').textContent     = L.statusNot;

  $('overviewTitle').textContent = L.overview;
  $('lblBeads').textContent   = L.beads;
  $('lblDecades').textContent = L.decades;
  $('lblRosaries').textContent= L.rosaries;
  $('lblChaplets').textContent= L.chaplets;

  $('avgTitle').textContent   = L.averages;
  $('lblAvgBead').textContent = L.avgBead;
  $('lblAvgDecade').textContent = L.avgDecade;
  $('lblAvgRosary').textContent = L.avgRosary;
  $('lblAvgChaplet').textContent= L.avgChaplet;
  $('avgNote').textContent    = L.avgNote;

  $('barTitle').textContent   = L.barTitle;
  $('donutTitle').textContent = L.donutTitle;
  $('partsTitle').textContent = L.partsTitle;
  $('bkNote').textContent     = L.bkTip;

  $('totalsTitle').textContent = L.totalsTitle;
  $('lblTbeads').textContent   = L.totBeads;
  $('lblTdecades').textContent = L.totDecades;
  $('lblTrosary').textContent  = L.totRosary;
  $('lblTchaplet').textContent = L.totChaplet;

  $('lblDevice').textContent      = L.pillDevice;
  $('lblFW').textContent          = L.pillFW;
  $('lblLastMystery').textContent = L.pillLastMystery;

  $('lblBackupRestore').textContent = L.backuprestore;

  $('settingsTitle').textContent = L.settingsTitle;
  $('lblHaptic').textContent     = L.lblHaptic;
  $('descHaptic').textContent    = L.descHaptic;
  $('lblPreset').textContent     = L.lblPreset;
  $('descPreset').textContent    = L.descPreset;
  $('lblAutosave').textContent   = L.lblAutosave;
  $('descAutosave').textContent  = L.descAutosave;
  $('lblDispBright').textContent = L.lblDispBright;
  $('descDispBright').textContent= L.descDispBright;
  $('lblWallBright').textContent = L.lblWallBright;
  $('descWallBright').textContent= L.descWallBright;

  $('rcTitle').textContent  = L.rcTitle;
  $('rcStatus').textContent = L.rcInactive;

  $('keysBackupBtn').textContent  = L.keysBackupBtn;
  $('keysRestoreBtn').textContent = L.keysRestoreBtn;

  setChartLabels(L);
  renderPillsFromCache();
  setWallpaperLang(lang);
  applyWallpaperI18n();
  applyHistoryI18n(L.history);
}

function fmtMs(ms){
  if (ms == null || isNaN(ms)) return '—';
  ms = Math.max(0, Math.round(ms));
  if (ms < 1000) return `${ms} ms`;
  let s = Math.floor(ms/1000);
  if (s < 60) return `${s}s`;
  let m = Math.floor(s/60); s = s % 60;
  if (m < 60) return `${m}m ${s}s`;
  let h = Math.floor(m/60); m = m % 60;
  return `${h}h ${m}m ${s}s`;
}

function localizeSetName(enName, langCode = lang){
  const idxMap = { None:0, Joyful:1, Sorrowful:2, Glorious:3, Luminous:4, Chaplet:5 };
  const idx = idxMap[enName];
  if (idx == null) return enName;
  const L = i18n[langCode] || i18n.en;
  return (L.lastsets && L.lastsets[idx]) ? L.lastsets[idx] : enName;
}

export function renderPillsFromCache(){
  const deviceName = lastSettings?.device ?? lastStats?.device ?? '—';
  $('valDevice').textContent = deviceName;
  $('valFW').textContent     = lastSettings?.fwVersion ?? '—';

  const lastSetEN  = lastStats?.lastMystery?.set;
  const lastIndex  = lastStats?.lastMystery?.index;
  const lastSetLOC = lastSetEN ? localizeSetName(lastSetEN) : '—';
  const suffix = lastIndex ? ` #${lastIndex}` : '';
  $('valLastMystery').textContent = `${lastSetLOC}${suffix}`;
}

export function updateFromJson({ jsStats, jsSettings, jsParts }) {
  lastStats = jsStats;
  const mergedSettings = cacheSettings(jsSettings) || {};

  $('kpiBeads').textContent    = (jsStats.totals?.beads ?? '—');
  $('kpiDecades').textContent  = (jsStats.totals?.decades ?? '—');
  $('kpiRosaries').textContent = (jsStats.totals?.rosaries ?? '—');
  $('kpiChaplets').textContent = (jsStats.totals?.chaplets ?? '—');

  $('valDevice').textContent = mergedSettings.device || jsStats.device || '—';
  $('valFW').textContent     = mergedSettings.fwVersion || '—';

  const lastSetEN  = jsStats.lastMystery?.set;
  const lastIndex  = jsStats.lastMystery?.index;
  const lastSetLOC = lastSetEN ? localizeSetName(lastSetEN) : '—';
  $('valLastMystery').textContent = `${lastSetLOC}${lastIndex ? ` #${lastIndex}` : ''}`;

  const d = jsStats.durations || {};
  const avgBeadMs     = safeNum(d.avgBeadMs,     0);
  const avgDecadeMs   = safeNum(d.avgDecadeMs,   0);
  const avgRosaryMs   = safeNum(d.avgRosaryMs,   0);
  const avgChapletMs  = safeNum(d.avgChapletMs,  0);
  const totBeadMs     = safeNum(d.totalBeadMs,     0);
  const totDecadeMs   = safeNum(d.totalDecadeMs,   0);
  const totRosaryMs   = safeNum(d.totalRosaryMs,   0);
  const totChapletMs  = safeNum(d.totalChapletMs,  0);

  $('kpiAvgBead').textContent     = fmtMs(avgBeadMs);
  $('kpiAvgDecade').textContent   = fmtMs(avgDecadeMs);
  $('kpiAvgRosary').textContent   = fmtMs(avgRosaryMs);
  $('kpiAvgChaplet').textContent  = fmtMs(avgChapletMs);

  $('totRosary').textContent  = fmtMs(totRosaryMs);
  $('totDecade').textContent  = fmtMs(totDecadeMs);
  $('totBead').textContent    = fmtMs(totBeadMs);
  $('totChaplet').textContent = fmtMs(totChapletMs);

  updateAverages({ avgBeadMs, avgDecadeMs, avgRosaryMs, avgChapletMs });

  const totalDec = (jsStats.totals?.decades ?? 0);
  const joyful   = (jsStats.sets?.joyful ?? 0);
  const sorrow   = (jsStats.sets?.sorrowful ?? 0);
  const glor     = (jsStats.sets?.glorious ?? 0);
  const lumi     = (jsStats.sets?.luminous ?? 0);
  const chap     = (jsStats.totals?.chaplets ?? 0);
  let none       = jsStats.sets?.none;
  if (none == null) {
    const sumKnown = joyful + sorrow + glor + lumi;
    none = Math.max(0, totalDec - sumKnown);
  }
  updateDonut({ none, joyful, sorrowful:sorrow, glorious:glor, luminous:lumi, chaplet:chap });

  if (jsParts) {
    updateParts(jsParts.setsParts || {});
  }

  applySettingsUi(mergedSettings);
  renderPillsFromCache();
  $('status').textContent = (i18n[lang].statusUpdated);
}

export function wireLangSelector(onChange) {
  $('langSelect').addEventListener('change', (ev) => {
    setLang(ev.target.value);
    onChange?.();
  });
}

// ADD (near other exports)
export function updateSettingsOnly(jsSettings) {
  const merged = cacheSettings(jsSettings);
  applySettingsUi(merged);
  renderPillsFromCache();
}

function applySettingsUi(settings) {
  if (!settings) return;

  const swH = document.getElementById('swHaptic');
  if (swH) swH.checked = !!settings.haptic;

  const swP = document.getElementById('swPreset');
  const swA = document.getElementById('swAutosave');
  const presetOn = !!settings.mystery?.preset;
  const autosaveOn = !!settings.mystery?.autosave;
  if (swP) swP.checked = presetOn;
  if (swA) swA.checked = autosaveOn;
  if (swP && swA) {
    swA.disabled = presetOn;
    swP.disabled = autosaveOn;
  }

  const db = Math.max(0, Math.min(100, Number(settings.display?.brightness ?? 0)));
  const sl = document.getElementById('slDispBright');
  const sv = document.getElementById('slDispBrightVal');
  if (sl && sv) { sl.value = db; sv.textContent = db + '%'; }

  const wb = Math.max(0, Math.min(100, Number(settings.wallpaper?.brightness ?? 0)));
  const slw = document.getElementById('slWallBright');
  const wv  = document.getElementById('wallBrightVal');
  if (slw && wv) { slw.value = wb; wv.textContent = wb + '%'; }

  const fwEl = document.getElementById('valFW');
  if (fwEl) fwEl.textContent = settings.fwVersion || '—';
}
