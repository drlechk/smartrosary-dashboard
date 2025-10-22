import { sleep, downloadBlob, globalProgressStart, globalProgressSet, globalProgressDone } from './utils.js';

// history.js — BLE history explorer card integration

const $ = (id) => document.getElementById(id);

const dom = {
  card: $('historyCard'),
  title: $('historyTitle'),
  restoreBtn: $('histRestoreBtn'),
  downloadBtn: $('histDownloadBtn'),
  uploadProg: $('histUploadProg'),
  fsInfo: $('histFsInfo'),
  parseSummary: $('histParseSummary'),
  downloadProgress: $('histDownloadProgress'),
  fileList: $('histFileList'),
  bucketSel: $('histBucketSel'),
  prevBtn: $('histPrevBtn'),
  nextBtn: $('histNextBtn'),
  periodLabel: $('histPeriodLabel'),
  chartCanvas: $('histChart'),
  legendRow1: $('histLegendRow1'),
  legendRow2: $('histLegendRow2'),
  restoreLabel: $('histRestoreLabel'),
  activityTitle: $('histActivityTitle'),
  bucketLabel: $('histBucketLabel'),
};

const FALLBACK_LEGEND_SETS = ['None','Joyful','Sorrowful','Glorious','Luminous','Chaplet'];
const FALLBACK_LEGEND_ROMAN = ['I','II','III','IV','V'];

let legendSets = [...FALLBACK_LEGEND_SETS];
let legendIntentLabel = 'Intention';
let legendRoman = [...FALLBACK_LEGEND_ROMAN];

const HISTORY_THEMES = {
  dark: {
    axisGrid: '#1a2733',
    axisTick: '#cfe4ff',
    legendText: '#cfe4ff',
    legendBorder: '#333',
    legendIntentBorder: '#2e2e2e',
  },
  light: {
    axisGrid: '#d4deeb',
    axisTick: '#1f2937',
    legendText: '#0f172a',
    legendBorder: '#94a3b8',
    legendIntentBorder: '#94a3b8',
  },
};

function resolveHistoryPalette(mode) {
  if (mode === 'light') return HISTORY_THEMES.light;
  if (mode === 'dark') return HISTORY_THEMES.dark;
  return document.body.classList.contains('theme-light') ? HISTORY_THEMES.light : HISTORY_THEMES.dark;
}

let historyPalette = resolveHistoryPalette();

const hiddenRestoreInput = (() => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.bin,application/octet-stream';
  input.style.display = 'none';
  input.id = 'histRestoreFile';
  document.body.appendChild(input);
  return input;
})();

const FS_SVC_UUID   = '12345678-1234-5678-1234-56789abcf000';
const FS_CTRL_UUID  = '12345678-1234-5678-1234-56789abcf001';
const FS_INFO_UUID  = '12345678-1234-5678-1234-56789abcf002';
const FS_DATA_UUID  = '12345678-1234-5678-1234-56789abcf003';
const FS_STAT_UUID  = '12345678-1234-5678-1234-56789abcf004';

const OPC = {
  LIST:          0x70,
  SEND_OPEN:     0x71,
  SEND_NEXT:     0x72,
  SEND_CLOSE:    0x73,
  DELETE:        0x74,
  DELETE_LOG:    0x75,
  CREATE_NEW:    0x76,
  RESTORE_BEGIN: 0x77,
  RESTORE_DATA:  0x78,
  RESTORE_DONE:  0x79,
  SET_RTC:       0x7A,
};

let serverRef = null;
let chCtrl = null;
let chInfo = null;
let chData = null;
let chStat = null;

let consentOk = false;
let connected = false;

let infoListener = null;
let dataListener = null;
let statListener = null;

let downloadActive = false;
let downloadBuf = [];
let downloadTarget = null;
let downloadTotal = 0;
let downloadSoFar = 0;
let lastDownloadProgressTs = 0;
let lastBlob = null;

let uploading = false;
let upTotal = 0;
let upSent = 0;
let upCredits = 0;
let lastCreditTs = 0;

const CREDIT_STALL_MS = 2000;
const PROGRESS_TIMEOUT_MS = 30000;
const CHUNK_MAX = 200;
const CHUNK_MIN = 40;
let dynChunk = 160;

const RETRY_MAX = 6;
const RETRY_DELAY_MS = 90;

const shades = {
  none:['#9e9e9e','#8f8f8f','#808080','#717171','#626262'],
  joyful:['#99ccff','#66b2ff','#3399ff','#1a7fd6','#0066cc'],
  sorrowful:['#ff6666','#ff3333','#cc0000','#990000','#730000'],
  glorious:['#66ff66','#33e633','#00cc00','#00a300','#007a00'],
  luminous:['#ffe680','#ffdb4d','#ffcc00','#e6b800','#cc9a00'],
  chaplet:'#8B4513'
};
const PK_NAME = ['NONE','JOYFUL','LUMINOUS','SORROWFUL','GLORIOUS','DIVINE_MERCY'];

let gRows = [];
let histChart = null;
let periodAnchor = null;
let queueChain = Promise.resolve();

function enqueue(task) {
  const run = queueChain.then(() => task());
  queueChain = run.catch((err) => { log('task failed', err); });
  return run;
}

function log(...args) {
  console.log('[history]', ...args);
}

function setCardMuted(muted) {
  if (!dom.card) return;
  dom.card.classList.toggle('history-muted', muted);
}

