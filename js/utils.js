// Small shared helpers (no DOM here)
export const $ = (id) => document.getElementById(id);

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const anchorProbe = (typeof document !== 'undefined') ? document.createElement('a') : null;
const supportsDownloadAttr = !!(anchorProbe && 'download' in anchorProbe);

const navUA = (typeof navigator !== 'undefined') ? (navigator.userAgent || '') : '';
const navPlatform = (typeof navigator !== 'undefined') ? (navigator.platform || '') : '';
const navTouchPoints = (typeof navigator !== 'undefined') ? (Number(navigator.maxTouchPoints) || 0) : 0;
const isBluefy = /Bluefy/i.test(navUA);
const isAndroid = /Android/i.test(navUA);
const isChromeLike = /Chrome\//i.test(navUA) || /Chromium\//i.test(navUA);
const isChromeFamily = isChromeLike && !/(EdgA|EdgiOS|OPR|SamsungBrowser|YaBrowser|DuckDuckGo)/i.test(navUA);
const isLikelyIOS = (() => {
  if (typeof navigator === 'undefined') return false;
  if (/iPad|iPhone|iPod/.test(navUA)) return true;
  // iPadOS reports as MacIntel with touch points > 1
  return navPlatform === 'MacIntel' && navTouchPoints > 1;
})();
export const platformFlags = {
  isBluefy,
  isLikelyIOS,
  isAndroid,
  isChromeFamily,
  isAndroidChrome: isAndroid && isChromeFamily,
};

function restoreInlineStyles(node, snapshot) {
  Object.entries(snapshot).forEach(([prop, value]) => {
    node.style[prop] = value;
  });
}

export function downloadBlob(blob, filename) {
  if (!blob) return false;
  const safeName = filename || 'download.bin';

  const blobSize = Number(blob.size) || 0;
  const iosBaseDelay = (isBluefy ? 20000 : 4000);
  const extraPer64KiB = (blobSize > 0) ? Math.min(60000, Math.ceil(blobSize / 65536) * 2000) : 0;
  const releaseDelay = (isLikelyIOS || isBluefy) ? (iosBaseDelay + extraPer64KiB) : 0;

  // Native share (iOS/Bluefy) — avoids the download attribute that breaks on Bluefy
  try {
    const shareCapable = (isLikelyIOS || isBluefy)
      && typeof navigator !== 'undefined'
      && typeof navigator.canShare === 'function'
      && typeof navigator.share === 'function';
    if (shareCapable) {
      const file = new File([blob], safeName, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: safeName }).catch((err) => {
          console.warn('downloadBlob share failed', err);
        });
        return true;
      }
    }
  } catch (err) {
    console.warn('downloadBlob share error', err);
  }

  const useDownloadAttr = supportsDownloadAttr && !isBluefy;

  // Standard object URL download path (skipped on Bluefy where it is unreliable)
  if (useDownloadAttr) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.rel = 'noopener';
    if (isLikelyIOS) a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.remove();
    };
    // Bluefy/iOS needs extra time to read the blob before it disappears.
    setTimeout(cleanup, releaseDelay);
    return true;
  }

  // Bluefy/iOS fallback: open blob in a new tab/window without relying on download attr
  try {
    const url = URL.createObjectURL(blob);
    const opened = window.open(url, '_blank');
    if (!opened) {
      const tmp = document.createElement('a');
      tmp.href = url;
      tmp.target = '_blank';
      tmp.rel = 'noopener';
      tmp.download = safeName;
      document.body.appendChild(tmp);
      tmp.click();
      tmp.remove();
    }
    setTimeout(() => { URL.revokeObjectURL(url); }, releaseDelay);
    return true;
  } catch (err) {
    console.warn('downloadBlob fallback (object URL) failed', err);
  }

  try {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      const opened = window.open(result, '_blank');
      if (!opened) {
        const tmp = document.createElement('a');
        tmp.href = result;
        tmp.target = '_blank';
        tmp.rel = 'noopener';
        document.body.appendChild(tmp);
        tmp.click();
        tmp.remove();
      }
    };
    reader.readAsDataURL(blob);
    return true;
  } catch (err) {
    console.warn('downloadBlob fallback failed', err);
    return false;
  }
}

