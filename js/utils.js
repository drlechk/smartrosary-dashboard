// Small shared helpers (no DOM here)
export const $ = (id) => document.getElementById(id);

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

export const u8ToStr = (u8) => dec.decode(u8);
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
