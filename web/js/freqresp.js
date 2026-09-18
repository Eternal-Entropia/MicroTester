// Frequency Response Analyzer Controller for MicroTester
// Linear Frequency Scale with accurate knobs, engineering unit parser, symmetric wheel, no gradient/glow, and real-time sweep

document.addEventListener('DOMContentLoaded', () => {
    const L = window.MTLogger;
    if (L) L.log('fr:init', 'FR panel init');

    const STORAGE_KEY = 'mt_fr_cal_v1';
    const FR_MODE_DIRECT = 0;
    const FR_MODE_DIODE = 1;
    const FR_MODE_SINE = 2;

    const FR_OUT_PIN = 0;
    const FR_IN_PIN = 7;

    // State
    const state = {
        sweeping: false,
        busy: false,
        zero: { diode: 0, direct: 0 },
        ref: [],
        dut: [],
        outPin: 0,
        inPin: 7,
        fmin: 20,
        fmax: 1000000,
        n: 96,
        oversample: 16,
        mode: 'sine',
        viewMode: 'gain', // 'gain' (АЧХ), 'phase' (ФЧХ), 'both' (Боде)
        calFmin: 0,
        calFmax: 0,
        calN: 0,
        calMode: ''
    };

    // Cache & pending request state
    let refIndex = null;
    let refDirty = true;
    let pendingFreq = null;
    let pendingResolve = null;
    let pendingTimer = null;
    let lastCfgKey = '';
    let hoverPoint = null;
    let frPacketBuffer = new Uint8Array(0);

    // Zoom viewport (0, 0 = full configured range)
    let viewLo = 0, viewHi = 0;

    // DOM Elements
    const btnSweep = document.getElementById('btnFrSweep');
    const btnSweepPhase = document.getElementById('btnFrSweepPhase');
    const btnSweepBode = document.getElementById('btnFrSweepBode');
    const btnViewGain = document.getElementById('btnFrViewGain');
    const btnViewPhase = document.getElementById('btnFrViewPhase');
    const btnViewBoth = document.getElementById('btnFrViewBoth');
    const lblPlotTitle = document.getElementById('lblFrPlotTitle');
    const legendGain = document.getElementById('legendFrGain');
    const legendPhase = document.getElementById('legendFrPhase');

    const btnStop = document.getElementById('btnFrStop');
    const btnCalibDiode = document.getElementById('btnFrCalibDiode');
    const btnCalibDirect = document.getElementById('btnFrCalibDirect');
    const btnCalibSine = document.getElementById('btnFrCalibSine');
    const btnCalibReset = document.getElementById('btnFrCalibReset');
    const frCalibStatus = document.getElementById('frCalibStatus');
    const frCalibLive = document.getElementById('frCalibLive');
    const frCalibZeroVal = document.getElementById('frCalibZeroVal');
    const frCalibRefVal = document.getElementById('frCalibRefVal');
    const modalFr = document.getElementById('modalFrCalib');
    const modalFrDesc = document.getElementById('frModalStepDesc');
    const modalFrProgress = document.getElementById('frModalProgress');
    const btnFrModalNext = document.getElementById('btnFrModalNext');
    const btnFrModalCancel = document.getElementById('btnFrModalCancel');
    const btnFrModalClose = document.getElementById('btnFrModalClose');
    const statusEl = document.getElementById('lblFrStatus');
    const rangeEl = document.getElementById('lblFrRange');
    const canvas = document.getElementById('frCanvas');

    const selMode = document.getElementById('cfgFrMode');
    const selOversample = document.getElementById('cfgFrOversample');
    const fldOversample = document.getElementById('fldFrOversample');
    const selPoints = document.getElementById('cfgFrPoints');
    const inpFmin = document.getElementById('cfgFrFmin');
    const inpFmax = document.getElementById('cfgFrFmax');
    const chkShowFc = document.getElementById('cfgFrShowFc');

    function resetGraphView() {
        viewLo = 0;
        viewHi = 0;
    }

    function graphViewRange() {
        const lo = viewLo > 0 ? Math.max(state.fmin, viewLo) : state.fmin;
        const hi = viewHi > 0 ? Math.min(state.fmax, viewHi) : Math.max(state.fmin, state.fmax);
        return [Math.max(1, lo), Math.max(lo + 1, hi)];
    }

    function normalizeMode(m) {
        if (m === 'sine' || m === FR_MODE_SINE || m === 2 || m === '2') return FR_MODE_SINE;
        if (m === 'direct' || m === FR_MODE_DIRECT || m === 0 || m === '0') return FR_MODE_DIRECT;
        return FR_MODE_DIODE;
    }

    function parseFreqString(str, fallback = 20) {
        if (typeof str === 'number') return isFinite(str) ? Math.round(str) : fallback;
        if (!str || typeof str !== 'string') return fallback;
        str = str.trim().toLowerCase().replace(',', '.');
        let mult = 1;
        if (str.endsWith('mhz') || str.endsWith('мгц')) {
            mult = 1000000;
            str = str.slice(0, -3).trim();
        } else if (str.endsWith('m') || str.endsWith('м')) {
            mult = 1000000;
            str = str.slice(0, -1).trim();
        } else if (str.endsWith('khz') || str.endsWith('кгц')) {
            mult = 1000;
            str = str.slice(0, -3).trim();
        } else if (str.endsWith('k') || str.endsWith('к')) {
            mult = 1000;
            str = str.slice(0, -1).trim();
        } else if (str.endsWith('hz') || str.endsWith('гц')) {
            mult = 1;
            str = str.slice(0, -2).trim();
        }
        const val = parseFloat(str);
        if (!isFinite(val) || val <= 0) return fallback;
        return Math.round(val * mult);
    }

    function buildUniversalCalPoints(mode, n) {
        const m = normalizeMode(mode);
        const pts = [];

        if (n && n >= 4) {
            // Custom uniform linear grid with n points across the mode's full range
            const range = (m === FR_MODE_DIODE) ? [10, 42000000] : [10, 1000000];
            const N = Math.round(n);
            for (let i = 0; i < N; i++) {
                pts.push(Math.round(range[0] + (range[1] - range[0]) * i / (N - 1)));
            }
        } else if (m === FR_MODE_SINE) {
            // Exactly 1024 points linear grid across 10 Hz – 1,000,000 Hz
            const N = 1024;
            const fmin = 10;
            const fmax = 1000000;
            for (let i = 0; i < N; i++) {
                const f = Math.round(fmin + (fmax - fmin) * i / (N - 1));
                pts.push(f);
            }
        } else if (m === FR_MODE_DIRECT) {
            const baseGrid = [
                10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000,
                20000, 50000, 100000, 200000, 300000, 400000, 500000,
                600000, 700000, 800000, 900000, 1000000
            ];
            pts.push(...baseGrid);
        } else {
            const baseGrid = [
                10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000,
                500000, 1000000, 2000000, 5000000, 10000000,
                15000000, 20000000, 25000000, 30000000, 35000000, 40000000, 42000000
            ];
            pts.push(...baseGrid);
        }

        return Array.from(new Set(pts.map(f => Math.round(f)))).sort((a, b) => a - b);
    }

    function getDefaultRef(mode) {
        const m = normalizeMode(mode);
        const points = buildUniversalCalPoints(m);
        return points.map(f => {
            let val = 1536;
            if (m === FR_MODE_SINE) {
                val = Math.round(1536 / Math.sqrt(1 + Math.pow(f / 1500000, 2)));
            } else if (m === FR_MODE_DIRECT) {
                val = 2048;
            } else {
                val = 2500;
            }
            return { freq: f >>> 0, mode: m, value: Math.max(1, val) >>> 0, phase: 0.0, isDefault: true };
        });
    }

    function invalidateRefIndex() {
        refDirty = true;
    }

    function ensureDefaultRefs() {
        const modes = [FR_MODE_SINE, FR_MODE_DIRECT, FR_MODE_DIODE];
        for (const m of modes) {
            const hasMode = state.ref.some(p => normalizeMode(p.mode) === m);
            if (!hasMode) {
                const defPoints = getDefaultRef(m);
                state.ref.push(...defPoints);
            }
        }
        invalidateRefIndex();
    }

    function loadCal() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed.zero) state.zero = parsed.zero;
                if (Array.isArray(parsed.ref) && parsed.ref.length > 0) {
                    state.ref = parsed.ref.map(p => ({
                        freq: p.freq >>> 0,
                        mode: normalizeMode(p.mode),
                        value: p.value >>> 0,
                        phase: (p.phase !== undefined && isFinite(p.phase)) ? p.phase : 0.0,
                        isDefault: !!p.isDefault
                    }));
                }
                if (Array.isArray(parsed.dut) && parsed.dut.length > 2) {
                    state.dut = parsed.dut.map(p => ({
                        freq: p.freq >>> 0,
                        mode: normalizeMode(p.mode),
                        value: p.value >>> 0,
                        phase: (p.phase !== undefined && isFinite(p.phase)) ? p.phase : 0.0
                    }));
                } else {
                    state.dut = [];
                }
                if (parsed.cal) {
                    state.calFmin = parsed.cal.fmin || 0;
                    state.calFmax = parsed.cal.fmax || 0;
                    state.calN = parsed.cal.n || 0;
                    state.calMode = parsed.cal.mode || '';
                }
            }
        } catch (e) { /* ignore */ }
        ensureDefaultRefs();
    }

    function saveCal() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                zero: state.zero,
                ref: state.ref,
                dut: state.dut,
                cal: {
                    fmin: state.calFmin || 0,
                    fmax: state.calFmax || 0,
                    n: state.calN || 0,
                    mode: state.calMode || ''
                }
            }));
        } catch (e) { /* ignore */ }
    }

    function setStatus(text, cls) {
        if (statusEl) {
            statusEl.innerText = text;
            statusEl.className = 'status-badge' + (cls ? ' ' + cls : '');
        }
    }

    function fmtHz(h) {
        if (h >= 1000000) return (h / 1000000).toFixed(2).replace(/\.00$/, '') + ' MHz';
        if (h >= 1000) return (h / 1000).toFixed(1).replace(/\.0$/, '') + ' kHz';
        return h + ' Hz';
    }

    function modeName(m) {
        const nm = normalizeMode(m);
        if (nm === FR_MODE_DIRECT) return 'Direct';
        if (nm === FR_MODE_SINE) return 'Sine';
        return 'Diode';
    }

    function parseConfig() {
        state.outPin = FR_OUT_PIN;
        state.inPin = FR_IN_PIN;
        state.fmin = Math.max(1, parseFreqString(inpFmin?.value, 20));
        state.mode = selMode ? selMode.value : 'sine';

        const maxAllowed = (state.mode === 'diode') ? 42000000 : 1000000;
        let curFmax = parseFreqString(inpFmax?.value, 1000000);
        if (curFmax > maxAllowed) curFmax = maxAllowed;
        state.fmax = Math.min(maxAllowed, Math.max(state.fmin, curFmax));

        state.n = Math.max(2, parseInt(selPoints?.value, 10) || 96);
        state.oversample = isNaN(parseInt(selOversample?.value, 10)) ? 16 : parseInt(selOversample?.value, 10);

        if (window.MTLogger) {
            const cfg = state.mode + '|' + state.fmin + '|' + state.fmax + '|' + state.n + '|' + state.oversample;
            if (cfg !== String(lastCfgKey)) {
                lastCfgKey = cfg;
                window.MTLogger.log('fr:config', 'config changed', { mode: state.mode, fmin: state.fmin, fmax: state.fmax, n: state.n, oversample: state.oversample, outPin: state.outPin, inPin: state.inPin });
            }
        }
    }

    function chooseMode(freq) {
        if (state.mode === 'direct') return FR_MODE_DIRECT;
        if (state.mode === 'sine') return FR_MODE_SINE;
        return FR_MODE_DIODE;
    }

    // Pure Linear Point Generator (Exact uniform step)
    function buildPoints() {
        const fmin = Math.max(1, state.fmin);
        const fmax = Math.max(fmin, state.fmax);
        const n = Math.max(2, state.n);
        if (fmax === fmin || n <= 1) return [fmin];

        const pts = [];
        const step = (fmax - fmin) / (n - 1);
        for (let i = 0; i < n; i++) {
            const f = Math.round(fmin + step * i);
            if (pts.length === 0 || pts[pts.length - 1] !== f) {
                pts.push(f);
            }
        }
        if (pts[pts.length - 1] !== fmax) pts.push(fmax);
        return pts;
    }

    function stopOtherInstruments() {
        try { if (typeof window.stopVoltmeter === 'function') window.stopVoltmeter(); } catch (e) {}
        try { if (typeof window.stopOsc === 'function') window.stopOsc(); } catch (e) {}
        if (typeof microTester !== 'undefined' && microTester.device) {
            microTester.sendCommand(CMD_SIG_STOP);
            microTester.sendCommand(CMD_SIGMA_DELTA_STOP);
            microTester.sendCommand(CMD_COMP_STOP);
        }
    }

    async function sendFrStart() {
        stopOtherInstruments();
        const limit = 1000000;
        const over = (state.oversample !== undefined) ? (state.oversample >>> 0) : 16;
        await microTester.sendCommand(CMD_FR_START, new Uint8Array([
            state.outPin, state.inPin,
            limit & 0xFF, (limit >> 8) & 0xFF, (limit >> 16) & 0xFF, (limit >> 24) & 0xFF,
            over & 0xFF
        ]));
    }

    function requestPoint(freq, mode, timeoutMs) {
        if (pendingResolve) return Promise.reject(new Error('busy'));
        if (!timeoutMs) {
            const overCount = Math.max(1, (state.oversample !== undefined) ? state.oversample : 16);
            const scale = Math.max(1, overCount / 16);
            if (freq < 10) timeoutMs = Math.round(20000 * scale);
            else if (freq < 30) timeoutMs = Math.round(12000 * scale);
            else if (freq < 100) timeoutMs = Math.round(8000 * scale);
            else if (mode === FR_MODE_SINE) timeoutMs = Math.round(5000 * scale);
            else timeoutMs = Math.round(4000 * scale);
        }
        return new Promise((resolve, reject) => {
            pendingFreq = freq >>> 0;
            pendingResolve = resolve;
            const payload = new Uint8Array(5);
            payload[0] = freq & 0xFF;
            payload[1] = (freq >> 8) & 0xFF;
            payload[2] = (freq >> 16) & 0xFF;
            payload[3] = (freq >> 24) & 0xFF;
            payload[4] = mode;
            microTester.sendCommand(CMD_FR_STEP, payload);
            if (window.MTLogger) window.MTLogger.log('fr:send', 'CMD_FR_STEP', { freq: freq >>> 0, mode, timeoutMs });
            pendingTimer = setTimeout(() => {
                if (pendingResolve) {
                    pendingResolve = null;
                    pendingFreq = null;
                    if (window.MTLogger) window.MTLogger.log('fr:timeout', 'FR point timeout', { freq: freq >>> 0, mode, timeoutMs });
                    reject(new Error('timeout'));
                }
            }, timeoutMs);
        });
    }

    // Live progressive sweep
    async function runSweep(points) {
        state.dut = [];
        render();
        if (window.MTLogger) window.MTLogger.log('fr:sweep', 'sweep start', points.length + ' points');

        for (let i = 0; i < points.length; i++) {
            if (!state.busy) break;
            const f = points[i];
            const mode = chooseMode(f);
            setStatus(`Sweep ${i + 1}/${points.length} · ${fmtHz(f)} · ${modeName(mode)}`, 'active');
            try {
                const resp = await requestPoint(f, mode);
                if (!resp) break;
                const pointMode = (resp.mode !== 0xFF && resp.mode !== undefined) ? resp.mode : mode;
                state.dut.push({ 
                    freq: resp.freq >>> 0, 
                    mode: normalizeMode(pointMode), 
                    value: resp.value >>> 0,
                    phase: (resp.phase !== undefined && isFinite(resp.phase)) ? resp.phase : 0.0
                });
                render();
            } catch (err) {
                if (window.MTLogger) window.MTLogger.warn('fr:point_err', 'point failed', { f, err: err?.message || err });
                if (!state.busy) break;
            }
        }
        return state.dut;
    }

    function setButtons() {
        const conn = !!(typeof microTester !== 'undefined' && microTester.device);
        if (btnSweep) btnSweep.disabled = state.busy;
        if (btnSweepPhase) btnSweepPhase.disabled = state.busy;
        if (btnSweepBode) btnSweepBode.disabled = state.busy;
        if (btnCalibDiode) btnCalibDiode.disabled = state.busy;
        if (btnCalibDirect) btnCalibDirect.disabled = state.busy;
        if (btnCalibSine) btnCalibSine.disabled = state.busy;
        if (btnStop) btnStop.disabled = !state.busy;
    }

    function stopSweep() {
        state.busy = false;
        if (typeof microTester !== 'undefined' && microTester.device) {
            microTester.sendCommand(CMD_FR_STOP);
        }
        setStatus('Stopped', 'stopped');
        if (pendingTimer) clearTimeout(pendingTimer);
        if (pendingResolve) {
            const r = pendingResolve;
            pendingResolve = null;
            pendingFreq = null;
            r(null);
        }
        render();
    }

    function ensureRefIndex() {
        if (!refDirty && refIndex) return;
        refIndex = {};
        for (const p of state.ref) {
            const m = normalizeMode(p.mode);
            const z = (m === FR_MODE_DIODE) ? (state.zero.diode || 0) : 0;
            const rawV = (p.value >>> 0);
            const v = (m === FR_MODE_DIODE && !p.isDefault) ? Math.max(1, rawV - z) : rawV;
            if (v <= 0) continue;
            const list = refIndex[m] || (refIndex[m] = []);
            list.push({ f: p.freq >>> 0, lf: p.freq, lv: Math.log(v), phase: (p.phase !== undefined) ? p.phase : 0.0 });
        }
        for (const m in refIndex) refIndex[m].sort((a, b) => a.f - b.f);
        refDirty = false;
    }

    function getRefLogAt(freq, mode) {
        ensureRefIndex();
        const m = normalizeMode(mode);
        const list = refIndex && refIndex[m];
        if (!list || list.length === 0) return null;
        const lf = freq;
        const first = list[0], last = list[list.length - 1];
        if (lf <= first.lf) return first.lv;
        if (lf >= last.lf) return last.lv;
        let lo = 0, hi = list.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (list[mid].lf < lf) lo = mid; else hi = mid;
        }
        const a = list[lo], b = list[hi];
        const t = (lf - a.lf) / (b.lf - a.lf);
        return a.lv + t * (b.lv - a.lv);
    }

    function getRefPhaseAt(freq, mode) {
        ensureRefIndex();
        const m = normalizeMode(mode);
        const list = refIndex && refIndex[m];
        if (!list || list.length === 0) return 0.0;
        const lf = freq;
        const first = list[0], last = list[list.length - 1];
        if (lf <= first.lf) return first.phase || 0.0;
        if (lf >= last.lf) return last.phase || 0.0;
        let lo = 0, hi = list.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (list[mid].lf < lf) lo = mid; else hi = mid;
        }
        const a = list[lo], b = list[hi];
        const t = (lf - a.lf) / (b.lf - a.lf);
        return (a.phase || 0.0) + t * ((b.phase || 0.0) - (a.phase || 0.0));
    }

    function refSpan(mode) {
        ensureRefIndex();
        const m = normalizeMode(mode);
        const list = refIndex && refIndex[m];
        if (!list || list.length === 0) return null;
        return { lo: list[0].f, hi: list[list.length - 1].f };
    }

    function computeDb() {
        const DB_LOG10 = 20 / Math.LN10;
        const results = [];
        if (!state.dut || state.dut.length === 0) return results;

        let maxSig = 1;
        for (const d of state.dut) {
            const rawV = (d.value >>> 0);
            if (rawV > maxSig) maxSig = rawV;
        }

        for (const d of state.dut) {
            const m = normalizeMode(d.mode);
            const z = (m === FR_MODE_DIODE) ? (state.zero.diode || 0) : 0;
            const rawV = (d.value >>> 0);
            const dutSig = Math.max(1, (m === FR_MODE_DIODE) ? (rawV - z) : rawV);
            const refLog = getRefLogAt(d.freq >>> 0, m);

            let db;
            if (refLog !== null) {
                db = DB_LOG10 * (Math.log(dutSig) - refLog);
            } else {
                db = 20 * Math.log10(dutSig / maxSig);
            }

            // Phase calculation
            const rawPhase = (d.phase !== undefined && isFinite(d.phase)) ? d.phase : 0.0;
            const refPhase = getRefPhaseAt(d.freq >>> 0, m);
            let relPhase = (dutSig <= 3) ? 0.0 : (rawPhase - refPhase);
            while (relPhase > 180.0) relPhase -= 360.0;
            while (relPhase < -180.0) relPhase += 360.0;

            if (isFinite(db)) {
                results.push({
                    freq: d.freq >>> 0,
                    mode: m,
                    ref: refLog !== null ? Math.round(Math.exp(refLog)) : 0,
                    dut: rawV,
                    db: db,
                    rawPhase: rawPhase,
                    phase: relPhase,
                    phaseUnwrapped: relPhase
                });
            }
        }

        // Unwrap phase across frequency points for smooth continuous curve
        if (results.length > 1) {
            let prev = results[0].phase;
            let offset = 0;
            results[0].phaseUnwrapped = prev;
            for (let i = 1; i < results.length; i++) {
                let cur = results[i].phase + offset;
                let diff = cur - prev;
                if (diff > 180.0) {
                    const steps = Math.round(diff / 360.0);
                    offset -= 360.0 * steps;
                } else if (diff < -180.0) {
                    const steps = Math.round(-diff / 360.0);
                    offset += 360.0 * steps;
                }
                results[i].phaseUnwrapped = results[i].phase + offset;
                prev = results[i].phaseUnwrapped;
            }
        }

        return results;
    }

    function normCurve(points) {
        if (!points || points.length === 0) return [];
        let maxV = 1;
        for (const p of points) {
            const v = (p.value >>> 0);
            if (v > maxV) maxV = v;
        }
        return points.map(p => ({
            freq: p.freq >>> 0,
            mode: normalizeMode(p.mode),
            ref: 0,
            dut: p.value >>> 0,
            db: 20 * Math.log10(Math.max(1, p.value >>> 0) / maxV),
            phase: p.phase || 0.0,
            phaseUnwrapped: p.phase || 0.0
        }));
    }

    function currentData() {
        if (!state.dut || state.dut.length === 0) return [];
        const dbData = computeDb();
        if (dbData.length > 0) return dbData;
        return normCurve(state.dut);
    }

    function render() {
        renderRange();
        renderCanvas();
    }

    function renderRange() {
        if (!rangeEl) return;
        parseConfig();
        const overStr = (state.oversample === 0) ? '1x' : `${state.oversample}x`;
        let measuredStr = '';
        if (state.dut && state.dut.length > 0) {
            const gainPts = state.dut.filter(p => p.value !== undefined).length;
            const phasePts = state.dut.filter(p => p.phase !== undefined && isFinite(p.phase)).length;
            measuredStr = ` · Measured: Gain ${gainPts} pts, Phase ${phasePts} pts`;
        }
        rangeEl.innerText = `Range: ${fmtHz(state.fmin)} → ${fmtHz(state.fmax)} · ${state.n} pts (${overStr} oversample)${measuredStr}`;
    }

    function resizeCanvas() {
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.parentElement ? canvas.parentElement.clientWidth : canvas.clientWidth;
        const height = canvas.parentElement ? canvas.parentElement.clientHeight : canvas.clientHeight;
        const w = Math.max(320, (width || 600) * dpr);
        const h = Math.max(200, (height || 300) * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Linear Frequency Scale Grid & Response Plot Renderer (Clean solid line, no gradient glow)
    function renderCanvas() {
        if (!canvas) return;
        resizeCanvas();
        const ctx = canvas.getContext('2d');
        const W = canvas.parentElement ? canvas.parentElement.clientWidth : (canvas.clientWidth || 600);
        const H = canvas.parentElement ? canvas.parentElement.clientHeight : (canvas.clientHeight || 300);
        
        const isBoth = (state.viewMode === 'both');
        const isPhaseOnly = (state.viewMode === 'phase');
        const isGainOnly = (state.viewMode === 'gain' || !state.viewMode);

        const padL = 52, padR = isBoth ? 52 : 24, padT = 24, padB = 34;
        const plotW = Math.max(10, W - padL - padR);
        const plotH = Math.max(10, H - padT - padB);

        // Dark background
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0b132b';
        ctx.fillRect(0, 0, W, H);

        const data = currentData();
        const [fmin, fmax] = graphViewRange();
        const fSpan = Math.max(1, fmax - fmin);

        // Determine Y-axis dB bounds
        let dbVals = [];
        let phaseVals = [];
        for (const p of data) {
            if (isFinite(p.db)) dbVals.push(p.db);
            const pv = (p.phaseUnwrapped !== undefined && isFinite(p.phaseUnwrapped)) ? p.phaseUnwrapped : p.phase;
            if (isFinite(pv)) phaseVals.push(pv);
        }
        let yMinDb = dbVals.length > 0 ? Math.min(...dbVals.concat([0])) : -50;
        let yMaxDb = dbVals.length > 0 ? Math.max(...dbVals.concat([0])) : 6;
        if (!isFinite(yMinDb) || !isFinite(yMaxDb) || yMaxDb - yMinDb < 6) {
            const m = isFinite(yMinDb) ? yMinDb : -6;
            yMinDb = Math.min(m, -3) - 2;
            yMaxDb = Math.max(yMaxDb, 0) + 2;
        }
        yMinDb = Math.floor(yMinDb - 1);
        yMaxDb = Math.ceil(yMaxDb + 1);

        // Determine Phase Y-axis bounds (degrees)
        let yMinPhase = -180;
        let yMaxPhase = 180;
        if (phaseVals.length > 0) {
            let minP = Math.min(...phaseVals);
            let maxP = Math.max(...phaseVals);
            if (minP < -180 || maxP > 180) {
                const span = maxP - minP;
                const step = span > 720 ? 180 : (span > 360 ? 90 : 45);
                yMinPhase = Math.floor((minP - 15) / step) * step;
                yMaxPhase = Math.ceil((maxP + 15) / step) * step;
            }
        }

        // Align 0 dB and 0 deg to the exact same vertical fraction on canvas when both axes are shown
        if (isBoth) {
            const rDb = Math.max(0.05, Math.min(0.95, yMaxDb / (yMaxDb - yMinDb)));
            const rPhase = Math.max(0.05, Math.min(0.95, yMaxPhase / (yMaxPhase - yMinPhase)));
            const r = Math.max(rDb, rPhase);

            if (rDb < r && (1 - r) > 0.001) {
                yMaxDb = Math.ceil((-yMinDb * r) / (1 - r));
            } else if (rDb > r && r > 0.001) {
                yMinDb = Math.floor((-yMaxDb * (1 - r)) / r);
            }

            if (rPhase < r && (1 - r) > 0.001) {
                yMaxPhase = Math.ceil((-yMinPhase * r) / (1 - r));
            } else if (rPhase > r && r > 0.001) {
                yMinPhase = Math.floor((-yMaxPhase * (1 - r)) / r);
            }
        }

        // Coordinate transforms
        const X = (f) => padL + ((f - fmin) / fSpan) * plotW;
        const Y_db = (db) => padT + ((yMaxDb - db) / (yMaxDb - yMinDb)) * plotH;
        const Y_phase = (deg) => padT + ((yMaxPhase - deg) / (yMaxPhase - yMinPhase)) * plotH;

        // ---- 1. Vertical Frequency Grid & Ticks (Linear) ----
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.lineWidth = 1;

        const xStep = niceStep(fSpan);
        const minorStep = xStep / 5;

        // Minor ticks
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
        const startMinor = Math.ceil(fmin / minorStep) * minorStep;
        for (let f = startMinor; f <= fmax + 1e-9; f += minorStep) {
            const x = X(f);
            if (x < padL || x > padL + plotW) continue;
            ctx.beginPath();
            ctx.moveTo(x, padT);
            ctx.lineTo(x, padT + plotH);
            ctx.stroke();
        }

        // Major lines and labels
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
        ctx.fillStyle = '#94a3b8';
        const startMajor = Math.ceil(fmin / xStep) * xStep;
        for (let f = startMajor; f <= fmax + 1e-9; f += xStep) {
            const x = X(f);
            if (x >= padL - 1 && x <= padL + plotW + 1) {
                ctx.beginPath();
                ctx.moveTo(x, padT);
                ctx.lineTo(x, padT + plotH);
                ctx.stroke();

                const label = fmtHz(f);
                const textW = ctx.measureText(label).width;
                const tx = Math.max(padL, Math.min(padL + plotW - textW, x - textW / 2));
                ctx.fillText(label, tx, padT + plotH + 18);
            }
        }

        // ---- 2. Horizontal Grid Lines & Y-Axes ----
        if (!isPhaseOnly) {
            // Left Axis: Gain in dB
            const yStep = niceStep(yMaxDb - yMinDb);
            for (let v = Math.floor(yMinDb / yStep) * yStep; v <= yMaxDb + 1e-9; v += yStep) {
                const y = Y_db(v);
                if (y < padT || y > padT + plotH) continue;
                ctx.strokeStyle = (Math.abs(v) < 1e-6) ? 'rgba(56, 189, 248, 0.35)' : 'rgba(56, 189, 248, 0.12)';
                ctx.beginPath();
                ctx.moveTo(padL, y);
                ctx.lineTo(padL + plotW, y);
                ctx.stroke();
                ctx.fillStyle = '#38bdf8';
                ctx.fillText(v.toFixed(0) + ' dB', 6, y + 3);
            }

            // Highlight 0 dB Reference line
            const y0 = Y_db(0);
            if (y0 >= padT && y0 <= padT + plotH) {
                ctx.strokeStyle = 'rgba(34, 197, 94, 0.75)';
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(padL, y0);
                ctx.lineTo(padL + plotW, y0);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#4ade80';
                ctx.fillText(isBoth ? '0 dB / 0°' : '0 dB', padL + plotW - (isBoth ? 60 : 32), y0 - 4);
            }
        }

        if (isPhaseOnly) {
            // Left Axis: Phase in Degrees
            const span = yMaxPhase - yMinPhase;
            const phaseStep = span > 720 ? 180 : (span > 360 ? 90 : 45);
            for (let v = yMinPhase; v <= yMaxPhase + 1e-9; v += phaseStep) {
                const y = Y_phase(v);
                if (y < padT || y > padT + plotH) continue;
                ctx.strokeStyle = (Math.abs(v) < 1e-6) ? 'rgba(251, 191, 36, 0.35)' : 'rgba(251, 191, 36, 0.12)';
                ctx.beginPath();
                ctx.moveTo(padL, y);
                ctx.lineTo(padL + plotW, y);
                ctx.stroke();
                ctx.fillStyle = '#fbbf24';
                ctx.fillText(v.toFixed(0) + '°', 6, y + 3);
            }

            // Highlight 0 deg Reference line
            const yp0 = Y_phase(0);
            if (yp0 >= padT && yp0 <= padT + plotH) {
                ctx.strokeStyle = 'rgba(34, 197, 94, 0.75)';
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(padL, yp0);
                ctx.lineTo(padL + plotW, yp0);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#4ade80';
                ctx.fillText('0°', padL + plotW - 28, yp0 - 4);
            }
        } else if (isBoth) {
            // Right Axis: Phase in Degrees for Bode Plot
            const span = yMaxPhase - yMinPhase;
            const phaseStep = span > 720 ? 180 : (span > 360 ? 90 : 45);
            for (let v = yMinPhase; v <= yMaxPhase + 1e-9; v += phaseStep) {
                const y = Y_phase(v);
                if (y < padT || y > padT + plotH) continue;
                ctx.fillStyle = '#fbbf24';
                ctx.fillText(v.toFixed(0) + '°', padL + plotW + 8, y + 3);
            }
        }

        // Outer plot frame
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(padL, padT, plotW, plotH);

        // ---- 3. Draw Curves ----
        if (data.length >= 2) {
            const sortedData = data.slice().sort((a, b) => a.freq - b.freq);

            // A. Draw Gain Curve (if Gain or Both)
            if (!isPhaseOnly) {
                ctx.strokeStyle = '#38bdf8';
                ctx.lineWidth = 2.0;
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                ctx.beginPath();
                let started = false;
                for (const p of sortedData) {
                    const x = X(p.freq);
                    const y = Y_db(p.db);
                    if (x < padL - 10 || x > padL + plotW + 10) continue;
                    if (!started) {
                        ctx.moveTo(x, y);
                        started = true;
                    } else {
                        ctx.lineTo(x, y);
                    }
                }
                ctx.stroke();

                // Point dots
                if (sortedData.length <= 512) {
                    for (const p of sortedData) {
                        const x = X(p.freq);
                        const y = Y_db(p.db);
                        if (x < padL || x > padL + plotW) continue;
                        ctx.fillStyle = '#38bdf8';
                        ctx.beginPath();
                        ctx.arc(x, y, 3, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.strokeStyle = '#0b132b';
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    }
                }

                // Cutoff frequency detection & line
                if (chkShowFc && chkShowFc.checked) {
                    let maxDb = -Infinity;
                    for (const p of sortedData) {
                        if (p.db > maxDb) maxDb = p.db;
                    }
                    const cutoffDb = maxDb - 3;
                    const yCut = Y_db(cutoffDb);
                    if (yCut >= padT && yCut <= padT + plotH) {
                        ctx.strokeStyle = '#f472b6';
                        ctx.setLineDash([4, 4]);
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(padL, yCut);
                        ctx.lineTo(padL + plotW, yCut);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        ctx.fillStyle = '#f472b6';
                        ctx.fillText('-3 dB', padL + 6, yCut - 4);
                    }

                    const cutoffFreq = findCutoff(sortedData, maxDb);
                    if (cutoffFreq && cutoffFreq >= fmin && cutoffFreq <= fmax) {
                        const xCut = X(cutoffFreq);
                        ctx.strokeStyle = '#f472b6';
                        ctx.setLineDash([2, 2]);
                        ctx.beginPath();
                        ctx.moveTo(xCut, padT);
                        ctx.lineTo(xCut, padT + plotH);
                        ctx.stroke();
                        ctx.setLineDash([]);

                        ctx.fillStyle = '#f472b6';
                        ctx.font = 'bold 10px JetBrains Mono, monospace';
                        ctx.fillText(`Fc (-3dB) ≈ ${fmtHz(cutoffFreq)}`, xCut + 6, yCut - 6);
                    }
                }
            }

            // B. Draw Phase Curve (if Phase or Both)
            if (!isGainOnly) {
                ctx.strokeStyle = '#fbbf24';
                ctx.lineWidth = 2.0;
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                if (isBoth) ctx.setLineDash([5, 3]);
                ctx.beginPath();
                let startedP = false;
                for (const p of sortedData) {
                    const x = X(p.freq);
                    const phaseVal = (p.phaseUnwrapped !== undefined && isFinite(p.phaseUnwrapped)) ? p.phaseUnwrapped : (p.phase || 0.0);
                    const y = Y_phase(phaseVal);
                    if (x < padL - 10 || x > padL + plotW + 10) continue;
                    if (!startedP) {
                        ctx.moveTo(x, y);
                        startedP = true;
                    } else {
                        ctx.lineTo(x, y);
                    }
                }
                ctx.stroke();
                ctx.setLineDash([]);

                // Point dots for Phase
                if (sortedData.length <= 512) {
                    for (const p of sortedData) {
                        const x = X(p.freq);
                        const phaseVal = (p.phaseUnwrapped !== undefined && isFinite(p.phaseUnwrapped)) ? p.phaseUnwrapped : (p.phase || 0.0);
                        const y = Y_phase(phaseVal);
                        if (x < padL || x > padL + plotW) continue;
                        ctx.fillStyle = '#fbbf24';
                        ctx.beginPath();
                        ctx.arc(x, y, isBoth ? 2.5 : 3, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.strokeStyle = '#0b132b';
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    }
                }
            }
        } else if (data.length === 0 && !state.busy) {
            // Idle State
            ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
            const boxW = Math.min(440, plotW - 20);
            const boxH = 56;
            const boxX = padL + (plotW - boxW) / 2;
            const boxY = padT + (plotH - boxH) / 2;
            ctx.fillRect(boxX, boxY, boxW, boxH);
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
            ctx.lineWidth = 1;
            ctx.strokeRect(boxX, boxY, boxW, boxH);

            ctx.fillStyle = '#38bdf8';
            ctx.font = 'bold 12px JetBrains Mono, monospace';
            ctx.textAlign = 'center';
            const titleStr = isPhaseOnly ? 'Phase Response' : (isBoth ? 'Bode Plot (Gain & Phase)' : 'Frequency Response');
            ctx.fillText(`${titleStr} · Planned ${fmtHz(fmin)} → ${fmtHz(fmax)}`, padL + plotW / 2, boxY + 22);

            const genPin = (state.mode === 'sine') ? 'PB5 (DAC)' : 'PA8 (PWM Meander)';
            ctx.fillStyle = '#94a3b8';
            ctx.font = '11px JetBrains Mono, monospace';
            ctx.fillText(`Connect DUT to ${genPin} & PB0 (ADC) · Click Sweep`, padL + plotW / 2, boxY + 42);
            ctx.textAlign = 'left';
        }

        // ---- 4. Hover Crosshair & Tooltip ----
        if (hoverPoint) {
            const hx = X(hoverPoint.freq);
            const hy = !isPhaseOnly ? Y_db(hoverPoint.db) : Y_phase(hoverPoint.phase);

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.setLineDash([2, 2]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(hx, padT);
            ctx.lineTo(hx, padT + plotH);
            ctx.moveTo(padL, hy);
            ctx.lineTo(padL + plotW, hy);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(hx, hy, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = !isPhaseOnly ? '#38bdf8' : '#fbbf24';
            ctx.lineWidth = 2;
            ctx.stroke();

            let tipText;
            const pv = (hoverPoint.phaseUnwrapped !== undefined) ? hoverPoint.phaseUnwrapped : hoverPoint.phase;
            const pStr = (pv !== undefined) ? `${pv >= 0 ? '+' : ''}${pv.toFixed(1)}°` : '--°';
            const gStr = `${hoverPoint.db >= 0 ? '+' : ''}${hoverPoint.db.toFixed(1)} dB`;
            if (isPhaseOnly) {
                tipText = `${fmtHz(hoverPoint.freq)} · Phase: ${pStr}`;
            } else if (isBoth) {
                tipText = `${fmtHz(hoverPoint.freq)} · Gain: ${gStr} | Phase: ${pStr}`;
            } else {
                tipText = `${fmtHz(hoverPoint.freq)} · ${gStr} (raw ${hoverPoint.dut})`;
            }

            ctx.font = 'bold 11px JetBrains Mono, monospace';
            const tipW = ctx.measureText(tipText).width + 16;
            const tipH = 24;
            let tipX = hx + 10;
            let tipY = hy - 30;
            if (tipX + tipW > padL + plotW) tipX = hx - tipW - 10;
            if (tipY < padT) tipY = hy + 10;

            ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
            ctx.strokeStyle = !isPhaseOnly ? '#38bdf8' : '#fbbf24';
            ctx.lineWidth = 1;
            ctx.fillRect(tipX, tipY, tipW, tipH);
            ctx.strokeRect(tipX, tipY, tipW, tipH);

            ctx.fillStyle = !isPhaseOnly ? '#38bdf8' : '#fbbf24';
            ctx.fillText(tipText, tipX + 8, tipY + 16);
        }

        if (viewLo > 0 || viewHi > 0) {
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(`Zoom: ${fmtHz(fmin)} – ${fmtHz(fmax)} (double-click to reset)`, padL + 8, H - 8);
        }
    }

    function niceStep(range) {
        if (range <= 0) return 1;
        const raw = range / 7;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const norm = raw / mag;
        if (norm < 1.5) return mag;
        if (norm < 3.5) return 2 * mag;
        if (norm < 7.5) return 5 * mag;
        return 10 * mag;
    }

    function findCutoff(data, maxDb) {
        if (!data || data.length < 2) return null;
        const target = maxDb - 3;
        const sorted = data.slice().sort((a, b) => a.freq - b.freq);

        for (let i = 1; i < sorted.length; i++) {
            const p0 = sorted[i - 1];
            const p1 = sorted[i];
            if ((p0.db >= target && p1.db <= target) || (p0.db <= target && p1.db >= target)) {
                if (Math.abs(p1.db - p0.db) < 1e-6) return p0.freq;
                const t = (target - p0.db) / (p1.db - p0.db);
                return Math.round(p0.freq + t * (p1.freq - p0.freq));
            }
        }
        return null;
    }

    function frGetMaxTurns() {
        return (selMode && selMode.value === 'diode') ? 6.0 : 5.0;
    }

    function frFreqToTurns(freq) {
        const maxTurns = frGetMaxTurns();
        const maxFreq = (maxTurns >= 6.0) ? 42000000 : 1000000;
        freq = Math.max(1, Math.min(maxFreq, freq));
        if (freq <= 100)      return (freq - 1) / 99;
        if (freq <= 1000)     return 1 + (freq - 100) / 900;
        if (freq <= 10000)    return 2 + (freq - 1000) / 9000;
        if (freq <= 100000)   return 3 + (freq - 10000) / 90000;
        if (freq <= 1000000)  return 4 + (freq - 100000) / 900000;
        return 5 + (freq - 1000000) / 41000000;
    }

    function frTurnsToFreq(turns) {
        const maxTurns = frGetMaxTurns();
        turns = Math.max(0, Math.min(maxTurns, turns));
        let f;
        if (turns <= 1)      f = 1 + turns * 99;
        else if (turns <= 2) f = 100 + (turns - 1) * 900;
        else if (turns <= 3) f = 1000 + (turns - 2) * 9000;
        else if (turns <= 4) f = 10000 + (turns - 3) * 90000;
        else if (turns <= 5) f = 100000 + (turns - 4) * 900000;
        else                 f = 1000000 + (turns - 5) * 41000000;
        return Math.round(f);
    }

    // Quantize to 0.1% resolution (for mouse drag)
    function frQuantizeFine(freq) {
        freq = Math.max(1, freq);
        let step;
        if (freq < 100)           step = 1;
        else if (freq < 1000)     step = 1;
        else if (freq < 10000)    step = 10;
        else if (freq < 100000)   step = 100;
        else if (freq < 1000000)  step = 1000;
        else if (freq < 10000000) step = 10000;
        else                      step = 100000;
        return Math.max(1, Math.round(freq / step) * step);
    }

    // 1% step for mouse wheel
    function frCoarseStep(freq) {
        if (freq <= 100) return 1;
        if (freq <= 1000) return 10;
        if (freq <= 10000) return 100;
        if (freq <= 100000) return 1000;
        if (freq <= 1000000) return 10000;
        if (freq <= 10000000) return 100000;
        return 1000000;
    }

    function frKnobLabel(f) {
        if (f >= 1e6) {
            const s = (f / 1e6).toFixed(3).replace(/\.?0+$/, '');
            return s + '<br><span style="font-size:11px; color: #94a3b8">MHz</span>';
        }
        if (f >= 1e3) {
            const s = (f / 1e3).toFixed(3).replace(/\.?0+$/, '');
            return s + '<br><span style="font-size:11px; color: #94a3b8">kHz</span>';
        }
        return f.toFixed(0) + '<br><span style="font-size:11px; color: #94a3b8">Hz</span>';
    }

    function createFrKnob(knobId, fillId, thumbId, textId, inputId, isMin) {
        const knob = document.getElementById(knobId);
        const fill = document.getElementById(fillId);
        const thumb = document.getElementById(thumbId);
        const textEl = document.getElementById(textId);
        const input = document.getElementById(inputId);
        if (!knob || !fill || !thumb || !textEl || !input) return null;

        let isDragging = false;
        let lastKnobAngle = 0;
        let dragTurns = 0;

        function updateKnobUI(freq) {
            const turns = frFreqToTurns(freq);
            const frac = turns % 1.0;
            const totalDash = 251.33;
            fill.style.strokeDashoffset = totalDash - (frac * totalDash);
            const rad = ((-90 + frac * 360) * Math.PI) / 180;
            if (thumb.setAttribute) {
                thumb.setAttribute('cx', 50 + 40 * Math.cos(rad));
                thumb.setAttribute('cy', 50 + 40 * Math.sin(rad));
            }
            textEl.innerHTML = frKnobLabel(freq);
        }

        function clampValue(v) {
            const maxAllowed = (selMode && selMode.value === 'diode') ? 42000000 : 1000000;
            if (isMin) {
                const other = parseFreqString(inpFmax?.value, maxAllowed);
                return Math.max(1, Math.min(v, other));
            } else {
                const other = parseFreqString(inpFmin?.value, 1);
                return Math.max(other, Math.min(v, maxAllowed));
            }
        }

        function commitValue(v, updateInput = true) {
            const clamped = clampValue(Math.round(v));
            if (updateInput) {
                input.value = clamped;
            }
            dragTurns = frFreqToTurns(clamped);
            updateKnobUI(clamped);
            parseConfig();
            renderRange();
            renderCanvas();
        }

        function handleStart(e) {
            isDragging = true;
            const currentFreq = parseFreqString(input.value, isMin ? 20 : 1000000);
            dragTurns = frFreqToTurns(currentFreq);

            const rect = knob.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            let x = e.clientX, y = e.clientY;
            if (e.touches && e.touches.length > 0) { x = e.touches[0].clientX; y = e.touches[0].clientY; }
            lastKnobAngle = Math.atan2(y - cy, x - cx) * 180 / Math.PI;

            document.addEventListener('mousemove', handleMove);
            document.addEventListener('touchmove', handleMove, { passive: false });
            document.addEventListener('mouseup', handleStop);
            document.addEventListener('touchend', handleStop);
        }

        function handleMove(e) {
            if (!isDragging) return;
            e.preventDefault();
            const rect = knob.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            let x = e.clientX, y = e.clientY;
            if (e.touches && e.touches.length > 0) { x = e.touches[0].clientX; y = e.touches[0].clientY; }

            const currentAngle = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
            let delta = currentAngle - lastKnobAngle;
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            lastKnobAngle = currentAngle;

            const maxTurns = frGetMaxTurns();
            dragTurns = Math.max(0, Math.min(maxTurns, dragTurns + delta / 360));
            const newFreq = frQuantizeFine(frTurnsToFreq(dragTurns));
            commitValue(newFreq, true);
        }

        function handleStop() {
            if (!isDragging) return;
            isDragging = false;
            document.removeEventListener('mousemove', handleMove);
            document.removeEventListener('touchmove', handleMove);
            document.removeEventListener('mouseup', handleStop);
            document.removeEventListener('touchend', handleStop);
        }

        function applyWheel(e) {
            e.preventDefault();
            const cur = parseFreqString(input.value, isMin ? 20 : 1000000);
            const dir = e.deltaY < 0 ? 1 : -1;
            const count = e.shiftKey ? 5 : 1;
            let next = cur;
            for (let i = 0; i < count; i++) {
                const step = frCoarseStep(next);
                next = Math.max(1, next + dir * step);
                next = Math.round(next / step) * step;
            }
            commitValue(next, true);
        }

        knob.addEventListener('mousedown', handleStart);
        knob.addEventListener('touchstart', handleStart, { passive: true });
        knob.addEventListener('wheel', applyWheel, { passive: false });
        input.addEventListener('wheel', applyWheel, { passive: false });

        // While typing: update preview without forcibly overwriting input text
        input.addEventListener('input', () => {
            const raw = input.value;
            const parsed = parseFreqString(raw, 0);
            if (parsed > 0) {
                updateKnobUI(parsed);
                parseConfig();
                renderRange();
            }
        });

        // On commit (blur, change, Enter): validate and format
        function commitFromInput() {
            const parsed = parseFreqString(input.value, isMin ? state.fmin : state.fmax);
            commitValue(parsed, true);
        }

        input.addEventListener('change', commitFromInput);
        input.addEventListener('blur', commitFromInput);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commitFromInput();
                input.blur();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const cur = parseFreqString(input.value, isMin ? 20 : 1000000);
                const step = frCoarseStep(cur);
                commitValue(cur + (e.shiftKey ? step * 5 : step), true);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const cur = parseFreqString(input.value, isMin ? 20 : 1000000);
                const step = frCoarseStep(cur);
                commitValue(Math.max(1, cur - (e.shiftKey ? step * 5 : step)), true);
            }
        });

        const initialVal = parseFreqString(input.value, isMin ? 20 : 1000000);
        updateKnobUI(initialVal);

        return {
            sync: () => {
                const cur = parseFreqString(input.value, isMin ? 20 : 1000000);
                const clamped = clampValue(cur);
                input.value = clamped;
                updateKnobUI(clamped);
            }
        };
    }

    // Canvas interactivity (Linear space)
    if (canvas) {
        const ZOOM_PADL = 52, ZOOM_PADR = 24;
        canvas.style.cursor = 'crosshair';

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const [lo, hi] = graphViewRange();
            const rect = canvas.getBoundingClientRect();
            const plotW = (rect.width || 600) - ZOOM_PADL - ZOOM_PADR;
            const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - ZOOM_PADL) / plotW));
            if (plotW <= 0 || !isFinite(frac)) return;

            const fAt = lo + (hi - lo) * frac;
            const k = Math.pow(2, e.deltaY / 400);

            let nLo = fAt - (fAt - lo) * k;
            let nHi = fAt + (hi - fAt) * k;
            if (nHi - nLo < 1) {
                nLo = fAt - 0.5;
                nHi = fAt + 0.5;
            }

            viewLo = Math.max(state.fmin, Math.round(nLo));
            viewHi = Math.min(state.fmax, Math.round(nHi));
            renderCanvas();
        }, { passive: false });

        canvas.addEventListener('dblclick', (e) => {
            e.preventDefault();
            resetGraphView();
            renderCanvas();
        });

        let dragActive = false, dragStartX = 0, dragStartLo = 0, dragStartHi = 0;
        canvas.addEventListener('mousedown', (e) => {
            dragActive = true;
            dragStartX = e.clientX;
            const [lo, hi] = graphViewRange();
            dragStartLo = lo;
            dragStartHi = hi;
            canvas.style.cursor = 'grabbing';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const plotW = (rect.width || 600) - ZOOM_PADL - ZOOM_PADR;

            if (dragActive) {
                if (plotW <= 0) return;
                const span = dragStartHi - dragStartLo;
                const dx = ((e.clientX - dragStartX) / plotW) * span;
                viewLo = Math.max(state.fmin, Math.round(dragStartLo - dx));
                viewHi = Math.min(state.fmax, Math.round(dragStartHi - dx));
                renderCanvas();
                return;
            }

            if (e.clientX >= rect.left + ZOOM_PADL && e.clientX <= rect.right - ZOOM_PADR &&
                e.clientY >= rect.top && e.clientY <= rect.bottom) {
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                const data = currentData();
                const [fmin, fmax] = graphViewRange();
                const fSpan = Math.max(1, fmax - fmin);

                if (data.length > 0) {
                    let closest = null;
                    let minDistance = Infinity;
                    for (const p of data) {
                        const px = ZOOM_PADL + ((p.freq - fmin) / fSpan) * plotW;
                        const dist = Math.abs(px - mouseX);
                        if (dist < minDistance) {
                            minDistance = dist;
                            closest = p;
                        }
                    }
                    if (closest && minDistance < 50) {
                        hoverPoint = { ...closest, mouseX, mouseY };
                        renderCanvas();
                        return;
                    }
                }
            }
            if (hoverPoint) {
                hoverPoint = null;
                renderCanvas();
            }
        });

        window.addEventListener('mouseup', () => {
            if (!dragActive) return;
            dragActive = false;
            canvas.style.cursor = 'crosshair';
        });
    }

    const frKnobFmin = createFrKnob('knobFrFmin', 'knobFrFminFill', 'knobFrFminThumb', 'knobFrFminText', 'cfgFrFmin', true);
    const frKnobFmax = createFrKnob('knobFrFmax', 'knobFrFmaxFill', 'knobFrFmaxThumb', 'knobFrFmaxText', 'cfgFrFmax', false);

    if (selMode) {
        selMode.addEventListener('change', () => {
            parseConfig();
            if (frKnobFmin) frKnobFmin.sync();
            if (frKnobFmax) frKnobFmax.sync();
            render();
        });
    }

    if (selPoints) {
        const onPointsUpdate = () => {
            parseConfig();
            render();
        };
        selPoints.addEventListener('input', onPointsUpdate);
        selPoints.addEventListener('change', onPointsUpdate);
    }

    if (selOversample) {
        selOversample.addEventListener('change', () => {
            parseConfig();
            render();
        });
    }

    if (chkShowFc) {
        chkShowFc.addEventListener('change', render);
    }

    // Quick presets wiring
    document.querySelectorAll('.fr-preset-btn').forEach((b) => {
        b.addEventListener('click', () => {
            if (b.dataset.mode && selMode) {
                selMode.value = b.dataset.mode;
            }
            if (b.dataset.fmin && inpFmin) {
                inpFmin.value = b.dataset.fmin;
            }
            if (b.dataset.fmax && inpFmax) {
                inpFmax.value = b.dataset.fmax;
            }
            parseConfig();
            if (frKnobFmin) frKnobFmin.sync();
            if (frKnobFmax) frKnobFmax.sync();
            resetGraphView();
            render();
        });
    });

    function updateFrBadge() {
        if (frCalibZeroVal) {
            frCalibZeroVal.innerText = (state.zero.diode > 0) ? state.zero.diode : '0';
        }
        if (frCalibRefVal) {
            const cntGain = { [FR_MODE_DIRECT]: 0, [FR_MODE_DIODE]: 0, [FR_MODE_SINE]: 0 };
            const cntPhase = { [FR_MODE_DIRECT]: 0, [FR_MODE_DIODE]: 0, [FR_MODE_SINE]: 0 };
            const isDef = { [FR_MODE_DIRECT]: true, [FR_MODE_DIODE]: true, [FR_MODE_SINE]: true };
            for (const p of state.ref) {
                const m = normalizeMode(p.mode);
                if (p.value !== undefined) cntGain[m] = (cntGain[m] || 0) + 1;
                if (p.phase !== undefined && isFinite(p.phase)) cntPhase[m] = (cntPhase[m] || 0) + 1;
                if (!p.isDefault) isDef[m] = false;
            }
            frCalibRefVal.innerText = `Sine: Gain ${cntGain[FR_MODE_SINE]} / Phase ${cntPhase[FR_MODE_SINE]} pts (${isDef[FR_MODE_SINE] ? 'Def' : 'Cal'})`
                + ` | Direct: Gain ${cntGain[FR_MODE_DIRECT]} / Phase ${cntPhase[FR_MODE_DIRECT]} pts (${isDef[FR_MODE_DIRECT] ? 'Def' : 'Cal'})`
                + ` | Diode: Gain ${cntGain[FR_MODE_DIODE]} pts (${isDef[FR_MODE_DIODE] ? 'Def' : 'Cal'})`;
        }
        if (frCalibStatus) {
            const curM = chooseMode(state.fmin);
            const ready = refReadyFor(curM);
            const curIsDef = state.ref.filter(p => normalizeMode(p.mode) === curM).every(p => p.isDefault);
            frCalibStatus.title = ready ? (curIsDef ? 'Universal default reference active' : 'Universal calibration stored') : 'FR calibration not done';
            frCalibStatus.style.background = ready ? (curIsDef ? 'rgba(56, 189, 248, 0.15)' : 'rgba(34, 197, 94, 0.12)') : 'rgba(239, 68, 68, 0.15)';
            frCalibStatus.style.border = ready ? (curIsDef ? '1px solid rgba(56, 189, 248, 0.3)' : '1px solid rgba(34, 197, 94, 0.4)') : '1px solid rgba(239, 68, 68, 0.3)';
        }
    }

    function refReadyFor(mode) {
        ensureRefIndex();
        const m = normalizeMode(mode);
        const list = refIndex && refIndex[m];
        return !!(list && list.length >= 2);
    }

    function frCalibPointsFor(mode) {
        const idMap = {
            [FR_MODE_SINE]: 'frCalibPointsSine',
            [FR_MODE_DIRECT]: 'frCalibPointsDirect',
            [FR_MODE_DIODE]: 'frCalibPointsDiode'
        };
        const el = document.getElementById(idMap[normalizeMode(mode)]);
        const n = el ? parseInt(el.value, 10) : 0;
        return (n && n >= 4) ? n : 0;
    }

    async function runAutoCalibration(forceMode, pointsOverride) {
        if (typeof microTester === 'undefined' || !microTester.device) {
            const connectOk = await (microTester ? microTester.connect() : false);
            if (!connectOk || !microTester.device) {
                alert('Please connect the MicroTester USB device first via "Connect USB" at the top right.');
                return;
            }
        }
        if (state.busy) return;

        state.busy = true;
        setButtons();

        if (forceMode && selMode && selMode.value !== forceMode) {
            selMode.value = forceMode;
            selMode.dispatchEvent(new Event('change'));
        }
        parseConfig();
        const calModeNum = normalizeMode(forceMode || chooseMode(state.fmin));
        state.calFmin = 10;
        state.calFmax = (calModeNum === FR_MODE_DIODE) ? 42000000 : 1000000;
        const customPoints = (pointsOverride && pointsOverride >= 4) ? pointsOverride : frCalibPointsFor(calModeNum);
        state.calN = (customPoints > 0) ? customPoints : ((calModeNum === FR_MODE_SINE) ? 1024 : ((calModeNum === FR_MODE_DIODE) ? 53 : 40));
        state.calMode = (calModeNum === FR_MODE_SINE) ? 'sine' : ((calModeNum === FR_MODE_DIRECT) ? 'direct' : 'diode');

        const modal = document.getElementById('modalFrCalib');
        const modalTitle = document.getElementById('frModalTitle');
        const stepDesc = document.getElementById('frModalStepDesc');
        const progContainer = document.getElementById('frModalProgressContainer');
        const statusText = document.getElementById('frModalStatusText');
        const progressBar = document.getElementById('frModalProgressBar');
        const resultsEl = document.getElementById('frModalResults');
        const btnNext = document.getElementById('btnFrModalNext');
        const btnCancel = document.getElementById('btnFrModalCancel');
        const btnClose = document.getElementById('btnFrModalClose');

        if (!modal) {
            state.busy = false;
            setButtons();
            return;
        }

        const isDiode = (calModeNum === FR_MODE_DIODE);
        let currentStep = isDiode ? 1 : 2; // For Sine and Direct: jump straight to reference sweep step
        const pointLLs = buildUniversalCalPoints(calModeNum, customPoints);

        if (modalTitle) {
            const extra = ` (${pointLLs.length} pts · ${fmtHz(pointLLs[0])} – ${fmtHz(pointLLs[pointLLs.length - 1])})`;
            modalTitle.innerText = `FR Calibration — ${modeName(calModeNum)}${extra}`;
        }

        const getStepDesc = (step) => {
            if (calModeNum === FR_MODE_SINE) {
                return `Connect <strong>DAC OUT (PB5) directly to PB0 (ADC input)</strong> with a jumper wire.<br><strong style="color:#f59e0b;">Do NOT connect the DUT yet</strong> (leave open to GND).<br><span style="color:#94a3b8; font-size:12px;">Universal reference calibration (${pointLLs.length} points · 10 Hz – 1 MHz) will be measured using the Sigma-Delta DAC (PB5) and Goertzel detector (PB0). Zero offset is not required.</span>`;
            } else if (calModeNum === FR_MODE_DIRECT) {
                return `Connect <strong>PA8 (Square Wave Meander Out) directly to PB0 (ADC input)</strong> with a jumper wire (bypass DUT).<br><span style="color:#94a3b8; font-size:12px;">Universal reference calibration (${pointLLs.length} points · 10 Hz – 1 MHz) will be measured using PA8 meander generator and PB0 Goertzel detector.</span>`;
            } else {
                if (step === 1) {
                    return `Step 1 of 2: Please disconnect <strong>PA8</strong> from the diode detector probe (leave open circuit / no signal) to measure the diode detector zero DC offset.<br><span style="color:#94a3b8; font-size:12px;">This measures the zero-signal DC baseline of your detector.</span>`;
                } else {
                    return `Step 2 of 2: Connect <strong>PA8 (Square Wave Meander Out)</strong> directly to the <strong>Diode Detector input</strong> (bypass DUT), with Diode Detector output connected to <strong>PB0</strong>.<br><span style="color:#94a3b8; font-size:12px;">Universal reference calibration (${pointLLs.length} points · 10 Hz – 42 MHz) will be measured.</span>`;
                }
            }
        };

        const resetModalState = () => {
            currentStep = isDiode ? 1 : 2;
            if (stepDesc) {
                stepDesc.style.display = 'block';
                stepDesc.innerHTML = getStepDesc(currentStep);
            }
            const targetRow = document.getElementById('frModalTargetRow');
            if (targetRow) {
                targetRow.style.display = isDiode ? 'none' : 'flex';
            }
            const pointsRow = document.getElementById('frModalPointsRow');
            if (pointsRow) {
                pointsRow.style.display = 'flex';
                pointsRow.querySelectorAll('select[data-mode]').forEach((s) => {
                    s.style.display = (s.dataset.mode === state.calMode) ? '' : 'none';
                });
            }
            if (progContainer) progContainer.style.display = 'none';
            if (resultsEl) resultsEl.style.display = 'none';
            if (btnNext) {
                btnNext.style.display = 'inline-block';
                btnNext.innerText = 'Continue ▶';
                btnNext.disabled = false;
            }
            if (btnCancel) btnCancel.disabled = false;
            if (btnClose) btnClose.disabled = false;
            if (progressBar) progressBar.style.width = '0%';
        };

        const closeModalWizard = () => {
            modal.classList.remove('active');
            state.busy = false;
            setButtons();
            if (statusEl) {
                statusEl.innerText = 'IDLE';
                statusEl.className = 'status-badge stopped';
            }
            updateFrBadge();
        };

        resetModalState();
        modal.classList.add('active');

        const handleCancel = () => {
            stopSweep();
            closeModalWizard();
        };

        if (btnCancel) btnCancel.onclick = handleCancel;
        if (btnClose) btnClose.onclick = handleCancel;

        if (btnNext) {
            btnNext.onclick = async () => {
                if (currentStep === 1) {
                    // Only Diode mode enters Step 1 (Zero measurement)
                    btnNext.disabled = true;
                    if (btnCancel) btnCancel.disabled = true;
                    if (progContainer) progContainer.style.display = 'block';
                    if (statusText) statusText.innerText = '1/2: Measuring Diode Zero Baseline (open-circuit)...';
                    if (progressBar) progressBar.style.width = '20%';

                    try {
                        await sendFrStart();
                        const zeroResp = await requestPoint(0, FR_MODE_DIODE, 4000);
                        state.zero.diode = zeroResp ? (zeroResp.value >>> 0) : 0;
                        state.zero.direct = 0;
                        if (window.MTLogger) window.MTLogger.log('fr:calib', 'zero OK', { zero: state.zero.diode });
                        updateFrBadge();
                        saveCal();

                        currentStep = 2;
                        if (progContainer) progContainer.style.display = 'none';
                        if (stepDesc) {
                            stepDesc.innerHTML = getStepDesc(2);
                        }
                        btnNext.disabled = false;
                        if (btnCancel) btnCancel.disabled = false;
                    } catch (e) {
                        alert('Zero calibration failed: ' + (e && e.message ? e.message : e));
                        closeModalWizard();
                    }
                } else if (currentStep === 2) {
                    // Reference Sweep for Sine, Direct, or Diode
                    btnNext.disabled = true;
                    if (btnCancel) btnCancel.disabled = true;
                    const targetRow = document.getElementById('frModalTargetRow');
                    if (targetRow) targetRow.style.display = 'none';
                    const pointsRow = document.getElementById('frModalPointsRow');
                    if (pointsRow) pointsRow.style.display = 'none';
                    const selCalOver = document.getElementById('frCalibOversample');
                    if (selCalOver) {
                        const ov = parseInt(selCalOver.value, 10);
                        state.oversample = isNaN(ov) ? 16 : Math.max(0, ov);
                        if (selOversample) selOversample.value = String(state.oversample);
                    }
                    if (progContainer) progContainer.style.display = 'block';

                    try {
                        await sendFrStart();
                        const fresh = [];
                        const total = pointLLs.length;

                        for (let i = 0; i < total; i++) {
                            if (!state.busy) break;
                            const f = pointLLs[i];
                            const pct = Math.round(((i + 1) / total) * 100);
                            const stepPrefix = isDiode ? '2/2: ' : '';
                            if (statusText) statusText.innerText = `${stepPrefix}Reference sweep ${i + 1}/${total} · ${fmtHz(f)} (${pct}%)`;
                            if (progressBar) progressBar.style.width = pct + '%';
                            setStatus(`Calibrating ${i + 1}/${total} · ${fmtHz(f)}`, 'active');

                            const resp = await requestPoint(f, calModeNum);
                            if (!resp) throw new Error('Cancelled or no response');
                            fresh.push({
                                freq: resp.freq >>> 0,
                                mode: calModeNum,
                                value: resp.value >>> 0,
                                phase: (resp.phase !== undefined && isFinite(resp.phase)) ? resp.phase : 0.0,
                                isDefault: false
                            });
                        }

                        if (fresh.length < 2) throw new Error('Calibration incomplete');

                        const calTargetSel = document.getElementById('frCalibTarget');
                        const calTarget = calTargetSel ? calTargetSel.value : 'both';

                        if (calTarget === 'both') {
                            state.ref = state.ref.filter(p => normalizeMode(p.mode) !== calModeNum).concat(fresh);
                        } else {
                            const existingList = state.ref.filter(p => normalizeMode(p.mode) === calModeNum);
                            const existingMap = new Map();
                            for (const r of existingList) existingMap.set(r.freq, r);
                            const merged = [];
                            for (const p of fresh) {
                                const ex = existingMap.get(p.freq);
                                if (calTarget === 'gain') {
                                    merged.push({
                                        freq: p.freq,
                                        mode: calModeNum,
                                        value: p.value,
                                        phase: (ex && ex.phase !== undefined) ? ex.phase : p.phase,
                                        isDefault: false
                                    });
                                } else if (calTarget === 'phase') {
                                    merged.push({
                                        freq: p.freq,
                                        mode: calModeNum,
                                        value: (ex && ex.value !== undefined) ? ex.value : p.value,
                                        phase: p.phase,
                                        isDefault: false
                                    });
                                }
                            }
                            state.ref = state.ref.filter(p => normalizeMode(p.mode) !== calModeNum).concat(merged);
                        }

                        invalidateRefIndex();
                        state.dut = [];
                        saveCal();
                        updateFrBadge();

                        currentStep = 3;
                        if (progContainer) progContainer.style.display = 'none';
                        if (stepDesc) stepDesc.style.display = 'none';

                        if (resultsEl) {
                            const targetLabel = (calTarget === 'gain') ? 'Gain Only (АЧХ)' : ((calTarget === 'phase') ? 'Phase Only (ФЧХ)' : 'Gain & Phase (Both)');
                            let detailsHtml = '';
                            if (calModeNum === FR_MODE_SINE) {
                                detailsHtml = `
                                    <div style="color: #4ade80; font-weight: bold; margin-bottom: 8px;">Universal Sine FR/PR Calibration Complete!</div>
                                    <div>• Mode: <strong>Sine (10 Hz – 1.00 MHz)</strong></div>
                                    <div>• Calibrated Target: <strong>${targetLabel}</strong></div>
                                    <div>• Generator Output: <strong>PB5 (Sigma-Delta DAC)</strong></div>
                                    <div>• Input: <strong>PB0 (ADC Goertzel Lock-in)</strong></div>
                                    <div>• Reference Baselines: <strong>Gain 0.0 dB / Phase 0.0°</strong></div>
                                    <div>• Calibrated Points: <strong>Gain: ${fresh.length} pts, Phase: ${fresh.length} pts</strong></div>
                                    <div style="margin-top: 8px; color: #38bdf8; font-size: 11px;">Calibration stored. Connect your DUT between PB5 and PB0 and click "Gain Sweep", "Phase Sweep", or "Bode (Both)"!</div>
                                `;
                            } else if (calModeNum === FR_MODE_DIRECT) {
                                detailsHtml = `
                                    <div style="color: #4ade80; font-weight: bold; margin-bottom: 8px;">Universal Direct FR/PR Calibration Complete!</div>
                                    <div>• Mode: <strong>Direct Meander (10 Hz – 1.00 MHz)</strong></div>
                                    <div>• Calibrated Target: <strong>${targetLabel}</strong></div>
                                    <div>• Generator Output: <strong>PA8 (TIM1_CH1 Meander 50%)</strong></div>
                                    <div>• Input: <strong>PB0 (ADC Goertzel)</strong></div>
                                    <div>• Reference Baselines: <strong>Gain 0.0 dB / Phase 0.0°</strong></div>
                                    <div>• Calibrated Points: <strong>Gain: ${fresh.length} pts, Phase: ${fresh.length} pts</strong></div>
                                    <div style="margin-top: 8px; color: #38bdf8; font-size: 11px;">Calibration stored. Connect your DUT between PA8 and PB0 and click "Gain Sweep", "Phase Sweep", or "Bode (Both)"!</div>
                                `;
                            } else {
                                detailsHtml = `
                                    <div style="color: #4ade80; font-weight: bold; margin-bottom: 8px;">Universal Diode FR Calibration Complete!</div>
                                    <div>• Mode: <strong>Diode (10 Hz – 42.00 MHz)</strong></div>
                                    <div>• Generator Output: <strong>PA8 (TIM1_CH1 Meander 50%)</strong></div>
                                    <div>• Input: <strong>PB0 (ADC via Diode Detector)</strong></div>
                                    <div>• Diode Zero Baseline: <strong>${state.zero.diode} counts</strong></div>
                                    <div>• Calibrated Reference Points: <strong>${fresh.length} points</strong></div>
                                    <div style="margin-top: 8px; color: #38bdf8; font-size: 11px;">Universal calibration stored. Connect your DUT between PA8 and Diode Detector and press "Start Sweep"!</div>
                                `;
                            }
                            resultsEl.innerHTML = detailsHtml;
                            resultsEl.style.display = 'block';
                        }

                        btnNext.innerText = 'Done';
                        btnNext.disabled = false;
                        setStatus('Calibration done. Ready to sweep.', '');
                        render();
                    } catch (e) {
                        alert('Reference calibration failed: ' + (e && e.message ? e.message : e));
                        closeModalWizard();
                    }
                } else if (currentStep === 3) {
                    closeModalWizard();
                }
            };
        }
    }

    async function startSweep() {
        if (typeof microTester === 'undefined' || !microTester.device) {
            if (typeof microTester !== 'undefined') {
                const ok = await microTester.connect();
                if (!ok || !microTester.device) {
                    alert('Please connect the MicroTester USB device via "Connect USB" at the top right.');
                    return;
                }
            } else {
                alert('WebUSB not available.');
                return;
            }
        }
        if (state.busy) return;
        parseConfig();
        const mode = chooseMode(state.fmin);

        state.busy = true;
        setButtons();
        resetGraphView();

        try {
            await sendFrStart();
            const points = buildPoints();
            await runSweep(points);
            saveCal();
            updateFrBadge();
            resetGraphView();

            const span = refSpan(mode);
            if (!span) {
                setStatus('Sweep OK (Normalized)', '');
            } else {
                setStatus('Sweep OK', '');
            }
            render();
        } catch (e) {
            setStatus('Sweep failed: ' + (e && e.message ? e.message : e), 'stopped');
        } finally {
            state.busy = false;
            setButtons();
            render();
        }
    }

    function setViewMode(mode) {
        state.viewMode = mode;
        if (btnViewGain) btnViewGain.classList.toggle('active', mode === 'gain');
        if (btnViewPhase) btnViewPhase.classList.toggle('active', mode === 'phase');
        if (btnViewBoth) btnViewBoth.classList.toggle('active', mode === 'both');

        if (legendGain) legendGain.style.display = (mode === 'phase') ? 'none' : 'inline-flex';
        if (legendPhase) legendPhase.style.display = (mode === 'gain') ? 'none' : 'inline-flex';

        if (lblPlotTitle) {
            if (mode === 'gain') lblPlotTitle.innerText = 'Frequency Response (Gain)';
            else if (mode === 'phase') lblPlotTitle.innerText = 'Phase Response (Phase Shift)';
            else lblPlotTitle.innerText = 'Bode Plot (Gain & Phase)';
        }

        renderCanvas();
    }

    if (btnSweep) {
        btnSweep.addEventListener('click', () => {
            setViewMode('gain');
            startSweep();
        });
    }

    if (btnSweepPhase) {
        btnSweepPhase.addEventListener('click', () => {
            parseConfig();
            if (state.mode === 'diode') {
                if (selMode) {
                    selMode.value = 'sine';
                    selMode.dispatchEvent(new Event('change'));
                }
            }
            setViewMode('phase');
            startSweep();
        });
    }

    if (btnSweepBode) {
        btnSweepBode.addEventListener('click', () => {
            parseConfig();
            if (state.mode === 'diode') {
                if (selMode) {
                    selMode.value = 'sine';
                    selMode.dispatchEvent(new Event('change'));
                }
            }
            setViewMode('both');
            startSweep();
        });
    }

    if (btnViewGain) btnViewGain.addEventListener('click', () => setViewMode('gain'));
    if (btnViewPhase) btnViewPhase.addEventListener('click', () => setViewMode('phase'));
    if (btnViewBoth) btnViewBoth.addEventListener('click', () => setViewMode('both'));

    if (btnStop) btnStop.addEventListener('click', stopSweep);
    if (btnCalibDiode) btnCalibDiode.addEventListener('click', () => runAutoCalibration('diode'));
    if (btnCalibDirect) btnCalibDirect.addEventListener('click', () => runAutoCalibration('direct'));
    if (btnCalibSine) btnCalibSine.addEventListener('click', () => runAutoCalibration('sine'));
    if (btnCalibReset) {
        btnCalibReset.addEventListener('click', () => {
            state.zero = { diode: 0, direct: 0 };
            state.ref = [];
            state.dut = [];
            ensureDefaultRefs();
            saveCal();
            updateFrBadge();
            resetGraphView();
            render();
            setStatus('FR calibration reset to factory defaults', '');
        });
    }

    // USB Data listener with streaming buffer
    if (typeof microTester !== 'undefined') {
        try {
            microTester.addDataListener((data) => {
                if (!data || data.length === 0) return;

                const newBuf = new Uint8Array(frPacketBuffer.length + data.length);
                newBuf.set(frPacketBuffer);
                newBuf.set(data, frPacketBuffer.length);
                frPacketBuffer = newBuf;

                while (frPacketBuffer.length >= 16) {
                    const pktType = frPacketBuffer[0];
                    const payloadLen = frPacketBuffer[1];
                    const payloadLenHi = frPacketBuffer[2];

                    if (pktType === PKT_FR_DATA && (payloadLen === 13 || payloadLen === 15) && payloadLenHi === 0) {
                        const pktTotalLen = payloadLen + 3;
                        if (frPacketBuffer.length < pktTotalLen) break;

                        const freq = (frPacketBuffer[3] | (frPacketBuffer[4] << 8) | (frPacketBuffer[5] << 16) | (frPacketBuffer[6] << 24)) >>> 0;
                        const mode = frPacketBuffer[7];
                        const value = (frPacketBuffer[8] | (frPacketBuffer[9] << 8) | (frPacketBuffer[10] << 16) | (frPacketBuffer[11] << 24)) >>> 0;
                        const n = (frPacketBuffer[12] | (frPacketBuffer[13] << 8)) >>> 0;
                        const rate = (frPacketBuffer[14] | (frPacketBuffer[15] << 8)) >>> 0;

                        let phase = 0.0;
                        if (payloadLen >= 15) {
                            let rawPhase = (frPacketBuffer[16] | (frPacketBuffer[17] << 8));
                            // Sign extend 16-bit to signed integer
                            rawPhase = (rawPhase << 16) >> 16;
                            phase = rawPhase / 100.0; // convert centi-degrees to degrees
                        }

                        frPacketBuffer = frPacketBuffer.slice(pktTotalLen);

                        if (!pendingResolve) continue;
                        if (pendingFreq !== null && pendingFreq !== freq) continue;

                        if (pendingTimer) clearTimeout(pendingTimer);
                        const resolve = pendingResolve;
                        pendingResolve = null;
                        pendingFreq = null;
                        const resp = { freq, mode, value, phase, n, rate };
                        if (window.MTLogger) window.MTLogger.log('fr:point', 'FR data', resp);
                        resolve(resp);
                    } else {
                        frPacketBuffer = frPacketBuffer.slice(1);
                    }
                }
            });
        } catch (e) { /* ignore */ }
    }

    window.addEventListener('resize', render);

    const frPanel = document.getElementById('panel-freqresp');
    if (frPanel && window.MutationObserver) {
        new MutationObserver(() => {
            setTimeout(render, 10);
        }).observe(frPanel, { attributes: true, attributeFilter: ['class'] });
    }

    // Global exports
    window.renderFrCanvas = render;
    window.stopFr = stopSweep;

    // Debug log panel
    const logView = document.getElementById('frLogView');
    const btnLogDownload = document.getElementById('btnFrLogDownload');
    const btnLogClear = document.getElementById('btnFrLogClear');
    if (logView && window.MTLogger && typeof window.MTLogger.get === 'function') {
        setInterval(() => {
            const entries = window.MTLogger.get();
            const tail = entries.slice(-60).map(e =>
                new Date(e.t).toISOString().substr(11, 8) + ' [' + e.cat + '] ' + e.msg +
                (e.data !== undefined ? ' ' + JSON.stringify(e.data) : '')
            ).join('\n');
            logView.textContent = tail || '(log empty)';
        }, 1000);
    } else if (logView) {
        logView.textContent = '(logger not loaded)';
    }
    if (btnLogDownload) {
        btnLogDownload.addEventListener('click', () => {
            if (window.MTLogger) {
                if (window.MTLogger.copy()) {
                    btnLogDownload.textContent = '✓ Copied';
                    setTimeout(() => { btnLogDownload.textContent = '📋 Copy log'; }, 1500);
                }
            }
        });
    }
    if (btnLogClear) {
        btnLogClear.addEventListener('click', () => {
            if (window.MTLogger) {
                window.MTLogger.clear();
                if (logView) logView.textContent = '(log cleared)';
            }
        });
    }

    // Debug Log visibility toggle (Settings panel)
    const frDebugLogCard = document.getElementById('frDebugLogCard');
    const cfgShowDebugLog = document.getElementById('cfgShowDebugLog');
    if (frDebugLogCard && cfgShowDebugLog) {
        const syncDebugLogCard = () => {
            const enabled = cfgShowDebugLog.checked;
            localStorage.setItem('microtester_show_debug_log', enabled ? 'true' : 'false');
            frDebugLogCard.style.display = enabled ? '' : 'none';
            const compDebugLogCard = document.getElementById('compDebugLogCard');
            if (compDebugLogCard) {
                compDebugLogCard.style.display = enabled ? 'block' : 'none';
            }
        };
        cfgShowDebugLog.checked = localStorage.getItem('microtester_show_debug_log') === 'true';
        syncDebugLogCard();
        cfgShowDebugLog.addEventListener('change', syncDebugLogCard);
    }

    // Initialize calibration and render
    loadCal();
    updateFrBadge();
    parseConfig();
    render();

    setInterval(() => {
        setButtons();
    }, 500);

    if (window.MTLogger) window.MTLogger.log('fr:init', 'FR panel ready');
});