function setControlsEnabled(enabled) {
  const ctrls = [
    dom.restoreBtn,
    dom.downloadBtn,
    dom.bucketSel,
    dom.prevBtn,
    dom.nextBtn,
  ];
  ctrls.forEach((el) => {
    if (!el) return;
    el.disabled = !enabled;
  });
  if (dom.bucketSel && !enabled) dom.bucketSel.value = 'week';
  setCardMuted(!enabled);
}

function resetProgress() {
  downloadActive = false;
  downloadBuf = [];
  downloadTarget = null;
  downloadTotal = 0;
  downloadSoFar = 0;
  lastDownloadProgressTs = 0;
  if (dom.downloadProgress) {
    dom.downloadProgress.style.display = 'none';
    dom.downloadProgress.textContent = '';
  }
  try { globalProgressDone(400); } catch {}
}

function showProgress() {
  if (!dom.downloadProgress) return;
  if (!downloadActive) {
    dom.downloadProgress.style.display = 'none';
    try { globalProgressDone(400); } catch {}
    return;
  }
  dom.downloadProgress.style.display = 'inline-flex';
  const soFar = downloadTotal > 0 ? Math.min(downloadSoFar, downloadTotal) : downloadSoFar;
  if (downloadTotal > 0) {
    const pct = Math.min(100, Math.floor((soFar * 100) / downloadTotal));
    dom.downloadProgress.textContent = `Downloading ${soFar}/${downloadTotal} B (${pct}%)`;
    try { globalProgressStart('Downloading…', 100); globalProgressSet(pct, 'Downloading…'); } catch {}
  } else {
    dom.downloadProgress.textContent = `Downloading ${soFar} B`;
    try { globalProgressStart('Downloading…', 100); } catch {}
  }
}

async function waitForProgress(prevBytes, timeoutMs = 750) {
  const started = performance.now();
  while (downloadActive && downloadSoFar <= prevBytes) {
    if (performance.now() - started >= timeoutMs) {
      log('waitForProgress: timeout', { prevBytes, downloadSoFar, timeoutMs });
      return false;
    }
    await sleep(16);
  }
  return downloadSoFar > prevBytes;
}

function resetUploadProgress() {
  uploading = false;
  upTotal = 0;
  upSent = 0;
  upCredits = 0;
  dynChunk = 160;
  if (dom.uploadProg) {
    dom.uploadProg.style.display = 'none';
    dom.uploadProg.textContent = '';
  }
  try { globalProgressDone(400); } catch {}
}

function showUploadProgress() {
  if (!dom.uploadProg) return;
  if (!uploading) {
    dom.uploadProg.style.display = 'none';
    try { globalProgressDone(400); } catch {}
    return;
  }
  dom.uploadProg.style.display = 'inline-flex';
  const pct = upTotal ? Math.min(100, Math.floor((upSent * 100) / upTotal)) : 0;
  dom.uploadProg.textContent = `Uploading ${upSent}/${upTotal} B (${pct}%)`;
   try { globalProgressStart('Uploading…', 100); globalProgressSet(pct, 'Uploading…'); } catch {}
}

function resetList() {
  if (!dom.fileList) return;
  dom.fileList.innerHTML = '';
}

function appendFile(name, size) {
  if (!dom.fileList) return;
  const row = document.createElement('div');
  row.className = 'history-file';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'mono';
  nameSpan.textContent = name;
  const sizeSpan = document.createElement('span');
  sizeSpan.className = 'muted';
  sizeSpan.textContent = `${size} B`;
  row.append(nameSpan, sizeSpan);
  dom.fileList.appendChild(row);
}

function formatRtcNowForDevice() {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'short' });
  const day   = String(now.getDate()).padStart(2, '0');
  const year  = now.getFullYear();

  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');

  return { date: `${month} ${day} ${year}`, time: `${hh}:${mm}:${ss}` };
}

function isGattBusy(err) {
  if (!err) return false;
  if (err.name === 'NetworkError') return true;
  return String(err).includes('GATT operation already in progress');
}

async function writeCtrl(value, label = 'cmd') {
  if (!chCtrl) throw new Error('CTRL unavailable');
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    try {
      await chCtrl.writeValue(value);
      return;
    } catch (err) {
      if (isGattBusy(err) && attempt < RETRY_MAX - 1) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      log(`${label} failed`, err);
      throw err;
    }
  }
}

async function setRtcNow() {
  const { date, time } = formatRtcNowForDevice();
  const encDate = new TextEncoder().encode(date);
  const encTime = new TextEncoder().encode(time);

  const pkt = new Uint8Array(1 + 1 + encDate.length + 1 + encTime.length);
  let o = 0;
  pkt[o++] = OPC.SET_RTC;
  pkt[o++] = encDate.length;
  pkt.set(encDate, o); o += encDate.length;
  pkt[o++] = encTime.length;
  pkt.set(encTime, o);

  log('SET_RTC', date, time);
  await writeCtrl(pkt, 'SET_RTC');
}

async function doList() {
  if (!chCtrl) return;
  log('doList: sending LIST');
  resetList();
  try {
    await writeCtrl(new Uint8Array([OPC.LIST]), 'LIST');
    if (dom.fsInfo) dom.fsInfo.textContent = 'Listing…';
  } catch (e) {
    console.warn('LIST failed', e);
  }
}

