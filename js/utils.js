// Small shared helpers (no DOM here)
export const $ = (id) => document.getElementById(id);

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const anchorProbe = (typeof document !== 'undefined') ? document.createElement('a') : null;
const supportsDownloadAttr = !!(anchorProbe && 'download' in anchorProbe);

const isLikelyIOS = (() => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const touchPoints = Number(navigator.maxTouchPoints) || 0;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS reports as MacIntel with touch points > 1
  return platform === 'MacIntel' && touchPoints > 1;
})();

function restoreInlineStyles(node, snapshot) {
  Object.entries(snapshot).forEach(([prop, value]) => {
    node.style[prop] = value;
  });
}

export function downloadBlob(blob, filename) {
  if (!blob) return false;
  const safeName = filename || 'download.bin';

  if (supportsDownloadAttr) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
    return true;
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
