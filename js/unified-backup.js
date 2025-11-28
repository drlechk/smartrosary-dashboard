import { downloadBlob, openFilePicker } from './utils.js';
import { i18n } from './i18n.js';
import { getLang } from './ui.js';

export function initUnifiedBackup({
    getStatsData, restoreStatsData, resetStatsData,
    getHistoryData, restoreHistoryData, resetHistoryData,
    getIntentionsData, restoreIntentionsData, resetIntentionsData,
    setStatus
}) {
    const backupBtn = document.getElementById('backupAllBtn');
    const restoreBtn = document.getElementById('restoreAllBtn');
    const resetBtn = document.getElementById('resetAllBtn');
    const restoreInput = document.getElementById('restoreAllInput');
    const dialog = document.getElementById('selectionDialog');
    const dialogTitle = document.getElementById('dialogTitle');
    const dialogDesc = document.getElementById('dialogDesc');
    const confirmBtn = document.getElementById('dialogConfirmBtn');
    const selStats = document.getElementById('selStats');
    const selHistory = document.getElementById('selHistory');
    const selIntentions = document.getElementById('selIntentions');

    let currentAction = null; // 'restore' or 'reset'
    let pendingRestoreFile = null;

    const IL = () => {
        const lang = getLang();
        return (i18n[lang] && i18n[lang].unified) ? i18n[lang] : i18n.en;
    };

    function updateButtons(busy, available) {
        if (backupBtn) backupBtn.disabled = busy || !available;
        if (restoreBtn) restoreBtn.disabled = busy || !available;
        if (resetBtn) resetBtn.disabled = busy || !available;
    }

    function updateDialogText() {
        const U = IL().unified;
        if (dialogTitle) dialogTitle.textContent = currentAction === 'restore' ? U.dialogTitleRestore : U.dialogTitleReset;
        if (dialogDesc) dialogDesc.textContent = currentAction === 'restore' ? U.dialogDescRestore : U.dialogDescReset;

        const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
        setTxt('lblStatsTitle', U.statsTitle);
        setTxt('lblStatsDesc', U.statsDesc);
        setTxt('lblHistoryTitle', U.historyTitle);
        setTxt('lblHistoryDesc', U.historyDesc);
        setTxt('lblIntentionsTitle', U.intentionsTitle);
        setTxt('lblIntentionsDesc', U.intentionsDesc);
        setTxt('dialogCancelBtn', U.cancel);
        setTxt('dialogConfirmBtn', U.confirm);
    }

    async function performBackup() {
        const U = IL().unified;
        if (!window.JSZip) {
            alert(U.jszipMissing);
            return;
        }
        const zip = new JSZip();
        const now = new Date();
        const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;

        try {
            setStatus(U.backupProgressStats);
            const stats = await getStatsData();
            if (stats) zip.file('stats.json', JSON.stringify(stats, null, 2));

            setStatus(U.backupProgressHistory);
            const history = await getHistoryData(); // Expecting Blob or Uint8Array
            if (history) zip.file('history.bin', history);

            setStatus(U.backupProgressIntentions);
            const intentions = await getIntentionsData();
            if (intentions) zip.file('intentions.json', JSON.stringify(intentions, null, 2));

            setStatus(U.backupProgressCompress);
            const content = await zip.generateAsync({ type: 'blob' });
            downloadBlob(content, `smartrosary_backup_${stamp}.zip`);
            setStatus(U.backupComplete);
        } catch (err) {
            console.error(err);
            setStatus(U.backupFailed + err.message);
        }
    }

    async function handleRestore(file) {
        const U = IL().unified;
        if (!window.JSZip) return;
        try {
            const zip = new JSZip();
            const contents = await zip.loadAsync(file);

            // Check what's inside to enable/disable checkboxes
            const hasStats = !!contents.file('stats.json');
            const hasHistory = !!contents.file('history.bin');
            const hasIntentions = !!contents.file('intentions.json');

            if (!hasStats && !hasHistory && !hasIntentions) {
                if (file.name.endsWith('.json')) {
                    alert(U.invalidZip);
                    return;
                }
            }

            pendingRestoreFile = contents;
            currentAction = 'restore';
            updateDialogText();

            selStats.disabled = !hasStats;
            selStats.checked = hasStats;

            selHistory.disabled = !hasHistory;
            selHistory.checked = hasHistory;

            selIntentions.disabled = !hasIntentions;
            selIntentions.checked = hasIntentions;

            dialog.showModal();
        } catch (err) {
            console.error(err);
            alert(U.readFailed + err.message);
        }
    }

    function handleReset() {
        currentAction = 'reset';
        pendingRestoreFile = null;
        updateDialogText();

        selStats.disabled = false;
        selStats.checked = false;
        selHistory.disabled = false;
        selHistory.checked = false;
        selIntentions.disabled = false;
        selIntentions.checked = false;

        dialog.showModal();
    }

    async function executeAction() {
        const U = IL().unified;
        const doStats = selStats.checked && !selStats.disabled;
        const doHistory = selHistory.checked && !selHistory.disabled;
        const doIntentions = selIntentions.checked && !selIntentions.disabled;

        dialog.close();

        if (!doStats && !doHistory && !doIntentions) return;

        if (currentAction === 'restore' && pendingRestoreFile) {
            try {
                if (doStats) {
                    setStatus(U.restoreProgressStats);
                    const text = await pendingRestoreFile.file('stats.json').async('string');
                    await restoreStatsData(JSON.parse(text));
                }
                if (doHistory) {
                    setStatus(U.restoreProgressHistory);
                    let binary = null;
                    if (pendingRestoreFile.file('history.bin')) {
                        binary = await pendingRestoreFile.file('history.bin').async('uint8array');
                    }
                    if (binary) {
                        await restoreHistoryData(binary);
                    }
                }
                if (doIntentions) {
                    setStatus(U.restoreProgressIntentions);
                    const text = await pendingRestoreFile.file('intentions.json').async('string');
                    await restoreIntentionsData(JSON.parse(text));
                }
                setStatus(U.restoreComplete);
            } catch (err) {
                console.error(err);
                setStatus(U.restoreFailed + err.message);
            }
        } else if (currentAction === 'reset') {
            if (!confirm(U.confirmReset)) return;
            try {
                if (doStats) {
                    setStatus(U.resetProgressStats);
                    await resetStatsData();
                }
                if (doHistory) {
                    setStatus(U.resetProgressHistory);
                    await resetHistoryData();
                }
                if (doIntentions) {
                    setStatus(U.resetProgressIntentions);
                    await resetIntentionsData();
                }
                setStatus(U.resetComplete);
            } catch (err) {
                console.error(err);
                setStatus(U.resetFailed + err.message);
            }
        }
    }

    if (backupBtn) backupBtn.addEventListener('click', performBackup);

    if (restoreBtn) restoreBtn.addEventListener('click', () => {
        if (restoreInput) openFilePicker(restoreInput);
    });

    if (restoreInput) restoreInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) handleRestore(file);
    });

    if (resetBtn) resetBtn.addEventListener('click', handleReset);

    if (confirmBtn) confirmBtn.addEventListener('click', (e) => {
        e.preventDefault(); // prevent form submit
        executeAction();
    });

    return { updateButtons };
}
