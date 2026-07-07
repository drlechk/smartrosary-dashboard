import { withRetry, readWithRetry, sleep } from './utils.js';
import { makeLogger } from './debug-log.js';

const log = (...args) => {
  try { console.log('[ble]', ...args); } catch {}
};
const dbg = makeLogger('ble');

// UUIDs (unchanged; must match firmware)
export const UUID = {
  OTA_SVC:          '12345678-1234-5678-1234-56789abcdef0',
  FS_SVC:           '12345678-1234-5678-1234-56789abcf000',
  FS_HIST_SVC:      '12345678-1234-5678-1234-56789abcf100',
  INTENTIONS_BIN:   '12345678-1234-5678-1234-56789abcde10',
  INFO_STATS:       'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1001',
  INFO_SETTINGS:    'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1002',
  INFO_CTRL:        'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e10ff',
  INFO_PARTS:       'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1003',
  INFO_INTENTIONS:  'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1010',
  INFO_INTENT_ENTRY:'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1011',
  INFO_UI:          'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1012',
  APP_PAIRING:      'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e10fe',
  TOUCH_CHAR:       '12345678-1234-5678-1234-56789abcdea1',
  KEYS_CHAR:        '12345678-1234-5678-1234-56789abcdea2',
  STATUS:           '12345678-1234-5678-1234-56789abcdef2',
};

const UI_CTRL_JSON = 0x70;
const APP_PAIR = 0x01;
const APP_DELETE_SLOT = 0x03;
const APP_LIST_SLOTS = 0x04;
const APP_CHECK_PAIR = 0x05;
const APP_DENIED = 0xA0;
const APP_PAIR_OK = 0xA1;
const APP_SLOT_DELETED = 0xA3;
const APP_CURRENT_PROTECTED = 0xA4;
const APP_SLOT_LIST = 0xA5;
const APP_INVALID = 0xE0;