export function openFilePicker(input) {
  if (!input) return false;

  if (typeof input.showPicker === 'function' && !isLikelyIOS) {
    try {
      input.showPicker();
      return true;
    } catch (err) {
      // showPicker not available, fall back to click
    }
  }

  let hiddenWorkaround = false;
  let snapshot = null;

  if (isLikelyIOS && typeof window !== 'undefined' && window.getComputedStyle) {
    const style = window.getComputedStyle(input);
    const hidden = style.display === 'none' || style.visibility === 'hidden';
    if (hidden) {
      hiddenWorkaround = true;
      snapshot = {
        display: input.style.display,
        position: input.style.position,
        opacity: input.style.opacity,
        pointerEvents: input.style.pointerEvents,
        width: input.style.width,
        height: input.style.height,
        zIndex: input.style.zIndex,
      };
      input.style.display = 'block';
      input.style.position = 'absolute';
      input.style.opacity = '0';
      input.style.pointerEvents = 'none';
      input.style.width = '1px';
      input.style.height = '1px';
      input.style.zIndex = '-1';
    }
  }

  try {
    input.click();
    return true;
  } catch (err) {
    console.warn('openFilePicker click failed', err);
    return false;
  } finally {
    if (hiddenWorkaround && snapshot) {
      setTimeout(() => restoreInlineStyles(input, snapshot), 16);
    }
  }
}

export async function loadImageSource(source) {
  if (!source) throw new Error('No image source provided');
  const blob = source instanceof Blob ? source : new Blob([source]);

  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch (err) {
      console.warn('createImageBitmap failed, falling back to Image()', err);
    }
  }

  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

export async function withRetry(fn, { tries = 5, base = 120 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { err = e; await sleep(base * Math.pow(1.6, i)); }
  }
  throw err;
}

export async function readWithRetry(ch, tries = 5) {
  return withRetry(() => ch.readValue(), { tries, base: 150 });
}

export function isLikelyGattError(err) {
  if (!err) return false;
  const name = String(err.name || '').toLowerCase();
  const msg = String(err.message || '').toLowerCase();
  return (
    name.includes('networkerror') ||
    msg.includes('gatt') ||
    msg.includes('att') ||
    msg.includes('operation failed') ||
    msg.includes('unknown') ||
    msg.includes('not permitted') ||
    msg.includes('disconnected')
  );
}

export const u8ToStr = (u8) => {
  try {
    return dec.decode(u8);
  } catch (e) {
    console.warn('u8ToStr decode failed, falling back to latin1', e);
    return Array.from(u8).map((c) => String.fromCharCode(c)).join('');
  }
};
export const safeNum = (x, d=0) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
};

// LE packing
export const le16 = (n) => {
  const a = new Uint8Array(2);
  n = Number(n) >>> 0; a[0] = n & 255; a[1] = (n >> 8) & 255;
  return a;
};
export const le32 = (n) => {
  const a = new Uint8Array(4);
  n = Number(n) >>> 0;
  a[0]=n&255; a[1]=(n>>8)&255; a[2]=(n>>16)&255; a[3]=(n>>24)&255;
  return a;
};
export const le64Big = (n) => {
  const a = new Uint8Array(8); let x = BigInt(n);
  for (let i=0;i<8;i++){ a[i] = Number(x & 0xffn); x >>= 8n; }
  return a;
};

// Control opcodes and types
export const OP = {
  SET_PREF: 0x50,
  SET_STAT: 0x53,
  REST_DONE: 0x55,
  REST_BEGIN: 0x54,
};

export function packKV(op, type, key, valBytes) {
  const k = enc.encode(key);
  const out = new Uint8Array(1 + 1 + 1 + k.length + valBytes.length);
  out[0]=op; out[1]=type; out[2]=k.length;
  out.set(k,3); out.set(valBytes, 3+k.length);
  return out;
}

export function encSize(type, value) {
  switch (type){
    case 0x01: return 1;      // bool
    case 0x11: return 1;      // u8
    case 0x12: return 2;      // u16
    case 0x14: return 4;      // u32
    case 0x21: return 4;      // i32
    case 0x18: return 8;      // u64
    case 0x31: return enc.encode(String(value)).length; // string
    default: throw new Error('encSize: bad type');
  }
}

// --- Global UI helpers (status + progress) ---
export function setGlobalStatus(text) {
  try {
    const el = document.getElementById('status');
    if (el && typeof text === 'string') el.textContent = text;
  } catch {}
}

