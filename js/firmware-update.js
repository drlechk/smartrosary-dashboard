const INSTALLER_URL = 'https://drlechk.github.io/smartrosary-web-installer/';

const CANDIDATE_SOURCES = [
  { url: INSTALLER_URL, kind: 'html' },
  { url: new URL('version.js', INSTALLER_URL).toString(), kind: 'js' },
  { url: new URL('manifest.json', INSTALLER_URL).toString(), kind: 'json' },
  { url: new URL('esp-web-tools-manifest.json', INSTALLER_URL).toString(), kind: 'json' },
  { url: new URL('firmware/manifest.json', INSTALLER_URL).toString(), kind: 'json' },
  { url: new URL('version.json', INSTALLER_URL).toString(), kind: 'json' },
  { url: new URL('latest.json', INSTALLER_URL).toString(), kind: 'json' },
];

let latestCache = null; // { atMs, value: { version, releaseMessage, breakingChanges, sourceUrl } }
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

export function breakingChangesApply(breakingChanges, currentVersion) {
  if (!breakingChanges || typeof breakingChanges !== 'object') return false;
  const versions = breakingChanges.versions;
  if (!versions || typeof versions !== 'object') return false;
  const current = normalizeVersionString(currentVersion);
  if (!current) return false;

  const before = versions.before ?? versions.lt ?? versions.maxExclusive;
  if (before != null) {
    const cmp = compareVersions(current, before);
    if (cmp == null || cmp >= 0) return false;
  }

  const from = versions.from ?? versions.gte ?? versions.minInclusive;
  if (from != null) {
    const cmp = compareVersions(current, from);
    if (cmp == null || cmp < 0) return false;
  }

  const through = versions.through ?? versions.lte ?? versions.maxInclusive;
  if (through != null) {
    const cmp = compareVersions(current, through);
    if (cmp == null || cmp > 0) return false;
  }

  return before != null || from != null || through != null;
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

function extractVersionFromText(text) {
  if (!text || typeof text !== 'string') return null;

  const smartRosaryVersion = text.match(/\bSMARTROSARY_VERSION\s*=\s*["'`]([^"'`]+)["'`]/i);
  const smartRosaryVersionNorm = normalizeVersionString(smartRosaryVersion?.[1]);
  if (smartRosaryVersionNorm) return smartRosaryVersionNorm;

  const scripted = text.match(/\bFW_VERSION\s*=\s*["'`]([^"'`]+)["'`]/i);
  const scriptedNorm = normalizeVersionString(scripted?.[1]);
  if (scriptedNorm) return scriptedNorm;

  const heading = text.match(/Upload firmware\s+v?(\d+(?:\.\d+){0,3})/i);
  const headingNorm = normalizeVersionString(heading?.[1]);
  if (headingNorm) return headingNorm;

  return null;
}

function extractJsonAssignmentFromText(text, name) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(new RegExp(`${name}\\s*=\\s*(\\{[\\s\\S]*?\\});`, 'i'));
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      console.warn(`Failed to parse ${name}`, e);
    }
  }
  return null;
}

function extractReleaseMessageFromText(text) {
  return extractJsonAssignmentFromText(text, 'SMARTROSARY_RELEASE_MESSAGE');
}

function extractBreakingChangesFromText(text) {
  return extractJsonAssignmentFromText(text, 'SMARTROSARY_BREAKING_CHANGES');
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

export async function getLatestFirmwareVersion({ maxAgeMs = 10 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (latestCache && (now - latestCache.atMs) < maxAgeMs) return latestCache.value;
  if (latestInFlight) return await latestInFlight;

  latestInFlight = (async () => {
    let best = null;
    let lastErr = null;
    for (const source of CANDIDATE_SOURCES) {
      try {
        let version = null;
        let releaseMessage = null;
        let breakingChanges = null;
        if (source.kind === 'json') {
          const json = await fetchJson(source.url);
          version = extractVersionFromManifest(json);
          releaseMessage = json.releaseMessage || null;
          breakingChanges = json.breakingChanges || null;
        } else {
          const text = await fetchText(source.url);
          version = extractVersionFromText(text);
          releaseMessage = extractReleaseMessageFromText(text);
          breakingChanges = extractBreakingChangesFromText(text);
        }

        if (version) {
          const value = { version, releaseMessage, breakingChanges, sourceUrl: source.url };
          if (!best || compareVersions(best.version, version) < 0) {
            best = value;
          }
        }
      } catch (err) {
        lastErr = err;
      }
    }
    if (best) {
      latestCache = { atMs: Date.now(), value: best };
      return best;
    }
    throw lastErr || new Error('No firmware version found');
  })();

  try {
    return await latestInFlight;
  } finally {
    latestInFlight = null;
  }
}
