// wallpaper.js — SPIFFS image explorer for SmartRosary (Wallpaper card)

// --- import i18n dictionary (ESM) ---
import { i18n } from './i18n.js';
import { downloadBlob, openFilePicker, loadImageSource, globalProgressStart, globalProgressSet, globalProgressDone } from './utils.js';

const log = (...args) => console.log('[wallpaper]', ...args);
const CANVAS_BG = '#2f3642';

let wpLang = 'en';
export function setWallpaperLang(code) {
  wpLang = (i18n && i18n[code]) ? code : 'en';
}
const WP = () => (i18n?.[wpLang]?.wp || i18n.en.wp);

function _applyStaticTexts() {
  if (ui.title)      ui.title.textContent      = WP().title || 'Wallpaper';
  if (ui.selectBtn)  ui.selectBtn.textContent  = WP().select || 'Select file…';
  if (ui.uploadBtn)  ui.uploadBtn.textContent  = WP().upload || 'Upload';
  if (ui.saveBinBtn) ui.saveBinBtn.textContent = WP().saveBin || 'Save .bin';
  if (ui.savePngBtn) ui.savePngBtn.textContent = WP().savePng || 'Save .png';
  if (ui.fullMsg)    ui.fullMsg.textContent    = WP().fullBanner || '🚫 Storage full (5/5) — delete one on the device first.';

  const thFile    = document.querySelector('#wpFilesPanel thead th.name');
  const thSize    = document.querySelector('#wpFilesPanel thead th.size');
  const thActions = document.querySelector('#wpFilesPanel thead th.actions');
  if (thFile)    thFile.textContent    = WP().thFile    || 'File';
  if (thSize)    thSize.textContent    = WP().thSize    || 'Size';
  if (thActions) thActions.textContent = WP().thActions || 'Actions';

  if (ui.presetSelect) {
    ui.presetSelect.title = WP().presetTitle || 'Choose a preset';
   // Only update existing placeholder; do NOT create here
   const ph = ui.presetSelect.querySelector('option[data-placeholder], option[value=""]');
   if (ph) ph.textContent = WP().presetPlaceholder || '— Preset —';
  }
}


// Small helpers for localized strings
export function applyWallpaperI18n() {
  const w = WP();
  if (ui.title)      ui.title.textContent      = w.title;
  if (ui.selectBtn)  ui.selectBtn.textContent  = w.select;
  if (ui.uploadBtn)  ui.uploadBtn.textContent  = w.upload;
  if (ui.saveBinBtn) ui.saveBinBtn.textContent = w.saveBin;
  if (ui.savePngBtn) ui.savePngBtn.textContent = w.savePng;
  if (ui.fullMsg)    ui.fullMsg.textContent    = w.fullBanner;

  // Table headers
  const thFile    = document.querySelector('#wpFilesPanel thead th.name');
  const thSize    = document.querySelector('#wpFilesPanel thead th.size');
  const thActions = document.querySelector('#wpFilesPanel thead th.actions');
  if (thFile)    thFile.textContent    = w.thFile;
  if (thSize)    thSize.textContent    = w.thSize;
  if (thActions) thActions.textContent = w.thActions;

  // Preset select placeholder
  if (ui.presetSelect) {
    ui.presetSelect.title = w.presetTitle;
    const ph = ui.presetSelect.querySelector('option[data-placeholder], option[value=""]');
    if (ph) ph.textContent = w.presetPlaceholder;
  }
}

// ==== SPIFFS UUIDs (do not clash with existing OTA UUIDs) ====
const FS_SVC_UUID  = "12345678-1234-5678-1234-56789abcf000";
const FS_CTRL_UUID = "12345678-1234-5678-1234-56789abcf001";
const FS_INFO_UUID = "12345678-1234-5678-1234-56789abcf002";
const FS_DATA_UUID = "12345678-1234-5678-1234-56789abcf003";
const FS_STAT_UUID = "12345678-1234-5678-1234-56789abcf004";

const TAG_LIST = 0xE0;   // ... 0xE1 (chunked listing)
const TAG_DATA = 0x90;   // ... 0x91 (read/write data)

const MAX_IMAGES = 5;
const TARGET_W = 240, TARGET_H = 240;

// Adaptive upload/read controls
const CHUNK_MAX = 200;         // your previous cap
const CHUNK_MIN = 40;          // conservative floor
const CHUNK_STEP_UP = 16;      // how we ramp back up
const CREDIT_STALL_MS = 2000;  // backoff if no credits for this long
const PROGRESS_HARD_TIMEOUT_MS = 30000; // abort if no progress this long

let lastCreditTs = 0;
let lastProgressTs = 0;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const ui = {
  // header + state
  title: $('wpTitle'),
  listBtn: $('wpListBtn'),
  conn: $('wpConn'),

  // file table
  filesPanel: $('wpFilesPanel'),
  filesBody: $('wpFiles'),

  // canvas + progress
  canvas: $('wpCanvas'),
  prog: $('wpProg'),
  progText: $('wpProgText'),

  // actions
  selectBtn: $('wpSelectBtn'),     // open picker
  uploadBtn: $('wpUploadBtn'),     // Upload staged buffer
  fileInput: $('wpFileInput'),

  // optional preset select (safe if missing)
  presetSelect: $('wpPresetSelect'),

  // downloads (optional, after READ)
  saveBinBtn: $('wpSaveBinBtn'),
  savePngBtn: $('wpSavePngBtn'),

  fullMsg:       $('wpFullMsg'),       // 🚫 5/5 banner
  presetSelect:  $('wpPresetSelect'),  // optional dropdown
};



// ---------- State ----------
let serverRef = null;
let fsCtrl=null, fsInfo=null, fsData=null, fsStat=null;
let fsCredits = 0;
let fsLastError = null; // latest FS error from status stream
let fsBindPromise = null;

let consent = false;
let connected = false;

let files = [];
let lastShownName = null; // normalized "/name.bin" last "show" sent to device

// staged upload (selected by user but not auto-uploaded)
let staged = { type:null, name:null, bytes:null, w:0, h:0, pixelOffset:4, fromCanvas:false };

let dlBlob = null;     // for Save .bin after read

// visible view context + offscreen work canvas
let viewCtx = null;
let workCanvas = null, workCtx = null;

// read-in-progress
let readState = null;

// busy flags so idle status packets don't hide progress mid-transfer
const busy = { uploading:false, reading:false };

// ---------- Utils ----------

function _canDelete() {
  return Array.isArray(files) && files.length > 1;
}

