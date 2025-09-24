import { $ } from './utils.js';

export const LV = { LEFT:2, RIGHT:1, TOP:8, BOTTOM:4 };
export const CMD_CENTER = 16;

export function initRemote({ getTouchChar, getKeysChar, i18nL }) {
  const canvasRC = $('lvgl_canvas');
  const btnUp = $('btnUp'), btnDown = $('btnDown'), btnLeft = $('btnLeft'), btnRight = $('btnRight'), btnCenter = $('btnCenter');
  const rcStatus = $('rcStatus');

  const setDpadEnabled = (en) => [btnUp, btnDown, btnLeft, btnRight, btnCenter].forEach(b => b.disabled = !en);
  const setRemoteMuted = (muted) => canvasRC.closest('.card')?.classList.toggle('remote-muted', muted);

  setDpadEnabled(false);
  setRemoteMuted(true);
  rcStatus.textContent = i18nL.rcInactive;

  function sendTouch(x, y, down) {
    const tc = getTouchChar();
    if (!tc) return;
    const buf = new ArrayBuffer(5);
    const v = new DataView(buf);
    v.setUint16(0, x, false);
    v.setUint16(2, y, false);
    v.setUint8(4, down ? 1 : 0);
    tc.writeValueWithoutResponse(buf).catch(async () => { try { await tc.writeValue(buf); } catch(_){} });
  }

  function sendKey(byte) {
    const kc = getKeysChar();
    if (!kc) return;
    const buf = new Uint8Array([byte & 0xFF]);
    kc.writeValueWithoutResponse(buf).catch(async () => { try { await kc.writeValue(buf); } catch(_){} });
  }

  function canvasXY(e) {
    const r  = canvasRC.getBoundingClientRect();
    const sx = canvasRC.width  / r.width;
    const sy = canvasRC.height / r.height;
    const x  = Math.round((e.clientX - r.left) * sx);
    const y  = Math.round((e.clientY - r.top)  * sy);
    return { x, y };
  }
  function clampToCircle(x, y) {
    const W = canvasRC.width, H = canvasRC.height;
    const cx = W/2, cy = H/2;
    const dx = x - cx, dy = y - cy;
    const r  = Math.min(W, H)/2;
    const d2 = dx*dx + dy*dy;
    if (d2 <= r*r) return { x: Math.round(x), y: Math.round(y) };
    const d = Math.sqrt(d2) || 1;
    const k = r/d;
    return { x: Math.round(cx + dx*k), y: Math.round(cy + dy*k) };
  }

  let rcIsDown = false;
  canvasRC.addEventListener('pointermove', (e) => {
    const {x, y} = canvasXY(e);
    const p = clampToCircle(x, y);
    const down = e.pointerType === 'mouse' ? !!e.buttons : rcIsDown;
    sendTouch(p.x, p.y, down);
    e.preventDefault();
  }, { passive:false });

  canvasRC.addEventListener('pointerdown', (e) => {
    rcIsDown = true; canvasRC.setPointerCapture(e.pointerId);
    const {x, y} = canvasXY(e);
    const p = clampToCircle(x, y);
    sendTouch(p.x, p.y, true);
    e.preventDefault();
  }, { passive:false });

  function rcEndPointer(e){
    rcIsDown = false;
    const {x, y} = canvasXY(e);
    const p = clampToCircle(x, y);
    sendTouch(p.x, p.y, false);
    e.preventDefault();
  }
  ['pointerup','pointercancel','pointerleave'].forEach(evt => canvasRC.addEventListener(evt, rcEndPointer, { passive:false }));
  canvasRC.addEventListener('contextmenu', (e) => e.preventDefault());

  btnUp    .addEventListener('pointerdown', e => { sendKey(LV.TOP);    e.preventDefault(); });
  btnDown  .addEventListener('pointerdown', e => { sendKey(LV.BOTTOM); e.preventDefault(); });
  btnLeft  .addEventListener('pointerdown', e => { sendKey(LV.LEFT);   e.preventDefault(); });
  btnRight .addEventListener('pointerdown', e => { sendKey(LV.RIGHT);  e.preventDefault(); });
  btnCenter.addEventListener('pointerdown', e => { sendKey(CMD_CENTER); e.preventDefault(); });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key === 'Enter' || e.key === ' ') { sendKey(CMD_CENTER); e.preventDefault(); }
    if (e.key === 'ArrowUp')    { sendKey(LV.TOP);    e.preventDefault(); }
    if (e.key === 'ArrowDown')  { sendKey(LV.BOTTOM); e.preventDefault(); }
    if (e.key === 'ArrowLeft')  { sendKey(LV.LEFT);   e.preventDefault(); }
    if (e.key === 'ArrowRight') { sendKey(LV.RIGHT);  e.preventDefault(); }
  });

  // API to update UI when connected
  function onRemoteAvailability({ touch, keys }) {
    setDpadEnabled(!!keys);
    setRemoteMuted(!touch && !keys);
    rcStatus.textContent = (keys
      ? (i18nL.rcReadyTouchKeys || 'Remote ready (touch + keys).')
      : (touch
          ? (i18nL.rcReadyTouchOnly || 'Remote ready (touch only).')
          : (i18nL.rcInactive || 'Touch + D-pad will activate after connecting.')));
  }

  return { onRemoteAvailability };
}
