import { $, u8ToStr, safeNum } from './utils.js';
import { setChartLabels, updateAverages, updateDonut, updateParts } from './charts.js';
import { applyWallpaperI18n, setWallpaperLang } from './wallpaper.js';
import { applyHistoryI18n } from './history.js';
import { i18n } from './i18n.js';

let lang = 'pl';
let lastStats = null;
let lastSettings = null;

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function normalizeSettingsStruct(settings) {
  if (!isPlainObject(settings)) return settings;
  const myst = settings.mystery;
  if (isPlainObject(myst)) {
    if (myst.sel != null && myst.selection == null) myst.selection = myst.sel;
    if (myst.selection != null) myst.sel = myst.selection;

    if (myst.iSel != null && myst.intentionSelected == null) myst.intentionSelected = !!myst.iSel;
    if (myst.intentionSelected != null) myst.iSel = !!myst.intentionSelected;
  }
  return settings;
}

function mergeSettings(base, patch) {
  patch = normalizeSettingsStruct(patch);
  if (!isPlainObject(patch)) return patch ?? base ?? null;
  const target = isPlainObject(base) ? { ...base } : {};
  for (const [key, val] of Object.entries(patch)) {
    target[key] = isPlainObject(val)
      ? mergeSettings(target[key], val)
      : val;
  }
  return normalizeSettingsStruct(target);
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
  const setTxt = (id, value) => { const el = $(id); if (el) el.textContent = value; };

  setTxt('titleTxt', L.title);
  setTxt('connectBtn', L.connect);
  setTxt('refreshBtn', L.refresh);
  setTxt('resetBtn', L.reset);
  setTxt('disconnectBtn', L.disconnect);
  setTxt('backupBtn', L.backup);
  setTxt('restoreBtn', L.restore);
  setTxt('status', L.statusNot);

  setTxt('overviewTitle', L.overview);
  setTxt('lblBeads', L.beads);
  setTxt('lblDecades', L.decades);
  setTxt('lblRosaries', L.rosaries);
  setTxt('lblChaplets', L.chaplets);

  setTxt('avgTitle', L.averages);
  setTxt('lblAvgBead', L.avgBead);
  setTxt('lblAvgDecade', L.avgDecade);
  setTxt('lblAvgRosary', L.avgRosary);
  setTxt('lblAvgChaplet', L.avgChaplet);
  setTxt('avgNote', L.avgNote);

  setTxt('donutTitle', L.donutTitle);
  setTxt('partsTitle', L.partsTitle);
  setTxt('bkNote', L.bkTip);

  setTxt('totalsTitle', L.totalsTitle);
  setTxt('lblTbeads', L.totBeads);
  setTxt('lblTdecades', L.totDecades);
  setTxt('lblTrosary', L.totRosary);
  setTxt('lblTchaplet', L.totChaplet);

  setTxt('lblDevice', L.pillDevice);
  setTxt('lblFW', L.pillFW);
  setTxt('lblLastMystery', L.pillLastMystery);

  setTxt('lblBackupRestore', L.backuprestore);

  setTxt('settingsTitle', L.settingsTitle);
  setTxt('lblHaptic', L.lblHaptic);
  setTxt('descHaptic', L.descHaptic);
  setTxt('lblPreset', L.lblPreset);
  setTxt('descPreset', L.descPreset);
  setTxt('lblAutosave', L.lblAutosave);
  setTxt('descAutosave', L.descAutosave);
  setTxt('lblDispBright', L.lblDispBright);
  setTxt('descDispBright', L.descDispBright);
  setTxt('lblWallBright', L.lblWallBright);
  setTxt('descWallBright', L.descWallBright);

  setTxt('rcTitle', L.rcTitle);
  setTxt('rcStatus', L.rcInactive);

  setTxt('keysBackupBtn', L.keysBackupBtn);
  setTxt('keysRestoreBtn', L.keysRestoreBtn);

  const IL = L.intentions || {};
  setTxt('intentionsTitle', IL.title || 'Intentions Scheduler');
  const intentionsIntro = $('intentionsIntro');
  if (intentionsIntro && IL.intro) intentionsIntro.textContent = IL.intro;
  const intentionsLoadBtn = $('intentionsLoadBtn');
  if (intentionsLoadBtn && IL.loadBtn) intentionsLoadBtn.textContent = IL.loadBtn;
  const intentionsSaveBtn = $('intentionsSaveBtn');
  if (intentionsSaveBtn && IL.saveBtn) intentionsSaveBtn.textContent = IL.saveBtn;
  setTxt('intentionsAutoLabel', IL.autoLabel || '');
  const intentionsHint = $('intentionsHint');
  if (intentionsHint && IL.hint) intentionsHint.textContent = IL.hint;
  const intentionsEmpty = $('intentionsEmpty');
  if (intentionsEmpty && IL.emptyDisconnected) intentionsEmpty.textContent = IL.emptyDisconnected;
  const headerCells = document.querySelectorAll('#intentionsTable thead th');
  if (headerCells.length >= 5 && IL.table) {
    headerCells[0].textContent = IL.table.index ?? '#';
    headerCells[1].textContent = IL.table.title ?? headerCells[1].textContent;
    headerCells[2].textContent = IL.table.start ?? headerCells[2].textContent;
    headerCells[3].textContent = IL.table.set ?? headerCells[3].textContent;
    headerCells[4].textContent = IL.table.part ?? headerCells[4].textContent;
  }

  setChartLabels(L);
  renderPillsFromCache();
  setWallpaperLang(lang);
  applyWallpaperI18n();
  applyHistoryI18n({ ...L.history, calendar: L.calendar });
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
