const MAX_ENTRIES_DEFAULT = 2500;
const FLAG_KEY = 'srDebug';

function nowMs() {
  try { return performance.now(); } catch { return Date.now(); }
}

function isoTs() {
  try { return new Date().toISOString(); } catch { return String(Date.now()); }
}

function getUA() {
  try { return navigator.userAgent || ''; } catch { return ''; }
}

function readEnabled() {
  try {
    const fromStorage = (window?.localStorage?.getItem(FLAG_KEY) === '1');
    const fromQuery = (typeof location !== 'undefined') && /(?:\?|&)srDebug=1(?:&|$)/.test(location.search || '');
    return !!(fromStorage || fromQuery);
  } catch {
    return false;
  }
}

function normalizeError(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (typeof err === 'object') {
    const name = err.name ? String(err.name) : 'Error';
    const message = err.message ? String(err.message) : String(err);
    const stack = err.stack ? String(err.stack) : undefined;
    return { name, message, stack };
  }
  return { name: 'Error', message: String(err) };
}

function safeClone(x) {
  if (x == null) return x;
  if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return x;
  if (Array.isArray(x)) return x.slice(0, 50).map(safeClone);
  if (x instanceof Uint8Array) return { __type: 'Uint8Array', len: x.byteLength };
  if (x instanceof ArrayBuffer) return { __type: 'ArrayBuffer', len: x.byteLength };
  if (x instanceof DataView) return { __type: 'DataView', len: x.byteLength };
  if (x instanceof Error) return normalizeError(x);
  if (typeof x === 'object') {
    const out = {};
    let count = 0;
    for (const k of Object.keys(x)) {
      if (count++ > 50) break;
      out[k] = safeClone(x[k]);
    }
    return out;
  }
  return String(x);
}

function ensureGlobal() {
  const g = (typeof window !== 'undefined') ? window : globalThis;
  if (!g.__srDebugLog) {
    g.__srDebugLog = {
      enabled: readEnabled(),
      max: MAX_ENTRIES_DEFAULT,
      ua: getUA(),
      startTs: isoTs(),
      entries: [],
    };
  } else {
    g.__srDebugLog.enabled = readEnabled();
  }
  return g.__srDebugLog;
}

export function debugEnabled() {
  return ensureGlobal().enabled;
}

export function dbg(scope, event, data) {
  const state = ensureGlobal();
  if (!state.enabled) return;
  const entry = {
    t: Math.round(nowMs()),
    ts: isoTs(),
    scope: String(scope || 'app'),
    event: String(event || ''),
    data: safeClone(data),
  };
  state.entries.push(entry);
  if (state.entries.length > state.max) state.entries.splice(0, state.entries.length - state.max);
}

export function dbgError(scope, event, err, data) {
  dbg(scope, event, { err: normalizeError(err), ...(data ? safeClone(data) : {}) });
}

export function makeLogger(scope) {
  const s = String(scope || 'app');
  return {
    log: (event, data) => dbg(s, event, data),
    error: (event, err, data) => dbgError(s, event, err, data),
  };
}

export function debugDump({ pretty = true } = {}) {
  const state = ensureGlobal();
  return JSON.stringify({
    enabled: state.enabled,
    ua: state.ua,
    startTs: state.startTs,
    entries: state.entries,
  }, null, pretty ? 2 : 0);
}

export function debugClear() {
  const state = ensureGlobal();
  state.entries = [];
}

export function debugEnable(on = true) {
  try {
    window?.localStorage?.setItem(FLAG_KEY, on ? '1' : '0');
  } catch {}
  ensureGlobal().enabled = readEnabled();
}

// Convenience globals for easy copy/paste from console.
try {
  const g = (typeof window !== 'undefined') ? window : globalThis;
  g.SR_DEBUG = g.SR_DEBUG || {};
  g.SR_DEBUG.enable = () => { debugEnable(true); return 'srDebug enabled (reload page recommended)'; };
  g.SR_DEBUG.disable = () => { debugEnable(false); return 'srDebug disabled'; };
  g.SR_DEBUG.clear = () => { debugClear(); return 'srDebug cleared'; };
  g.SR_DEBUG.dump = () => debugDump({ pretty: true });
  g.SR_DEBUG.dumpCompact = () => debugDump({ pretty: false });
  g.SR_DEBUG.enabled = () => debugEnabled();
  g.SR_DEBUG.copy = async () => {
    const text = debugDump({ pretty: true });
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return `Copied ${text.length} chars to clipboard`;
      }
    } catch {}
    try {
      // Fallback for environments without clipboard access.
      // eslint-disable-next-line no-alert
      prompt('Copy debug log JSON:', text);
      return `Prompted ${text.length} chars`;
    } catch {
      return text;
    }
  };
  g.SR_DEBUG.download = () => {
    const text = debugDump({ pretty: true });
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smartrosary-debug-${Date.now()}.json`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch {}
      try { a.remove(); } catch {}
    }, 4000);
    return `Downloading ${blob.size} bytes`;
  };
} catch {}
