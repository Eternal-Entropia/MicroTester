// Modulator tab: live AM / FM / SSB / Class-D generation for MicroTester
// Payload layout (32 bytes) mirrors ModConfig in firmware/MicroTester/modulator.h
// UI follows the PWM (Signal Generator) tab design: preview canvas, multi-turn
// carrier knob, depth knob, quick presets and a computed parameters row.

document.addEventListener('DOMContentLoaded', () => {
    const FS = 32000;                  // must match MOD_FS in modulator.h
    const PH_UNIT = 4294967296 / FS;   // phase increment per Hz (2^32 * f / FS)
    const TIMER_CLK = 84000000;        // duty-resolution estimate (APB2 timers, same as siggen)

    // --- UI references ---
    const $ = (id) => document.getElementById(id);
    const cfgModMode       = $('cfgModMode');
    const cfgModSideband   = $('cfgModSideband');
    const cfgModSource     = $('cfgModSource');
    const cfgModCarrier    = $('cfgModCarrier');
    const cfgModToneFreq   = $('cfgModToneFreq');
    const cfgModDev        = $('cfgModDev');
    const cfgModOutPin     = $('cfgModOutPin');
    const cfgModAdcPin     = $('cfgModAdcPin');
    const cfgModBias       = $('cfgModBias');
    const cfgModHq         = $('cfgModHq');
    const cfgModDepth      = $('cfgModDepth');
    const cfgModSsbLevel   = $('cfgModSsbLevel');
    const lblModSsbLevelVal = $('lblModSsbLevelVal');
    const cfgModGain       = $('cfgModGain');
    const lblModGainVal    = $('lblModGainVal');
    const cfgModOffset     = $('cfgModOffset');
    const lblModOffsetVal  = $('lblModOffsetVal');
    const cfgModNorm       = $('cfgModNorm');
    const cfgModNormTarget = $('cfgModNormTarget');
    const lblModTargetVal  = $('lblModTargetVal');

    const btnModStart = $('btnModStart');
    const btnModStop  = $('btnModStop');
    const lblModStatus = $('lblModStatus');
    const modIndicator = $('modIndicator');

    const modSidebandField = $('modSidebandField');
    const modFmDevField    = $('modFmDevField');
    const modSsbLevelField = $('modSsbLevelField');
    const modOutPinField   = $('modOutPinField');
    const modBitrateField  = $('modBitrateField');
    const modAdcCard       = $('modAdcCard');
    const modModeHint      = $('modModeHint');
    const lblModCarrierTitle = $('lblModCarrierTitle');
    const lblModDepthTitle   = $('lblModDepthTitle');

    // Knob elements
    const carrierKnob      = $('carrierKnob');
    const carrierKnobFill  = $('carrierKnobFill');
    const carrierKnobThumb = $('carrierKnobThumb');
    const carrierKnobText  = $('carrierKnobText');
    const depthKnob        = $('depthKnob');
    const depthKnobFill    = $('depthKnobFill');
    const depthKnobThumb   = $('depthKnobThumb');
    const depthKnobText    = $('depthKnobText');

    // Preset groups
    const presetsSigma  = $('modCarrierPresetsSigma');
    const presetsClassD = $('modCarrierPresetsClassD');

    // Preview canvas
    const modCanvas = $('modWaveCanvas');

    // Parameters row (6 dynamic items)
    const infoL = [null, $('lblModL1'), $('lblModL2'), $('lblModL3'), $('lblModL4'), $('lblModL5'), $('lblModL6')];
    const infoP = [null, $('lblModP1'), $('lblModP2'), $('lblModP3'), $('lblModP4'), $('lblModP5'), $('lblModP6')];

    // --- State ---
    let isRunning = false;
    let sendTimer = null;
    let sendDirty = false;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const toI = (id, fallback) => {
        const v = parseInt(id ? id.value : '', 10);
        return Number.isFinite(v) ? v : fallback;
    };
    const toF = (id, fallback) => {
        const v = parseFloat(id ? id.value : '');
        return Number.isFinite(v) ? v : fallback;
    };

    const modeVal  = () => toI(cfgModMode, 1);
    const isClassD = () => modeVal() === 4;
    const isSsb    = () => modeVal() === 3;
    const isFm     = () => modeVal() === 2;
    const srcIsAdc = () => toI(cfgModSource, 0) === 1;

    const CARRIER_MIN = () => isClassD() ? 500 : 20;
    const CARRIER_MAX = () => isClassD() ? 300000 : 20000;
    const clampCarrier = (f) => clamp(Math.round(f), CARRIER_MIN(), CARRIER_MAX());
    const getCarrier = () => clampCarrier(toF(cfgModCarrier, isClassD() ? 62500 : 1000));
    const getTone = () => clamp(Math.round(toF(cfgModToneFreq, 1000)), 10, 8000);
    const getDev  = () => clamp(Math.round(toF(cfgModDev, 2000)), 0, 15000);
    const getDepth = () => clamp(toI(cfgModDepth, 100), 0, 100);
    const getSsbLevel = () => clamp(toI(cfgModSsbLevel, 70), 0, 100);
    const getTarget = () => clamp(toI(cfgModNormTarget, 80), 0, 100) / 100;
    const bitrate = () => (toI(cfgModHq, 6) === 5 ? 1312500 : 656000);

    // Envelope amplitude used for math/preview: the internal tone is a fixed
    // 0.7 FS sine on-device; with an external source + AGC the normalized peak
    // is the target percentage.
    const envAmp = () => (srcIsAdc() && cfgModNorm && cfgModNorm.checked) ? getTarget() : 0.7;

    function quantStep(f) {
        if (isClassD()) return f >= 10000 ? 100 : 10;
        return f >= 1000 ? 10 : 1;
    }

    // --- Formatting helpers (same style as the PWM tab) ---
    function fmtFreq(f) {
        if (f >= 1e6) return (f / 1e6).toFixed(2) + ' MHz';
        if (f >= 1000) return (f / 1000).toFixed(2) + ' kHz';
        return Math.round(f) + ' Hz';
    }
    function fmtFreqKnob(f) {
        const u = f >= 1e6 ? 'MHz' : f >= 1000 ? 'kHz' : 'Hz';
        const v = f >= 1e6 ? (f / 1e6).toFixed(2) : f >= 1000 ? (f / 1000).toFixed(2) : String(Math.round(f));
        return v + '<br><span style="font-size:12px; color:#94a3b8">' + u + '</span>';
    }
    function fmtTime(s) {
        if (s >= 1) return s.toFixed(2) + ' s';
        if (s >= 1e-3) return (s * 1e3).toFixed(2) + ' ms';
        if (s >= 1e-6) return (s * 1e6).toFixed(1) + ' µs';
        return (s * 1e9).toFixed(0) + ' ns';
    }

    // --- Payload builder (32 bytes, little-endian fields) ---
    const phaseInc = (f) => {
        let v = Math.round(f * PH_UNIT);
        while (v >= 4294967296) v -= 4294967296;
        return v;
    };

    function buildPayload() {
        const m = modeVal();
        const classD = m === 4;
        const p = new Uint8Array(32);
        const u8  = (o, v) => { p[o] = v & 0xFF; };
        const i8  = (o, v) => { p[o] = v & 0xFF; };
        const u16 = (o, v) => { p[o] = v & 0xFF; p[o + 1] = (v >> 8) & 0xFF; };
        const u32 = (o, v) => {
            p[o] = v & 0xFF; p[o + 1] = (v >> 8) & 0xFF;
            p[o + 2] = (v >> 16) & 0xFF; p[o + 3] = (v >> 24) & 0xFF;
        };

        const carrier = getCarrier();
        const tone = getTone();
        const dev  = getDev();
        const depth  = getDepth();
        const ssbLvl = getSsbLevel();
        const gain   = clamp(toI(cfgModGain, 200), 25, 800);
        const offset = clamp(toI(cfgModOffset, 0), -100, 100);
        const normT  = clamp(toI(cfgModNormTarget, 80), 0, 100);

        u8(0, m);
        u8(1, toI(cfgModSideband, 0) === 1 ? 1 : 0);
        u8(2, srcIsAdc() ? 1 : 0);
        u8(3, clamp(toI(cfgModOutPin, 0), 0, 10));
        u8(4, clamp(toI(cfgModAdcPin, 0), 0, 3));
        u8(5, toI(cfgModHq, 6) === 5 ? 5 : 6);
        u8(6, cfgModNorm && cfgModNorm.checked ? 1 : 0);
        u8(7, cfgModBias && cfgModBias.checked ? 1 : 0);
        u32(8, phaseInc(carrier));              // carrierInc (sigma modes)
        u32(12, phaseInc(tone));                // modInc (internal tone)
        u16(16, m >= 1 && m <= 4 ? Math.round(depth * 32768 / 100) : 32768); // depthQ15
        u32(18, phaseInc(dev));                 // devInc (FM)
        u16(22, Math.round(ssbLvl * 32768 / 100)); // ssbLevelQ15
        u16(24, Math.round(gain * 2.56));       // gainQ8 (256 = x1.00)
        i8(26, Math.round(offset * 127 / 100)); // offsetQ7
        u8(27, normT);                          // normTargetPct (0 = off)
        u32(28, classD ? carrier : 0);          // classDCarrierHz (raw PWM rate)
        return p;
    }

    // --- Knob UI updates ---
    const KNOB_DASH = 251.33; // 2*pi*40 (matches siggen)

    function setKnobThumb(thumb, frac) {
        // Same convention as siggen: 0 % -> 12 o'clock, sweep clockwise
        const angle = -90 + frac * 360;
        const rad = angle * Math.PI / 180;
        thumb.setAttribute('cx', (50 + 40 * Math.cos(rad)).toFixed(2));
        thumb.setAttribute('cy', (50 + 40 * Math.sin(rad)).toFixed(2));
    }

    function updateCarrierKnobUI() {
        if (!carrierKnobFill) return;
        const f = getCarrier();
        const lo = CARRIER_MIN(), hi = CARRIER_MAX();
        const frac = clamp(Math.log10(f / lo) / Math.log10(hi / lo), 0, 1);
        carrierKnobFill.style.strokeDashoffset = KNOB_DASH - frac * KNOB_DASH;
        setKnobThumb(carrierKnobThumb, frac);
        if (carrierKnobText) carrierKnobText.innerHTML = fmtFreqKnob(f);
    }

    function updateDepthKnobUI() {
        if (!depthKnobFill) return;
        const d = getDepth();
        const frac = d / 100;
        depthKnobFill.style.strokeDashoffset = KNOB_DASH - frac * KNOB_DASH;
        setKnobThumb(depthKnobThumb, frac);
        if (depthKnobText) depthKnobText.innerHTML = d + '<br><span style="font-size:12px; color:#94a3b8">%</span>';
    }

    // --- Knob interaction (drag + wheel), same feel as the PWM tab ---
    let knobDragging = null;
    let knobLastAngle = 0;

    function knobAngleFromEvent(e, el) {
        const r = el.getBoundingClientRect();
        return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
    }

    function carrierKnobDelta(dTurns) {
        const lo = CARRIER_MIN(), hi = CARRIER_MAX();
        let turns = Math.log10(getCarrier() / lo);
        turns = clamp(turns + dTurns, 0, Math.log10(hi / lo));
        setCarrierValue(lo * Math.pow(10, turns));
    }

    function depthKnobDelta(dPct) {
        cfgModDepth.value = Math.round(clamp(getDepth() + dPct, 0, 100));
        refreshAll();
    }

    function bindKnob(el, onDelta) {
        if (!el) return;
        el.addEventListener('mousedown', (e) => {
            knobDragging = el.id;
            knobLastAngle = knobAngleFromEvent(e, el);
            e.preventDefault();
        });
        el.addEventListener('wheel', (e) => {
            e.preventDefault();
            onDelta(-(e.deltaY / 100) * 0.08);
        }, { passive: false });
    }
    bindKnob(carrierKnob, (d) => carrierKnobDelta(d));
    bindKnob(depthKnob, (d) => depthKnobDelta(d * 100));

    document.addEventListener('mousemove', (e) => {
        if (!knobDragging) return;
        const el = document.getElementById(knobDragging);
        if (!el) { knobDragging = null; return; }
        const a = knobAngleFromEvent(e, el);
        let d = a - knobLastAngle;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        knobLastAngle = a;
        if (knobDragging === 'carrierKnob') carrierKnobDelta(d / (2 * Math.PI));
        else if (knobDragging === 'depthKnob') depthKnobDelta((d / (2 * Math.PI)) * 100);
    });
    document.addEventListener('mouseup', () => { knobDragging = null; });

    function setCarrierValue(f) {
        const q = quantStep(f);
        cfgModCarrier.value = clamp(Math.round(f / q) * q, CARRIER_MIN(), CARRIER_MAX());
        refreshAll();
    }

    // --- Visibility helpers ---
    function updateVisibility() {
        const m = modeVal();
        const classD = m === 4;
        const ssb = m === 3;
        const fm = m === 2;
        const amOrd = m === 1;

        modSidebandField.style.display = ssb ? '' : 'none';
        modFmDevField.style.display = fm ? '' : 'none';
        modSsbLevelField.style.display = ssb ? '' : 'none';
        modOutPinField.style.display = classD ? '' : 'none';
        if (modBitrateField) modBitrateField.style.display = classD ? 'none' : '';
        // Tone field stays visible: the internal tone is a valid Class-D source too

        // Carrier title / presets / numeric bounds follow the mode
        if (lblModCarrierTitle) lblModCarrierTitle.innerText = classD ? 'PWM Carrier' : 'Carrier (PB5 ΣΔ)';
        if (presetsSigma) presetsSigma.style.display = classD ? 'none' : 'flex';
        if (presetsClassD) presetsClassD.style.display = classD ? 'flex' : 'none';
        cfgModCarrier.min = CARRIER_MIN();
        cfgModCarrier.max = CARRIER_MAX();

        // Depth knob is only meaningful for AM / Class-D
        const depthEnabled = amOrd || classD;
        if (depthKnob) {
            depthKnob.style.opacity = depthEnabled ? '1' : '0.5';
            depthKnob.style.pointerEvents = depthEnabled ? 'auto' : 'none';
        }
        if (cfgModDepth) cfgModDepth.disabled = !depthEnabled;
        if (lblModDepthTitle) lblModDepthTitle.innerText = classD ? 'Swing (%)' : 'Depth (%)';

        // External-source conditioning card only applies to ADC source
        if (modAdcCard) {
            const adc = srcIsAdc();
            modAdcCard.style.opacity = adc ? '1' : '0.55';
            modAdcCard.style.pointerEvents = adc ? 'auto' : 'none';
        }

        lblModSsbLevelVal.innerText = `${getSsbLevel()} %`;
        lblModGainVal.innerText = `${(clamp(toI(cfgModGain, 200), 25, 800) / 100).toFixed(2)} x`;
        lblModOffsetVal.innerText = `${toI(cfgModOffset, 0)} %`;
        lblModTargetVal.innerText = `${toI(cfgModNormTarget, 80)} % of full swing`;

        modModeHint.innerText =
            m === 1 ? 'AM: s = (1 + m·env)·sin(2π·Fc·t). Sine carrier generated live on the ΣΔ bitstream (carrier amplitude fixed at 3/8 for headroom).' :
            fm ? 'FM: phase integrates env(t) with the deviation phase increment — true linear FM.' :
            ssb ? 'SSB: x = m·cosφ − m̂·sinφ (USB) or + (LSB) with a 15-tap Hilbert FIR.' :
            'Class-D: PWM duty = 50 % ± swing·env(t). Unlimited modulation frequency — envelope rate is ~32 kS/s on-device.';
    }

    // --- Parameters output row (dynamic like the PWM tab) ---
    function updateInfoRow() {
        const m = modeVal();
        const classD = m === 4;
        const f = getCarrier();
        const tone = getTone();

        if (!classD) {
            const br = bitrate();
            const dev = getDev();
            const beta = dev / tone;
            const osrCycle = br / f;
            let l5 = `${getDepth()} %`;
            if (m === 2) l5 = `${fmtFreq(dev)} (β ${beta.toFixed(2)})`;
            if (isSsb()) l5 = `${getSsbLevel()} % (${toI(cfgModSideband, 0) === 1 ? 'LSB' : 'USB'})`;
            const set = (i, l, v) => {
                if (infoL[i]) infoL[i].innerText = l;
                if (infoP[i]) infoP[i].innerText = v;
            };
            set(1, 'Carrier', fmtFreq(f));
            set(2, 'Carrier Period', fmtTime(1 / f));
            set(3, 'Oversampling', (osrCycle >= 100 ? Math.round(osrCycle) : osrCycle.toFixed(1)) + ' bits/cycle');
            set(4, 'Env OSR', (br / FS).toFixed(1) + '× @ 32 kS/s');
            set(5, m === 2 ? 'FM Deviation' : isSsb() ? 'SSB Level' : 'Depth', l5);
            set(6, 'Phase Increment', phaseInc(f).toLocaleString('en-US'));
        } else {
            const resSteps = Math.max(2, Math.floor(TIMER_CLK / f));
            const resBits = Math.log2(resSteps).toFixed(1);
            const stepPct = 100.0 / resSteps;
            const fmtPct = stepPct < 0.01 ? stepPct.toFixed(4) : (stepPct < 1 ? stepPct.toFixed(2) : stepPct.toFixed(1));
            const set = (i, l, v) => {
                if (infoL[i]) infoL[i].innerText = l;
                if (infoP[i]) infoP[i].innerText = v;
            };
            set(1, 'PWM Rate', fmtFreq(f));
            set(2, 'PWM Period', fmtTime(1 / f));
            set(3, 'Duty Resolution', `${resSteps.toLocaleString('en-US')} steps (${resBits} bit)`);
            set(4, 'Step Precision', `±${fmtPct}%`);
            set(5, 'Swing', `${getDepth()} %`);
            set(6, 'Envelope Rate', '≈ 32.2 kS/s');
        }
    }

    // --- Waveform live preview (schematic, like the PWM tab canvas) ---
    const MONO = '11px JetBrains Mono, Consolas, monospace';

    function drawPreview() {
        if (!modCanvas || !modCanvas.parentElement) return;
        const pw = modCanvas.parentElement.clientWidth || 600;
        const w = modCanvas.width = Math.max(320, pw);
        const h = modCanvas.height = 160;
        const ctx = modCanvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);

        // Grid
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        for (let x = 40; x < w; x += 40) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        for (let y = 0; y < h; y += 32) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }

        const m = modeVal();
        const fc = getCarrier();
        const ft = getTone();
        const depth = getDepth() / 100;
        const level = getSsbLevel() / 100;
        const dev = getDev();
        const envA = envAmp();
        const yMid = h / 2, ampPx = h / 2 - 20;
        const toY = (s) => yMid - (s / 0.75) * ampPx;

        ctx.fillStyle = '#94a3b8';
        ctx.font = MONO;
        ctx.fillText(
            (m === 4 ? 'Class-D PWM' : m === 3 ? 'SSB ' + (toI(cfgModSideband, 0) === 1 ? 'LSB' : 'USB') : ['AM', 'FM'][m - 1]) +
            `  ·  source: ${srcIsAdc() ? `ADC (schematic, AGC target ${Math.round(envA * 100)}%)` : `tone ${fmtFreq(ft)}`}`,
            8, 14
        );

        if (m === 4) { drawClassD(ctx, w, h, fc, ft, depth, envA, yMid, ampPx); }
        else { drawSigma(ctx, w, h, m, fc, ft, depth, level, dev, envA, yMid, toY); }
    }

    function glowPath(ctx, color, width) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width || 2.5;
        ctx.shadowColor = 'rgba(56, 189, 248, 0.5)';
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    function dashedPath(ctx, color) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = color || '#f59e0b';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Universal waveform renderers:
    //  - sparse signal  -> classic polyline with glow (like the PWM tab)
    //  - dense signal   -> per-pixel min/max "scope band" (no aliasing look)
    function polylineWave(ctx, w, tEnd, valFn, yOfFn) {
        ctx.beginPath();
        for (let x = 0; x <= w; x++) {
            const y = yOfFn(valFn((x / w) * tEnd));
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
    }
    function bandWave(ctx, w, tEnd, valFn, yOfFn, cycPerPx) {
        const k = Math.min(64, Math.max(8, Math.ceil(cycPerPx * 2.5)));
        const dt = tEnd / w / k;
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
            const t0 = (x / w) * tEnd;
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < k; i++) {
                const s = valFn(t0 + i * dt);
                if (s > hi) hi = s;
                if (s < lo) lo = s;
            }
            const xc = x + 0.5;
            ctx.moveTo(xc, yOfFn(hi));
            ctx.lineTo(xc, yOfFn(lo));
        }
    }
    function renderWave(ctx, w, tEnd, valFn, yOfFn, cycPerPx) {
        if (cycPerPx < 0.5) {
            polylineWave(ctx, w, tEnd, valFn, yOfFn);
            glowPath(ctx, '#38bdf8', 2);
        } else {
            bandWave(ctx, w, tEnd, valFn, yOfFn, cycPerPx);
            glowPath(ctx, '#38bdf8', 1.5);
        }
    }

    function drawSigma(ctx, w, h, m, fc, ft, depth, level, dev, envA, yMid, toY) {
        const isAm = m === 1, isFm = m === 2, isSsb = m === 3;
        const lsb = toI(cfgModSideband, 0) === 1;
        const fe = isSsb ? Math.abs(lsb ? fc - ft : fc + ft) : fc;
        const tEnd = 3 / ft;                      // 3 modulation periods on screen
        const cycles = tEnd * fe;

        const envVal = (t) => {
            const e = Math.sin(2 * Math.PI * ft * t) * envA;
            if (isAm) return 0.375 * (1 + depth * e);
            if (isSsb) return 0.75 * level;
            return 0.75; // FM constant peak
        };
        const sigVal = (t) => {
            if (isFm) return 0.75 * Math.sin(2 * Math.PI * fc * t + (dev / Math.max(1, ft)) * Math.sin(2 * Math.PI * ft * t));
            if (isSsb) return 0.75 * level * Math.sin(2 * Math.PI * fe * t);
            return 0.375 * (1 + depth * Math.sin(2 * Math.PI * ft * t) * envA) * Math.sin(2 * Math.PI * fc * t);
        };

        // Envelope: dashed amber lines (+ and −)
        ctx.beginPath();
        for (let x = 0; x <= w; x += 2) {
            const s = envVal((x / w) * tEnd);
            if (x === 0) ctx.moveTo(x, toY(s)); else ctx.lineTo(x, toY(s));
        }
        dashedPath(ctx);
        ctx.beginPath();
        for (let x = 0; x <= w; x += 2) {
            const s = -envVal((x / w) * tEnd);
            if (x === 0) ctx.moveTo(x, toY(s)); else ctx.lineTo(x, toY(s));
        }
        dashedPath(ctx);

        if (cycles / w >= 0.5) {
            // Dense carrier: soften the band between the envelopes (drawn under the wave)
            ctx.fillStyle = 'rgba(56, 189, 248, 0.10)';
            ctx.beginPath();
            for (let x = 0; x <= w; x += 2) {
                const s = envVal((x / w) * tEnd);
                if (x === 0) ctx.moveTo(x, toY(s)); else ctx.lineTo(x, toY(s));
            }
            for (let x = w; x >= 0; x -= 2) {
                ctx.lineTo(x, toY(-envVal((x / w) * tEnd)));
            }
            ctx.closePath();
            ctx.fill();
        }
        renderWave(ctx, w, tEnd, sigVal, toY, cycles / w);

        ctx.fillStyle = '#94a3b8';
        ctx.font = MONO;
        const note = isAm ? `Fc ${fmtFreq(fc)} · depth ${Math.round(depth * 100)} % · carrier amp 3/8`
            : isFm ? `Fc ${fmtFreq(fc)} · ±${fmtFreq(dev)} · β ${(dev / ft).toFixed(2)}`
            : `Fc±Ft = ${fmtFreq(fe)} · level ${Math.round(level * 100)} %`;
        ctx.fillText(note, 8, h - 12);
    }

    function drawClassD(ctx, w, h, fc, ft, swing, envA, yMid, ampPx) {
        const tEnd = 3 / ft;               // 3 envelope periods on screen
        const cycles = tEnd * fc;
        const yHigh = yMid - ampPx * 0.88;
        const yLow = yMid + ampPx * 0.88;
        const dutyAt = (t) => clamp(0.5 + swing * envA * Math.sin(2 * Math.PI * ft * t), 0.02, 0.98);
        const dutyY = (d) => yLow + (1 - d) * (yHigh - yLow);

        // 50 % duty reference
        ctx.beginPath();
        ctx.moveTo(0, dutyY(0.5)); ctx.lineTo(w, dutyY(0.5));
        dashedPath(ctx, '#475569');

        // Actual PWM toggling with envelope-following duty
        const pwmVal = (t) => (((t * fc) % 1) < dutyAt(t) ? 1 : -1);
        renderWave(ctx, w, tEnd, pwmVal, (v) => (v > 0 ? yHigh : yLow), cycles / w);

        // Duty trend = post-filter (LC) view of the class-D stage
        ctx.beginPath();
        for (let x = 0; x <= w; x += 2) {
            const y = dutyY(dutyAt((x / w) * tEnd));
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        dashedPath(ctx, '#f59e0b');

        ctx.fillStyle = '#94a3b8';
        ctx.font = MONO;
        ctx.fillText(`fPWM ${fmtFreq(fc)} · duty 50 % ± ${Math.round(swing * 100)} %·env · 3.3 V rail`, 8, h - 12);
    }

    // --- Refresh pipeline ---
    function refreshAll() {
        updateVisibility();
        updateCarrierKnobUI();
        updateDepthKnobUI();
        updateInfoRow();
        drawPreview();
    }

    // --- Live config push while running (throttled) ---
    function scheduleConfigSend() {
        if (!isRunning) return;
        sendDirty = true;
        if (sendTimer !== null) return;
        sendTimer = setTimeout(() => {
            sendTimer = null;
            if (!sendDirty || !isRunning || !microTester || !microTester.device) return;
            sendDirty = false;
            try { microTester.sendCommand(CMD_MOD_CONFIG, buildPayload()); } catch (e) { /* ignore transient */ }
        }, 120);
    }

    // --- Start / Stop ---
    function setStatus(running) {
        isRunning = running;
        if (lblModStatus) {
            lblModStatus.innerText = running ? 'MODULATING' : 'STOPPED';
            lblModStatus.className = running ? 'status-badge active' : 'status-badge stopped';
        }
        if (modIndicator) modIndicator.classList.toggle('active', running);
        if (btnModStart) btnModStart.disabled = running;
        if (btnModStop) btnModStop.disabled = !running;
    }

    if (btnModStart) {
        btnModStart.addEventListener('click', async () => {
            if (!microTester || !microTester.device) {
                if (!microTester) return alert('Connect USB first!');
                // Same UX as the oscilloscope: clicking Start opens the device picker
                const ok = await microTester.connect();
                if (!ok || !microTester.device) return alert('Connect USB first!');
            }
            refreshAll();
            microTester.sendCommand(CMD_MOD_CONFIG, buildPayload());
            microTester.sendCommand(CMD_MOD_START);
            setStatus(true);
        });
    }

    if (btnModStop) {
        btnModStop.addEventListener('click', () => {
            try { microTester && microTester.sendCommand(CMD_MOD_STOP); } catch (e) { /* ignore */ }
            setStatus(false);
        });
    }

    // --- Input wiring ---
    // Mode change first snaps the carrier into the valid range of the new mode
    if (cfgModMode) {
        cfgModMode.addEventListener('change', () => {
            const f = toF(cfgModCarrier, isClassD() ? 62500 : 1000);
            if (f < CARRIER_MIN() || f > CARRIER_MAX()) setCarrierValue(f);
            refreshAll();
            scheduleConfigSend();
        });
    }
    const allInputs = [cfgModSideband, cfgModSource, cfgModCarrier, cfgModToneFreq, cfgModDev,
        cfgModOutPin, cfgModAdcPin, cfgModBias, cfgModHq, cfgModDepth, cfgModSsbLevel,
        cfgModGain, cfgModOffset, cfgModNormTarget, cfgModNorm];
    ['input', 'change'].forEach((evt) => {
        allInputs.concat([cfgModMode]).forEach((el) => {
            if (el) el.addEventListener(evt, () => { refreshAll(); scheduleConfigSend(); });
        });
    });

    // Quick presets
    document.querySelectorAll('#panel-modulator .mod-tone-preset-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (cfgModToneFreq) cfgModToneFreq.value = btn.dataset.freq;
            refreshAll();
            scheduleConfigSend();
        });
    });
    document.querySelectorAll('#panel-modulator .mod-carrier-preset-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            setCarrierValue(parseFloat(btn.dataset.freq));
            scheduleConfigSend();
        });
    });

    // Redraw the preview when the layout resizes (tab shown, window resized)
    if (typeof ResizeObserver !== 'undefined' && modCanvas && modCanvas.parentElement) {
        new ResizeObserver(() => drawPreview()).observe(modCanvas.parentElement);
    }

    // Keep Start/Stop buttons in sync (Start stays clickable while disconnected:
    // clicking it opens the WebUSB device picker, same as the oscilloscope tab)
    const syncModButtons = () => {
        if (btnModStart) btnModStart.disabled = isRunning;
        if (btnModStop) btnModStop.disabled = !isRunning;
    };
    syncModButtons();
    setInterval(syncModButtons, 500);

    refreshAll();

    // --- Clean up on USB disconnect ---
    if (typeof microTester !== 'undefined' && microTester && typeof microTester.onDisconnect !== 'undefined') {
        const origDis = microTester.onDisconnect;
        microTester.onDisconnect = function () {
            if (origDis) origDis.apply(this, arguments);
            setStatus(false);
        };
    }
});