async function openAndRead() {
  if (!chCtrl) return;

  downloadActive = true;
  downloadBuf = [];
  downloadTarget = null;
  downloadTotal = 0;
  downloadSoFar = 0;
  lastDownloadProgressTs = performance.now();
  showProgress();
  log('openAndRead: begin download history.bin');

  const name = 'history.bin';
  const enc = new TextEncoder().encode(name);
  const pkt = new Uint8Array(1 + 1 + enc.length);
  pkt[0] = OPC.SEND_OPEN;
  pkt[1] = enc.length;
  pkt.set(enc, 2);

  try {
    await writeCtrl(pkt, 'SEND_OPEN');
    log('openAndRead: SEND_OPEN success');
  } catch (e) {
    console.error('SEND_OPEN failed', e);
    resetProgress();
    return;
  }

  const nextReq = new Uint8Array([OPC.SEND_NEXT, 0x00, 0x00]);
  let guard = 0;
  let idleRounds = 0;

  while (downloadActive) {
    const before = downloadSoFar;
    try {
      await writeCtrl(nextReq, 'SEND_NEXT');
    } catch {
      await sleep(20);
    }

    const progressed = await waitForProgress(before, 650);
    if (progressed) {
      idleRounds = 0;
      lastDownloadProgressTs = performance.now();
      log('openAndRead: chunk received', downloadSoFar, '/', downloadTotal || '?');
    } else {
      idleRounds++;
      log('openAndRead: no progress', { idleRounds, guard, downloadSoFar, downloadTotal });
    }

    if (!downloadActive) break;

    if (downloadTotal && downloadSoFar >= downloadTotal) break;
    if (idleRounds >= 5) break;
    if (++guard > 1200) break;

    if (performance.now() - lastDownloadProgressTs > PROGRESS_TIMEOUT_MS) break;
  }

  try {
    await writeCtrl(new Uint8Array([OPC.SEND_CLOSE]), 'SEND_CLOSE');
  } catch {}
  log('openAndRead: loop exit guard=', guard, 'idleRounds=', idleRounds, 'downloadSoFar=', downloadSoFar, 'total=', downloadTotal);
}

function finalizeDownload() {
  const expected = downloadTotal || 0;
  const usedFromTarget = downloadTarget ? Math.min(downloadSoFar, downloadTarget.length) : 0;

  let bytes;
  if (downloadTarget && downloadBuf.length === 0) {
    bytes = downloadTarget.subarray(0, usedFromTarget);
  } else {
    const buffered = downloadBuf.reduce((acc, chunk) => acc + chunk.length, 0);
    const merged = new Uint8Array(usedFromTarget + buffered);
    let offset = 0;
    if (downloadTarget && usedFromTarget > 0) {
      merged.set(downloadTarget.subarray(0, usedFromTarget), offset);
      offset += usedFromTarget;
    }
    for (const chunk of downloadBuf) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    bytes = merged.subarray(0, offset);
  }

  lastBlob = {
    name: 'history.bin',
    blob: new Blob([bytes], { type: 'application/octet-stream' })
  };

  try {
    parseHistory(bytes);
  } catch (err) {
    console.error('parseHistory failed', err);
  }

  log('finalizeDownload:', { bytes: bytes.length, expected, bufferCount: downloadBuf.length });

  if (dom.fsInfo) {
    const extra = expected && expected !== bytes.length ? `/${expected}` : '';
    dom.fsInfo.textContent = `Received ${bytes.length}${extra} B`;
  }
}

function hasPendingDownload() {
  if (!downloadActive) return false;
  if (downloadSoFar > 0) return true;
  if (downloadBuf.length > 0) return true;
  if (downloadTarget && downloadTotal > 0) return true;
  return false;
}

function downloadRawFile() {
  if (!lastBlob || !lastBlob.blob) {
    alert('History data not available yet. Please wait for the device to sync.');
    return;
  }
  downloadBlob(lastBlob.blob, lastBlob.name || 'history.bin');
}

function _crc32(bytes) {
  let crc = 0xFFFFFFFF >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

async function doRestoreFromFile(file) {
  if (!file) {
    alert('Pick a history.bin file first.');
    return;
  }
  if (!chCtrl) {
    alert('Not connected.');
    return;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length % 5 !== 0) {
    if (!confirm(`File size ${bytes.length} is not a multiple of 5 bytes. Upload anyway?`)) {
      return;
    }
  }

  uploading = true;
  upTotal = bytes.length;
  upSent = 0;
  upCredits = 0;
  dynChunk = Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, 160));
  showUploadProgress();

  const sz = bytes.length >>> 0;
  const begin = new Uint8Array(1 + 4);
  begin[0] = OPC.RESTORE_BEGIN;
  begin[1] = sz & 0xFF;
  begin[2] = (sz >> 8) & 0xFF;
  begin[3] = (sz >> 16) & 0xFF;
  begin[4] = (sz >> 24) & 0xFF;

  await writeCtrl(begin, 'RESTORE_BEGIN');

  lastCreditTs = performance.now();
  let guardWait = 0;
  while (upCredits <= 0 && guardWait < 5000) {
    if (performance.now() - lastCreditTs > CREDIT_STALL_MS) {
      lastCreditTs = performance.now();
    }
    await new Promise((r) => setTimeout(r, 10));
    guardWait++;
  }
  if (upCredits <= 0) {
    alert('Device did not grant credit to start upload.');
    resetUploadProgress();
    return;
  }

  for (let off = 0; off < bytes.length; ) {
    let waited = 0;
    while (upCredits <= 0) {
      if (performance.now() - lastCreditTs > CREDIT_STALL_MS) {
        dynChunk = Math.max(CHUNK_MIN, (dynChunk / 2) | 0);
        lastCreditTs = performance.now();
      }
      if (waited > PROGRESS_TIMEOUT_MS / 10) {
        alert('Upload timed out (no credits).');
        resetUploadProgress();
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
      waited++;
    }
    upCredits--;

    const n = Math.min(dynChunk, bytes.length - off);
    const slice = bytes.subarray(off, off + n);
    const c = _crc32(slice);

    const pkt = new Uint8Array(1 + n + 4);
    pkt[0] = OPC.RESTORE_DATA;
    pkt.set(slice, 1);
    pkt[1 + n] = c & 0xFF;
    pkt[2 + n] = (c >> 8) & 0xFF;
    pkt[3 + n] = (c >> 16) & 0xFF;
    pkt[4 + n] = (c >> 24) & 0xFF;

    let wrote = false;
    let tries = 0;
    while (!wrote && tries < 3) {
      try {
        await writeCtrl(pkt, 'RESTORE_DATA');
        wrote = true;
      } catch (e) {
        tries++;
        await new Promise((r) => setTimeout(r, 20));
        if (tries === 3) throw e;
      }
    }

    off += n;
    upSent = off;
    showUploadProgress();

    if (performance.now() - lastCreditTs < 300) {
      dynChunk = Math.min(CHUNK_MAX, dynChunk + 16);
    }
  }

  try {
    await writeCtrl(new Uint8Array([OPC.RESTORE_DONE]), 'RESTORE_DONE');
  } catch {}
  uploading = false;
  showUploadProgress();

  await new Promise((r) => setTimeout(r, 200));
  await doList();
}

