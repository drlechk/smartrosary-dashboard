import { enc, packKV, downloadBlob, writeGatt } from './utils.js';

// For AUTH_SET strings
function authSetFrame(key, strVal) {
  const k = enc.encode(key);
  const v = enc.encode(String(strVal));
  const out = new Uint8Array(3 + k.length + v.length);
  out[0] = 0x61; // AUTH_SET
  out[1] = 0x31; // string
  out[2] = k.length;
  out.set(k, 3);
  out.set(v, 3 + k.length);
  return out;
}

// Ask on-device consent for 'export' or 'restore'
export async function requestKeysConsent({ chCtrl, statusChar, mode='export' }) {
  if (!chCtrl || !statusChar) throw new Error('Control/Status characteristic missing');

  const res = await new Promise(async (resolve) => {
    const onStatus = (ev) => {
      const v = new Uint8Array(ev.target.value.buffer)[0];
      if (v === 0xB1 || v === 0x01) { statusChar.removeEventListener('characteristicvaluechanged', onStatus); resolve(true); }
      if (v === 0xB0) { statusChar.removeEventListener('characteristicvaluechanged', onStatus); resolve(false); }
    };
    statusChar.addEventListener('characteristicvaluechanged', onStatus);

    const modeByte = (mode === 'restore') ? 0x02 : 0x01; // 0x01 export, 0x02 restore
    await writeGatt(chCtrl, Uint8Array.from([0x64, modeByte])); // KEYS_HELLO
    setTimeout(()=>resolve(false), 25000);
  });
  if (!res) throw new Error('On-device key consent denied or timed out.');
}

export async function backupKeys({ chAuthInfo, statusEl, i18nL }) {
  if (!chAuthInfo) throw new Error('Auth info characteristic missing');

  statusEl.textContent = i18nL.backupKeysStart || 'Preparing key export…';
  const v = await chAuthInfo.readValue();
  const js = JSON.parse(new TextDecoder().decode(v));
  if (!js?.id || !js?.pubKey || !js?.privKey) throw new Error('Device did not return full keys.');

  const payload = { id: js.id, pubKey: js.pubKey, privKey: js.privKey };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, (js.id || 'rosary') + '_keys.json');

  statusEl.textContent = i18nL.backupKeysDone || 'Keys downloaded.';
}

export async function restoreKeys({ chAuthCtrl, statusEl, waitReady, id, pubKey, privKey, i18nL }) {
  statusEl.textContent = (i18nL.restoreKeysStart || 'Restoring keys…');

  await writeGatt(chAuthCtrl, Uint8Array.from([0x60]));  // AUTH_BEGIN
  await waitReady();

  await writeGatt(chAuthCtrl, authSetFrame('id', id));         await waitReady();
  await writeGatt(chAuthCtrl, authSetFrame('pubKey', pubKey)); await waitReady();
  await writeGatt(chAuthCtrl, authSetFrame('privKey', privKey)); await waitReady();

  await writeGatt(chAuthCtrl, Uint8Array.from([0x62])); // AUTH_COMMIT
  await waitReady();

  statusEl.textContent = (i18nL.restoreKeysDone || 'Keys restored.');
}
