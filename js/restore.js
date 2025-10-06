import { enc, le16, le32, le64Big, packKV, encSize, writeGatt } from './utils.js';

const OP_SET_PREF = 0x50;
const OP_SET_STAT = 0x53;
const OP_REST_DONE = 0x55;
const OP_REST_BEGIN = 0x54;

export async function restoreFromJson(js, { chCtrl, waitReady, writePrefKey, writeStatKey, onProgress }) {
  const prefs = js.settings || js.prefs || {};
  const stAll = js.stats || {};

  const totalsObj = stAll.totals || {};
  const lastObj   = stAll.lastMystery || {};
  const setsObj   = stAll.sets || {};
  const ringArr   = stAll.ring || [];
  const partsObj  = js.setsParts || stAll.setsParts || {};
  const durObj    = stAll.durations || {};

  const setMap = { None:0, Joyful:1, Luminous:2, Sorrowful:3, Glorious:4, Chaplet:5 };
  const order = ['none','joyful','luminous','sorrowful','glorious'];

  const totalSteps = 15 + 5 + 3 + 2 + 30 + 5 + (5*5) + 8;
  let step=0; const tick = ()=>onProgress?.(++step, totalSteps);

  // PREPASS: compute totalBytes for RESTORE_BEGIN
  let totalBytes = 0;
  const sumKV = (key, type, value) => { totalBytes += key.length + encSize(type, value); };

  // prefs booleans
  sumKV("haptic-en",     0x01, !!prefs.haptic);
  sumKV("m-preset-en",   0x01, !!(prefs.mystery?.preset));
  sumKV("m-autosave-en", 0x01, !!(prefs.mystery?.autosave));
  sumKV("m-intro-en",    0x01, !!(prefs.mystery?.intro));
  const mysteryIntentSel = prefs.mystery?.intentionSelected ?? prefs.mystery?.iSel;
  sumKV("m-intention",   0x01, !!mysteryIntentSel);
  sumKV("i-en",          0x01, !!(prefs.intentions?.enabled));

  // prefs ints
  sumKV("disp-bright",   0x21, prefs.display?.brightness ?? 0);
  sumKV("disp-rot",      0x21, prefs.display?.rotation ?? 0);
  sumKV("wall-bright",   0x21, prefs.wallpaper?.brightness ?? 0);
  sumKV("ImageIndex",    0x21, prefs.wallpaper?.imageIndex ?? 0);
  sumKV("beadIndex",     0x21, prefs.mystery?.beadIndex ?? -1);
  sumKV("m-pos",         0x21, prefs.mystery?.pos ?? 0);
  sumKV("m-part",        0x21, prefs.mystery?.part ?? 0);
  const mysterySelection = prefs.mystery?.selection ?? prefs.mystery?.sel ?? 0;
  sumKV("m-select",      0x21, mysterySelection);
  sumKV("i-pos",         0x21, prefs.intentions?.pos ?? 0);

  // stats scalars
  sumKV("beads",    0x14, totalsObj.beads    ?? 0);
  sumKV("paters",   0x14, totalsObj.paters   ?? 0);
  sumKV("glorias",  0x14, totalsObj.glorias  ?? 0);
  sumKV("decades",  0x14, totalsObj.decades  ?? 0);
  sumKV("rosaries", 0x14, totalsObj.rosaries ?? 0);

  // last mystery + ts
  sumKV("lastSet", 0x11, setMap[lastObj.set] ?? 0);
  sumKV("lastIdx", 0x11, lastObj.index ?? 0);
  sumKV("lastTs",  0x14, stAll.lastPrayer ?? 0);

  // streak + baseDay
  sumKV("streak",  0x12, stAll.streakDays ?? 0);
  sumKV("baseDay", 0x14, 0);

  // ring[30]
  for (let i=0;i<30;i++) sumKV(`r${String(i).padStart(2,'0')}`, 0x12, ringArr[i] ?? 0);

  // sets totals set0..set4
  for (let si=0; si<5; si++) sumKV(`set${si}`, 0x14, setsObj[order[si]] ?? 0);

  // parts pXY
  for (let si=0; si<5; si++) {
    const arr = partsObj[order[si]] || [0,0,0,0,0];
    for (let pi=0; pi<5; pi++) sumKV(`p${si}${pi}`, 0x14, arr[pi] ?? 0);
  }

  // durations
  sumKV("bSum", 0x18, BigInt(durObj.totalBeadMs   ?? 0));
  sumKV("bInt", 0x14, (durObj.beadIntervals ?? 0));
  sumKV("dSum", 0x18, BigInt(durObj.totalDecadeMs ?? 0));
  sumKV("dCnt", 0x14, (durObj.decadeCount  ?? 0));
  sumKV("rSum", 0x18, BigInt(durObj.totalRosaryMs ?? 0));
  sumKV("rCnt", 0x14, (durObj.rosaryCount  ?? 0));
  sumKV("cSum", 0x18, BigInt(durObj.totalChapletMs ?? 0));
  sumKV("cCnt", 0x14, (stAll.totals?.chaplets ?? durObj.chapletCount ?? 0));

  // RESTORE_BEGIN
  const begin = new Uint8Array(1+2+4);
  begin[0] = OP_REST_BEGIN;
  begin.set(le16(totalSteps), 1);
  begin.set(le32(totalBytes), 3);
  await writeGatt(chCtrl, begin);
  try { await waitReady(); } catch { /* if pacing not started yet, continue */ }

  // PREFS
  await writePrefKey("haptic-en",     0x01, !!prefs.haptic);                     tick();
  await writePrefKey("m-preset-en",   0x01, !!(prefs.mystery?.preset));          tick();
  await writePrefKey("m-autosave-en", 0x01, !!(prefs.mystery?.autosave));        tick();
  await writePrefKey("m-intro-en",    0x01, !!(prefs.mystery?.intro));           tick();
  await writePrefKey("m-intention",   0x01, !!mysteryIntentSel);                   tick();
  await writePrefKey("i-en",          0x01, !!(prefs.intentions?.enabled));      tick();

  await writePrefKey("disp-bright",   0x21, prefs.display?.brightness ?? 0);     tick();
  await writePrefKey("disp-rot",      0x21, prefs.display?.rotation ?? 0);       tick();
  await writePrefKey("wall-bright",   0x21, prefs.wallpaper?.brightness ?? 0);   tick();
  await writePrefKey("ImageIndex",    0x21, prefs.wallpaper?.imageIndex ?? 0);   tick();
  await writePrefKey("beadIndex",     0x21, prefs.mystery?.beadIndex ?? -1);     tick();
  await writePrefKey("m-pos",         0x21, prefs.mystery?.pos ?? 0);            tick();
  await writePrefKey("m-part",        0x21, prefs.mystery?.part ?? 0);           tick();
  await writePrefKey("m-select",      0x21, mysterySelection);                   tick();
  await writePrefKey("i-pos",         0x21, prefs.intentions?.pos ?? 0);         tick();

  // STATS
  await writeStatKey("beads",    0x14, totalsObj.beads    ?? 0); tick();
  await writeStatKey("paters",   0x14, totalsObj.paters   ?? 0); tick();
  await writeStatKey("glorias",  0x14, totalsObj.glorias  ?? 0); tick();
  await writeStatKey("decades",  0x14, totalsObj.decades  ?? 0); tick();
  await writeStatKey("rosaries", 0x14, totalsObj.rosaries ?? 0); tick();

  await writeStatKey("lastSet",  0x11, setMap[lastObj.set] ?? 0); tick();
  await writeStatKey("lastIdx",  0x11, lastObj.index ?? 0);       tick();
  await writeStatKey("lastTs",   0x14, stAll.lastPrayer ?? 0);    tick();

  await writeStatKey("streak",   0x12, stAll.streakDays ?? 0);    tick();
  await writeStatKey("baseDay",  0x14, 0);                        tick();

  for (let i=0;i<30;i++){
    await writeStatKey(`r${String(i).padStart(2,'0')}`, 0x12, ringArr[i] ?? 0); tick();
  }

  for (let si=0; si<5; si++) {
    await writeStatKey(`set${si}`, 0x14, setsObj[order[si]] ?? 0); tick();
  }

  for (let si=0; si<5; si++){
    const arr = partsObj[order[si]] || [0,0,0,0,0];
    for (let pi=0; pi<5; pi++){
      await writeStatKey(`p${si}${pi}`, 0x14, arr[pi] ?? 0); tick();
    }
  }

  await writeStatKey("bSum", 0x18, BigInt(durObj.totalBeadMs   ?? 0)); tick();
  await writeStatKey("bInt", 0x14, (durObj.beadIntervals ?? 0));       tick();
  await writeStatKey("dSum", 0x18, BigInt(durObj.totalDecadeMs ?? 0)); tick();
  await writeStatKey("dCnt", 0x14, (durObj.decadeCount  ?? 0));        tick();
  await writeStatKey("rSum", 0x18, BigInt(durObj.totalRosaryMs ?? 0)); tick();
  await writeStatKey("rCnt", 0x14, (durObj.rosaryCount  ?? 0));        tick();
  await writeStatKey("cSum", 0x18, BigInt(durObj.totalChapletMs ?? 0));                    tick();
  await writeStatKey("cCnt", 0x14, (stAll.totals?.chaplets ?? durObj.chapletCount ?? 0));  tick();

  await writeGatt(chCtrl, new Uint8Array([OP_REST_DONE]));
  await waitReady();
}