// Defaults (English); mutable so i18n can override
const MONTH_SHORT_DEFAULT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEK_DOW_DEFAULT    = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
let MONTH_SHORT = [...MONTH_SHORT_DEFAULT];
let WEEK_DOW    = [...WEEK_DOW_DEFAULT];

function startOfTodayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0,0,0,0));
}

function startOfISOWeekUTC(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0,0,0,0));
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt;
}

function startOfMonthUTC(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
function startOfYearUTC(d) { return new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); }

function fixedLabels(mode) {
  if (mode === 'day') return Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  if (mode === 'week') return WEEK_DOW.slice();
  if (mode === 'month') return Array.from({ length: 31 }, (_, d) => String(d + 1));
  if (mode === 'year') return MONTH_SHORT.slice();
  return [];
}

function setAnchorToNow(mode) {
  const now = new Date();
  if (mode === 'day') periodAnchor = startOfTodayUTC();
  else if (mode === 'week') periodAnchor = startOfISOWeekUTC(now);
  else if (mode === 'month') periodAnchor = startOfMonthUTC(now);
  else if (mode === 'year') periodAnchor = startOfYearUTC(now);
  else periodAnchor = startOfTodayUTC();
}

function shiftAnchor(mode, dir) {
  if (!periodAnchor) return;
  if (mode === 'day') {
    periodAnchor = new Date(periodAnchor.getTime() + dir * 24 * 3600 * 1000);
  } else if (mode === 'week') {
    periodAnchor = new Date(periodAnchor.getTime() + dir * 7 * 24 * 3600 * 1000);
  } else if (mode === 'month') {
    const y = periodAnchor.getUTCFullYear();
    const m = periodAnchor.getUTCMonth();
    periodAnchor = new Date(Date.UTC(y, m + dir, 1));
  } else if (mode === 'year') {
    const y = periodAnchor.getUTCFullYear();
    periodAnchor = new Date(Date.UTC(y + dir, 0, 1));
  }
}

function getPeriodBounds(mode) {
  if (mode === 'day') {
    const s = new Date(Date.UTC(periodAnchor.getUTCFullYear(), periodAnchor.getUTCMonth(), periodAnchor.getUTCDate()));
    const e = new Date(s.getTime() + 24 * 3600 * 1000);
    return { start: s, end: e };
  }
  if (mode === 'week') {
    const s = startOfISOWeekUTC(periodAnchor);
    const e = new Date(s.getTime() + 7 * 24 * 3600 * 1000);
    return { start: s, end: e };
  }
  if (mode === 'month') {
    const s = new Date(Date.UTC(periodAnchor.getUTCFullYear(), periodAnchor.getUTCMonth(), 1));
    const e = new Date(Date.UTC(periodAnchor.getUTCFullYear(), periodAnchor.getUTCMonth() + 1, 1));
    return { start: s, end: e };
  }
  if (mode === 'year') {
    const s = new Date(Date.UTC(periodAnchor.getUTCFullYear(), 0, 1));
    const e = new Date(Date.UTC(periodAnchor.getUTCFullYear() + 1, 0, 1));
    return { start: s, end: e };
  }
  return { start: startOfTodayUTC(), end: new Date() };
}