// Internal debounce state for global progress visibility
const __gProg = {
  hideTimer: null,      // timer used to schedule a deferred "done" (idle at 100%)
  lastUpdate: 0,        // timestamp of the last Set/Start call
  lockUntil: 0,         // do not apply "done" until after this time (ms since epoch)
};

export function globalProgressStart(label, max = 100) {
  try {
    // When the aggregator is active, the global bar is already managed
    // by weighted segments. Avoid resetting the bar here; simply ensure
    // it stays visible.
    if (__gAgg.active) {
      const el = document.getElementById('globalProg');
      if (el) {
        let fill = el.querySelector('.bar');
        if (!fill) { fill = document.createElement('div'); fill.className = 'bar'; el.appendChild(fill); }
        el.hidden = false;
        el.classList.remove('idle');
      }
      const now = Date.now();
      __gProg.lastUpdate = now;
      __gProg.lockUntil = now + 300;
      if (__gProg.hideTimer) { clearTimeout(__gProg.hideTimer); __gProg.hideTimer = null; }
      return;
    }
    const el = document.getElementById('globalProg');
    if (el) {
      const m = Number(max) || 100;
      el.dataset.max = String(m);
      let fill = el.querySelector('.bar');
      if (!fill) { fill = document.createElement('div'); fill.className = 'bar'; el.appendChild(fill); }
      fill.style.width = '0%';
      el.hidden = false;
      el.classList.remove('idle');
    }
    // mark as recently updated and cancel any pending hide
    const now = Date.now();
    __gProg.lastUpdate = now;
    __gProg.lockUntil = now + 300; // brief lock so a concurrent Done cannot override immediately
    if (__gProg.hideTimer) { clearTimeout(__gProg.hideTimer); __gProg.hideTimer = null; }
  } catch {}
}

export function globalProgressSet(value, label) {
  try {
    // If aggregation is active and a delegate is set, route this update
    // to the aggregator instead of directly manipulating the bar.
    if (__gAgg.active && __gAgg.delegateId) {
      const pct = Math.max(0, Math.min(100, Math.floor(Number(value) || 0)));
      __gAgg.setSegment(__gAgg.delegateId, pct);
      return;
    }
    if (__gAgg.active) {
      return;
    }
    const el = document.getElementById('globalProg');
    if (el && typeof value === 'number') {
      const max = Number(el.dataset?.max) || 100;
      const pct = Math.max(0, Math.min(100, Math.floor((value / max) * 100)));
      let fill = el.querySelector('.bar');
      if (!fill) { fill = document.createElement('div'); fill.className = 'bar'; el.appendChild(fill); }
      fill.style.width = pct + '%';
      el.hidden = false;
      el.classList.remove('idle');
    }
    // bump last update and cancel any pending hide to prevent flicker
    const now = Date.now();
    __gProg.lastUpdate = now;
    __gProg.lockUntil = now + 350; // extend lock a bit with every progress tick
    if (__gProg.hideTimer) { clearTimeout(__gProg.hideTimer); __gProg.hideTimer = null; }
  } catch {}
}

export function globalProgressDone(delayMs = 600) {
  try {
    // If aggregation is active and a delegate is set, treat this as segment completion
    // rather than finishing the whole bar.
    if (__gAgg.active && __gAgg.delegateId) {
      __gAgg.setSegment(__gAgg.delegateId, 100);
      return;
    }
    const el = document.getElementById('globalProg');
    if (!el) return;

    // Defer applying the final 100% state until
    // there has been a quiet period (no Set calls) to avoid bouncing
    const applyDone = () => {
      const now = Date.now();
      if (now < __gProg.lockUntil) {
        // still receiving updates; try again shortly
        __gProg.hideTimer = setTimeout(applyDone, 120);
        return;
      }
      let fill = el.querySelector('.bar');
      if (!fill) { fill = document.createElement('div'); fill.className = 'bar'; el.appendChild(fill); }
      fill.style.width = '100%';
      el.hidden = false;
      el.classList.add('idle');
      __gProg.lastUpdate = now;
      if (__gProg.hideTimer) { clearTimeout(__gProg.hideTimer); __gProg.hideTimer = null; }
    };

    if (__gProg.hideTimer) { clearTimeout(__gProg.hideTimer); __gProg.hideTimer = null; }
    __gProg.hideTimer = setTimeout(applyDone, Math.max(0, Number(delayMs) || 0));
  } catch {}
}

