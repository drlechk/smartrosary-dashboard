// Minimal NVS V2 builder for the intentions partition.
// Adapted from smartrosary-intentions-editor; only the writer/CRC pieces are kept.

const TYPES = {
  U8: 0x01,
  I32: 0x14,
  SZ: 0x21,
  BLOB: 0x41,
  BLOB_DATA: 0x42,
  BLOB_IDX: 0x48,
};

const CONSTS = {
  PAGE_SIZE: 4096,
  HEADER_SIZE: 32,
  BITMAP_OFFSET: 32,
  BITMAP_SIZE: 32,
  ENTRY_OFFSET: 64,
  ENTRY_SIZE: 32,
  MAX_ENTRIES: 126,
  STATE_ACTIVE: 0xFFFFFFFE,
  STATE_FULL: 0xFFFFFFFC,
  VERSION2: 0xFE,
  CHUNK_ANY: 0xFF,
};

class CRC32 {
  constructor() {
    this.table = CRC32._makeTable();
  }
  static _makeTable() {
    const tbl = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      tbl[n] = c >>> 0;
    }
    return tbl;
  }
  run(data, seed = 0) {
    let c = (seed ^ 0xFFFFFFFF) >>> 0;
    const tbl = this.table;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    for (let i = 0; i < bytes.length; i++) {
      c = (c >>> 8) ^ tbl[(c ^ bytes[i]) & 0xFF];
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
}

const crc32 = new CRC32();
const sharedEnc = new TextEncoder();

class NvsBuilder {
  constructor({ totalBytes = 20480, version = CONSTS.VERSION2 } = {}) {
    if (totalBytes % CONSTS.PAGE_SIZE !== 0) throw new Error('totalBytes must be multiple of 4096');
    this.version = version;
    this.totalBytes = totalBytes;
    this.activePages = (totalBytes / CONSTS.PAGE_SIZE) - 1; // last reserved page
    this.pages = [];
    this.cur = null;
    this.namespaceCount = 0;
    this.writtenNamespaces = new Map();
    this._newPage();
  }

  _newPage({ reserved = false } = {}) {
    const pageIndex = this.pages.length;
    if (this.cur && !this.cur.reserved) {
      this.cur.dv.setUint32(0, CONSTS.STATE_FULL, true);
    }
    const buf = new Uint8Array(CONSTS.PAGE_SIZE);
    buf.fill(0xFF);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (!reserved) {
      dv.setUint32(0, CONSTS.STATE_ACTIVE, true);
      dv.setUint32(4, pageIndex >>> 0, true);
      buf[8] = this.version;
      // header CRC over bytes 4..27
      const hdrCrc = crc32.run(buf.slice(4, 28), 0xFFFFFFFF) >>> 0;
      dv.setUint32(28, hdrCrc >>> 0, true);
    }
    const page = { buf, dv, entryNum: 0, reserved: !!reserved };
    this.pages.push(page);
    this.cur = page;
    return page;
  }

  _ensureSpace(entriesNeeded) {
    if (this.cur.reserved) this._newPage();
    const available = CONSTS.MAX_ENTRIES - this.cur.entryNum;
    if (available >= entriesNeeded) return;
    if (this.pages.length < this.activePages) {
      this._newPage();
    } else {
      this._newPage();
    }
  }

  _writeBitmapBit() {
    // NVS uses 2 bits per entry in bitmap (erased=11, written=??); we clear the first bit for each entry.
    const bitnum = this.cur.entryNum * 2;
    const byteIdx = CONSTS.BITMAP_OFFSET + (bitnum >> 3);
    const bitOffset = bitnum & 7;
    const mask = ~(1 << bitOffset) & 0xFF;
    this.cur.buf[byteIdx] = this.cur.buf[byteIdx] & mask;
  }

  _writeEntryBytes(bytes) {
    const off = CONSTS.ENTRY_OFFSET + this.cur.entryNum * CONSTS.ENTRY_SIZE;
    this.cur.buf.set(bytes, off);
    this._writeBitmapBit();
    this.cur.entryNum += 1;
  }

  _writeDataChunk(data) {
    const rounded = (data.length + 31) & ~31;
    const cnt = rounded / 32;
    const padded = new Uint8Array(rounded);
    padded.fill(0xFF);
    padded.set(data);
    for (let i = 0; i < cnt; i++) {
      const block = padded.slice(i * 32, i * 32 + 32);
      this._ensureSpace(1);
      this._writeEntryBytes(block);
    }
    return cnt;
  }

  _entryHeaderTemplate() {
    const e = new Uint8Array(CONSTS.ENTRY_SIZE);
    e.fill(0xFF);
    e[2] = 1; // span default
    e[3] = CONSTS.CHUNK_ANY;
    // Keys are zero-padded (not 0xFF padded)
    for (let i = 8; i < 24; i++) e[i] = 0x00;
    return e;
  }

  _setKey(e, key) {
    const kb = sharedEnc.encode(key);
    const n = Math.min(16, kb.length);
    e.set(kb.slice(0, n), 8);
  }

  _setHeaderCrc(e) {
    // Header CRC over [0..3] + [8..31], stored at [4..7]
    const tmp = new Uint8Array(28);
    tmp.set(e.slice(0, 4), 0);
    tmp.set(e.slice(8, 32), 4);
    const c = crc32.run(tmp, 0xFFFFFFFF) >>> 0;
    new DataView(e.buffer, e.byteOffset, e.byteLength).setUint32(4, c, true);
  }

  writeNamespace(name) {
    if (this.writtenNamespaces.has(name)) return this.writtenNamespaces.get(name);
    const idx = ++this.namespaceCount;
    const e = this._entryHeaderTemplate();
    e[0] = 0;
    e[1] = TYPES.U8;
    e[2] = 1;
    e[3] = CONSTS.CHUNK_ANY;
    this._setKey(e, name);
    e[24] = idx & 0xFF;
    this._setHeaderCrc(e);
    this._ensureSpace(1);
    this._writeEntryBytes(e);
    this.writtenNamespaces.set(name, idx);
    return idx;
  }

  writeI32(nsIdx, key, value) {
    const e = this._entryHeaderTemplate();
    e[0] = nsIdx;
    e[1] = TYPES.I32;
    this._setKey(e, key);
    new DataView(e.buffer, e.byteOffset, e.byteLength).setInt32(24, value | 0, true);
    this._setHeaderCrc(e);
    this._ensureSpace(1);
    this._writeEntryBytes(e);
  }

  writeBlob(nsIdx, key, bytes) {
    // V2 multipage blob: write BLOB_DATA chunks then BLOB_IDX entry.
    let remaining = bytes.length;
    let offset = 0;
    const chunkStart = 0;
    let chunkCount = 0;
    while (remaining > 0) {
      // Tailroom available on current page (in bytes) for data following 1 header entry
      const tailroom = (CONSTS.MAX_ENTRIES - this.cur.entryNum - 1) * CONSTS.ENTRY_SIZE;
      let chunkSize = Math.min(remaining, Math.max(tailroom, 0));
      if (chunkSize <= 0) {
        this._newPage();
        continue;
      }

      const e = this._entryHeaderTemplate();
      e[0] = nsIdx;
      e[1] = TYPES.BLOB_DATA;
      const rounded = (chunkSize + 31) & ~31;
      const cnt = rounded / 32;
      e[2] = (1 + cnt) & 0xFF; // span includes header + data entries
      e[3] = (chunkStart + chunkCount) & 0xFF;
      this._setKey(e, key);
      new DataView(e.buffer, e.byteOffset, e.byteLength).setUint16(24, chunkSize, true);
      const dataChunk = bytes.slice(offset, offset + chunkSize);
      const dataCrc = crc32.run(dataChunk, 0xFFFFFFFF) >>> 0;
      new DataView(e.buffer, e.byteOffset, e.byteLength).setUint32(28, dataCrc, true);
      this._setHeaderCrc(e);
      this._ensureSpace(1);
      this._writeEntryBytes(e);

      this._ensureSpace(cnt);
      this._writeDataChunk(dataChunk);

      chunkCount++;
      offset += chunkSize;
      remaining -= chunkSize;

      const leftover = (CONSTS.MAX_ENTRIES - this.cur.entryNum) * 32;
      if (remaining > 0 && leftover < 32) this._newPage();
    }

    const idxE = this._entryHeaderTemplate();
    idxE[0] = nsIdx;
    idxE[1] = TYPES.BLOB_IDX;
    idxE[2] = 1;
    idxE[3] = CONSTS.CHUNK_ANY;
    this._setKey(idxE, key);
    new DataView(idxE.buffer, idxE.byteOffset, idxE.byteLength).setUint32(24, bytes.length >>> 0, true);
    idxE[28] = chunkCount & 0xFF;
    idxE[29] = chunkStart & 0xFF;
    this._setHeaderCrc(idxE);
    this._ensureSpace(1);
    this._writeEntryBytes(idxE);
  }

  finalize() {
    while (this.pages.length < this.activePages) this._newPage();
    const reserved = new Uint8Array(CONSTS.PAGE_SIZE);
    reserved.fill(0xFF);
    this.pages.push({ buf: reserved, reserved: true });
    const out = new Uint8Array(this.pages.length * CONSTS.PAGE_SIZE);
    for (let i = 0; i < this.pages.length; i++) {
      out.set(this.pages[i].buf, i * CONSTS.PAGE_SIZE);
    }
    return out.slice(0, this.totalBytes);
  }
}

function utf8Encode(s) { return sharedEnc.encode(s || ''); }

export function buildIntentionsBin({ numIntentions = 0, iS = '', iSched = '', titles = [], descs = [], totalBytes = 20480 } = {}) {
  const b = new NvsBuilder({ totalBytes, version: CONSTS.VERSION2 });
  const nsIdx = b.writeNamespace('intentions');
  b.writeI32(nsIdx, 'numIntentions', numIntentions | 0);
  b.writeBlob(nsIdx, 'iS', utf8Encode(iS));
  if (iSched) b.writeBlob(nsIdx, 'iSched', utf8Encode(iSched));
  for (let i = 0; i < numIntentions; i++) {
    const t = titles[i] || '';
    const d = descs[i] || '';
    b.writeBlob(nsIdx, 'iT' + i, utf8Encode(t));
    b.writeBlob(nsIdx, 'iD' + i, utf8Encode(d));
  }
  return b.finalize();
}

export function crc32Bytes(bytes) {
  return crc32.run(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}
