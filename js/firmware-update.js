const INSTALLER_URL = 'https://drlechk.github.io/smartrosary-web-installer/';

const CANDIDATE_URLS = [
  new URL('manifest.json', INSTALLER_URL).toString(),
  new URL('esp-web-tools-manifest.json', INSTALLER_URL).toString(),
  new URL('firmware/manifest.json', INSTALLER_URL).toString(),
  new URL('version.json', INSTALLER_URL).toString(),
  new URL('latest.json', INSTALLER_URL).toString(),
];

let latestCache = null; // { atMs, value: { version, sourceUrl } }
let latestInFlight = null;

export function getInstallerUrl() {
  return INSTALLER_URL;
}

export function normalizeVersionString(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Common forms: "v1.2.3", "1.2.3", "1.2.3+meta", "1.2.3-beta.1"
  const m = raw.match(/v?(\d+(?:\.\d+){0,3})(?:[+\-].*)?$/i);
  if (m?.[1]) return m[1];

  // Fallback: find first x.y(.z) sequence anywhere
  const m2 = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m2) return null;
  const parts = [m2[1], m2[2], m2[3], m2[4]].filter((p) => p != null);
  return parts.join('.');
}

export function compareVersions(a, b) {
  const av = normalizeVersionString(a);
  const bv = normalizeVersionString(b);
  if (!av || !bv) return null;

  const ap = av.split('.').map((x) => Number(x) || 0);
  const bp = bv.split('.').map((x) => Number(x) || 0);
  const n = Math.max(ap.length, bp.length, 3);
  for (let i = 0; i < n; i++) {
    const ai = ap[i] ?? 0;
    const bi = bp[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

export function isUpdateAvailable(current, latest) {
  const cmp = compareVersions(current, latest);
  return cmp != null && cmp < 0;
}

function extractVersionFromManifest(json) {
  if (!json || typeof json !== 'object') return null;

  const direct = json.version ?? json.firmwareVersion ?? json.latest ?? json.tag;
  const directNorm = normalizeVersionString(direct);
  if (directNorm) return directNorm;

  // Some manifests might embed version info under "firmware" / "release"
  const nestedCandidates = [
    json.firmware?.version,
    json.release?.version,
    json.release?.tag,
    json.metadata?.version,
  ];
  for (const c of nestedCandidates) {
    const norm = normalizeVersionString(c);
    if (norm) return norm;
  }

  return null;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function getLatestFirmwareVersion({ maxAgeMs = 10 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (latestCache && (now - latestCache.atMs) < maxAgeMs) return latestCache.value;
  if (latestInFlight) return await latestInFlight;

  latestInFlight = (async () => {
    let lastErr = null;
    for (const url of CANDIDATE_URLS) {
      try {
        const json = await fetchJson(url);
        const version = extractVersionFromManifest(json);
        if (version) {
          const value = { version, sourceUrl: url };
          latestCache = { atMs: Date.now(), value };
          return value;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('No firmware version found');
  })();

  try {
    return await latestInFlight;
  } finally {
    latestInFlight = null;
  }
}