// ---------------- Progress Aggregator ----------------

// Allows multiple services/tasks to contribute to a single global bar.
// Each segment provides 0..100% which is weighted into an overall percent.
const __gAgg = {
  active: false,
  delegateId: null,
  totalWeight: 0,
  segments: new Map(), // id -> { weight, pct }
  order: [],
  lastLogPct: null,
  lastOverall: null,
  // Ensure the bar exists and return { el, fill }
  _ensureBar() {
    const el = document.getElementById('globalProg');
    if (!el) return { el: null, fill: null };
    let fill = el.querySelector('.bar');
    if (!fill) { fill = document.createElement('div'); fill.className = 'bar'; el.appendChild(fill); }
    if (!fill.style.transition) fill.style.transition = 'width 0.35s ease';
    el.hidden = false;
    el.classList.remove('idle');
    return { el, fill };
  },
  _apply() {
    const { el, fill } = this._ensureBar();
    if (!el || !fill) return;
    // compute weighted percent
    if (!this.totalWeight) return;
    let acc = 0;
    for (const [id, seg] of this.segments) {
      const pct = Math.max(0, Math.min(100, Number(seg.pct) || 0));
      acc += (seg.weight * pct) / 100;
    }
    const rawOverall = Math.max(0, Math.min(100, Math.floor((acc * 100) / this.totalWeight)));
    const overall = (this.lastOverall == null) ? rawOverall : Math.max(this.lastOverall, rawOverall);
    fill.style.width = overall + '%';
    if (this.lastLogPct === null || Math.abs(overall - this.lastLogPct) >= 3 || overall === 100) {
      try { console.log('[progress][aggregate]', overall); } catch {}
      this.lastLogPct = overall;
    }
    // keep progress visible and non-idle while active
    el.hidden = false;
    el.classList.remove('idle');
    const now = Date.now();
    __gProg.lastUpdate = now;
    __gProg.lockUntil = now + 350;
    if (__gProg.hideTimer) { clearTimeout(__gProg.hideTimer); __gProg.hideTimer = null; }
    this.lastOverall = overall;
  },
  start(plan) {
    this.active = true;
    this.delegateId = null;
    this.totalWeight = 0;
    this.segments.clear();
    this.order = [];
    this.lastLogPct = null;
    for (const seg of plan || []) {
      if (!seg || !seg.id) continue;
      const w = Number(seg.weight) || 0;
      this.totalWeight += w;
      this.segments.set(seg.id, { weight: w, pct: 0 });
      this.order.push(seg.id);
    }
    this.lastOverall = 0;
    // show bar at 0%
    const { el, fill } = this._ensureBar();
    if (el && fill) {
      fill.style.width = '0%';
      el.dataset.max = '100';
    }
    const now = Date.now();
    __gProg.lastUpdate = now;
    __gProg.lockUntil = now + 300;
  },
  setSegment(id, pct) {
    if (!this.active) return;
    const seg = this.segments.get(id);
    if (!seg) return;
    seg.pct = Math.max(0, Math.min(100, Number(pct) || 0));
    this._apply();
  },
  enter(id) {
    if (!this.active) return;
    if (!this.segments.has(id)) return;
    this.delegateId = id;
    // nudge apply to make sure bar is visible
    this._apply();
  },
  leave(id) {
    if (this.delegateId === id) this.delegateId = null;
  },
  done() {
    // mark everything complete
    if (this.active) {
      for (const [id, seg] of this.segments) seg.pct = 100;
      this._apply();
    }
    this.active = false;
    this.delegateId = null;
    this.lastLogPct = null;
    this.lastOverall = null;
    try { globalProgressDone(600); } catch {}
  },
};

export function progAggregateStart(plan) { __gAgg.start(plan); }
export function progAggregateSet(id, pct) { __gAgg.setSegment(id, pct); }
export function progAggregateEnter(id) { __gAgg.enter(id); }
export function progAggregateLeave(id) { __gAgg.leave(id); }
export function progAggregateDone() { __gAgg.done(); }
export function progAggregateActive() { return __gAgg.active; }