function fmtYMD(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function periodText(mode) {
  if (mode === 'day') return fmtYMD(periodAnchor);
  if (mode === 'week') {
    const { start, end } = getPeriodBounds('week');
    const sTxt = fmtYMD(start);
    const eTxt = fmtYMD(new Date(end.getTime() - 1));
    return `Week: ${sTxt} – ${eTxt}`;
  }
  if (mode === 'month') {
    const y = periodAnchor.getUTCFullYear();
    const m = MONTH_SHORT[periodAnchor.getUTCMonth()];
    return `${m} ${y}`;
  }
  if (mode === 'year') return String(periodAnchor.getUTCFullYear());
  return '';
}

function binIndexForDate(d, mode, periodStart) {
  if (mode === 'day') {
    const sameDay = d.getUTCFullYear() === periodStart.getUTCFullYear()
      && d.getUTCMonth() === periodStart.getUTCMonth()
      && d.getUTCDate() === periodStart.getUTCDate();
    return sameDay ? d.getUTCHours() : -1;
  }
  if (mode === 'week') {
    const start = new Date(periodStart);
    const diffMs = d - start;
    if (diffMs < 0 || diffMs >= 7 * 24 * 3600 * 1000) return -1;
    return (d.getUTCDay() + 6) % 7;
  }
  if (mode === 'month') {
    const sameMonth = d.getUTCFullYear() === periodStart.getUTCFullYear()
      && d.getUTCMonth() === periodStart.getUTCMonth();
    return sameMonth ? (d.getUTCDate() - 1) : -1;
  }
  if (mode === 'year') {
    const sameYear = d.getUTCFullYear() === periodStart.getUTCFullYear();
    return sameYear ? d.getUTCMonth() : -1;
  }
  return -1;
}

function colorFor(pk, part) {
  if (pk === 5) return shades.chaplet;
  const idx = Math.min(5, Math.max(1, part)) - 1;
  if (pk === 0) return shades.none[idx];
  if (pk === 1) return shades.joyful[idx];
  if (pk === 2) return shades.luminous[idx];
  if (pk === 3) return shades.sorrowful[idx];
  if (pk === 4) return shades.glorious[idx];
  return '#666';
}

function buildDatasetsFixed(mode) {
  const { start: startUTC, end: endUTC } = getPeriodBounds(mode);
  const labels = fixedLabels(mode);
  const L = labels.length;
  const datasets = [];
  const PKS = [0,1,2,3,4,5];

  log('buildDatasetsFixed: inputs', { mode, records: gRows.length, startUTC, endUTC });

  for (const pk of PKS) {
    const maxPart = (pk === 5 ? 1 : 5);
    for (let part = 1; part <= maxPart; part++) {
      const solid = new Array(L).fill(0);
      const intent = new Array(L).fill(0);

      for (const r of gRows) {
        const t = r.date instanceof Date ? r.date : new Date(r.date);
        if (!(t >= startUTC && t < endUTC)) continue;

        const bin = binIndexForDate(t, mode, startUTC);
        if (bin < 0 || bin >= L) continue;

        if (r.pk !== pk) continue;

        // scaling factors
        const weight = (pk === 5) ? 1 : 0.2;

        if (pk === 5) {
          if (r.intent) intent[bin] += weight;
          else solid[bin] += weight;
        } else {
          if (r.dec !== part) continue;
          if (r.intent) intent[bin] += weight;
          else solid[bin] += weight;
        }
      }

      const base = colorFor(pk, part);
      const stripe = (window.pattern && window.pattern.draw)
        ? window.pattern.draw('diagonal', base, '#2e2e2e', 6)
        : base;

      datasets.push({
        label: `${PK_NAME[pk] || ('PK' + pk)}${pk === 5 ? '' : (' ' + part)}`,
        data: solid,
        backgroundColor: base,
        borderWidth: 0,
        stack: 'all',
        order: 1,
        meta: { pk, part, isIntent: false, baseColor: base }
      });
      datasets.push({
        label: `${PK_NAME[pk] || ('PK' + pk)}${pk === 5 ? '' : (' ' + part)} (intent)`,
        data: intent,
        backgroundColor: stripe,
        borderWidth: 0,
        stack: 'all',
        order: 2,
        meta: { pk, part, isIntent: true, baseColor: base }
      });

      if (solid.some(Boolean) || intent.some(Boolean)) {
        log('buildDatasetsFixed: dataset populated', { pk, part, solid, intent });
      }
    }
  }

  return { labels, datasets };
}

function renderChart() {
  if (!dom.chartCanvas) return;
  const bucket = dom.bucketSel?.value || 'day';
  const { labels, datasets } = buildDatasetsFixed(bucket);
  log('renderChart: datasets built', { bucket, labels: labels.length, ds: datasets.length, first: datasets[0]?.data });

  const ctx = dom.chartCanvas.getContext('2d');
  if (!ctx) return;

  if (dom.periodLabel) dom.periodLabel.textContent = periodText(bucket);

  historyPalette = resolveHistoryPalette();

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { type: 'category', stacked: true, ticks: { color: historyPalette.axisTick, autoSkip: false, maxRotation: 45, minRotation: 45, font: { size: 10 } }, grid: { color: historyPalette.axisGrid } },
      y: { stacked: true, beginAtZero: true, ticks: { color: historyPalette.axisTick, precision: 0, font: { size: 10 } }, grid: { color: historyPalette.axisGrid } }
    },
    animations: { y: { from: 0, duration: 700, easing: 'easeOutCubic' } }
  };

  if (!histChart) {
    log('renderChart: creating chart instance');
    histChart = new Chart(ctx, { type: 'bar', data: { labels, datasets }, options });
  } else {
    histChart.data.labels = labels;
    histChart.data.datasets = datasets;
    if (histChart.options?.scales) {
      const { scales } = histChart.options;
      if (scales.x) {
        if (!scales.x.ticks) scales.x.ticks = {};
        scales.x.ticks.color = historyPalette.axisTick;
        if (!scales.x.grid) scales.x.grid = {};
        scales.x.grid.color = historyPalette.axisGrid;
      }
      if (scales.y) {
        if (!scales.y.ticks) scales.y.ticks = {};
        scales.y.ticks.color = historyPalette.axisTick;
        if (!scales.y.grid) scales.y.grid = {};
        scales.y.grid.color = historyPalette.axisGrid;
      }
    }
    histChart.update();
    log('renderChart: chart updated');
  }
}

