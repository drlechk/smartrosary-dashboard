import { withRetry, readWithRetry, sleep } from './utils.js';

// UUIDs (unchanged; must match firmware)
export const UUID = {
  OTA_SVC:          '12345678-1234-5678-1234-56789abcdef0',
  FS_SVC:           '12345678-1234-5678-1234-56789abcf000',
  INFO_STATS:       'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1001',
  INFO_SETTINGS:    'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1002',
  INFO_CTRL:        'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e10ff',
  INFO_PARTS:       'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1003',
  INFO_INTENTIONS:  'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1010',
  INFO_INTENT_ENTRY:'b8a7a0e2-1a5d-4c1e-9d93-2c9e2b9e1011',
  TOUCH_CHAR:       '12345678-1234-5678-1234-56789abcdea1',
  KEYS_CHAR:        '12345678-1234-5678-1234-56789abcdea2',
  AUTH_INFO:        '8b40f200-78e7-4a6b-b1d3-6b5f3a10a201',
  AUTH_CTRL:        '8b40f201-78e7-4a6b-b1d3-6b5f3a10a201',
  STATUS:           '12345678-1234-5678-1234-56789abcdef2',
};

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
    this.statusChar = null;

    this.chAuthInfo = null;
    this.chAuthCtrl = null;

    this.touchChar = null;
    this.keysChar = null;

    this.readyFlag = true;
    this.consentOk = false;
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available. On iOS, use the Bluefy app.');

    let dev;
    try {
      dev = await navigator.bluetooth.requestDevice({
        filters: [{ services: [UUID.OTA_SVC] }],
        optionalServices: [UUID.OTA_SVC, UUID.FS_SVC],
      });
    } catch {
      dev = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [UUID.OTA_SVC, UUID.FS_SVC],
      });
      if (!dev.name || !dev.name.toLowerCase().startsWith('rosary')) {
        throw new Error('Please pick your Rosary device.');
      }
    }

    this.device = dev;
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());

    this.server = await dev.gatt.connect();
    await this._helloAndConsent();

    // settle for Android
    await sleep(300);

    await this._getAllChars();

    // STATUS pacing
    this.statusChar = await withRetry(() => this.service.getCharacteristic(UUID.STATUS));
    await this.statusChar.startNotifications();
    this.statusChar.addEventListener('characteristicvaluechanged', (ev) => {
      const dv = ev.target.value;
      const v = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)[0];
      if (v === 0x01) this.readyFlag = true;  // READY tick from FW
    });

    // optional remote ctrl
    try { this.touchChar = await withRetry(() => this.service.getCharacteristic(UUID.TOUCH_CHAR)); } catch { this.touchChar = null; }
    try { this.keysChar  = await withRetry(() => this.service.getCharacteristic(UUID.KEYS_CHAR));  } catch { this.keysChar  = null; }

    this.dispatchEvent(new CustomEvent('connected', {
      detail: {
        deviceName: this.device?.name || '',
        touch: !!this.touchChar, keys: !!this.keysChar, consent: this.consentOk
      }
    }));
  }

  async _helloAndConsent() {
    const svc  = await this.server.getPrimaryService(UUID.OTA_SVC);
    const ctrl = await svc.getCharacteristic(UUID.INFO_CTRL);
    const stat = await svc.getCharacteristic(UUID.STATUS);

    await stat.startNotifications();

    const ok = await new Promise(async (resolve) => {
      const onStatus = (ev) => {
        const dv = ev.target.value;
        const v = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)[0];
        if (v === 0xA1) { stat.removeEventListener('characteristicvaluechanged', onStatus); resolve(true); }
        if (v === 0xA0) { stat.removeEventListener('characteristicvaluechanged', onStatus); resolve(false); }
      };
      stat.addEventListener('characteristicvaluechanged', onStatus);
      await ctrl.writeValue(Uint8Array.from([0x41])); // HELLO_WEB
      setTimeout(()=>resolve(false), 25000);
    });

    if (!ok) throw new Error('Device denied consent or timed out.');
    this.consentOk = true;
  }

  async _getAllChars() {
    this.service    = await withRetry(() => this.server.getPrimaryService(UUID.OTA_SVC));
    this.chSettings = await withRetry(() => this.service.getCharacteristic(UUID.INFO_SETTINGS));
    this.chStats    = await withRetry(() => this.service.getCharacteristic(UUID.INFO_STATS));
    this.chCtrl     = await withRetry(() => this.service.getCharacteristic(UUID.INFO_CTRL));
    try { this.chParts = await withRetry(() => this.service.getCharacteristic(UUID.INFO_PARTS)); } catch { this.chParts = null; }
    try { this.chIntentions = await withRetry(() => this.service.getCharacteristic(UUID.INFO_INTENTIONS)); } catch { this.chIntentions = null; }
    try { this.chIntentEntry = await withRetry(() => this.service.getCharacteristic(UUID.INFO_INTENT_ENTRY)); } catch { this.chIntentEntry = null; }

    // auth (optional)
    try { this.chAuthInfo = await withRetry(() => this.service.getCharacteristic(UUID.AUTH_INFO)); } catch { this.chAuthInfo = null; }
    try { this.chAuthCtrl = await withRetry(() => this.service.getCharacteristic(UUID.AUTH_CTRL)); } catch { this.chAuthCtrl = null; }
  }

  async reacquire() {
    await sleep(200);
    await this._getAllChars();
  }

  async robustRead(ch) {
    try { return await readWithRetry(ch); }
    catch (e1) {
      await this.reacquire();
      try { return await readWithRetry(ch); }
      catch (e2) {
        try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch {}
        await sleep(250);
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
      if (Date.now() - start > timeoutMs) throw new Error('BLE pacing timeout');
      await sleep(30);
    }
    this.readyFlag = false; // consume a permit
  }

  async disconnect() {
    try { if (this.device && this.device.gatt.connected) await this.device.gatt.disconnect(); }
    finally { this._onDisconnected(); }
  }

  _onDisconnected() {
    this.dispatchEvent(new CustomEvent('disconnected'));
  }
}