const _norm = (s) => (s && s.startsWith('/') ? s : '/' + s);
const _toKiB = (n) => (n/1024).toFixed(1)+' KiB';
const _sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function _cleanName(name) {
  let base = (name||'image').replace(/^.*[\\/]/,'').replace(/\s+/g,'');
  if (!/\.(bin|rgb565|565|raw)$/i.test(base)) base = base.replace(/\.[^.]*$/,'') + '.bin';
  return base;
}
function _clip16Bin(name) {
  const ext = '.bin';
  let stem = (name||'image').replace(/\.[^.]*$/,'');
  if (stem.length > 16 - ext.length) stem = stem.slice(0, 16 - ext.length);
  return stem + ext;
}
function _crc32(bytes){
  let crc = 0xFFFFFFFF>>>0;
  for (let i=0;i<bytes.length;i++){
    crc ^= bytes[i];
    for (let j=0;j<8;j++) crc = (crc>>>1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (~crc)>>>0;
}

// ---------- Progress helpers ----------
function _hideProgress() {
    if (ui.prog) ui.prog.value = 0;
    if (ui.progText) ui.progText.textContent = '';
    const wrap = document.querySelector('#wpCard .wp-progress');
    if (wrap) wrap.style.display = 'none';
    try { globalProgressDone(400); } catch {}
}

function _showProgress(max, label) {
  if (ui.prog) {
    ui.prog.max = max;
    ui.prog.value = 0;
  }
  if (ui.progText) ui.progText.textContent = label || '';

  const wrap = document.querySelector('#wpCard .wp-progress');
  if (wrap) wrap.style.display = 'flex';   // flex column per CSS
  try { globalProgressStart(label || 'Working…', 100); } catch {}
}

// ---------- Muted handling ----------
function _updateMuted(){
  const card = document.getElementById('wpCard');
  if (!card) return;
  const muted = !(connected && consent);
  card.classList.toggle('wp-muted', muted);
  if (!muted) {
    card.style.opacity = '1';
    card.style.filter = 'none';
  }
}

// ---------- Public hooks (ES module) ----------
export function setWallpaperConsent(ok) {
  consent = !!ok;
  _updateMuted();
  _uiEnable(connected && consent);
  if (connected && consent) _list();
}

export async function attachWallpaperFS(server) {
  serverRef = server;
  await _initCanvas();
  _hideProgress(); // ensure hidden on load

  try {
    log('attachWallpaperFS: acquiring filesystem service');
    const fss = await server.getPrimaryService(FS_SVC_UUID);
    fsCtrl = await fss.getCharacteristic(FS_CTRL_UUID); log('attachWallpaperFS: CTRL ready');
    fsInfo = await fss.getCharacteristic(FS_INFO_UUID); log('attachWallpaperFS: INFO ready');
    fsData = await fss.getCharacteristic(FS_DATA_UUID); log('attachWallpaperFS: DATA ready');
    fsStat = await fss.getCharacteristic(FS_STAT_UUID); log('attachWallpaperFS: STAT ready');

    const safeStart = async (char, name) => {
      try {
        await char.startNotifications();
        log(`attachWallpaperFS: ${name} notifications started`);
        return true;
      } catch (err) {
        console.warn(`[wallpaper] ${name} startNotifications failed`, err?.message || err);
        return false;
      }
    };

    const infoNotifies = await safeStart(fsInfo, 'INFO');
    const dataNotifies = await safeStart(fsData, 'DATA');
    const statNotifies = await safeStart(fsStat, 'STAT');
    if (!infoNotifies || !dataNotifies || !statNotifies) {
      log('attachWallpaperFS: proceeding despite notification errors');
    }

    fsInfo.addEventListener('characteristicvaluechanged', _onFsInfo);
    fsData.addEventListener('characteristicvaluechanged', _onFsData);
    fsStat.addEventListener('characteristicvaluechanged', _onFsStat);

    connected = true;
    _updateMuted();
    _uiEnable(connected && consent);
    log('attachWallpaperFS: ready', { consent });


    if (connected && consent) {
      _list().catch((err) => console.warn('Wallpaper list failed', err));
    }
  } catch (e) {
    connected = false;
    _updateMuted();
    _uiEnable(false);
    log('attachWallpaperFS: failed', e);
    throw e;
  }
}

export function resetWallpaperFS() {
  connected = false;
  fsCtrl=fsInfo=fsData=fsStat=null;
  fsLastError = null;
  fsBindPromise = null;
  _resetUrls();
  _clearPreview();
  _uiEnable(false);
  _updateMuted();
  _hideProgress();
}

function _isInvalidCharError(err) {
  if (!err) return false;
  if (err.name === 'InvalidStateError') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('no longer valid') || msg.includes('gatt characteristic');
}

function _detachFsListeners() {
  try { fsInfo?.removeEventListener('characteristicvaluechanged', _onFsInfo); } catch {}
  try { fsData?.removeEventListener('characteristicvaluechanged', _onFsData); } catch {}
  try { fsStat?.removeEventListener('characteristicvaluechanged', _onFsStat); } catch {}
  try { fsInfo?.stopNotifications?.(); } catch {}
  try { fsData?.stopNotifications?.(); } catch {}
  try { fsStat?.stopNotifications?.(); } catch {}
}

async function _rebindFsService() {
  if (!serverRef) throw new Error('Wallpaper FS server not attached');
  if (fsBindPromise) return fsBindPromise;

  fsBindPromise = (async () => {
    _detachFsListeners();
    fsCtrl = fsInfo = fsData = fsStat = null;

    const svc = await serverRef.getPrimaryService(FS_SVC_UUID);
    const ctrl = await svc.getCharacteristic(FS_CTRL_UUID);
    const info = await svc.getCharacteristic(FS_INFO_UUID);
    const data = await svc.getCharacteristic(FS_DATA_UUID);
    const stat = await svc.getCharacteristic(FS_STAT_UUID);

    const safeStart = async (char, name) => {
      try {
        await char.startNotifications();
        log(`_rebindFsService: ${name} notifications started`);
        return true;
      } catch (err) {
        console.warn(`[wallpaper] rebind ${name} startNotifications failed`, err?.message || err);
        return false;
      }
    };

    await safeStart(info, 'INFO');
    await safeStart(data, 'DATA');
    await safeStart(stat, 'STAT');

    info.addEventListener('characteristicvaluechanged', _onFsInfo);
    data.addEventListener('characteristicvaluechanged', _onFsData);
    stat.addEventListener('characteristicvaluechanged', _onFsStat);

    fsCtrl = ctrl;
    fsInfo = info;
    fsData = data;
    fsStat = stat;

    connected = true;
    fsLastError = null;
    fsCredits = 0;
    lastCreditTs = performance.now();
    lastProgressTs = performance.now();
    _updateMuted();
    _uiEnable(connected && consent);
  })();

  try {
    await fsBindPromise;
  } finally {
    fsBindPromise = null;
  }
}

function _isFsActive() {
  try {
    const dev = fsCtrl?.service?.device;
    return !!(dev && dev.gatt && dev.gatt.connected);
  } catch {
    return connected;
  }
}

async function _ensureFsService() {
  if (!fsCtrl || !_isFsActive()) {
    connected = false;
    await _rebindFsService();
  }
}

async function _writeFs(buf) {
  await _ensureFsService();
  try {
    await fsCtrl.writeValue(buf);
  } catch (err) {
    if (_isInvalidCharError(err)) {
      connected = false;
      await _rebindFsService();
      await fsCtrl.writeValue(buf);
      return;
    }
    throw err;
  }
}

// ---------- UI wiring ----------
ui.selectBtn?.addEventListener('click', () => {
  if (!ui.fileInput) return;
  openFilePicker(ui.fileInput);
});

ui.fileInput?.addEventListener('change', async (e) => {

  if (Array.isArray(files) && files.length >= MAX_IMAGES) {
    // Reflect lock purely in UI; no alert needed
    if (ui.fullMsg) ui.fullMsg.style.display = 'block';
    if (ui.uploadBtn) ui.uploadBtn.disabled = true;
    e.target.value = '';
    return;
  }

  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;

  // preview only; do not upload yet
  log('file selected', { name: f.name, type: f.type, size: f.size });
  if (/^image\/(png|jpe?g|webp)$/i.test(f.type) || /\.(png|jpe?g|jpg|webp)$/i.test(f.name)) {
    const imgSource = await loadImageSource(f);
    await _drawToCanvasCover(imgSource);
    staged = { type:'canvas', name:f.name, bytes:null, w:TARGET_W, h:TARGET_H, pixelOffset:4, fromCanvas:true };
  } else if (/\.(bin|rgb565|565|raw)$/i.test(f.name) || /octet-stream/.test(f.type)) {
    const buf = new Uint8Array(await f.arrayBuffer());
    const det = _detectFormat(buf, f.name);
    await _previewRaw(buf, det.w, det.h, det.offset);
    staged = { type:'raw', name:f.name, bytes:buf, w:det.w, h:det.h, pixelOffset:det.offset, fromCanvas:false };
  } else {
    alert(WP().unsupportedFile || 'Unsupported file. Use PNG/JPEG/WebP or RGB565 .bin/.raw.');
    return;
  }

  // enable Upload only when staged and space available & permitted
  if (ui.uploadBtn) ui.uploadBtn.disabled = !(connected && consent) || _isFull();
});

ui.uploadBtn?.addEventListener('click', async () => {
  if (!staged || !staged.type) { alert(WP().select || 'Select file…'); return; }
  if (!connected || !consent) { alert(WP().connectFirst || 'Connect and allow on device first.'); return; }
  if (_isFull()) { alert(WP().fullShort || 'Storage full (5/5). Delete one first.'); return; }

  try {
    log('upload click', { staged });
    if (staged.fromCanvas) {
      await _uploadFromCanvas(staged.name || 'image.bin');
    } else {
      const fname = _clip16Bin(_cleanName(staged.name || 'image.bin'));
      await _uploadBytes(staged.bytes, fname, staged.w, staged.h, staged.pixelOffset);
    }

    _clearStaged();
    if (ui.uploadBtn) ui.uploadBtn.disabled = true;
  } catch (err) {
    console.error('Wallpaper upload failed', err);
    const msg = err?.message || WP().uploadFailed || 'Upload failed.';
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = msg;
    if (ui.prog) ui.prog.style.display = 'none';
    if (ui.progText) ui.progText.textContent = msg;
    if (ui.uploadBtn) ui.uploadBtn.disabled = false;
  }
});

// optional manual list refresh (if you keep a button)
ui.listBtn?.addEventListener('click', () => _list());

// ---------- Small helpers ----------
function _isFull(){ return Array.isArray(files) && files.length >= MAX_IMAGES; }

function _uiEnable(ok) {
  log('_uiEnable', { ok, connected, consent, staged: !!staged?.type, full: _isFull() });
  if (ui.listBtn)    ui.listBtn.disabled = !ok; // safe
  if (ui.uploadBtn)  ui.uploadBtn.disabled = !ok || !staged.type || _isFull();
  if (ui.conn)       ui.conn.textContent = ok ? 'Connected' : (WP().connectFirst || 'Connect first to enable');
  // Keep table header visible always
  if (ui.filesPanel) ui.filesPanel.style.display = 'block';
}

// ---------- Canvas setup & drawing ----------
async function _initCanvas() {
  if (viewCtx) return;

  log('_initCanvas');
  // visible
  const dpr = window.devicePixelRatio || 1;
  const cssW = ui.canvas.clientWidth || ui.canvas.width;
  const cssH = ui.canvas.clientHeight || ui.canvas.height;
  ui.canvas.width  = Math.round(cssW * dpr);
  ui.canvas.height = Math.round(cssH * dpr);
  viewCtx = ui.canvas.getContext('2d', { alpha:false });
  viewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  viewCtx.imageSmoothingEnabled = true;
  try {
    viewCtx.save();
    viewCtx.fillStyle = CANVAS_BG;
    viewCtx.fillRect(0,0,ui.canvas.clientWidth, ui.canvas.clientHeight);
    viewCtx.restore();
  } catch {}

  // work
  workCanvas = document.createElement('canvas');
  workCanvas.width = TARGET_W; workCanvas.height = TARGET_H;
  workCtx = workCanvas.getContext('2d', { alpha:false, willReadFrequently:true });
  try {
    workCtx.save();
    workCtx.fillStyle = CANVAS_BG;
    workCtx.fillRect(0,0,workCanvas.width, workCanvas.height);
    workCtx.restore();
  } catch {}

  window.addEventListener('resize', () => {
    const dpr2 = window.devicePixelRatio || 1;
    const cssW2 = ui.canvas.clientWidth || ui.canvas.width;
    const cssH2 = ui.canvas.clientHeight || ui.canvas.height;
    ui.canvas.width  = Math.round(cssW2 * dpr2);
    ui.canvas.height = Math.round(cssH2 * dpr2);
    viewCtx = ui.canvas.getContext('2d', { alpha:false });
    viewCtx.setTransform(dpr2, 0, 0, dpr2, 0, 0);
    viewCtx.imageSmoothingEnabled = true;
    try {
      viewCtx.save();
      viewCtx.fillStyle = CANVAS_BG;
      viewCtx.fillRect(0,0,ui.canvas.clientWidth, ui.canvas.clientHeight);
      viewCtx.restore();
    } catch {}
    _blit();
  });
}

function _blit() {
  if (!viewCtx) return;
  try {
    viewCtx.save();
    viewCtx.fillStyle = CANVAS_BG;
    viewCtx.fillRect(0,0,ui.canvas.clientWidth, ui.canvas.clientHeight);
    viewCtx.restore();
  } catch {
    viewCtx.clearRect(0,0,ui.canvas.clientWidth, ui.canvas.clientHeight);
  }
  viewCtx.drawImage(
    workCanvas, 0,0, workCanvas.width, workCanvas.height,
    0,0, ui.canvas.clientWidth, ui.canvas.clientHeight
  );
}

function _clearPreview() {
  if (!workCtx) return;
  workCtx.save();
  workCtx.fillStyle = CANVAS_BG;
  workCtx.fillRect(0,0,workCanvas.width, workCanvas.height);
  workCtx.restore();
  _blit();
}

async function _drawToCanvasCover(bmp) {
  workCanvas.width = TARGET_W; workCanvas.height = TARGET_H;
  const srcW = bmp.width || bmp.naturalWidth || bmp.videoWidth;
  const srcH = bmp.height || bmp.naturalHeight || bmp.videoHeight;
  if (!srcW || !srcH) throw new Error('Invalid image dimensions');
  const s = Math.max(TARGET_W / srcW, TARGET_H / srcH);
  const dw = Math.round(srcW * s), dh = Math.round(srcH * s);
  const dx = Math.round((TARGET_W - dw)/2), dy = Math.round((TARGET_H - dh)/2);
  workCtx.save();
  workCtx.fillStyle = CANVAS_BG;
  workCtx.fillRect(0,0,TARGET_W,TARGET_H);
  workCtx.restore();
  workCtx.drawImage(bmp, dx, dy, dw, dh);
  _blit();
  try { bmp.close(); } catch {}
}

// ---------- Progress overlay on view canvas ----------
function _workYtoViewY(y) {
  return y * (ui.canvas.clientHeight / workCanvas.height);
}
function _drawBadge(edgeYWork, pct, redrawBase) {
  if (redrawBase) redrawBase();
  const ctx = viewCtx;
  const y = Math.min(ui.canvas.clientHeight - 12, Math.max(14, _workYtoViewY(edgeYWork)));
  const label = `${Math.round(pct)}%`;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = Math.max(16, Math.floor(ui.canvas.clientHeight * 0.08)) + "px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.strokeText(label, ui.canvas.clientWidth/2, y);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, ui.canvas.clientWidth/2, y);
  ctx.restore();
}
function _fadeBadge(edgeYWork, redrawBase){
  const D = 650; const t0 = performance.now();
  function frame(now){
    const tt = Math.min(1, (now - t0) / D);
    const a = 1 - tt;
    if (redrawBase) redrawBase();
    const ctx = viewCtx;
    const y = Math.max(14, _workYtoViewY(edgeYWork) - 12);
    const label = "100%";
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = Math.max(16, Math.floor(ui.canvas.clientHeight * 0.08)) + "px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.strokeText(label, ui.canvas.clientWidth/2, y);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, ui.canvas.clientWidth/2, y);
    ctx.restore();
    if (tt < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------- Format detect/preview for raw/bin ----------
function _detectLvglHeader(bytes){
  if (bytes.length < 4) return null;
  const v  =  bytes[0] | (bytes[1]<<8) | (bytes[2]<<16) | (bytes[3]<<24);
  const cf =  v & 0xFF;
  const w4 = (v >> 8)  & 0xFFF;
  const h2 = (v >> 20) & 0xFFF;
  if (cf !== 4) return null;
  const w = w4 / 4;
  const h = h2 / 2;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w<=0 || h<=0) return null;
  if (bytes.length !== 4 + w*h*2) return null;
  return { w, h, offset: 4, bigEndian: true };
}
function _detectFormat(bytes, nameHint) {
  const lv = _detectLvglHeader(bytes);
  if (lv) return lv;

  let w=0,h=0;
  const m = /_(\d+)x(\d+)\./.exec(nameHint||'');
  if (m) { w=parseInt(m[1],10)||0; h=parseInt(m[2],10)||0; }
  if (w&&h && bytes.length === w*h*2) return { w, h, offset:0, bigEndian:true };

  if ((bytes.length % 2) === 0) {
    const px = bytes.length/2;
    const s = Math.round(Math.sqrt(px));
    if (s*s === px) return { w:s, h:s, offset:0, bigEndian:true };
  }
  return { w:TARGET_W, h:TARGET_H, offset:0, bigEndian:true };
}
function _drawRowsRGB565(bytes, w, h, img, startRow, rowCount, {offset=0, bigEndian=true}={}){
  const rgba = img.data;
  let siBase = offset + startRow*w*2;
  let diBase = startRow*w*4;
  for (let r=0; r<rowCount; r++) {
    let si = siBase + r*w*2;
    let di = diBase + r*w*4;
    for (let x=0; x<w; x++) {
      const b0 = bytes[si++], b1 = bytes[si++];
      const v  = bigEndian ? ((b0<<8) | b1) : (b0 | (b1<<8));
      const R5=(v>>11)&31, G6=(v>>5)&63, B5=v&31;
      rgba[di++] = (R5*255/31)|0;
      rgba[di++] = (G6*255/63)|0;
      rgba[di++] = (B5*255/31)|0;
      rgba[di++] = 255;
    }
  }
}
async function _previewRaw(buf, w, h, offset){
  workCanvas.width = w; workCanvas.height = h;
  const img = workCtx.createImageData(w,h);
  _drawRowsRGB565(buf, w, h, img, 0, h, { offset, bigEndian:true });
  workCtx.putImageData(img, 0, 0);
  _blit();
}

// ---------- Conversions ----------
function _canvasToLVGL(cf=4){
  const W = workCanvas.width, H = workCanvas.height;
  const img = workCtx.getImageData(0,0,W,H).data;
  const out = new Uint8Array(4 + W*H*2);
  const headerVal = (cf & 0xFF) | ((W * 4) << 8) | ((H * 2) << 20);
  out[0]= headerVal & 0xFF;
  out[1]=(headerVal>>8) & 0xFF;
  out[2]=(headerVal>>16)& 0xFF;
  out[3]=(headerVal>>24)& 0xFF;
  let di=4;
  for (let i=0;i<img.length;i+=4){
    const r=img[i], g=img[i+1], b=img[i+2];
    const v = ((r*31/255)&31)<<11 | ((g*63/255)&63)<<5 | ((b*31/255)&31);
    out[di++] = (v>>8)&0xFF; out[di++] = v & 0xFF;
  }
  return out;
}

// ---------- FS ops ----------
async function _list() {
  log('_list', { connected, consent });
  if (!connected || !consent) return;
  // FS_LS_BEGIN path="/" pattern=""
  await _writeFs(new Uint8Array([0x10, 0x01, 0x00, '/'.charCodeAt(0)]));
  if (!busy.uploading && !busy.reading) _hideProgress();
}
async function _listAfter(ms=300){ await _sleep(ms); await _list(); }

async function _read(name) {
  _resetUrls(); _clearPreview();
  const enc = new TextEncoder();
  const nm = enc.encode(name.startsWith('/')? name : '/'+name);
  const buf = new Uint8Array(2 + nm.length);
  buf[0]=0x11; buf[1]=nm.length; buf.set(nm,2);
  await _writeFs(buf);
  readState = { name, header:false, size:0, off:0, w:0, h:0, offset:4, rowsDrawn:0, bigEndian:true, buf:null };
}
async function _show(name) {
  const enc = new TextEncoder();
  const nm = enc.encode(name.startsWith('/')? name : '/'+name);
  const buf = new Uint8Array(2 + nm.length);
  buf[0]=0x40; buf[1]=nm.length; buf.set(nm,2);
  await _writeFs(buf);
  lastShownName = _norm(name);
}
async function _delete(name) {
  const enc = new TextEncoder();
  const nm = enc.encode(name.startsWith('/')? name : '/'+name);
  const buf = new Uint8Array(2 + nm.length);
  buf[0]=0x30; buf[1]=nm.length; buf.set(nm,2);
  await _writeFs(buf);
}
async function _rename(from, to) {
  const enc = new TextEncoder();
  const a = enc.encode(from.startsWith('/')? from : '/'+from);
  const b = enc.encode(to  .startsWith('/')? to   : '/'+to);
  const buf = new Uint8Array(3 + a.length + b.length);
  buf[0]=0x31; buf[1]=a.length; buf[2]=b.length; buf.set(a,3); buf.set(b,3+a.length);
  await _writeFs(buf);
}

// ---------- Uploads ----------
async function _uploadFromCanvas(nameHint) {
  const bytes = _canvasToLVGL();
  await _uploadBytes(bytes, _clip16Bin(_cleanName(nameHint||'image.bin')), workCanvas.width, workCanvas.height, 4);
}
async function _uploadBytes(bytes, filename, w, h, pixelOffset = 4) {
  busy.uploading = true;

  try {
    if (typeof preventStandby === 'function') preventStandby();

    fsLastError = null;

    // --- WRITE_BEGIN header ---
    const enc = new TextEncoder();
    const nm  = enc.encode(filename);
    const sz  = bytes.length >>> 0;

    const hdr = new Uint8Array(1 + 1 + 2 + 2 + 4 + nm.length);
    hdr[0] = 0x20;              // WRITE_BEGIN
    hdr[1] = nm.length;
    hdr[2] =  w & 0xFF;
    hdr[3] = (w >> 8) & 0xFF;
    hdr[4] =  h & 0xFF;
    hdr[5] = (h >> 8) & 0xFF;
    hdr[6] =  sz        & 0xFF;
    hdr[7] = (sz >>  8) & 0xFF;
    hdr[8] = (sz >> 16) & 0xFF;
    hdr[9] = (sz >> 24) & 0xFF;
    hdr.set(nm, 10);

    await _writeFs(hdr);

    // --- Fresh credit state every upload ---
    fsCredits = 0;
    lastCreditTs   = performance.now();
    lastProgressTs = performance.now();

    _throwIfFsError();

    // --- Wait explicitly for the first credit (fixes "stuck at ~0.5 KiB") ---
    while (fsCredits <= 0) {
      _throwIfFsError();
      const now = performance.now();
      if (now - lastCreditTs > CREDIT_STALL_MS) {
        // just nudge the timestamp; device will emit 0x01 when ready
        lastCreditTs = now;
      }
      if (now - lastProgressTs > PROGRESS_HARD_TIMEOUT_MS) {
        throw new Error('Upload timed out waiting for initial credit');
      }
      await _sleep(10);
      _throwIfFsError();
    }

    // --- Chunk sizing (BLE 517 MTU typical, but cap to CHUNK_MAX) ---
    const mtu = 517;
    let payload  = (mtu >= 23) ? (mtu - 3) : 20;  // ATT header
    let baseChunk = payload - 1 /*tag*/ - 4 /*CRC*/;
    let dynChunk  = Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, baseChunk));

    // --- Progress UI / overlay ---
    _showProgress(sz, WP().uploading || 'Uploading…');

    const rowBytes = w * 2;
    let   sent     = 0;

    const redrawBase = () => {
      const avail = Math.max(0, sent - pixelOffset);
      const rows  = Math.min(h, Math.floor(avail / rowBytes));
      _blit();
      viewCtx.save();
      viewCtx.fillStyle = 'rgba(0,0,0,0.35)';
      const yv = _workYtoViewY(rows);
      viewCtx.fillRect(0, yv, ui.canvas.clientWidth, ui.canvas.clientHeight - yv);
      viewCtx.restore();
      return rows;
    };

    // 0% badge
    let rowsRevealed = redrawBase();
    _drawBadge(rowsRevealed, 0, redrawBase);

    // --- Send chunks ---
    for (let off = 0; off < sz; ) {
      _throwIfFsError();

      // credit gate
      while (fsCredits <= 0) {
        _throwIfFsError();
        const now = performance.now();
        if (now - lastCreditTs > CREDIT_STALL_MS) {
          dynChunk = Math.max(CHUNK_MIN, (dynChunk / 2) | 0); // backoff
          lastCreditTs = now;
        }
        if (now - lastProgressTs > PROGRESS_HARD_TIMEOUT_MS) {
          throw new Error('Upload timed out: no progress from device');
        }
        await _sleep(10);
        _throwIfFsError();
      }
      fsCredits--;

      const n     = Math.min(dynChunk, sz - off);
      const slice = bytes.subarray(off, off + n);
      const c     = _crc32(slice);

      const pkt = new Uint8Array(1 + n + 4);
      pkt[0] = 0x21;            // WRITE_DATA
      pkt.set(slice, 1);
      pkt[1 + n] =  c        & 0xFF;
      pkt[2 + n] = (c >>  8) & 0xFF;
      pkt[3 + n] = (c >> 16) & 0xFF;
      pkt[4 + n] = (c >> 24) & 0xFF;

      // write with small retry
      let wrote = false, tries = 0;
      while (!wrote && tries < 3) {
        try {
          await _writeFs(pkt);
          wrote = true;
        } catch (err) {
          tries++;
          await _sleep(20);
          if (tries >= 3) throw err;
        }
      }

      _throwIfFsError();

      off  += n;
      sent  = off;
      lastProgressTs = performance.now();

      if (ui.prog) ui.prog.value = off;
      try {
        const pct = Math.floor((off * 100) / sz);
        globalProgressSet(pct, WP().uploading || 'Uploading…');
      } catch {}
      if (ui.progText) {
        const doneKiB  = off / 1024;
        const totalKiB = sz  / 1024;
        ui.progText.textContent =
          (WP().kib ? WP().kib(doneKiB, totalKiB)
                    : `${doneKiB.toFixed(1)} KiB / ${totalKiB.toFixed(1)} KiB`);
      }

      const pct = (sent * 100) / sz;
      rowsRevealed = redrawBase();
      _drawBadge(rowsRevealed, pct, redrawBase);

      // gentle ramp-up if credits flowing quickly
      if (performance.now() - lastCreditTs < 300) {
        dynChunk = Math.min(CHUNK_MAX, dynChunk + CHUNK_STEP_UP);
      }
    }

    // try a CLOSE/flush (0x22); ignore errors
    try { await _writeFs(new Uint8Array([0x22])); } catch {}

    // finish visuals
    _blit();
    _fadeBadge(h, _blit);
    _hideProgress();
    try { globalProgressDone(600); } catch {}

    // show on device and refresh list
    await _sleep(120);
    await _show(filename);
    await _listAfter(300);

  } finally {
    busy.uploading = false;
    if (typeof releaseWakeLock === 'function') releaseWakeLock();
  }
}

// ---------- FS notifications ----------
function _fsStatusMessage(code) {
  const hex = code.toString(16).padStart(2, '0');
  const w = WP();
  switch (code) {
    case 0xE9: return w.errNoFs || 'Wallpaper storage unavailable on device.';
    case 0xF1: return w.errRead || 'Failed to open file on device.';
    case 0xF2: return w.errCreate || 'Failed to create file on device.';
    case 0xF3: return w.errSession || 'Upload session is not active. Try again.';
    case 0xC3: return w.errCrc || 'Device rejected chunk (CRC mismatch).';
    case 0xF4: return w.errWrite || 'Device write failed (check free space).';
    case 0xF5: return w.errDelete || 'Delete failed on device.';
    case 0xF6: return w.errRename || 'Rename failed on device.';
    case 0xFE: return w.errUnknown ? (typeof w.errUnknown === 'function' ? w.errUnknown(`0x${hex}`) : w.errUnknown) : `Device reported error (0x${hex}).`;
    default:
      if (code >= 0x80) {
        if (typeof w.errUnknown === 'function') return w.errUnknown(`0x${hex}`);
        return w.errUnknown || `Device reported error (0x${hex}).`;
      }
      return '';
  }
}

function _recordFsError(code, aux) {
  const previous = fsLastError?.code;
  const message = _fsStatusMessage(code) || `Device reported error (0x${code.toString(16)})`;
  fsLastError = { code, aux, message };
  console.warn('[WallpaperFS] status 0x' + code.toString(16) + ' aux=' + aux);
  if (ui.prog) ui.prog.style.display = 'none';
  if (ui.progText) ui.progText.textContent = message;
  const statusEl = document.getElementById('status');
  if (statusEl && message) statusEl.textContent = message;
  if (previous !== code) console.error(message);
}

function _throwIfFsError() {
  if (!fsLastError) return;
  const err = fsLastError;
  fsLastError = null;
  throw new Error(err.message || `Device error (0x${err.code.toString(16)})`);
}

function _onFsStat(e){
  const dv = e.target.value;
 // Device may pack multiple bytes; count all 0x01 credits.
 let added = 0;
 for (let i = 0; i < dv.byteLength; i++) {
   const code = dv.getUint8(i);
   if (code === 0x01) {
     fsCredits++;
     added++;
   } else if (code === 0x00) {
     if (!busy.uploading && !busy.reading) _hideProgress();
   }
 }
 if (added) lastCreditTs = performance.now();
}
let listChunks = [];
function _onFsInfo(e){
  const dv = e.target.value;
  log('_onFsInfo', { len: dv.byteLength, first: dv.getUint8(0) });

  // READ header
  if (dv.byteLength === 10 && dv.getUint8(0) === 0x11) {
    busy.reading = true;
    readState = {
      name: (readState?.name)||'',
      header:true,
      w: dv.getUint16(1, true),
      h: dv.getUint16(3, true),
      size: dv.getUint32(6, true),
      off: 0, rowsDrawn: 0, offset: 4, bigEndian:true, buf:null
    };
    workCanvas.width = readState.w; workCanvas.height = readState.h;

    const needRaw = readState.w * readState.h * 2;
    if (readState.size === needRaw) readState.offset = 0; // raw without LVGL header

    _blit();
    _showProgress(readState.size, WP().receiving || 'Receiving…');
    try { globalProgressStart(WP().receiving || 'Receiving…', 100); } catch {}

    // draw 0% overlay
    const redrawBase0 = () => {
      _blit();
      viewCtx.save();
      viewCtx.fillStyle = "rgba(0,0,0,0.35)";
      const yv = _workYtoViewY(0);
      viewCtx.fillRect(0, yv, ui.canvas.clientWidth, ui.canvas.clientHeight - yv);
      viewCtx.restore();
    };
    _drawBadge(0, 0, redrawBase0);
    return;
  }

  // Plain JSON listing
  const b0 = dv.getUint8(0);
  if (b0 === 0x7B /* '{' */) {
    try {
      const txt = new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      log('_onFsInfo plain JSON', txt);
      const obj = JSON.parse(txt);
      if (obj && Array.isArray(obj.files)) {
        _renderList(obj);
      } else {
        log('_onFsInfo ignoring JSON without files[]');
      }
    } catch(e){ console.warn('List parse error', e); }
    return;
  }

  // Chunked listing
  const tag = b0, last = (tag & 1) === 1;
  if ((tag & 0xFE) === TAG_LIST) {
    log('_onFsInfo chunked', { tag, last, len: dv.byteLength });
    const chunk = new Uint8Array(dv.buffer, dv.byteOffset+1, dv.byteLength-1);
    listChunks.push(chunk);
    if (last) {
      const totalLen = listChunks.reduce((a,c)=>a+c.length,0);
      const total = new Uint8Array(totalLen);
      let off=0; for (const c of listChunks){ total.set(c,off); off+=c.length; }
      listChunks = [];
      try {
        const txt = new TextDecoder().decode(total);
        _renderList(JSON.parse(txt));
      } catch(e){ console.warn('Chunked list parse error', e); }
    }
  }
}
function _onFsData(e){
  if (!readState || !readState.header) return;
  const dv = e.target.value;
  const tag = dv.getUint8(0);
  const last = (tag & 1) === 1;
  log('_onFsData', { tag, last, len: dv.byteLength, off: readState.off, size: readState.size });
  if ((tag & 0xFE) !== TAG_DATA) return;

  const bytes = new Uint8Array(dv.buffer, dv.byteOffset+1, dv.byteLength-1);
  if (!readState.buf) readState.buf = new Uint8Array(readState.size);
  readState.buf.set(bytes, readState.off);
  readState.off += bytes.length;

  if (ui.prog) ui.prog.value = readState.off;
  try {
    const pct = Math.floor((readState.off * 100) / (readState.size || 1));
    globalProgressSet(pct, WP().receiving || 'Receiving…');
  } catch {}
  if (ui.progText) {
    const doneKiB = readState.off/1024, totalKiB = readState.size/1024;
    ui.progText.textContent = (WP().kib ? WP().kib(doneKiB, totalKiB) : `${doneKiB.toFixed(1)} KiB / ${totalKiB.toFixed(1)} KiB`);
  }

  // progressive draw
  const rowBytes = readState.w * 2;
  const availBytes = Math.max(0, readState.off - readState.offset);
  const availRows  = Math.min(readState.h, Math.floor(availBytes / rowBytes));
  if (availRows > 0) {
    const img = workCtx.createImageData(readState.w, readState.h);
    _drawRowsRGB565(readState.buf, readState.w, readState.h, img, 0, availRows, { offset: readState.offset });
    workCtx.putImageData(img, 0, 0);
  }

  // overlay
  const redrawBase = () => {
    _blit();
    viewCtx.save();
    viewCtx.fillStyle = "rgba(0,0,0,0.35)";
    const yv = _workYtoViewY(availRows);
    viewCtx.fillRect(0, yv, ui.canvas.clientWidth, ui.canvas.clientHeight - yv);
    viewCtx.restore();
  };
  const pct = (readState.off / readState.size) * 100;
  _drawBadge(availRows, pct, redrawBase);

  // done
  if (last && readState.off >= readState.size) {
    // final pass to ensure full image drawn
    const img = workCtx.createImageData(readState.w, readState.h);
    _drawRowsRGB565(readState.buf, readState.w, readState.h, img, 0, readState.h, { offset: readState.offset });
    workCtx.putImageData(img, 0, 0);
    _blit();
    _fadeBadge(readState.h, _blit);

    _showSaveButtons(readState.name, readState.buf);

    busy.reading = false;
    _hideProgress();
    try { globalProgressDone(600); } catch {}
  }
}

// ---------- File list / actions ----------
function _mkIconBtn(iconName, tooltip, onclick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.innerHTML = `<span class="material-symbols-outlined">${iconName}</span>`;
  b.title = tooltip;
  b.onclick = onclick;
  return b;
}

function _findNextNameFromList(list, current) {
  if (!list || list.length === 0) return null;
  const sorted = [...list].sort((a,b)=> a.name.localeCompare(b.name));
  const cur = _norm(current);
  for (const f of sorted) {
    if (_norm(f.name) > cur) return f.name;
  }
  return sorted[0].name; // wrap-around
}

async function _deleteWithSwitch(name){
  // hard guard in case of races
  if (!_canDelete()) {
    alert(WP().mustKeepOne || 'At least one image must remain on the device.');
    return;
  }

  const deleting   = _norm(name);
  const wasCurrent = _norm(lastShownName) === deleting;

  // compute candidate from current in-memory list first
  const localAfter = (files || []).filter(f => _norm(f.name) !== deleting);

  // If deleting would leave 0, block (extra safety)
  if (localAfter.length === 0) {
    alert(WP().mustKeepOne || 'At least one image must remain on the device.');
    return;
  }

  const candidateNext = _findNextNameFromList(localAfter, deleting);

  if (wasCurrent) { _clearPreview(); _resetUrls(); }

  await _delete(name);
  await _sleep(150);

  // switch immediately on device (before listing)
  if (wasCurrent && candidateNext) {
    await _show(candidateNext);
    lastShownName = _norm(candidateNext);
  }

  await _listAfter(300);
}

async function _renderList(j) {
  files = (j.files || [])
    .filter(f => /\.(bin|rgb565|565|raw)$/i.test(f.name))
    .sort((a,b)=> a.name.localeCompare(b.name));

  const isFull = Array.isArray(files) && files.length >= MAX_IMAGES;

  // Toggle the 🚫 Full banner
  if (ui.fullMsg) ui.fullMsg.style.display = isFull ? 'block' : 'none';

  // Hard-disable picking/uploading when full
  if (ui.selectBtn)  ui.selectBtn.disabled  = isFull || !(connected && consent);
  if (ui.uploadBtn)  ui.uploadBtn.disabled  = isFull || !staged.type || !(connected && consent);
  if (ui.fileInput)  ui.fileInput.disabled  = isFull;

  // Optional: lock presets if present
  if (ui.presetSelect) {
    ui.presetSelect.disabled = isFull || !(connected && consent);
    ui.presetSelect.title = isFull ? (WP().fullShort || 'Storage full — delete one on the device first.') : (WP().presetTitle || '');
  }

  const tb = ui.filesBody;
  if (!tb) return;
  tb.innerHTML = '';

  for (const f of files) {
    const tr  = document.createElement('tr');

    // Name
    const tdN = document.createElement('td');
    tdN.className = 'name';
    const dispName = f.name.startsWith('/') ? f.name.slice(1) : f.name;
    tdN.textContent = dispName;

    // Size
    const tdS = document.createElement('td');
    tdS.className = 'size';
    tdS.textContent = _toKiB(f.size);

    // Actions
    const tdA = document.createElement('td');
    tdA.className = 'actions';

    const bDown = _mkIconBtn('download', (WP().actDownload || 'Download (preview here)'), async () => { await _read(f.name); });
    const bShow = _mkIconBtn('slideshow', (WP().actShow || 'Show on device'), async () => { await _show(f.name); });
    const bDel  = _mkIconBtn('delete', (WP().actDelete || 'Delete'), async () => {
      // click-time guard (UI might be stale)
      if (!_canDelete()) {
        alert(WP().mustKeepOne || 'At least one image must remain on the device.');
        return;
      }
      const msg = (WP().confirmDelete ? WP().confirmDelete(dispName) : ('Delete ' + dispName + '?'));
      if (!confirm(msg)) return;
      await _deleteWithSwitch(f.name);
    });
    // If only one image is present, disable Delete button and adjust tooltip
    if (!_canDelete()) {
      bDel.disabled = true;
      bDel.title = WP().cannotDeleteLast || 'Cannot delete the last remaining image.';
    }
    const bRen  = _mkIconBtn('edit',     (WP().actRename || 'Rename'), async () => {
      const promptMsg = (WP().promptRename ? WP().promptRename(dispName) : 'New name (with extension):');
      let nn = prompt(promptMsg, dispName);
      if (!nn || nn === dispName) return;
      if (!/\.(bin|rgb565|565|raw)$/i.test(nn)) nn += '.bin';
      await _rename(f.name, nn);
      await _listAfter(300);
    });

    const wrap = document.createElement('div');
    wrap.className = 'actions-wrap';
    wrap.append(bDown, bShow, bDel, bRen);

    tdA.append(wrap);
    tr.append(tdN, tdS, tdA);
    tb.append(tr);
  }

  // Safety net: if the currently shown image disappeared, show the next
  if (lastShownName && !files.some(f => _norm(f.name) === _norm(lastShownName))) {
    const next = _findNextNameFromList(files, lastShownName);
    if (next) {
      await _show(next);
      lastShownName = _norm(next);
    } else {
      _clearPreview();
      _resetUrls();
      lastShownName = null;
    }
  }

  // Update Upload button availability (in case of full/space freed)
  if (ui.uploadBtn) ui.uploadBtn.disabled = !(connected && consent) || !staged.type || _isFull();
}

// ---------- Save buttons after READ ----------
function _resetUrls() {
  dlBlob = null;
  if (ui.saveBinBtn) ui.saveBinBtn.style.display = 'none';
  if (ui.savePngBtn) ui.savePngBtn.style.display = 'none';
}
function _showSaveButtons(name, bytes) {
  _resetUrls();
  const clean = (name||'image.bin').replace(/^\/+/, '');
  dlBlob = new Blob([bytes], { type:'application/octet-stream' });

  if (ui.saveBinBtn) {
    ui.saveBinBtn.style.display='inline-block';
    ui.saveBinBtn.textContent = WP().saveBin || 'Save .bin';
    ui.saveBinBtn.onclick = () => {
      if (dlBlob) downloadBlob(dlBlob, clean);
    };
  }
  if (ui.savePngBtn) {
    ui.savePngBtn.style.display='inline-block';
    ui.savePngBtn.textContent = WP().savePng || 'Save .png';
    ui.savePngBtn.onclick = () => {
      const targetName = clean.replace(/\.bin$/i, '.png');
      if (ui.canvas?.toBlob) {
        ui.canvas.toBlob((blob) => {
          if (blob) {
            downloadBlob(blob, targetName);
          }
        }, 'image/png');
      } else if (ui.canvas) {
        const dataUrl = ui.canvas.toDataURL('image/png');
        const opened = window.open(dataUrl, '_blank');
        if (!opened) {
          const link = document.createElement('a');
          link.href = dataUrl;
          link.target = '_blank';
          link.rel = 'noopener';
          document.body.appendChild(link);
          link.click();
          link.remove();
        }
      }
    };
  }
}

// ---------- Staging helpers ----------
function _clearStaged(){ staged = { type:null, name:null, bytes:null, w:0, h:0, pixelOffset:4, fromCanvas:false }; }

// ---------- PRESETS (optional UI) ----------
const PRESETS = [
  { id: "rok2025",     label: "Rok Jubileuszowy 2025",  url: "presets/rok2025.png",     type: "image/png" },
  { id: "jezus",       label: "Jezus Miłosierny",       url: "presets/jezus.png",       type: "image/png" },
  { id: "fatima",      label: "Matka Boska Fatimska",   url: "presets/fatima.png",      type: "image/png" },
  { id: "czestochowa", label: "Matka Boska Częstochowa",url: "presets/czestochowa.png", type: "image/png" },
  { id: "guadalupe",   label: "Matka Boska z Guadalupe",url: "presets/guadalupe.png",   type: "image/png" },
];

function _initPresetsUI() {
  if (!ui.presetSelect || ui.presetSelect.dataset._filled === '1') return;

 // Ensure there is exactly ONE placeholder.
 // Re-use an existing empty option if present; otherwise create one.
 let optPh = ui.presetSelect.querySelector('option[data-placeholder], option[value=""]');
 if (!optPh) {
    optPh = document.createElement('option');
    optPh.value = '';
    ui.presetSelect.prepend(optPh);
  }
  optPh.textContent = WP().presetPlaceholder || '— Preset —';
  optPh.setAttribute('data-placeholder', '1');

  for (const p of PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.label;
    ui.presetSelect.appendChild(opt);
  }
  ui.presetSelect.title = WP().presetTitle || 'Choose a preset';
  ui.presetSelect.dataset._filled = '1';
}
_initPresetsUI();

// Handle preset choose (preview + stage, keep selection)
ui.presetSelect?.addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!id) return;

  // If full, show banner and revert selection — no alert
  if (Array.isArray(files) && files.length >= MAX_IMAGES) {
    if (ui.fullMsg) ui.fullMsg.style.display = 'block';
    e.target.value = '';
    return;
  }
  if (!connected || !consent) {
    e.target.value = '';
    return;
  }

  // capacity / state checks
  if (_isFull()) { alert(WP().fullShort || 'Storage is full (5/5). Delete one first.'); e.target.value = ''; return; }
  if (!connected || !consent) { alert(WP().connectFirst || 'Connect and allow on device first.'); e.target.value = ''; return; }

  const preset = PRESETS.find(p => p.id === id);
  if (!preset) { e.target.value = ''; return; }

  try {
    const res = await fetch(preset.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf  = await res.arrayBuffer();
    const name = preset.url.split('/').pop() || 'preset';

    // Emulate the same staging as file input
    if (/^image\/(png|jpe?g|webp)$/i.test(preset.type) || /\.(png|jpe?g|jpg|webp)$/i.test(name)) {
      const bmp = await loadImageSource(new Blob([buf], { type: preset.type || 'image/png' }));
      await _drawToCanvasCover(bmp);
      staged = { type:'canvas', name, bytes:null, w:TARGET_W, h:TARGET_H, pixelOffset:4, fromCanvas:true };
    } else if (/\.(bin|rgb565|565|raw)$/i.test(name) || /octet-stream/.test(preset.type||'')) {
      const u8 = new Uint8Array(buf);
      const det = _detectFormat(u8, name);
      await _previewRaw(u8, det.w, det.h, det.offset);
      staged = { type:'raw', name, bytes:u8, w:det.w, h:det.h, pixelOffset:det.offset, fromCanvas:false };
    } else {
      alert(WP().unsupportedPreset || 'Unsupported preset. Use PNG/JPEG/WebP or RGB565 .bin/.raw.');
      e.target.value = '';
      return;
    }

    if (ui.uploadBtn) ui.uploadBtn.disabled = !(connected && consent) || _isFull();
  } catch (err) {
    console.error(err);
    alert(WP().presetLoadFailed || 'Failed to load preset. See console for details.');
    e.target.value = '';
  }
});

// Ensure progress is hidden if the script loads before attach
_hideProgress();
// Apply initial static texts
_applyStaticTexts();

// ===== END =====
