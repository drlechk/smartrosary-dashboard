import { $, dec, packKV, le32 } from './utils.js';
import { i18n } from './i18n.js';
import { getLang } from './ui.js';

const log = (...args) => {
  try { console.log('[intentions]', ...args); } catch {}
};

const OP_SET_PREF = 0x50;
const TYPE_BOOL = 0x01;
const TYPE_U8 = 0x11;
const TYPE_U32 = 0x14;

const DEFAULT_SET_LABELS = ['None', 'Joyful', 'Sorrowful', 'Glorious', 'Luminous', 'Chaplet'];

const ROW_LIMIT = 32;

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

export function initIntentions({ client, setStatus }) {
  const loadBtn = $('intentionsLoadBtn');
  const saveBtn = $('intentionsSaveBtn');
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

  function setBusy(flag) {
    log('setBusy', flag);
    state.busy = flag;
    loadBtn.disabled = !state.available || flag;
    saveBtn.disabled = flag || !state.entries.length || !state.available || !state.dirty;
    autoToggle.disabled = flag || !state.entries.length;
  }

  function setAvailable(flag, message) {
    log('setAvailable', { available: flag, message });
    const strings = IL();
    state.available = flag;
    if (card) card.classList.toggle('card-muted', !flag);
    if (!flag) {
      showEmpty(message || strings.serviceMissing);
      loadBtn.disabled = true;
      saveBtn.disabled = true;
      autoToggle.disabled = true;
      autoToggle.checked = false;
      state.summary = null;
      state.entries = [];
      state.dirty = false;
    } else {
      loadBtn.disabled = false;
      saveBtn.disabled = true;
      autoToggle.disabled = true;
      showEmpty(strings.promptLoad);
    }
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
  }

  function markDirty() {
    if (!state.available) return;
    state.dirty = true;
    saveBtn.disabled = state.busy || !state.entries.length;
  }

  function clearDirty() {
    state.dirty = false;
    saveBtn.disabled = true;
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
      const tr = document.createElement('tr');

      const tdIndex = document.createElement('td');
      tdIndex.dataset.label = tableLabels.index ?? '#';
      const indexWrap = document.createElement('div');
      indexWrap.className = 'intentions-index-wrap';
      const indexNumber = document.createElement('span');
      indexNumber.className = 'intentions-index';
      indexNumber.textContent = String(entry.index + 1);
      indexWrap.appendChild(indexNumber);
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
      tdDate.dataset.label = tableLabels.start ?? 'Start Date';
      const inputDate = document.createElement('input');
      inputDate.type = 'date';
      inputDate.value = epochToDateInput(entry.start);
      inputDate.addEventListener('change', () => {
        entry.start = dateInputToEpoch(inputDate.value);
        markDirty();
      });
      tdDate.appendChild(inputDate);
      tr.appendChild(tdDate);

      const tdSet = document.createElement('td');
      tdSet.dataset.label = tableLabels.set ?? 'Mystery';
      const selectSet = document.createElement('select');
      getMysteryOptions().forEach((opt) => {
        const option = document.createElement('option');
        option.value = String(opt.value);
        option.textContent = opt.label;
        if (opt.value === entry.set) option.selected = true;
        selectSet.appendChild(option);
      });
      selectSet.addEventListener('change', () => {
        entry.set = Number(selectSet.value) || 0;
        markDirty();
      });
      tdSet.appendChild(selectSet);
      tr.appendChild(tdSet);

      const tdPart = document.createElement('td');
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
      selectPart.addEventListener('change', () => {
        entry.part = Number(selectPart.value) || 0;
        markDirty();
      });
      tdPart.appendChild(selectPart);
      tr.appendChild(tdPart);

      entry.controls = { dateInput: inputDate, setSelect: selectSet, partSelect: selectPart };

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
    if (!silent) setStatus(() => IL().statusLoading);
    log('refresh: begin', { silent, ignoreBusy });
    try {
      const summary = await readSummary();
      state.summary = summary;
      state.entries = [];

      if (summary.requireConsent) {
        const consentDefault = 'Allow the dashboard on the device, then press “Load” again.';
        const consentMsg =
          strings.consentRequired ||
          consentDefault;
        state.entries = [];
        renderTable();
        clearDirty();
        showEmpty(consentMsg);
        autoToggle.disabled = true;
        log('refresh: requireConsent flag from device');
        setStatus(() => IL().consentRequired || consentDefault);
        return false;
      }

      if (!summary.present) {
        resetTable();
        autoToggle.disabled = true;
        clearDirty();
        const msg = strings.emptySchedule;
        showEmpty(msg);
        if (!silent) setStatus(() => IL().emptySchedule);
        return true;
      }

      const count = Math.min(Number(summary.count) || 0, ROW_LIMIT);
      log('refresh: summary', { count, auto: summary.auto, selected: summary.selected });
      if (!count) {
        setAvailable(false, strings.emptySchedule);
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
      }

      autoToggle.disabled = !state.entries.length;
      autoToggle.checked = !!summary.auto;
      renderTable();
      clearDirty();

      if (!silent) {
        const selectedIndex = summary.selected != null ? Number(summary.selected) + 1 : null;
        setStatus(() => {
          const s = IL();
          const base = selectedIndex != null ? s.statusSelected(selectedIndex) : s.statusLoaded;
          return `${base}.`;
        });
      }
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
      log('refresh: end');
    }
  }

  async function writePref(key, type, valueBytes) {
    if (!client.chCtrl) throw new Error('Control characteristic missing');
    const payload = packKV(OP_SET_PREF, type, key, valueBytes);
    await client.chCtrl.writeValue(payload);
    await client.waitReady();
  }

  async function save() {
    if (!state.available || !state.entries.length) return;
    if (state.busy) return;
    setBusy(true);
    const strings = IL();
    setStatus(() => IL().statusSaving);
    log('save: begin', { entries: state.entries.length });
    try {
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
      }

      await writePref('i-cnt', TYPE_U8, u8(state.entries.length));
      await writePref('i-auto', TYPE_BOOL, u8(autoToggle.checked ? 1 : 0));

      state.summary = state.summary || {};
      state.summary.auto = autoToggle.checked;
      clearDirty();
      setStatus(() => IL().statusSavedRefreshing);
      await refresh({ silent: true, ignoreBusy: true });
      setStatus(() => IL().statusUpdated);
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
      setBusy(false);
      log('save: end');
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
    loadBtn.disabled = true;
    saveBtn.disabled = true;
    autoToggle.disabled = true;
    autoToggle.checked = false;
    clearDirty();
  }

  if (loadBtn) {
    loadBtn.addEventListener('click', () => {
      log('loadBtn clicked');
      if (!state.available) return;
      if (state.dirty && !confirm(IL().confirmDiscard)) return;
      refresh();
    });
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

  showEmpty(IL().emptyDisconnected);
  loadBtn.disabled = true;
  saveBtn.disabled = true;
  autoToggle.disabled = true;

  return {
    onConnected,
    onDisconnected,
    refresh,
  };
}