function makeLegendItem(color, label, hatched = false) {
  const item = document.createElement('div');
  item.className = 'legend-item';
  item.style.color = historyPalette.legendText;
  const box = document.createElement('span');
  box.className = 'legend-color';
  box.style.setProperty('--legend-base', color);
  box.style.borderColor = hatched ? historyPalette.legendIntentBorder : historyPalette.legendBorder;
  if (hatched) {
    box.classList.add('hatched');
  } else {
    box.classList.remove('hatched');
    box.style.backgroundColor = color;
  }
  const txt = document.createElement('span');
  txt.textContent = label;
  item.append(box, txt);
  return item;
}

function renderLegend() {
  if (!dom.legendRow1 || !dom.legendRow2) return;
  dom.legendRow1.innerHTML = '';
  dom.legendRow2.innerHTML = '';

  historyPalette = resolveHistoryPalette();

  const sets = legendSets.length >= 6 ? legendSets : FALLBACK_LEGEND_SETS;
  const romans = legendRoman.length >= 5 ? legendRoman : FALLBACK_LEGEND_ROMAN;

  const top = [
    makeLegendItem('#808080', sets[0] ?? FALLBACK_LEGEND_SETS[0]),
    makeLegendItem('#3399ff', sets[1] ?? FALLBACK_LEGEND_SETS[1]),
    makeLegendItem('#ff6666', sets[2] ?? FALLBACK_LEGEND_SETS[2]),
    makeLegendItem('#00cc00', sets[3] ?? FALLBACK_LEGEND_SETS[3]),
    makeLegendItem('#ffcc00', sets[4] ?? FALLBACK_LEGEND_SETS[4]),
    makeLegendItem('#8B4513', sets[5] ?? FALLBACK_LEGEND_SETS[5]),
    makeLegendItem('#eeeeee', legendIntentLabel, true),
  ];
  const bottom = [
    makeLegendItem('#9e9e9e', romans[0] ?? FALLBACK_LEGEND_ROMAN[0]),
    makeLegendItem('#8f8f8f', romans[1] ?? FALLBACK_LEGEND_ROMAN[1]),
    makeLegendItem('#808080', romans[2] ?? FALLBACK_LEGEND_ROMAN[2]),
    makeLegendItem('#717171', romans[3] ?? FALLBACK_LEGEND_ROMAN[3]),
    makeLegendItem('#626262', romans[4] ?? FALLBACK_LEGEND_ROMAN[4]),
  ];

  top.forEach((el) => dom.legendRow1.appendChild(el));
  bottom.forEach((el) => dom.legendRow2.appendChild(el));
  applyPaletteToLegendRows();
}

function applyPaletteToLegendRows() {
  const updateRow = (row) => {
    if (!row) return;
    row.querySelectorAll('.legend-item').forEach((item) => {
      item.style.color = historyPalette.legendText;
      item.querySelectorAll('.legend-color').forEach((box) => {
        const isHatched = box.classList.contains('hatched');
        box.style.borderColor = isHatched ? historyPalette.legendIntentBorder : historyPalette.legendBorder;
      });
    });
  };
  updateRow(dom.legendRow1);
  updateRow(dom.legendRow2);
}

function parseHistory(bytes) {
  const recSize = 5;
  if (bytes.length % recSize !== 0) {
    console.warn(`History size ${bytes.length} not multiple of ${recSize}; trailing ${bytes.length % recSize}B ignored`);
  }
  const nrec = Math.floor(bytes.length / recSize);

  gRows = [];
  let decades = 0;
  let chaplets = 0;
  let intentions = 0;

  for (let i = 0; i < nrec; i++) {
    const off = i * recSize;
    const ts = (
      (bytes[off]) |
      (bytes[off + 1] << 8) |
      (bytes[off + 2] << 16) |
      (bytes[off + 3] << 24)
    ) >>> 0;
    const b0 = bytes[off + 4];
    const pk = (b0 >> 5) & 0x07;
    const dec = (b0 >> 2) & 0x07;
    const intent = (b0 & 0x01) !== 0;

    const d = new Date(ts * 1000);
    if (dec === 0) chaplets++; else decades++;
    if (intent) intentions++;

    gRows.push({ date: d, pk, dec, intent });
  }

  if (dom.parseSummary) {
    dom.parseSummary.textContent = `${nrec} record(s) — decades:${decades} chaplets:${chaplets} intentions:${intentions}`;
  }

  log('parseHistory:', { nrec, decades, chaplets, intentions, bucket: dom.bucketSel?.value });

  const bucket = dom.bucketSel?.value || 'day';
  setAnchorToNow(bucket);
  renderChart();
}

function onInfo(ev) {
  const v = new TextDecoder().decode(ev.target.value);
  log('onInfo: payload', v);
  for (const line of v.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.name && typeof obj.size === 'number') {
        appendFile(obj.name, obj.size);
      }
      if (dom.fsInfo && obj.fs) {
        dom.fsInfo.textContent = obj.fs;
      }
    } catch (e) {
      // ignore non-JSON
    }
  }
}

