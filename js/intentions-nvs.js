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
  constructor({ totalBytes = 20480, version = CONSTS.VERSION2, activePages = 4 }) {
    this.pages = [];
    this.activePages = activePages;
    this.totalBytes = totalBytes;
    this.version = version;
    this.page = null;
    this.pageIndex = 0;
    this.bitmapCursor = 0;
    this.entryCursor = 0;
    this._newPage();
  }

  _newPage() {
    const buf = new Uint8Array(CONSTS.PAGE_SIZE);
    buf.fill(0xFF);
    const view = new DataView(buf.buffer);
    view.setUint32(0, CONSTS.STATE_ACTIVE, true);
    view.setUint32(4, this.pageIndex, true);
    buf[8] = this.version;
    this.page = { buf, view, entries: 0 };
    this.pages.push(this.page);
    this.bitmapCursor = 0;
    this.entryCursor = 0;
    this.pageIndex++;
  }

  _ensureSpace(entriesNeeded) {
    if (this.entryCursor + entriesNeeded <= CONSTS.MAX_ENTRIES && this.page.entries + entriesNeeded <= CONSTS.MAX_ENTRIES) return;
    this.page.view.setUint32(0, CONSTS.STATE_FULL, true);
    this.page = null;
    this._newPage();
  }

  _writeBitmapBit() {
    const byteIdx = Math.floor(this.bitmapCursor / 8);
    const bitIdx = this.bitmapCursor % 8;
    const off = CONSTS.BITMAP_OFFSET + byteIdx;
    this.page.buf[off] &= ~(1 << bitIdx);
    this.bitmapCursor++;
  }

  _writeEntryBytes(bytes) {
    const off = CONSTS.ENTRY_OFFSET + this.entryCursor * CONSTS.ENTRY_SIZE;
    this.page.buf.set(bytes, off);
    this.entryCursor++;
    this.page.entries++;
  }

  _setHeaderCrc(entry) {
    const crc = crc32.run(entry.subarray(0, 28));
    entry[28] = crc & 0xFF;
    entry[29] = (crc >> 8) & 0xFF;
    entry[30] = (crc >> 16) & 0xFF;
    entry[31] = (crc >> 24) & 0xFF;
  }

  writeNamespace(name) {
    const e = new Uint8Array(CONSTS.ENTRY_SIZE);
    e.fill(0xFF);
    e[0] = 0; // nsIdx
    e[1] = TYPES.U8;
    e[2] = 1; // span
    // Optimization: encode directly to entry buffer
    sharedEnc.encodeInto(name, e.subarray(8, 23));
    e[24] = this.pageIndex; // assign idx
    this._setHeaderCrc(e);
    this._ensureSpace(1);
    this._writeBitmapBit();
    this._writeEntryBytes(e);
    return this.pageIndex - 1;
  }

  writeI32(nsIdx, key, value) {
    const e = new Uint8Array(CONSTS.ENTRY_SIZE);
    e.fill(0xFF);
    e[0] = nsIdx;
    e[1] = TYPES.I32;
    e[2] = 1;
    // Optimization: encode directly to entry buffer
    sharedEnc.encodeInto(key, e.subarray(8, 23));
    new DataView(e.buffer, e.byteOffset, e.byteLength).setInt32(24, value | 0, true);
    this._setHeaderCrc(e);
    this._ensureSpace(1);
    this._writeBitmapBit();
    this._writeEntryBytes(e);
  }

  _writeDataChunk(data) {
    const rounded = (data.length + 31) & ~31;
    const tmp = new Uint8Array(rounded);
    tmp.fill(0xFF);
    tmp.set(data);
    const cnt = rounded / 32;
    this._ensureSpace(cnt);
    for (let i = 0; i < cnt; i++) {
      const block = tmp.subarray(i * 32, (i + 1) * 32); // subarray is cheaper than slice
      this._writeBitmapBit();
      this._writeEntryBytes(block);
    }
  }

  writeBlob(nsIdx, key, bytes) {
    const chunkSize = CONSTS.ENTRY_SIZE - 8; // max data per BLOB_DATA entry
    const chunkCount = Math.ceil(bytes.length / chunkSize);
    const chunkStart = 0;

    for (let ci = 0; ci < chunkCount; ci++) {
      const slice = bytes.subarray(ci * chunkSize, (ci + 1) * chunkSize); // subarray is cheaper
      const e = new Uint8Array(CONSTS.ENTRY_SIZE);
      e.fill(0xFF);
      e[0] = nsIdx;
      e[1] = TYPES.BLOB_DATA;
      e[2] = 1;
      e[3] = chunkStart + ci;
      const dv = new DataView(e.buffer, e.byteOffset, e.byteLength);
      dv.setUint16(24, slice.length, true);
      this._setHeaderCrc(e);
      this._ensureSpace(1 + Math.ceil((slice.length + 31) / 32));
      this._writeBitmapBit();
      this._writeEntryBytes(e);
      this._writeDataChunk(slice);
    }

    const idxE = new Uint8Array(CONSTS.ENTRY_SIZE);
    idxE.fill(0xFF);
    idxE[0] = nsIdx;
    idxE[1] = TYPES.BLOB_IDX;
    idxE[2] = 1;
    // Optimization: encode directly to entry buffer
    sharedEnc.encodeInto(key, idxE.subarray(8, 23));
    const dvIdx = new DataView(idxE.buffer, idxE.byteOffset, idxE.byteLength);
    dvIdx.setUint32(24, bytes.length, true);
    idxE[28] = chunkCount & 0xFF;
    idxE[29] = chunkStart & 0xFF;
    this._setHeaderCrc(idxE);
    this._ensureSpace(1);
    this._writeBitmapBit();
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

export function buildIntentionsBin({ numIntentions = 0, iS = '', titles = [], descs = [], totalBytes = 20480 } = {}) {
  const b = new NvsBuilder({ totalBytes, version: CONSTS.VERSION2 });
  const nsIdx = b.writeNamespace('intentions');
  b.writeI32(nsIdx, 'numIntentions', numIntentions | 0);
  b.writeBlob(nsIdx, 'iS', utf8Encode(iS));
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
