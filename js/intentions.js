import { $, enc, dec, packKV, le32, globalProgressStart, globalProgressSet, globalProgressDone, progAggregateActive, downloadBlob, openFilePicker } from './utils.js';
import { i18n } from './i18n.js';
import { getLang } from './ui.js';
import { buildIntentionsBin, crc32Bytes } from './intentions-nvs.js';
import { UUID } from './ble.js';

const log = (...args) => {
  try { console.log('[intentions]', ...args); } catch { }
};

const OP_SET_PREF = 0x50;
const TYPE_BOOL = 0x01;
const TYPE_U8 = 0x11;
const TYPE_U32 = 0x14;

const DEFAULT_SET_LABELS = ['None', 'Joyful', 'Sorrowful', 'Glorious', 'Luminous', 'Chaplet'];

const ROW_LIMIT = 32;
const EXPORT_VERSION = 1;
const NVS_FILENAME = 'nvs-intentions.bin';
const NVS_CHUNK_SIZE = 320;

function toUint8(view) {
  if (!view) return new Uint8Array();
  if (view.buffer) {
    return new Uint8Array(view.buffer, view.byteOffset || 0, view.byteLength || 0);
  }
  return new Uint8Array(view);
}

function epochToDateInput(epoch) {
  if (!epoch) return '';
  const d = new Date(epoch * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateInputToEpoch(value) {
  if (!value) return 0;
  const parts = value.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return 0;
  const [year, month, day] = parts;
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

const IL = () => {
  const lang = getLang();
  return (i18n[lang] && i18n[lang].intentions) ? i18n[lang].intentions : i18n.en.intentions;
};

const getMysteryOptions = () => {
  const sets = i18n[getLang()]?.sets || DEFAULT_SET_LABELS;
  const order = [
    { idx: 0, value: 0 }, // None
    { idx: 1, value: 1 }, // Joyful
    { idx: 4, value: 2 }, // Luminous
    { idx: 2, value: 3 }, // Sorrowful
    { idx: 3, value: 4 }, // Glorious
  ];
  return order.map(({ idx, value }) => ({
    value,
    label: sets[idx] || DEFAULT_SET_LABELS[idx],
  }));
};

function defaultMonthStartEpoch(idx) {
  if (idx >= 12) return 0;
  const now = new Date();
  const baseYear = now.getUTCFullYear();
  return Math.floor(Date.UTC(baseYear, idx, 1) / 1000);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function u8(val) {
  const v = Number(val) & 0xff;
  return new Uint8Array([v]);
}

function safeJsonParse(text) {
  if (!text) return { present: false };
  const cleaned = text.replace(/\u0000/g, '').trim();
  if (!cleaned) return { present: false };
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(IL().invalidJson);
  }
}

async function getIntentionsWriteChar(client) {
  if (client.chIntentionsBin) return client.chIntentionsBin;
  try {
    const svc = client.service || (client.server && await client.server.getPrimaryService(UUID.OTA_SVC));
    if (!svc) return null;
    const ch = await svc.getCharacteristic(UUID.INTENTIONS_BIN);
    client.chIntentionsBin = ch;
    return ch;
  } catch (err) {
    console.warn('intentions write char missing', err);
    return null;
  }
}

export function initIntentions({ client, setStatus }) {
  const saveBtn = $('intentionsSaveBtn');
  const downloadBtn = $('intentionsDownloadBtn');
  const restoreBtn = $('intentionsRestoreBtn');
  const restoreInput = $('intentionsRestoreInput');
  const resetBtn = $('intentionsResetBtn');
  const deleteBtn = $('intentionsDeleteBtn');
  const eraseBtn = $('intentionsEraseBtn');
  const autoToggle = $('intentionsAuto');
  const table = $('intentionsTable');
  const tbody = table ? table.querySelector('tbody') : null;
  const emptyState = $('intentionsEmpty');
  const card = $('intentionsCard');

  const state = {
    summary: null,
    entries: [],
    dirty: false,
    available: false,
    busy: false,
  };

  function updateActions() {
    const hasEntries = !!state.entries.length;
    if (saveBtn) saveBtn.disabled = state.busy || !hasEntries || !state.available || !state.dirty;
    if (downloadBtn) downloadBtn.disabled = state.busy || !state.available || !hasEntries;
    if (restoreBtn) restoreBtn.disabled = state.busy || !state.available;
    if (resetBtn) resetBtn.disabled = state.busy || !state.available;
    if (deleteBtn) deleteBtn.disabled = state.busy || !state.available;
    if (eraseBtn) eraseBtn.disabled = state.busy || !state.available;
    if (autoToggle) autoToggle.disabled = state.busy || !hasEntries || !state.available;
  }

  function setBusy(flag) {
    log('setBusy', flag);
    state.busy = flag;
    updateActions();
  }

  function setAvailable(flag, message) {
    log('setAvailable', { available: flag, message });
    const strings = IL();
    state.available = flag;
    if (card) card.classList.toggle('card-muted', !flag);
    if (!flag) {
      showEmpty(message || strings.serviceMissing);
      if (autoToggle) {
        autoToggle.disabled = true;
        autoToggle.checked = false;
      }
      state.summary = null;
      state.entries = [];
      state.dirty = false;
    } else {
      showEmpty(strings.promptLoad);
    }
    updateActions();
  }

  function showEmpty(message) {
    if (table) table.style.display = 'none';
    if (emptyState) {
      emptyState.textContent = message;
      emptyState.style.display = 'block';
    }
  }

  function showTable() {
    if (table) table.style.display = 'table';
    if (emptyState) emptyState.style.display = 'none';
  }

  function resetTable() {
    if (tbody) tbody.innerHTML = '';
    showEmpty(IL().promptLoad);
    updateActions();
  }

  function markDirty() {
    if (!state.available) return;
    state.dirty = true;
    updateActions();
  }

  function clearDirty() {
    state.dirty = false;
    updateActions();
  }

  function renderTable() {
    const strings = IL();
    const tableLabels = strings.table || {};
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!state.entries.length) {
      showEmpty(strings.emptyList);
      return;
    }
    showTable();

    state.entries.forEach((entry) => {
      let updateDisplays = () => { };

      const tr = document.createElement('tr');
      tr.className = 'intentions-row';
      tr.classList.toggle('editing', !!entry.editing);

      const tdIndex = document.createElement('td');
      tdIndex.dataset.label = tableLabels.index ?? '#';
      const indexWrap = document.createElement('div');
      indexWrap.className = 'intentions-index-wrap';
      const indexNumber = document.createElement('span');
      indexNumber.className = 'intentions-index';
      indexNumber.textContent = String(entry.index + 1);
      indexWrap.appendChild(indexNumber);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'intentions-toggle';
      const updateToggleLabel = () => {
        toggleBtn.textContent = entry.editing ? (strings.collapseEdit || 'Collapse') : (strings.editEntry || 'Edit');
        toggleBtn.setAttribute('aria-expanded', entry.editing ? 'true' : 'false');
      };
      updateToggleLabel();
      toggleBtn.addEventListener('click', () => {
        entry.editing = !entry.editing;
        tr.classList.toggle('editing', entry.editing);
        updateToggleLabel();
      });
      indexWrap.appendChild(toggleBtn);
      tdIndex.appendChild(indexWrap);
      tr.appendChild(tdIndex);

      const tdTitle = document.createElement('td');
      tdTitle.className = 'intentions-title-cell';
      tdTitle.dataset.label = tableLabels.title ?? 'Intention';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'intentions-title-wrap';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'intentions-title';
      const titleText = entry.title || strings.fallbackTitle(entry.index + 1);
      titleSpan.textContent = titleText;
      titleSpan.title = titleText;
      titleWrap.appendChild(titleSpan);

      const rawDesc = (entry.desc || '').trim();
      let descRow = null;
      let descToggle = null;

      if (rawDesc.length) {
        const descId = `intent-desc-${entry.index}`;
        descToggle = document.createElement('button');
        descToggle.type = 'button';
        descToggle.className = 'intentions-desc-toggle';
        descToggle.textContent = '▸';
        descToggle.setAttribute('aria-label', strings.descShow);
        descToggle.setAttribute('aria-controls', descId);
        descToggle.setAttribute('aria-expanded', 'false');

        const descCell = document.createElement('td');
        descCell.colSpan = 5;
        descCell.className = 'intentions-desc-cell';

        const descText = document.createElement('div');
        descText.className = 'intentions-desc-text';
        descText.id = descId;
        descText.textContent = rawDesc;
        descText.setAttribute('aria-hidden', 'true');

        descCell.appendChild(descText);
        descRow = document.createElement('tr');
        descRow.className = 'intentions-desc-row';
        descRow.hidden = true;
        descRow.appendChild(descCell);

        descToggle.addEventListener('click', () => {
          const stringsClick = IL();
          const expanded = descToggle.getAttribute('aria-expanded') === 'true';
          const nextState = !expanded;
          descToggle.textContent = nextState ? '▾' : '▸';
          descToggle.setAttribute('aria-expanded', String(nextState));
          descToggle.setAttribute('aria-label', nextState ? stringsClick.descHide : stringsClick.descShow);
          descText.setAttribute('aria-hidden', String(!nextState));
          descRow.hidden = !nextState;
          descRow.classList.toggle('open', nextState);
        });

        indexWrap.appendChild(descToggle);
      }

      tdTitle.appendChild(titleWrap);
      tr.appendChild(tdTitle);

      const tdDate = document.createElement('td');
      tdDate.className = 'intentions-date-cell';
      tdDate.dataset.label = tableLabels.start ?? 'Start Date';
      const inputDate = document.createElement('input');
      inputDate.type = 'date';
      inputDate.value = epochToDateInput(entry.start);
      inputDate.addEventListener('change', () => {
        entry.start = dateInputToEpoch(inputDate.value);
        markDirty();
        updateDisplays();
      });
      const showDatePicker = () => {
        try {
          if (typeof inputDate.showPicker === 'function') {
            inputDate.showPicker();
          }
        } catch {
          // Native picker not available; ignore.
        }
      };
      inputDate.addEventListener('focus', showDatePicker);
      inputDate.addEventListener('click', showDatePicker);
      const dateDisplay = document.createElement('div');
      dateDisplay.className = 'intentions-display';
      const dateEdit = document.createElement('div');
      dateEdit.className = 'intentions-edit';
      dateEdit.appendChild(inputDate);
      tdDate.appendChild(dateDisplay);
      tdDate.appendChild(dateEdit);
      tr.appendChild(tdDate);

      const tdSet = document.createElement('td');
      tdSet.className = 'intentions-set-cell';
      tdSet.dataset.label = tableLabels.set ?? 'Mystery';
      const selectSet = document.createElement('select');
      getMysteryOptions().forEach((opt) => {
        const option = document.createElement('option');
        option.value = String(opt.value);
        option.textContent = opt.label;
        if (opt.value === entry.set) option.selected = true;
        selectSet.appendChild(option);
      });
      const setDisplay = document.createElement('div');
      setDisplay.className = 'intentions-display';
      const setEdit = document.createElement('div');
      setEdit.className = 'intentions-edit';
      setEdit.appendChild(selectSet);
      tdSet.appendChild(setDisplay);
      tdSet.appendChild(setEdit);
      tr.appendChild(tdSet);

      const tdPart = document.createElement('td');
      tdPart.className = 'intentions-part-cell';
      tdPart.dataset.label = tableLabels.part ?? 'Part';
      const selectPart = document.createElement('select');
      const blank = document.createElement('option');
      blank.value = '0';
      blank.textContent = '—';
      selectPart.appendChild(blank);
      for (let i = 1; i <= 5; i++) {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = String(i);
        selectPart.appendChild(option);
      }
      selectPart.value = String(entry.part || 0);
      const partDisplay = document.createElement('div');
      partDisplay.className = 'intentions-display';
      const partEdit = document.createElement('div');
      partEdit.className = 'intentions-edit';
      partEdit.appendChild(selectPart);
      tdPart.appendChild(partDisplay);
      tdPart.appendChild(partEdit);
      tr.appendChild(tdPart);

      updateDisplays = () => {
        dateDisplay.textContent = inputDate.value || '—';
        const selectedSet = selectSet.options[selectSet.selectedIndex];
        setDisplay.textContent = selectedSet ? selectedSet.textContent : '—';
        const partVal = Number(selectPart.value) || 0;
        partDisplay.textContent = partVal ? String(partVal) : '—';
      };
      updateDisplays();

      selectSet.addEventListener('change', () => {
        entry.set = Number(selectSet.value) || 0;
        markDirty();
        updateDisplays();
      });

      selectPart.addEventListener('change', () => {
        entry.part = Number(selectPart.value) || 0;
        markDirty();
        updateDisplays();
      });

      entry.controls = {
        dateInput: inputDate,
        setSelect: selectSet,
        partSelect: selectPart,
        dateDisplay,
        setDisplay,
        partDisplay,
        row: tr,
      };

      tbody.appendChild(tr);
      if (descRow) {
        tbody.appendChild(descRow);
      }
    });
  }

  async function readSummary() {
    if (!client.chIntentions) throw new Error(IL().summaryMissing);
    log('readSummary: request');
    const value = await client.chIntentions.readValue();
    const text = dec.decode(toUint8(value));
    const parsed = safeJsonParse(text);
    log('readSummary: response', parsed);
    return parsed;
  }

  async function readEntry(index) {
    if (!client.chIntentEntry) throw new Error(IL().entryMissing);
    log('readEntry: request', index);
    const buf = new Uint8Array([index & 0xff, (index >> 8) & 0xff]);
    await client.chIntentEntry.writeValue(buf);
    await client.waitReady();
    const value = await client.chIntentEntry.readValue();
    const text = dec.decode(toUint8(value));
    const parsed = safeJsonParse(text);
    log('readEntry: response', { index, parsed });
    return parsed;
  }

  async function refresh({ silent = false, ignoreBusy = false, consentRetry = false } = {}) {
    if (!state.available) return false;
    if (state.busy && !ignoreBusy) return false;
    const alreadyBusy = state.busy;
    if (!alreadyBusy) setBusy(true);
    const strings = IL();
    const progressLabel = strings.statusLoading || 'Loading intentions…';
    const useStandaloneProgress = !silent && !progAggregateActive();
    let standaloneProgressActive = false;
    const updateStandaloneProgress = (pct) => {
      if (!standaloneProgressActive) return;
      try { globalProgressSet(Math.max(0, Math.min(100, pct)), progressLabel); } catch { }
    };
    if (useStandaloneProgress) {
      try {
        globalProgressStart(progressLabel, 100);
        standaloneProgressActive = true;
        updateStandaloneProgress(5);
      } catch {
        standaloneProgressActive = false;
      }
    }
    if (!silent) setStatus(() => IL().statusLoading);
    log('refresh: begin', { silent, ignoreBusy });
    try {
      const summary = await readSummary();
      updateStandaloneProgress(20);
      state.summary = summary;
      state.entries = [];

      if (summary.requireConsent) {
        const consentDefault = 'Allow the dashboard on the device, then try again.';
        const consentMsg =
          strings.consentRequired ||
          consentDefault;
        state.entries = [];
        renderTable();
        clearDirty();
        showEmpty(consentMsg);
        if (autoToggle) autoToggle.checked = false;
        updateActions();
        log('refresh: requireConsent flag from device');
        setStatus(() => IL().consentRequired || consentDefault);
        updateStandaloneProgress(100);
        return false;
      }

      if (!summary.present) {
        resetTable();
        if (autoToggle) autoToggle.checked = false;
        clearDirty();
        const msg = strings.emptySchedule;
        showEmpty(msg);
        if (!silent) setStatus(() => IL().emptySchedule);
        updateStandaloneProgress(100);
        return true;
      }

      const count = Math.min(Number(summary.count) || 0, ROW_LIMIT);
      log('refresh: summary', { count, auto: summary.auto, selected: summary.selected });
      if (!count) {
        state.entries = [];
        renderTable();
        clearDirty();
        showEmpty(strings.emptySchedule);
        if (autoToggle) autoToggle.checked = false;
        updateActions();
        updateStandaloneProgress(100);
        return true;
      }
      const names = typeof summary.names === 'string' ? summary.names.split('\n') : [];
      const schedule = typeof summary.entries === 'string' && summary.entries.length
        ? summary.entries.split(',')
        : [];

      for (let idx = 0; idx < count; idx++) {
        const detail = await readEntry(idx);
        const fallbackTitle = names[idx] || strings.fallbackTitle(idx + 1);
        const scheduleParts = (schedule[idx] || '').split('|');
        const scheduledStart = Number(scheduleParts[0]) || 0;
        const scheduledSet = Number(scheduleParts[1]) || 0;
        const scheduledPart = Number(scheduleParts[2]) || 0;

        let start = detail.start || scheduledStart;
        if (!start && idx < 12) {
          start = defaultMonthStartEpoch(idx);
        }

        state.entries.push({
          index: idx,
          title: detail.title || fallbackTitle,
          desc: detail.desc || '',
          start,
          set: detail.set !== undefined ? detail.set : scheduledSet,
          part: detail.part !== undefined ? detail.part : scheduledPart,
          controls: null,
        });
        if (standaloneProgressActive) {
          const progressBase = 25;
          const progressSpan = 55;
          const pct = progressBase + (count ? ((idx + 1) / count) * progressSpan : progressSpan);
          updateStandaloneProgress(Math.min(85, pct));
        }
      }

      if (autoToggle) autoToggle.checked = !!summary.auto;
      renderTable();
      clearDirty();
      updateActions();
      updateStandaloneProgress(95);

      if (!silent) {
        const selectedIndex = summary.selected != null ? Number(summary.selected) + 1 : null;
        setStatus(() => {
          const s = IL();
          const base = selectedIndex != null ? s.statusSelected(selectedIndex) : s.statusLoaded;
          return `${base}.`;
        });
      }
      updateStandaloneProgress(100);
      log('refresh: completed', { entries: state.entries.length });
      return true;
    } catch (err) {
      console.error(err);
      log('refresh: error', err?.message || err);
      if (!silent) {
        const errMsg = err?.message || String(err);
        setStatus(() => {
          const s = IL();
          const base = s.statusLoadFailed || 'Intentions load failed';
          return `${base}: ${errMsg}`;
        });
      }
      return false;
    } finally {
      if (!alreadyBusy) setBusy(false);
      if (standaloneProgressActive) {
        try { globalProgressDone(400); } catch { }
      }
      log('refresh: end');
    }
  }

  async function writePref(key, type, valueBytes) {
    if (!client.chCtrl) throw new Error('Control characteristic missing');
    const payload = packKV(OP_SET_PREF, type, key, valueBytes);
    await client.chCtrl.writeValue(payload);
    await client.waitReady();
  }

  async function save({ ignoreBusy = false } = {}) {
    if (!state.available || !state.entries.length) return;
    if (state.busy && !ignoreBusy) return;
    const alreadyBusy = state.busy;
    if (!alreadyBusy) setBusy(true);
    const strings = IL();
    const progressLabel = strings.statusSaving || 'Saving intentions schedule…';
    const useStandaloneProgress = !progAggregateActive();
    let standaloneProgressActive = false;
    const updateStandaloneProgress = (pct) => {
      if (!standaloneProgressActive) return;
      try { globalProgressSet(Math.max(0, Math.min(100, pct)), progressLabel); } catch { }
    };
    if (useStandaloneProgress) {
      try {
        globalProgressStart(progressLabel, 100);
        standaloneProgressActive = true;
        updateStandaloneProgress(5);
      } catch {
        standaloneProgressActive = false;
      }
    }
    setStatus(() => IL().statusSaving);
    log('save: begin', { entries: state.entries.length });
    try {
      const total = state.entries.length || 1;
      let index = 0;
      for (const entry of state.entries) {
        const startEpoch = dateInputToEpoch(entry.controls?.dateInput?.value) || entry.start || 0;
        const setVal = Number(entry.controls?.setSelect?.value) || entry.set || 0;
        const partVal = Number(entry.controls?.partSelect?.value) || entry.part || 0;

        entry.start = startEpoch;
        entry.set = setVal;
        entry.part = partVal;

        await writePref(`i${pad2(entry.index)}s`, TYPE_U32, le32(startEpoch >>> 0));
        await writePref(`i${pad2(entry.index)}m`, TYPE_U8, u8(setVal));
        await writePref(`i${pad2(entry.index)}p`, TYPE_U8, u8(partVal));
        index += 1;
        if (standaloneProgressActive) {
          const progressBase = 15;
          const progressSpan = 65;
          const pct = progressBase + ((index / total) * progressSpan);
          updateStandaloneProgress(Math.min(85, pct));
        }
      }

      await writePref('i-cnt', TYPE_U8, u8(state.entries.length));
      await writePref('i-auto', TYPE_BOOL, u8(autoToggle.checked ? 1 : 0));
      updateStandaloneProgress(90);

      state.summary = state.summary || {};
      state.summary.auto = autoToggle.checked;
      clearDirty();
      setStatus(() => IL().statusSavedRefreshing);
      await refresh({ silent: true, ignoreBusy: true });
      setStatus(() => IL().statusUpdated);
      updateStandaloneProgress(100);
      log('save: completed');
    } catch (err) {
      console.error(err);
      log('save: error', err?.message || err);
      const errMsg = err?.message || String(err);
      setStatus(() => {
        const s = IL();
        const base = s.statusSaveFailed || 'Intentions save failed';
        return `${base}: ${errMsg}`;
      });
    } finally {
      if (!alreadyBusy) setBusy(false);
      if (standaloneProgressActive) {
        try { globalProgressDone(450); } catch { }
      }
      log('save: end');
    }
  }

  function buildExportPayload() {
    const entries = state.entries.map((entry, idx) => {
      const startEpoch = dateInputToEpoch(entry.controls?.dateInput?.value) || entry.start || 0;
      const setVal = Number(entry.controls?.setSelect?.value ?? entry.set ?? 0) || 0;
      const partVal = Number(entry.controls?.partSelect?.value ?? entry.part ?? 0) || 0;
      return {
        index: idx,
        start: startEpoch,
        set: setVal,
        part: partVal,
      };
    });
    const summary = state.summary || {};
    return {
      version: EXPORT_VERSION,
      generatedAt: new Date().toISOString(),
      auto: !!summary.auto,
      selected: summary.selected != null ? Number(summary.selected) : null,
      count: entries.length,
      entries,
    };
  }

  function parseRestorePayload(data) {
    if (!data || typeof data !== 'object') throw new Error(IL().invalidJson || 'Invalid JSON payload');
    const rawEntries = Array.isArray(data.entries)
      ? data.entries
      : Array.isArray(data.intentions)
        ? data.intentions
        : null;
    if (!rawEntries || !rawEntries.length) {
      throw new Error(IL().restoreNoEntries || 'No intentions found in file.');
    }
    const existingByIndex = new Map();
    state.entries.forEach((e) => { existingByIndex.set(e.index, e); });
    const strings = IL();
    const normalized = rawEntries.slice(0, ROW_LIMIT).map((entry, idx) => {
      const setVal = Math.max(0, Math.min(5, Number(entry?.set) || 0));
      const partVal = Math.max(0, Math.min(5, Number(entry?.part) || 0));
      let startVal = Number(entry?.start) || 0;
      if (!startVal && idx < 12) {
        startVal = defaultMonthStartEpoch(idx);
      }
      const index = Number.isFinite(entry?.index) ? Number(entry.index) : idx;
      const existing = existingByIndex.get(index);
      const title = existing?.title || strings.fallbackTitle(index + 1);
      const desc = existing?.desc || '';
      return {
        index,
        title,
        desc,
        start: startVal,
        set: setVal,
        part: partVal,
        controls: null,
      };
    });
    normalized.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    normalized.forEach((entry, idx) => { entry.index = idx; });
    const auto = data.auto;
    return { entries: normalized, auto };
  }

  async function downloadIntentions() {
    if (!state.available) {
      alert(IL().connectFirst || 'Connect to the rosary first.');
      return;
    }
    if (state.busy) return;
    if (!state.entries.length) {
      alert(IL().emptyList || 'No intentions found on the device.');
      return;
    }
    const strings = IL();
    try {
      const payload = buildExportPayload();
      setStatus(() => strings.statusDownloading || 'Preparing intentions download…');
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const now = new Date();
      const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
      downloadBlob(blob, `intentions_${stamp}.json`);
      setStatus(() => strings.statusUpdated || 'Intentions updated.');
    } catch (err) {
      console.error(err);
      const errMsg = err?.message || String(err);
      setStatus(() => {
        const base = strings.statusDownloadFailed || 'Intentions download failed';
        return `${base}: ${errMsg}`;
      });
    }
  }

  async function restoreFromData(data) {
    if (!state.available) {
      alert(IL().connectFirst || 'Connect to the rosary first.');
      return;
    }
    if (state.busy) return;
    const strings = IL();

    let parsed = null;
    try {
      parsed = parseRestorePayload(data);
    } catch (err) {
      console.error(err);
      alert(err?.message || (strings.invalidJson || 'Invalid JSON payload'));
      return;
    }

    // Unified restore handles confirmation
    // if (state.dirty && !confirm(strings.confirmDiscard || 'Discard unsaved intention edits?')) return;
    // if (!confirm(strings.confirmRestore || 'Restore and overwrite the intentions schedule from this file?')) return;

    state.entries = parsed.entries;
    state.summary = state.summary || {};
    if (parsed.auto != null) state.summary.auto = !!parsed.auto;
    if (autoToggle) autoToggle.checked = !!state.summary.auto;
    renderTable();
    clearDirty();
    markDirty();

    try {
      setStatus(() => strings.statusRestoring || 'Restoring intentions…');
      await save();
      setStatus(() => strings.statusRestoreDone || strings.statusUpdated || 'Intentions restored.');
    } catch (err) {
      console.error(err);
      const errMsg = err?.message || String(err);
      setStatus(() => {
        const base = strings.statusRestoreFailed || 'Intentions restore failed';
        return `${base}: ${errMsg}`;
      });
    } finally {
      updateActions();
    }
  }

  async function restoreFromFile(file) {
    if (!file) return;
    const strings = IL();
    let data = null;
    try {
      const text = await file.text();
      data = JSON.parse(text);
    } catch (err) {
      console.error(err);
      alert(strings.invalidJson || 'Invalid JSON payload');
      return;
    }
    // Legacy button flow needs confirmation
    if (state.dirty && !confirm(strings.confirmDiscard || 'Discard unsaved intention edits?')) return;
    if (!confirm(strings.confirmRestore || 'Restore and overwrite the intentions schedule from this file?')) return;

    await restoreFromData(data);
  }

  // ... existing uploadIntentionsBin ...

  async function deleteIntentions(skipConfirm = false) {
    if (!state.available || state.busy) return;
    const strings = IL();
    if (!skipConfirm && !confirm(strings.confirmDelete || 'Delete all intentions from the device? This cannot be undone.')) return;
    setBusy(true);
    try {
      setStatus(() => strings.statusDeleting || 'Deleting intentions…');
      const blank = buildIntentionsBin({ numIntentions: 0, iS: '', titles: [], descs: [] });
      await uploadIntentionsBin(blank, { statusLabel: strings.statusDeleting });
      await writePref('i-cnt', TYPE_U8, u8(0));
      await writePref('i-auto', TYPE_BOOL, u8(0));
      state.summary = null;
      state.entries = [];
      renderTable();
      clearDirty();
      showEmpty(strings.emptySchedule || 'No intentions stored on the device.');
      if (autoToggle) autoToggle.checked = false;
      setStatus(() => strings.statusDeleteDone || strings.statusUpdated || 'Intentions deleted.');
    } catch (err) {
      console.error(err);
      const errMsg = err?.message || String(err);
      setStatus(() => {
        const base = strings.statusDeleteFailed || 'Intentions delete failed';
        return `${base}: ${errMsg}`;
      });
    } finally {
      setBusy(false);
      updateActions();
    }
  }




  async function uploadIntentionsBin(data, { statusLabel }) {
    const ch = await getIntentionsWriteChar(client);
    if (!ch) throw new Error('Intentions upload characteristic missing');
    const strings = IL();
    const label = statusLabel || strings.statusDeleting || 'Deleting intentions…';
    const useStandaloneProgress = !progAggregateActive();
    let standaloneProgressActive = false;
    const updateStandaloneProgress = (pct) => {
      if (!standaloneProgressActive) return;
      try { globalProgressSet(Math.max(0, Math.min(100, pct)), label); } catch { }
    };
    if (useStandaloneProgress) {
      try {
        globalProgressStart(label, 100);
        standaloneProgressActive = true;
        updateStandaloneProgress(4);
      } catch {
        standaloneProgressActive = false;
      }
    }
    try {
      await ch.writeValue(enc.encode(NVS_FILENAME));
      await client.waitReady(8000);
      let offset = 0;
      while (offset < data.length) {
        const len = Math.min(NVS_CHUNK_SIZE, data.length - offset);
        const chunk = data.slice(offset, offset + len);
        const pkt = new Uint8Array(len + 4);
        pkt.set(chunk);
        const crc = crc32Bytes(chunk);
        const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
        dv.setUint32(len, crc, true);
        await ch.writeValue(pkt);
        await client.waitReady(8000);
        offset += len;
        const pct = Math.min(95, Math.round((offset / data.length) * 100));
        updateStandaloneProgress(pct);
      }
      updateStandaloneProgress(100);
    } finally {
      if (standaloneProgressActive) {
        try { globalProgressDone(400); } catch { }
      }
    }
  }

  async function resetSchedule(skipConfirm = false) {
    if (!state.available || state.busy) return;
    const strings = IL();
    if (!skipConfirm && !confirm(strings.confirmReset || 'Reset the intentions schedule on the device?')) return;
    if (!state.entries.length) {
      alert(strings.emptyList || 'No intentions found on the device.');
      return;
    }

    // Normalize schedule fields back to defaults but keep titles/descriptions intact.
    state.entries.forEach((entry, idx) => {
      const nextStart = idx < 12 ? defaultMonthStartEpoch(idx) : 0;
      entry.start = nextStart;
      entry.set = 0;
      entry.part = 0;
      if (entry.controls?.dateInput) entry.controls.dateInput.value = epochToDateInput(nextStart);
      if (entry.controls?.setSelect) entry.controls.setSelect.value = '0';
      if (entry.controls?.partSelect) entry.controls.partSelect.value = '0';
    });
    state.summary = state.summary || {};
    state.summary.auto = false;
    if (autoToggle) autoToggle.checked = false;
    markDirty();
    const alreadyBusy = state.busy;
    if (!alreadyBusy) setBusy(true);
    try {
      setStatus(() => strings.statusResetting || 'Resetting intentions…');
      await save({ ignoreBusy: true });
      setStatus(() => strings.statusResetDone || strings.statusUpdated || 'Intentions reset.');
    } catch (err) {
      console.error(err);
      const errMsg = err?.message || String(err);
      setStatus(() => {
        const base = strings.statusResetFailed || 'Intentions reset failed';
        return `${base}: ${errMsg}`;
      });
    } finally {
      if (!alreadyBusy) setBusy(false);
      updateActions();
    }
  }

  async function deleteIntentions() {
    if (!state.available || state.busy) return;
    const strings = IL();
    if (!confirm(strings.confirmDelete || 'Delete all intentions from the device? This cannot be undone.')) return;
    setBusy(true);
    try {
      setStatus(() => strings.statusDeleting || 'Deleting intentions…');
      const blank = buildIntentionsBin({ numIntentions: 0, iS: '', titles: [], descs: [] });
      await uploadIntentionsBin(blank, { statusLabel: strings.statusDeleting });
      await writePref('i-cnt', TYPE_U8, u8(0));
      await writePref('i-auto', TYPE_BOOL, u8(0));
      state.summary = null;
      state.entries = [];
      renderTable();
      clearDirty();
      showEmpty(strings.emptySchedule || 'No intentions stored on the device.');
      if (autoToggle) autoToggle.checked = false;
      setStatus(() => strings.statusDeleteDone || strings.statusUpdated || 'Intentions deleted.');
    } catch (err) {
      console.error(err);
      const errMsg = err?.message || String(err);
      setStatus(() => {
        const base = strings.statusDeleteFailed || 'Intentions delete failed';
        return `${base}: ${errMsg}`;
      });
    } finally {
      setBusy(false);
      updateActions();
    }
  }

  async function eraseIntentionsPartition() {
    if (!state.available || state.busy) return;
    const strings = IL();
    const confirmMsg = strings.confirmErase || 'Delete the entire intentions partition (schedule and entries)? This cannot be undone.';
    if (!confirm(confirmMsg)) return;
    setBusy(true);
    try {
      setStatus(() => strings.statusErasing || 'Erasing intentions partition…');
      const blank = buildIntentionsBin({ numIntentions: 0, iS: '', titles: [], descs: [] });
      await uploadIntentionsBin(blank, { statusLabel: strings.statusErasing });
      await writePref('i-cnt', TYPE_U8, u8(0));
      await writePref('i-auto', TYPE_BOOL, u8(0));
      state.summary = null;
      state.entries = [];
      renderTable();
      clearDirty();
      showEmpty(strings.emptySchedule || 'No intentions stored on the device.');
      if (autoToggle) autoToggle.checked = false;
      setStatus(() => strings.statusEraseDone || strings.statusUpdated || 'Intentions partition erased.');
    } catch (err) {
      console.error(err);
      const errMsg = err?.message || String(err);
      setStatus(() => {
        const base = strings.statusEraseFailed || 'Intentions partition erase failed';
        return `${base}: ${errMsg}`;
      });
    } finally {
      setBusy(false);
      updateActions();
    }
  }

  function onConnected() {
    log('onConnected');
    const available = !!(client.chIntentions && client.chIntentEntry);
    if (!available) {
      setAvailable(false, IL().editorMissing);
      return;
    }
    setAvailable(true);
    state.summary = null;
    state.entries = [];
    state.dirty = false;
    clearDirty();
    resetTable();
  }

  function onDisconnected() {
    log('onDisconnected');
    state.summary = null;
    state.entries = [];
    state.dirty = false;
    state.busy = false;
    state.available = false;
    showEmpty(IL().emptyDisconnected);
    if (card) card.classList.add('card-muted');
    if (autoToggle) autoToggle.checked = false;
    updateActions();
    clearDirty();
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      if (!state.available || !state.entries.length) return;
      save();
    });
  }

  if (autoToggle) {
    autoToggle.addEventListener('change', () => {
      if (!state.summary) return;
      state.summary.auto = autoToggle.checked;
      markDirty();
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      downloadIntentions();
    });
  }

  if (restoreInput) {
    restoreInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      await restoreFromFile(file);
    });
  }

  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => {
      if (!state.available) {
        alert(IL().connectFirst || 'Connect to the rosary first.');
        return;
      }
      if (!restoreInput) return;
      openFilePicker(restoreInput);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      resetSchedule();
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      deleteIntentions();
    });
  }

  if (eraseBtn) {
    eraseBtn.addEventListener('click', () => {
      eraseIntentionsPartition();
    });
  }

  showEmpty(IL().emptyDisconnected);
  updateActions();

  return {
    onConnected,
    onDisconnected,
    refresh,
    onLangChange: () => {
      // Re-render with current language strings without refetching data.
      renderTable();
      updateActions();
    },
    getIntentionsData: async () => {
      if (!state.available || !state.entries.length) return null;
      return buildExportPayload();
    },
    restoreIntentionsData: restoreFromData,
    resetIntentionsData: () => resetSchedule(true),
  };
}
