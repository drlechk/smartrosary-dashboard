import { $, dec, packKV, le32, writeGatt } from './utils.js';
import { i18n } from './i18n.js';
import { getLang } from './ui.js';

const OP_SET_PREF = 0x50;
const TYPE_BOOL = 0x01;
const TYPE_U8 = 0x11;
const TYPE_U32 = 0x14;

const DEFAULT_SET_LABELS = ['None', 'Joyful', 'Luminous', 'Sorrowful', 'Glorious', 'Chaplet'];

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
  return [
    { value: 0, label: sets[0] || DEFAULT_SET_LABELS[0] },
    { value: 1, label: sets[1] || DEFAULT_SET_LABELS[1] },
    { value: 2, label: sets[2] || DEFAULT_SET_LABELS[2] },
    { value: 3, label: sets[3] || DEFAULT_SET_LABELS[3] },
    { value: 4, label: sets[4] || DEFAULT_SET_LABELS[4] },
  ];
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
    state.busy = flag;
    loadBtn.disabled = !state.available || flag;
    saveBtn.disabled = flag || !state.entries.length || !state.available || !state.dirty;
    autoToggle.disabled = flag || !state.entries.length;
  }

  function setAvailable(flag, message) {
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
      tdIndex.textContent = String(entry.index + 1);
      tr.appendChild(tdIndex);

      const tdTitle = document.createElement('td');
      tdTitle.className = 'intentions-title-cell';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'intentions-title';
      titleSpan.textContent = entry.title || strings.fallbackTitle(entry.index + 1);
      const descBlock = document.createElement('div');
      descBlock.className = 'intentions-desc';
      const descToggle = document.createElement('button');
      descToggle.type = 'button';
      descToggle.className = 'intentions-desc-toggle';
      descToggle.textContent = '▸';
      descToggle.setAttribute('aria-label', strings.descShow);
      const descText = document.createElement('div');
      descText.className = 'intentions-desc-text';
      descText.textContent = entry.desc || '';
      const descId = `intent-desc-${entry.index}`;
      descText.id = descId;
      descToggle.setAttribute('aria-controls', descId);
      if (!descText.textContent.trim()) {
        descToggle.disabled = true;
        descToggle.classList.add('muted');
        descToggle.textContent = '—';
        descToggle.removeAttribute('aria-label');
        descToggle.removeAttribute('aria-controls');
        descText.style.display = 'none';
      } else {
        descToggle.setAttribute('aria-expanded', 'false');
        descText.setAttribute('aria-hidden', 'true');
        descText.style.maxHeight = '0px';
        descToggle.addEventListener('click', () => {
          const stringsClick = IL();
          const expanded = descText.classList.toggle('expanded');
          descToggle.textContent = expanded ? '▾' : '▸';
          descToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          descToggle.setAttribute('aria-label', expanded ? stringsClick.descHide : stringsClick.descShow);
          descText.setAttribute('aria-hidden', expanded ? 'false' : 'true');
          descText.style.maxHeight = expanded ? descText.scrollHeight + 'px' : '0px';
        });
      }
      descBlock.appendChild(descToggle);
      descBlock.appendChild(descText);
      tdTitle.appendChild(titleSpan);
      tdTitle.appendChild(descBlock);
      tr.appendChild(tdTitle);

      const tdDate = document.createElement('td');
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
    });
  }

  async function readSummary() {
    if (!client.chIntentions) throw new Error(IL().summaryMissing);
    const value = await client.chIntentions.readValue();
    const text = dec.decode(toUint8(value));
    return safeJsonParse(text);
  }

  async function readEntry(index) {
    if (!client.chIntentEntry) throw new Error(IL().entryMissing);
    const buf = new Uint8Array([index & 0xff, (index >> 8) & 0xff]);
    await writeGatt(client.chIntentEntry, buf);
    await client.waitReady();
    const value = await client.chIntentEntry.readValue();
    const text = dec.decode(toUint8(value));
    return safeJsonParse(text);
  }

  async function refresh({ silent = false, ignoreBusy = false } = {}) {
    if (!state.available) return false;
    if (state.busy && !ignoreBusy) return false;
    const alreadyBusy = state.busy;
    if (!alreadyBusy) setBusy(true);
    const strings = IL();
    if (!silent) setStatus(strings.statusLoading);
    try {
      const summary = await readSummary();
      state.summary = summary;
      state.entries = [];

      if (!summary.present) {
        resetTable();
        autoToggle.disabled = true;
        clearDirty();
        const msg = strings.emptySchedule;
        showEmpty(msg);
        if (!silent) setStatus(msg);
        return true;
      }

      const count = Math.min(Number(summary.count) || 0, ROW_LIMIT);
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
        const selected = summary.selected != null
          ? strings.statusSelected(Number(summary.selected) + 1)
          : strings.statusLoaded;
        setStatus(`${selected}.`);
      }
      return true;
    } catch (err) {
      console.error(err);
      if (!silent) setStatus(`${strings.statusLoadFailed}: ${err.message}`);
      return false;
    } finally {
      if (!alreadyBusy) setBusy(false);
    }
  }

  async function writePref(key, type, valueBytes) {
    if (!client.chCtrl) throw new Error('Control characteristic missing');
    const payload = packKV(OP_SET_PREF, type, key, valueBytes);
    await writeGatt(client.chCtrl, payload);
    await client.waitReady();
  }

  async function save() {
    if (!state.available || !state.entries.length) return;
    if (state.busy) return;
    setBusy(true);
    const strings = IL();
    setStatus(strings.statusSaving);
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
      setStatus(strings.statusSavedRefreshing);
      await refresh({ silent: true, ignoreBusy: true });
      setStatus(strings.statusUpdated);
    } catch (err) {
      console.error(err);
      setStatus(`${strings.statusSaveFailed}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function onConnected() {
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