function onData(ev) {
  if (!downloadActive) return;
  const chunk = new Uint8Array(ev.target.value.buffer.slice(0));
  if (downloadTarget) {
    const remaining = Math.max(0, downloadTarget.length - downloadSoFar);
    const take = Math.min(remaining, chunk.length);
    if (take > 0) {
      downloadTarget.set(chunk.subarray(0, take), downloadSoFar);
    }
    if (take < chunk.length) {
      downloadBuf.push(chunk.subarray(take));
    }
  } else {
    downloadBuf.push(chunk);
  }
  downloadSoFar += chunk.length;
  lastDownloadProgressTs = performance.now();
  log('onData: chunk', chunk.length, 'B -> total', downloadSoFar, '/', downloadTotal || '?', 'bufPending', downloadBuf.length);
  showProgress();
}

function rd32LE(dv, off) {
  return dv.getUint32(off, true);
}

function onStat(ev) {
  const dv = new DataView(ev.target.value.buffer);
  const code = dv.getUint8(0);
  const aux = rd32LE(dv, 1);

  switch (code) {
    case 0xD0:
      downloadTotal = aux >>> 0;
      if (downloadTotal > 0) {
        try {
          downloadTarget = new Uint8Array(downloadTotal);
          downloadBuf = [];
        } catch (err) {
          console.warn('history alloc fallback', err);
          downloadTarget = null;
        }
        downloadSoFar = 0;
        lastDownloadProgressTs = performance.now();
      }
      log('onStat: size announced', downloadTotal);
      showProgress();
      break;
    case 0xD1:
      log('onStat: download complete signal (bytes=', aux, ')');
      finalizeDownload();
      resetProgress();
      break;
    case 0xD2:
      log('onStat: closed');
      if (hasPendingDownload()) {
        try { finalizeDownload(); }
        catch (err) { console.error('finalize on close failed', err); }
      }
      resetProgress();
      break;
    case 0x01:
      upCredits++;
      log('onStat: credit +1 (total', upCredits, ')');
      showUploadProgress();
      break;
    case 0x00:
      log('onStat: OK/ACK', aux);
      break;
    default:
      log('STAT', code, aux);
  }
}

function wireUi() {
  hiddenRestoreInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('This will overwrite the current history on the device. Continue?')) return;
    try {
      await doRestoreFromFile(file);
    } catch (err) {
      console.error(err);
      alert('Restore failed: ' + err.message);
      resetUploadProgress();
    }
  });

  dom.restoreBtn?.addEventListener('click', () => {
    if (!consentOk || !connected) {
      alert('Connect first.');
      return;
    }
    hiddenRestoreInput.click();
  });

  dom.downloadBtn?.addEventListener('click', async () => {
    log('downloadBtn clicked', { connected, consentOk });
    if (!consentOk) {
      alert('Allow dashboard access on the device first.');
      return;
    }
    if (!connected) {
      if (!serverRef) {
        alert('Connect first.');
        return;
      }
      try {
        await attachHistoryFS(serverRef);
      } catch (err) {
        console.error('History attach failed', err);
        alert('Failed to bind history service: ' + err.message);
        return;
      }
    }
    downloadRawFile();
  });

  dom.bucketSel?.addEventListener('change', () => {
    setAnchorToNow(dom.bucketSel.value);
    renderChart();
  });
  dom.prevBtn?.addEventListener('click', () => {
    const mode = dom.bucketSel?.value || 'day';
    shiftAnchor(mode, -1);
    renderChart();
  });
  dom.nextBtn?.addEventListener('click', () => {
    const mode = dom.bucketSel?.value || 'day';
    shiftAnchor(mode, +1);
    renderChart();
  });
}

function bootDefaults() {
  resetList();
  resetProgress();
  resetUploadProgress();
  if (dom.parseSummary) dom.parseSummary.textContent = '';
  if (dom.fsInfo) dom.fsInfo.textContent = '';
  if (dom.bucketSel) dom.bucketSel.value = 'day';
  periodAnchor = startOfTodayUTC();
  renderLegend();
}

async function cleanupCharacteristics() {
  try { chInfo?.removeEventListener('characteristicvaluechanged', infoListener); } catch {}
  try { chData?.removeEventListener('characteristicvaluechanged', dataListener); } catch {}
  try { chStat?.removeEventListener('characteristicvaluechanged', statListener); } catch {}
  try { chInfo?.stopNotifications(); } catch {}
  try { chData?.stopNotifications(); } catch {}
  try { chStat?.stopNotifications(); } catch {}
}

export function initHistory() {
  wireUi();
  bootDefaults();
  setControlsEnabled(false);
}

