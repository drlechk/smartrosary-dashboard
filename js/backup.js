import { u8ToStr, sleep, downloadBlob } from './utils.js';

export async function doBackup({ chSettings, chParts, chStats, statusEl, i18nL, robustRead }) {
  if (!chStats || !chSettings) return;
  statusEl.textContent = i18nL.backupStart();

  await sleep(150);

  const vSettings = await robustRead(chSettings);

  let vParts = null;
  if (chParts) {
    try { vParts = await robustRead(chParts); }
    catch (e) { console.warn('parts read skipped:', e); }
  }

  await sleep(80);
  const vStats = await robustRead(chStats);

  let jsStats, jsSettings;
  let rawStats = u8ToStr(vStats);
  let rawSettings = u8ToStr(vSettings);
  try {
    jsStats = JSON.parse(rawStats);
  } catch (err) {
    console.warn('[backup] stats JSON parse failed', err, rawStats);
    throw err;
  }

  const healers = [
    (raw) => {
      const idx = raw.indexOf('"entries":"');
      if (idx < 0) return null;
      return `${raw.slice(0, idx + 11)}""}}`;
    },
    (raw) => {
      const idx = raw.indexOf(',"intentions"');
      if (idx < 0) return null;
      return `${raw.slice(0, idx)}}`;
    },
    (raw) => {
      const idx = raw.indexOf('"intentions"');
      if (idx < 0) return null;
      return `${raw.slice(0, idx - 1)}}`;
    }
  ];

  for (let i = 0; i <= healers.length; i++) {
    try {
      jsSettings = JSON.parse(rawSettings);
      const myst = jsSettings?.mystery;
      if (myst && typeof myst === 'object') {
        if (Object.prototype.hasOwnProperty.call(myst, 'sel')) {
          myst.selection = myst.selection ?? myst.sel;
          delete myst.sel;
        }
        if (Object.prototype.hasOwnProperty.call(myst, 'iSel')) {
          myst.intentionSelected = myst.intentionSelected ?? !!myst.iSel;
          delete myst.iSel;
        }
      }
      break;
    } catch (err) {
      if (i === healers.length) {
        console.warn('[backup] settings JSON parse failed', err, rawSettings);
        throw err;
      }
      const healed = healers[i](rawSettings);
      if (!healed) {
        console.warn('[backup] settings healer', i + 1, 'not applicable');
        throw err;
      }
      console.warn(`[backup] applying settings healer #${i + 1}`);
      rawSettings = healed;
    }
  }

  const d = jsStats?.durations || {};
  const beadSum = Number(d.totalBeadMs ?? 0);
  const decSum  = Number(d.totalDecadeMs ?? 0);
  const rosSum  = Number(d.totalRosaryMs ?? 0);
  const chapSum = Number(d.totalChapletMs ?? 0);

  let beadCnt = Number(d.beadIntervals || 0);
  let decCnt  = Number(d.decadeCount   || 0);
  let rosCnt  = Number(d.rosaryCount   || 0);
  let chapCnt = Number(jsStats.totals?.chaplets ?? d.chapletCount ?? 0);

  if (!beadCnt) { const avg = Number(d.avgBeadMs || 0);    beadCnt = avg>0 ? Math.floor(beadSum/avg) : 0; }
  if (!decCnt)  { const avg = Number(d.avgDecadeMs || 0);  decCnt  = avg>0 ? Math.floor(decSum/avg) : 0; }
  if (!rosCnt)  { const avg = Number(d.avgRosaryMs || 0);  rosCnt  = avg>0 ? Math.floor(rosSum/avg) : 0; }
  if (!chapCnt) { const avg = Number(d.avgChapletMs || 0); chapCnt = avg>0 ? Math.floor(chapSum/avg) : 0; }

  jsStats.durations = {
    ...d,
    beadIntervals: beadCnt,
    decadeCount:   decCnt,
    rosaryCount:   rosCnt,
    chapletCount:  chapCnt,
    totalBeadMs:   String(beadSum),
    totalDecadeMs: String(decSum),
    totalRosaryMs: String(rosSum),
    totalChapletMs:String(chapSum)
  };

  const out = {
    device:    jsStats.device || '',
    fwVersion: jsSettings.fwVersion || '',
    stats:     jsStats,
    settings:  jsSettings,
    setsParts: null
  };

  if (vParts) {
    try {
      const jp = JSON.parse(u8ToStr(vParts));
      out.setsParts = jp.setsParts || null;
    } catch(e) { console.warn('Parts JSON parse skipped:', e); }
  }

  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  downloadBlob(blob, (out.device || 'rosary') + '_backup.json');

  statusEl.textContent = i18nL.backupDone;
}
