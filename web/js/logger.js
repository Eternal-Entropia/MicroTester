// MicroTester diagnostics logger: ring buffer + localStorage + JSONL export.
(function () {
    'use strict';

    const KEY = 'mt_debug_log_v1';
    const MAX = 4000;
    let buf = [];
    let saveTimer = null;

    function load() {
        try {
            const s = localStorage.getItem(KEY);
            if (s) {
                const p = JSON.parse(s);
                if (Array.isArray(p)) buf = p;
            }
        } catch (e) { /* ignore */ }
    }

    function persist() {
        try {
            const keep = buf.length > MAX ? buf.slice(-MAX) : buf;
            localStorage.setItem(KEY, JSON.stringify(keep));
        } catch (e) { /* storage full */ }
    }

    function scheduleSave() {
        if (saveTimer) return;
        saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 800);
    }

    function push(cat, msg, data) {
        const e = { t: Date.now(), cat, msg };
        if (data !== undefined) e.data = data;
        buf.push(e);
        if (buf.length > MAX) buf.splice(0, buf.length - MAX);
        try {
            console.log('[MT:' + cat + '] ' + msg + (data !== undefined ? ' ' + JSON.stringify(data) : ''));
        } catch (_) { /* ignore */ }
        scheduleSave();
    }

    window.MTLogger = {
        log: push,
        info: (m, d) => push('info', m, d),
        warn: (m, d) => push('warn', m, d),
        error: (m, d) => push('error', m, d),
        get: () => buf,
        clear() { buf = []; persist(); },
        download() {
            const lines = buf.map(e => JSON.stringify(e));
            const blob = new Blob([lines.join('\n') + (lines.length ? '\n' : '')], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'microtester-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
        },
        copy() {
            const lines = buf.map(e => JSON.stringify(e));
            if (!lines.length) return false;
            const text = lines.join('\n') + '\n';
            const done = (err) => {
                if (err) {
                    try {
                        const ta = document.createElement('textarea');
                        ta.value = text;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        ta.remove();
                    } catch (_) { /* ignore */ }
                }
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => done(null), done);
            } else {
                done(new Error('no clipboard api'));
            }
            return true;
        }
    };

    load();
})();