export function applyHistoryI18n(dict) {
  if (!dict) return;
  if (dom.title && dict.title) dom.title.textContent = dict.title;
  if (dom.downloadBtn && dict.downloadRaw) dom.downloadBtn.textContent = dict.downloadRaw;
  if (dom.restoreBtn && dict.uploadRestore) dom.restoreBtn.textContent = dict.uploadRestore;
  if (dom.restoreLabel && dict.restoreLabel) dom.restoreLabel.textContent = dict.restoreLabel;
  if (dom.activityTitle && dict.activity) dom.activityTitle.textContent = dict.activity;
  if (dom.bucketLabel && dict.bucket) dom.bucketLabel.textContent = dict.bucket;
  //if (dom.prevBtn && dict.prev) dom.prevBtn.textContent = dict.prev;
  //if (dom.nextBtn && dict.next) dom.nextBtn.textContent = dict.next;
  if (dom.bucketSel && dict.bucketOptions) {
    const opts = dom.bucketSel.options;
    if (opts && opts.length >= 4) {
      if (dict.bucketOptions.day)   opts[0].textContent = dict.bucketOptions.day;
      if (dict.bucketOptions.week)  opts[1].textContent = dict.bucketOptions.week;
      if (dict.bucketOptions.month) opts[2].textContent = dict.bucketOptions.month;
      if (dict.bucketOptions.year)  opts[3].textContent = dict.bucketOptions.year;
    }
  }
  if (Array.isArray(dict.legendSets) && dict.legendSets.length >= 6) {
    legendSets = dict.legendSets.slice();
  }
  if (dict.legendIntent) legendIntentLabel = dict.legendIntent;
  if (Array.isArray(dict.legendRoman) && dict.legendRoman.length >= 5) {
    legendRoman = dict.legendRoman.slice();
  }
  // --- NEW: calendar labels override (month + weekday) ---
  // Accept either dict.calendar.monthShort/weekDow OR dict.monthShort/weekDow
  const cal = dict.calendar || dict;
  if (Array.isArray(cal?.monthShort) && cal.monthShort.length === 12) {
    MONTH_SHORT = cal.monthShort.slice();
  } else {
    MONTH_SHORT = [...MONTH_SHORT_DEFAULT];
  }
  if (Array.isArray(cal?.weekDow) && cal.weekDow.length === 7) {
    WEEK_DOW = cal.weekDow.slice();  // Monday-first expected
  } else {
    WEEK_DOW = [...WEEK_DOW_DEFAULT];
  }
  // ---
  renderLegend();
}

export function setHistoryConsent(ok) {
  consentOk = !!ok;
  setControlsEnabled(connected && consentOk);
}

export function primeHistoryServer(server) {
  serverRef = server;
}

export async function attachHistoryFS(server) {
  serverRef = server;

  try {
    log('attachHistoryFS: acquiring history service');
    const svc = await server.getPrimaryService(FS_SVC_UUID);
    chCtrl = await svc.getCharacteristic(FS_CTRL_UUID); log('attachHistoryFS: CTRL ready');
    chInfo = await svc.getCharacteristic(FS_INFO_UUID); log('attachHistoryFS: INFO ready');
    chData = await svc.getCharacteristic(FS_DATA_UUID); log('attachHistoryFS: DATA ready');
    chStat = await svc.getCharacteristic(FS_STAT_UUID); log('attachHistoryFS: STAT ready');

    infoListener = (ev) => onInfo(ev);
    dataListener = (ev) => onData(ev);
    statListener = (ev) => onStat(ev);

    const safeStart = async (char, name) => {
      try {
        await char.startNotifications();
        log(`attachHistoryFS: ${name} notifications started`);
        return true;
      } catch (err) {
        console.warn(`[history] ${name} startNotifications failed`, err?.message || err);
        return false;
      }
    };

    const infoNotifies = await safeStart(chInfo, 'INFO');
    const dataNotifies = await safeStart(chData, 'DATA');
    const statNotifies = await safeStart(chStat, 'STAT');
    if (!infoNotifies || !dataNotifies || !statNotifies) {
      log('attachHistoryFS: one or more notifications unavailable; proceeding with manual reads');
    }

    chInfo.addEventListener('characteristicvaluechanged', infoListener);
    chData.addEventListener('characteristicvaluechanged', dataListener);
    chStat.addEventListener('characteristicvaluechanged', statListener);

    connected = true;
    setControlsEnabled(consentOk && connected);
    log('attachHistoryFS: notifications started; consentOk=', consentOk);

    enqueue(async () => {
      try {
        log('attachHistoryFS: initial list/download');
        await doList();
        await openAndRead();
      } catch (e) {
        console.warn('Auto history fetch failed', e);
      }
    });

    enqueue(async () => {
      try { await sleep(200); } catch {}
      try {
        await setRtcNow();
      } catch (e) {
        console.warn('RTC sync failed', e);
      }
    });

  } catch (e) {
    log('attachHistoryFS: failed', e);
    connected = false;
    setControlsEnabled(false);
    await cleanupCharacteristics();
    chCtrl = chInfo = chData = chStat = null;
    throw e;
  }
}

export function applyHistoryTheme(mode) {
  historyPalette = resolveHistoryPalette(mode);

  if (histChart?.options?.scales) {
    const { scales } = histChart.options;
    if (scales.x) {
      if (!scales.x.ticks) scales.x.ticks = {};
      scales.x.ticks.color = historyPalette.axisTick;
      if (!scales.x.grid) scales.x.grid = {};
      scales.x.grid.color = historyPalette.axisGrid;
    }
    if (scales.y) {
      if (!scales.y.ticks) scales.y.ticks = {};
      scales.y.ticks.color = historyPalette.axisTick;
      if (!scales.y.grid) scales.y.grid = {};
      scales.y.grid.color = historyPalette.axisGrid;
    }
    histChart.update('none');
  }

  applyPaletteToLegendRows();
}

export async function resetHistory() {
  await cleanupCharacteristics();
  serverRef = null;
  chCtrl = chInfo = chData = chStat = null;
  connected = false;
  consentOk = false;
  queueChain = Promise.resolve();
  resetProgress();
  resetUploadProgress();
  setControlsEnabled(false);
  hiddenRestoreInput.value = '';
}

export function onHistoryDisconnected() {
  resetHistory().catch(() => {});
}

export function refreshHistory() {
  if (!connected || !consentOk) return Promise.resolve();
  log('refreshHistory: queued');
  return enqueue(async () => {
    log('refreshHistory: running');
    await doList();
    await openAndRead();
    log('refreshHistory: done');
  });
}