export class BleClient extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.service = null;

    this.chStats = null;
    this.chSettings = null;
    this.chCtrl = null;
    this.chParts = null;
    this.chIntentions = null;
    this.chIntentEntry = null;
    this.chIntentionsBin = null;
    this.chUi = null;
    this.chAppPairing = null;
    this.statusChar = null;

    this.touchChar = null;
    this.keysChar = null;
    this.rssi = null;

    this.readyFlag = true;
    this.consentOk = false;
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available');

    let dev;
    try {
      log('requestDevice with services filter', { service: UUID.OTA_SVC });
      dbg.log('requestDevice', { mode: 'filter', service: UUID.OTA_SVC });
      dev = await navigator.bluetooth.requestDevice({
        filters: [{ services: [UUID.OTA_SVC] }],
        optionalServices: [UUID.OTA_SVC, UUID.FS_SVC, UUID.FS_HIST_SVC],
      });
    } catch {
      log('requestDevice fallback acceptAllDevices');
      dbg.log('requestDevice', { mode: 'acceptAllDevices' });
      dev = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [UUID.OTA_SVC, UUID.FS_SVC, UUID.FS_HIST_SVC],
      });
      if (!dev.name || !dev.name.toLowerCase().startsWith('rosary')) {
        throw new Error('Please pick your Rosary device.');
      }
    }

    this.device = dev;
    this.device.addEventListener('gattserverdisconnected', () => {
      dbg.log('gattserverdisconnected', { name: this.device?.name || '', id: this.device?.id || '' });
      this._onDisconnected();
    });

    log('Connecting GATT server', { name: dev.name || '', id: dev.id || '' });
    dbg.log('connect', { name: dev.name || '', id: dev.id || '' });
    this.server = await dev.gatt.connect();
    dbg.log('connected', { connected: !!this.server?.connected });
    await this._helloAndConsent();

    // settle for Android
    await sleep(300);

    await this._getAllChars();

    // STATUS pacing
    this.statusChar = await withRetry(() => this.service.getCharacteristic(UUID.STATUS));
    try {
      await this.statusChar.startNotifications();
      log('STATUS characteristic notifications enabled');
      dbg.log('statusNotifications', { ok: true });
    } catch (err) {
      console.warn('[ble] STATUS startNotifications failed', err?.message || err);
      dbg.error('statusNotifications', err, { ok: false });
    }
    this.statusChar.addEventListener('characteristicvaluechanged', (ev) => {
      const v = new Uint8Array(ev.target.value.buffer)[0];
      if (v === 0x01) this.readyFlag = true;  // READY tick from FW
    });

    // optional remote ctrl
    try {
      this.touchChar = await withRetry(() => this.service.getCharacteristic(UUID.TOUCH_CHAR));
      log('TOUCH characteristic ready');
    } catch (err) {
      this.touchChar = null;
      log('TOUCH characteristic missing', err?.message || err);
    }
    try {
      this.keysChar  = await withRetry(() => this.service.getCharacteristic(UUID.KEYS_CHAR));
      log('KEYS characteristic ready');
    } catch (err) {
      this.keysChar  = null;
      log('KEYS characteristic missing', err?.message || err);
    }

    this.dispatchEvent(new CustomEvent('connected', {
      detail: {
        deviceName: this.device?.name || '',
        touch: !!this.touchChar, keys: !!this.keysChar, consent: this.consentOk
      }
    }));
    this._startRssiWatch();
  }

  async _helloAndConsent() {
    const svc  = await this.server.getPrimaryService(UUID.OTA_SVC);
    log('OTA service acquired for consent handshake');
    dbg.log('hello:svc', { uuid: UUID.OTA_SVC });
    const ctrl = await svc.getCharacteristic(UUID.INFO_CTRL);
    const stat = await svc.getCharacteristic(UUID.STATUS);

    await stat.startNotifications();
    log('STATUS notifications started (consent flow)');
    dbg.log('hello:statusNotifications', { ok: true });

    const ok = await new Promise(async (resolve) => {
      const onStatus = (ev) => {
        const v = new Uint8Array(ev.target.value.buffer)[0];
        if (v === 0xA1) { stat.removeEventListener('characteristicvaluechanged', onStatus); resolve(true); }
        if (v === 0xA0) { stat.removeEventListener('characteristicvaluechanged', onStatus); resolve(false); }
      };
      stat.addEventListener('characteristicvaluechanged', onStatus);
      log('Sending HELLO_WEB');
      dbg.log('hello:write', { op: 'HELLO_WEB' });
      await ctrl.writeValue(Uint8Array.from([0x41])); // HELLO_WEB
      setTimeout(()=>resolve(false), 25000);
    });

    log('Consent status', ok ? 'granted' : 'denied or timeout');
    dbg.log('hello:result', { ok });
    if (!ok) throw new Error('Device denied consent or timed out.');
    this.consentOk = true;
  }

  async _getAllChars() {
    log('Binding OTA service characteristics');
    this.service    = await withRetry(() => this.server.getPrimaryService(UUID.OTA_SVC));
    this.chSettings = await withRetry(() => this.service.getCharacteristic(UUID.INFO_SETTINGS));
    this.chStats    = await withRetry(() => this.service.getCharacteristic(UUID.INFO_STATS));
    this.chCtrl     = await withRetry(() => this.service.getCharacteristic(UUID.INFO_CTRL));
    log('Core info characteristics ready', {
      settings: !!this.chSettings,
      stats: !!this.chStats,
      ctrl: !!this.chCtrl,
    });
    try {
      this.chParts = await withRetry(() => this.service.getCharacteristic(UUID.INFO_PARTS));
      log('INFO_PARTS characteristic ready');
    } catch (err) {
      this.chParts = null;
      log('INFO_PARTS characteristic missing', err?.message || err);
    }
    try {
      this.chIntentions = await withRetry(() => this.service.getCharacteristic(UUID.INFO_INTENTIONS));
      log('INFO_INTENTIONS characteristic ready');
    } catch (err) {
      this.chIntentions = null;
      log('INFO_INTENTIONS characteristic missing', err?.message || err);
    }
    try {
      this.chIntentEntry = await withRetry(() => this.service.getCharacteristic(UUID.INFO_INTENT_ENTRY));
      log('INFO_INTENT_ENTRY characteristic ready');
    } catch (err) {
      this.chIntentEntry = null;
      log('INFO_INTENT_ENTRY characteristic missing', err?.message || err);
    }
    try {
      this.chIntentionsBin = await withRetry(() => this.service.getCharacteristic(UUID.INTENTIONS_BIN));
      log('INTENTIONS_BIN characteristic ready');
    } catch (err) {
      this.chIntentionsBin = null;
      log('INTENTIONS_BIN characteristic missing', err?.message || err);
    }
    try {
      this.chUi = await withRetry(() => this.service.getCharacteristic(UUID.INFO_UI));
      log('INFO_UI characteristic ready');
    } catch (err) {
      this.chUi = null;
      log('INFO_UI characteristic missing', err?.message || err);
    }
    try {
      this.chAppPairing = await withRetry(() => this.service.getCharacteristic(UUID.APP_PAIRING));
      log('APP_PAIRING characteristic ready');
    } catch (err) {
      this.chAppPairing = null;
      log('APP_PAIRING characteristic missing', err?.message || err);
    }
  }

  async reacquire() {
    log('Reacquiring OTA characteristics');
    dbg.log('reacquire', {});
    await sleep(200);
    await this._getAllChars();
  }

  async robustRead(ch) {
    try { return await readWithRetry(ch); }
    catch (e1) {
      dbg.error('robustRead:read1', e1);
      await this.reacquire();
      try { return await readWithRetry(ch); }
      catch (e2) {
        dbg.error('robustRead:read2', e2);
        try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch {}
        await sleep(250);
        dbg.log('robustRead:reconnect', {});
        this.server = await this.device.gatt.connect();
        await sleep(300);
        await this._getAllChars();
        return await readWithRetry(ch);
      }
    }
  }

  async waitReady(timeoutMs = 4000) {
    const start = Date.now();
    while (!this.readyFlag) {
      if (Date.now() - start > timeoutMs) {
        const err = new Error('BLE pacing timeout');
        dbg.error('waitReady:timeout', err, { timeoutMs });
        throw err;
      }
      await sleep(30);
    }
    this.readyFlag = false; // consume a permit
  }

  async disconnect() {
    try {
      if (this.device && this.device.gatt.connected) {
        log('Disconnecting GATT', { name: this.device.name || '', id: this.device.id || '' });
        dbg.log('disconnect', { name: this.device?.name || '', id: this.device?.id || '' });
        await this.device.gatt.disconnect();
      }
    }
    finally { this._onDisconnected(); }
  }

  async requestUiCommand(command, args = {}) {
    if (!this.chUi || !this.chCtrl) throw new Error('Firmware UI command channel unavailable.');
    await this.chUi.startNotifications();
    const requestText = JSON.stringify({ cmd: command, ...args });
    const request = new Uint8Array([UI_CTRL_JSON, ...new TextEncoder().encode(requestText)]);
    const decode = (value) => {
      try {
        const text = new TextDecoder().decode(
          value instanceof DataView
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(value.buffer ?? value)
        ).split('\0')[0];
        const parsed = JSON.parse(text);
        return parsed?.cmd === command ? parsed : null;
      } catch {
        return null;
      }
    };

    return await new Promise(async (resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.chUi?.removeEventListener('characteristicvaluechanged', onValue);
        fn(value);
      };
      const onValue = (ev) => {
        const parsed = decode(ev.target.value);
        if (parsed) finish(resolve, parsed);
      };
      const timer = setTimeout(() => finish(reject, new Error(`Timed out waiting for firmware command ${command}.`)), 3500);
      this.chUi.addEventListener('characteristicvaluechanged', onValue);
      try {
        await this.chCtrl.writeValue(request);
        for (let i = 0; i < 20 && !done; i++) {
          await sleep(120);
          try {
            const parsed = decode(await this.chUi.readValue());
            if (parsed) finish(resolve, parsed);
          } catch {}
        }
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  async checkAppPairing(token) {
    const result = await this._writeAppPairingAndWait(new Uint8Array([APP_CHECK_PAIR, ...token]), [APP_PAIR_OK, APP_DENIED, APP_INVALID], 6000);
    return result?.[0] === APP_PAIR_OK;
  }

  async pairDashboardToken(token) {
    const result = await this._writeAppPairingAndWait(new Uint8Array([APP_PAIR, ...token]), [APP_PAIR_OK, APP_DENIED, APP_INVALID], 25000);
    if (result?.[0] !== APP_PAIR_OK) throw new Error('Dashboard pairing was not approved on the rosary, or no pairing slot is free.');
  }

  async readAppPairingSlots(token) {
    const payload = token?.length
      ? new Uint8Array([APP_LIST_SLOTS, ...token])
      : new Uint8Array([APP_LIST_SLOTS]);
    const result = await this._writeAppPairingAndWait(payload, [APP_SLOT_LIST, APP_DENIED, APP_INVALID], 6000);
    if (!result || result[0] !== APP_SLOT_LIST || result.length < 4) return [];
    const count = result[1];
    const slots = [];
    let offset = 4;
    for (let i = 0; i < count && offset + 5 < result.length; i++) {
      const slot = result[offset];
      const fp = (result[offset + 1] | (result[offset + 2] << 8) | (result[offset + 3] << 16) | (result[offset + 4] << 24)) >>> 0;
      const current = result[offset + 5] !== 0;
      slots.push({ slot, fingerprint: fp.toString(16).padStart(8, '0').toUpperCase(), current });
      offset += 6;
    }
    return slots;
  }

  async deleteAppPairingSlot(token, slot) {
    const payload = token?.length
      ? new Uint8Array([APP_DELETE_SLOT, ...token, slot & 0xff])
      : new Uint8Array([APP_DELETE_SLOT, slot & 0xff]);
    const result = await this._writeAppPairingAndWait(payload, [APP_SLOT_DELETED, APP_CURRENT_PROTECTED, APP_DENIED, APP_INVALID], 6000);
    if (result?.[0] === APP_SLOT_DELETED) return true;
    if (result?.[0] === APP_CURRENT_PROTECTED) throw new Error('The current dashboard pairing cannot be deleted here.');
    throw new Error('The rosary did not confirm that the paired app was removed.');
  }

  async _writeAppPairingAndWait(payload, acceptedStatuses, timeoutMs = 6000) {
    if (!this.chAppPairing) throw new Error('Firmware app-pairing management unavailable.');
    await this.chAppPairing.startNotifications();
    return await new Promise(async (resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.chAppPairing?.removeEventListener('characteristicvaluechanged', onValue);
        fn(value);
      };
      const onValue = (ev) => {
        const bytes = new Uint8Array(ev.target.value.buffer, ev.target.value.byteOffset, ev.target.value.byteLength);
        if (bytes.length && acceptedStatuses.includes(bytes[0])) finish(resolve, Array.from(bytes));
      };
      const timer = setTimeout(() => finish(reject, new Error('Timed out waiting for app-pairing response.')), timeoutMs);
      this.chAppPairing.addEventListener('characteristicvaluechanged', onValue);
      try {
        await this.chAppPairing.writeValue(payload);
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  async _startRssiWatch() {
    const dev = this.device;
    if (!dev || typeof dev.watchAdvertisements !== 'function') return;
    try {
      dev.addEventListener('advertisementreceived', (event) => {
        if (typeof event.rssi === 'number') {
          this.rssi = event.rssi;
          this.dispatchEvent(new CustomEvent('rssi', { detail: { rssi: this.rssi } }));
        }
      });
      await dev.watchAdvertisements();
    } catch (err) {
      log('RSSI watch unavailable', err?.message || err);
    }
  }

  async requestConsent() {
    log('requestConsent: re-running HELLO handshake');
    this.consentOk = false;
    await this._helloAndConsent();
    try {
      await this._getAllChars();
    } catch (err) {
      log('requestConsent: reacquire chars failed', err?.message || err);
    }
    return this.consentOk;
  }

  _onDisconnected() {
    log('GATT disconnected');
    dbg.log('disconnected', {});
    this.dispatchEvent(new CustomEvent('disconnected'));
  }
}
