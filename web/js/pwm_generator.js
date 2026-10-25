// ============================================================
// [PWM Generator] — вкладка "PWM" (панель #panel-siggen)
// Hardware-timer PWM output: frequency / duty control.
// (ранее файл назывался siggen.js — переименован для ясности)
// ============================================================

// Signal Generator / PWM Controller for MicroTester

document.addEventListener('DOMContentLoaded', () => {
    // --- UI Elements ---
    const cfgSigWaveform  = document.getElementById('cfgSigWaveform');
    const cfgSigFreq      = document.getElementById('cfgSigFreq');
    const cfgSigFreqRange = document.getElementById('cfgSigFreqRange');
    const cfgSigDuty      = document.getElementById('cfgSigDuty');
    const cfgSigDutyRange = document.getElementById('cfgSigDutyRange');
    const cfgSigPin       = document.getElementById('cfgSigPin');

    const btnSigStart = document.getElementById('btnSigStart');
    const btnSigStop  = document.getElementById('btnSigStop');

    // Calculated Parameter Display Elements
    const lblSigPeriod = document.getElementById('lblSigPeriod');
    const lblSigTHigh  = document.getElementById('lblSigTHigh');
    const lblSigTLow   = document.getElementById('lblSigTLow');
    const lblSigResolution    = document.getElementById('lblSigResolution');
    const lblSigStepPrecision = document.getElementById('lblSigStepPrecision');
    const lblSigRealFreq      = document.getElementById('lblSigRealFreq');
    const lblSigStatus = document.getElementById('lblSigStatus');
    const sigGenIndicator = document.getElementById('sigGenIndicator');
    const canvas       = document.getElementById('sigWaveCanvas');
    const cfgShowLevelLabels = document.getElementById('cfgShowLevelLabels');

    const showLevelLabels = () => !cfgShowLevelLabels || cfgShowLevelLabels.checked;

    let isRunning = false;

    // --- Enable/Disable Buttons based on Running state ---
    // Start stays clickable while disconnected: clicking it opens the WebUSB
    // device picker (same UX as the oscilloscope / voltmeter tabs).
    const syncRunButtons = () => {
        if (btnSigStart) btnSigStart.disabled = isRunning;
        if (btnSigStop)  btnSigStop.disabled  = !isRunning;
    };
    syncRunButtons();
    setInterval(syncRunButtons, 500);

    // --- Helper: Format Time Units ---
    function formatTime(seconds) {
        if (seconds < 1e-6) return (seconds * 1e9).toFixed(1) + ' ns';
        if (seconds < 1e-3) return (seconds * 1e6).toFixed(2) + ' µs';
        if (seconds < 1)    return (seconds * 1e3).toFixed(2) + ' ms';
        return seconds.toFixed(3) + ' s';
    }

    // --- Helper: Format Frequency Units ---
    function formatFreq(hz) {
        if (hz >= 1e6) return (hz / 1e6).toFixed(3) + ' MHz';
        if (hz >= 1e3) return (hz / 1e3).toFixed(2) + ' kHz';
        return hz.toFixed(0) + ' Hz';
    }

    // --- Update Parameters & Waveform Canvas Preview ---
    function updateCalculationsAndPreview() {
        const waveform = parseInt(cfgSigWaveform?.value || '0');
        const freq = Math.max(1, Math.min(42000000, parseInt(cfgSigFreq?.value || '1000')));
        const duty = (waveform === 0) ? 50 : ((waveform === 2) ? 100 : Math.min(100, Math.max(0, parseInt(cfgSigDuty?.value || '50'))));

        // Disable/enable controls based on waveform type
        const isDc = (waveform === 2);
        if (cfgSigFreq) cfgSigFreq.disabled = isDc;
        if (cfgSigFreqRange) cfgSigFreqRange.disabled = isDc;
        const freqKnob = document.getElementById('freqKnob');
        if (freqKnob) freqKnob.style.opacity = isDc ? '0.5' : '1';
        if (freqKnob) freqKnob.style.pointerEvents = isDc ? 'none' : 'auto';
        if (cfgSigDuty) cfgSigDuty.disabled = (waveform === 0 || isDc);
        if (cfgSigDutyRange) cfgSigDutyRange.disabled = (waveform === 0 || isDc);

        // Firmware-exact duty math: the compare register holds
        // floor((ARR + 1) * duty% / 100) ticks of high time (fixed 50% for the
        // square wave). That is the REAL high time the timer can produce —
        // finer input percents collapse into the same compare value.
        const per = pwmPeriod(freq);
        const dutyRealPct = dutyRealPercent(waveform, duty, per);
        const dutyDec = per.ticks < 100 ? 2 : (per.ticks < 2000 ? 1 : 0);

        // Update Knob UI (duty knob text always shows the real duty)
        updateKnobUI(freq);
        updateDutyKnobPwmUI(duty, dutyRealPct, per.ticks);

        if (isDc) {
            if (lblSigPeriod) lblSigPeriod.innerText = 'DC';
            if (lblSigTHigh)  lblSigTHigh.innerText  = 'Continuous';
            if (lblSigTLow)  (lblSigTLow.innerText   = '0 ms');
            if (lblSigResolution)    lblSigResolution.innerText    = 'N/A (DC)';
            if (lblSigStepPrecision) lblSigStepPrecision.innerText = 'N/A';
        } else {
            const realFreq = SIG_TIM_CLK / (per.psc * per.ticks);   // what the timer produces
            const periodSec = 1.0 / realFreq;
            const tHighSec  = periodSec * (dutyRealPct / 100.0);
            const tLowSec   = periodSec - tHighSec;

            if (lblSigPeriod) lblSigPeriod.innerText = formatTime(periodSec);
            if (lblSigTHigh)  lblSigTHigh.innerText  = formatTime(tHighSec);
            if (lblSigTLow)   lblSigTLow.innerText   = formatTime(tLowSec);

            if (lblSigRealFreq) {
                const periodTicks = per.psc * per.ticks;
                lblSigRealFreq.innerText = formatFreq(realFreq) + ' (' + periodTicks.toLocaleString() + ' ticks)';
            }

            // Timer PWM Resolution — duty steps (compare-register granularity)
            const resSteps = per.ticks;
            const resBits  = Math.log2(resSteps).toFixed(1);
            const stepPct  = (100.0 / resSteps);
            const fmtPct   = stepPct < 0.01 ? stepPct.toFixed(4) : (stepPct < 1 ? stepPct.toFixed(2) : stepPct.toFixed(1));

            if (lblSigResolution)    lblSigResolution.innerText    = `${resSteps.toLocaleString()} steps (${resBits} bit)`;
            if (lblSigStepPrecision) lblSigStepPrecision.innerText = `±${fmtPct}%`;
        }

        // Draw Canvas Preview
        if (canvas) {
            const ctx = canvas.getContext('2d');
            // Hi-DPI rendering: sharp text/lines on any display
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.parentElement ? canvas.parentElement.clientWidth : 600;
            const h = 160;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            canvas.style.width = '100%';
            canvas.style.height = h + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            ctx.clearRect(0, 0, w, h);

            // Background grid
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            for (let x = 0; x < w; x += 40) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
            }
            for (let y = 0; y < h; y += 32) {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(w, y);
                ctx.stroke();
            }

            const yHigh = 35;
            const yLow  = h - 35;

            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 3;
            ctx.shadowColor = 'rgba(56, 189, 248, 0.5)';
            ctx.shadowBlur = 10;

            if (isDc) {
                // Draw Flat DC Line
                ctx.beginPath();
                ctx.moveTo(20, yHigh);
                ctx.lineTo(w - 20, yHigh);
                ctx.stroke();
                ctx.shadowBlur = 0;

                ctx.fillStyle = '#94a3b8';
                ctx.font = '12px JetBrains Mono, Consolas, monospace';
                if (showLevelLabels()) ctx.fillText(`3.3V (DC HIGH)`, 25, yHigh - 10);
                ctx.fillText(`Mode: DC (Constant 3.3V)`, w - 240, 24);
            } else {
                // Draw Waveform Line
                const periodPx = 180; // 180px per full period
                const highPx = periodPx * (dutyRealPct / 100.0);

                ctx.beginPath();
                let currX = 20;
                ctx.moveTo(currX, yLow);

                while (currX < w) {
                    // Low to High transition
                    ctx.lineTo(currX, yHigh);
                    // High level
                    const xHighEnd = Math.min(currX + highPx, w);
                    ctx.lineTo(xHighEnd, yHigh);
                    
                    if (xHighEnd >= w) break;

                    // High to Low transition
                    ctx.lineTo(xHighEnd, yLow);
                    // Low level
                    const xPeriodEnd = Math.min(currX + periodPx, w);
                    ctx.lineTo(xPeriodEnd, yLow);

                    currX += periodPx;
                }
                ctx.stroke();
                ctx.shadowBlur = 0; // reset glow

                // Draw Annotations
                ctx.fillStyle = '#94a3b8';
                ctx.font = '12px JetBrains Mono, Consolas, monospace';
                if (showLevelLabels()) {
                    ctx.fillText(`3.3V (HIGH)`, 25, yHigh - 10);
                    ctx.fillText(`0V (LOW)`, 25, yLow + 20);
                }
                ctx.fillText(`Freq: ${formatFreq(freq)}  |  Duty: ${dutyRealPct.toFixed(dutyDec)}%`, w - 240, 24);
            }
        }
    }

    // --- Send Command Helper ---
    function sendSigStart() {
        if (!microTester || !microTester.device) return;

        const pin      = parseInt(cfgSigPin?.value || '0');
        const waveform = parseInt(cfgSigWaveform?.value || '0');
        const freq     = Math.max(1, Math.min(42000000, parseInt(cfgSigFreq?.value || '1000')));
        const duty     = Math.min(100, Math.max(0, parseInt(cfgSigDuty?.value || '50')));

        const payload = new Uint8Array(7);
        payload[0] = pin;
        payload[1] = waveform;
        payload[2] = freq & 0xFF;
        payload[3] = (freq >> 8) & 0xFF;
        payload[4] = (freq >> 16) & 0xFF;
        payload[5] = (freq >> 24) & 0xFF;
        payload[6] = duty;

        microTester.sendCommand(CMD_SIG_START, payload);
    }

    function sendSigStop() {
        if (!microTester || !microTester.device) return;
        microTester.sendCommand(CMD_SIG_STOP);
    }

    // --- Event Listeners for Live Inputs ---
    if (cfgSigFreq && cfgSigFreqRange) {
        cfgSigFreq.addEventListener('input', () => {
            const freqVal = Math.max(1, Math.min(42000000, parseFloat(cfgSigFreq.value) || 1));
            if (cfgSigFreqRange) cfgSigFreqRange.value = Math.log10(freqVal);
            updateCalculationsAndPreview();
            if (isRunning) sendSigStart();
        });
        // finished typing (blur/Enter): snap to the nearest attainable value
        cfgSigFreq.addEventListener('change', () => {
            const snapped = quantizeFreq(parseFloat(cfgSigFreq.value) || 1000);
            cfgSigFreq.value = snapped;
            if (cfgSigFreqRange) cfgSigFreqRange.value = Math.log10(snapped);
            updateCalculationsAndPreview();
            if (isRunning) sendSigStart();
        });
        cfgSigFreqRange.addEventListener('input', () => {
            const freqHz = quantizeFreq(Math.round(Math.pow(10, parseFloat(cfgSigFreqRange.value))));
            cfgSigFreq.value = freqHz;
            updateCalculationsAndPreview();
            if (isRunning) sendSigStart();
        });
    }

    if (cfgSigDuty && cfgSigDutyRange) {
        cfgSigDuty.addEventListener('input', () => {
            cfgSigDutyRange.value = cfgSigDuty.value;
            updateCalculationsAndPreview();
            if (isRunning) sendSigStart();
        });
        cfgSigDutyRange.addEventListener('input', () => {
            cfgSigDuty.value = cfgSigDutyRange.value;
            updateCalculationsAndPreview();
            if (isRunning) sendSigStart();
        });
    }

    // --- Debounced USB Update Handler ---
    let pwmSendTimer = null;
    function debouncedSendSigStart() {
        if (!isRunning) return;
        if (pwmSendTimer) clearTimeout(pwmSendTimer);
        pwmSendTimer = setTimeout(() => {
            sendSigStart();
        }, 300);
    }

    // --- Mouse Wheel Adjustment Handlers ---
    function adjustFreqByWheel(e) {
        if (cfgSigFreq?.disabled) return;
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const isFast = e.shiftKey || e.ctrlKey;
        const currentFreq = Math.max(1, Math.min(42000000, parseFloat(cfgSigFreq?.value || 1000)));

        // Classic linear ladder (unchanged UX), Shift/Ctrl = 5x
        let step = 1;
        if (currentFreq < 100)          step = 1;
        else if (currentFreq < 1000)    step = 10;
        else if (currentFreq < 10000)   step = 100;
        else if (currentFreq < 100000)  step = 1000;
        else if (currentFreq < 1000000) step = 10000;
        else if (currentFreq < 10000000) step = 100000;
        else                            step = 1000000;
        if (isFast) step *= 5;

        // Snap to the attainable staircase so the value is exactly reproducible
        const newFreq = Math.min(42000000, Math.max(1, currentFreq + dir * step));
        let snapped = quantizeFreq(newFreq);

        // Fine ladder steps can collapse into the same attainable entry
        // (e.g. 1 MHz steps in the 12-28 MHz band, where the next entry is
        // 14 MHz away): jump straight to the adjacent attainable entry.
        if (snapped === currentFreq) {
            const nxt = nextAttainable(currentFreq, dir);
            if (nxt !== null) snapped = nxt;
        }

        if (cfgSigFreq && parseFloat(cfgSigFreq.value) !== snapped) {
            cfgSigFreq.value = snapped;
            if (cfgSigFreqRange) cfgSigFreqRange.value = Math.log10(snapped);
            updateCalculationsAndPreview();
            debouncedSendSigStart();
        }
    }

    function adjustDutyByWheel(e) {
        if (cfgSigDuty?.disabled) return;
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const isFast = e.shiftKey || e.ctrlKey;
        const step = isFast ? 5 : 1;
        const currentDuty = parseInt(cfgSigDuty?.value || '50');
        const newDuty = Math.min(100, Math.max(0, currentDuty + dir * step));
        if (cfgSigDuty) cfgSigDuty.value = newDuty;
        if (cfgSigDutyRange) cfgSigDutyRange.value = newDuty;
        updateCalculationsAndPreview();
        debouncedSendSigStart();
    }

    if (cfgSigFreq) cfgSigFreq.addEventListener('wheel', adjustFreqByWheel, { passive: false });
    if (cfgSigFreqRange) cfgSigFreqRange.addEventListener('wheel', adjustFreqByWheel, { passive: false });
    if (cfgSigDuty) cfgSigDuty.addEventListener('wheel', adjustDutyByWheel, { passive: false });
    if (cfgSigDutyRange) cfgSigDutyRange.addEventListener('wheel', adjustDutyByWheel, { passive: false });

    if (cfgSigWaveform) {
        cfgSigWaveform.addEventListener('change', () => {
            updateCalculationsAndPreview();
            if (isRunning) sendSigStart();
        });
    }

    if (cfgSigPin) {
        cfgSigPin.addEventListener('change', () => {
            if (isRunning) sendSigStart();
        });
    }

    // Preset Frequency Buttons
    document.querySelectorAll('.sig-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = parseInt(btn.getAttribute('data-freq'));
            if (val && cfgSigFreq) {
                const snapped = quantizeFreq(val);   // only truly attainable presets
                cfgSigFreq.value = snapped;
                if (cfgSigFreqRange) cfgSigFreqRange.value = Math.log10(snapped);
                updateCalculationsAndPreview();
                if (isRunning) sendSigStart();
            }
        });
    });

    // Preset Resolution Buttons
    document.querySelectorAll('.sig-res-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const bits = parseInt(btn.getAttribute('data-res'));
            if (bits && cfgSigFreq) {
                const targetSteps = Math.pow(2, bits);
                const freqHz = Math.round(84000000 / targetSteps);
                const snapped = quantizeFreq(freqHz);
                cfgSigFreq.value = snapped;
                if (cfgSigFreqRange) cfgSigFreqRange.value = Math.log10(snapped);
                updateCalculationsAndPreview();
                if (isRunning) sendSigStart();
            }
        });
    });

    // --- Start / Stop Handlers ---
    if (btnSigStart) {
        btnSigStart.addEventListener('click', async () => {
            if (!microTester || !microTester.device) {
                if (!microTester) return alert("Connect USB first!");
                // Same UX as the oscilloscope: clicking Start opens the device picker
                const ok = await microTester.connect();
                if (!ok || !microTester.device) return alert("Connect USB first!");
            }

            sendSigStart();
            isRunning = true;

            if (lblSigStatus) {
                lblSigStatus.innerText = 'GENERATING';
                lblSigStatus.className = 'status-badge active';
            }
            if (sigGenIndicator) sigGenIndicator.classList.add('active');

            if (btnSigStart) btnSigStart.disabled = true;
            if (btnSigStop) btnSigStop.disabled = false;
        });
    }

    if (btnSigStop) {
        btnSigStop.addEventListener('click', () => {
            sendSigStop();
            isRunning = false;

            if (lblSigStatus) {
                lblSigStatus.innerText = 'STOPPED';
                lblSigStatus.className = 'status-badge stopped';
            }
            if (sigGenIndicator) sigGenIndicator.classList.remove('active');

            if (btnSigStart) btnSigStart.disabled = false;
            if (btnSigStop) btnSigStop.disabled = true;
        });
    }

    if (typeof microTester !== 'undefined') {
        const origDis = microTester.onDisconnect;
        microTester.onDisconnect = function() {
            if (origDis) origDis.apply(this, arguments);
            isRunning = false;
            if (lblSigStatus) {
                lblSigStatus.innerText = 'STOPPED';
                lblSigStatus.className = 'status-badge stopped';
            }
            if (sigGenIndicator) sigGenIndicator.classList.remove('active');
            if (btnSigStart) btnSigStart.disabled = false;
            if (btnSigStop) btnSigStop.disabled = true;
        };
    }

    // Expose update function globally
    window.updateSigPreview = updateCalculationsAndPreview;

    // Redraw previews when level-label toggle changes (Settings panel)
    if (cfgShowLevelLabels) {
        cfgShowLevelLabels.addEventListener('change', () => {
            updateCalculationsAndPreview();
            if (window.updatePwmDacPreview) window.updatePwmDacPreview();
        });
    }

    // --- Multi-Turn Knob Slider Logic ---
    const freqKnob = document.getElementById('freqKnob');
    const freqKnobFill = document.getElementById('freqKnobFill');
    const freqKnobThumb = document.getElementById('freqKnobThumb');
    const freqKnobText = document.getElementById('freqKnobText');
    
    let isKnobDragging = false;
    let lastKnobAngle = 0;
    const MAX_TURNS = 7.0;

    function freqToTurns(freq) {
        freq = Math.max(1, Math.min(42000000, freq));
        if (freq <= 100)        return 0.0 + (freq - 1) / 99;
        if (freq <= 1000)       return 1.0 + (freq - 100) / 900;
        if (freq <= 10000)      return 2.0 + (freq - 1000) / 9000;
        if (freq <= 100000)     return 3.0 + (freq - 10000) / 90000;
        if (freq <= 1000000)    return 4.0 + (freq - 100000) / 900000;
        if (freq <= 10000000)   return 5.0 + (freq - 1000000) / 9000000;
        return 6.0 + (freq - 10000000) / 32000000;
    }

    function turnsToFreq(turns) {
        turns = Math.max(0, Math.min(MAX_TURNS, turns));
        let f;
        if (turns <= 1.0)      f = 1 + turns * 99;
        else if (turns <= 2.0) f = 100 + (turns - 1.0) * 900;
        else if (turns <= 3.0) f = 1000 + (turns - 2.0) * 9000;
        else if (turns <= 4.0) f = 10000 + (turns - 3.0) * 90000;
        else if (turns <= 5.0) f = 100000 + (turns - 4.0) * 900000;
        else if (turns <= 6.0) f = 1000000 + (turns - 5.0) * 9000000;
        else                   f = 10000000 + (turns - 6.0) * 32000000;
        return Math.round(f);
    }

    function updateKnobUI(freq) {
        if (!freqKnobFill || !freqKnobThumb || !freqKnobText) return;
        const turns = freqToTurns(freq);
        let turnFraction = turns % 1.0;
        if (turns >= MAX_TURNS) turnFraction = turns - Math.floor(turns);
        
        // Update SVG (360 degrees total, C = 251.33)
        const totalDash = 251.33;
        freqKnobFill.style.strokeDashoffset = totalDash - (turnFraction * totalDash);
        
        // Update Thumb (-90 deg to 270 deg)
        const angle = -90 + (turnFraction * 360);
        const rad = angle * Math.PI / 180;
        freqKnobThumb.setAttribute('cx', 50 + 40 * Math.cos(rad));
        freqKnobThumb.setAttribute('cy', 50 + 40 * Math.sin(rad));
        
        // Update Text — the REAL frequency the timer generates (ARR-quantized).
        // Decimal count follows the local attainable step, so any adjacent
        // selectable value differs in the last displayed digit.
        const real = pwmRealFreq(freq);
        const nAdj = Math.max(2, Math.round(SIG_TIM_CLK / Math.max(1e-9, real)));
        const gap = SIG_TIM_CLK / ((nAdj + 1) * nAdj);   // local attainable step
        if (real >= 1e6) {
            const dec = gap < 10 ? 4 : 2;
            freqKnobText.innerHTML = (real / 1e6).toFixed(dec) + '<br><span style="font-size:12px; color: #94a3b8">MHz</span>';
        } else if (real >= 1e3) {
            const dec = gap < 0.01 ? 5 : (gap < 1 ? 4 : (gap < 120 ? 3 : 2));
            freqKnobText.innerHTML = (real / 1e3).toFixed(dec) + '<br><span style="font-size:12px; color: #94a3b8">kHz</span>';
        } else {
            freqKnobText.innerHTML = real.toFixed(1) + '<br><span style="font-size:12px; color: #94a3b8">Hz</span>';
        }
    }

    let dragTurns = 0;

    function handleKnobStart(e) {
        if (!freqKnob) return;
        isKnobDragging = true;
        
        const currentFreq = Math.max(1, Math.min(42000000, parseFloat(cfgSigFreq?.value || 1000)));
        dragTurns = freqToTurns(currentFreq);

        const rect = freqKnob.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        let clientX = e.clientX;
        let clientY = e.clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        }
        
        lastKnobAngle = Math.atan2(clientY - centerY, clientX - centerX) * 180 / Math.PI;
    }

    // Real (timer-quantized) frequency of the generated square wave.
    // Exact mirror of STM32duino HardwareTimer::setOverflow(freq, HERTZ_FORMAT):
    //   period_cyc = floor(84e6 / freq)            [timer ticks per period]
    //   psc_factor = floor(period_cyc / 0x10000) + 1
    //   ticks      = floor(period_cyc / psc_factor)
    //   real       = 84e6 / (psc_factor * ticks)
    // Every PWM pin here sits on TIM1/2/3/4, all clocked at 2x APB = 84 MHz on
    // F401, so this function predicts the firmware output to the last Hz.
    const SIG_TIM_CLK = 84000000;
    // Exact firmware split for a requested frequency: prescaler factor and
    // CCR-granularity ticks. setOverflow HERTZ_FORMAT computes
    //   period_cyc = floor(84e6 / Hz);  psc = floor(pc / 65536) + 1;
    //   ticks (ARR + 1) = floor(pc / psc)
    // The duty compare register lives in this tick domain
    // (firmware: compare = (ARR + 1) * duty% / 100), so duty precision is
    // 100 / ticks percent per step and degrades as frequency grows.
    function pwmPeriod(f) {
        f = Math.round(Math.max(1, Math.min(42000000, f)) || 1);
        const periodCyc = Math.max(1, Math.floor(SIG_TIM_CLK / f));
        const psc = Math.floor(periodCyc / 0x10000) + 1;
        return { psc, ticks: Math.max(1, Math.floor(periodCyc / psc)) };
    }
    function pwmRealFreq(f) {
        const { psc, ticks } = pwmPeriod(f);
        return SIG_TIM_CLK / (psc * ticks);
    }
    // Real duty the compare register yields for the input percent.
    // Firmware: compare = floor((ARR + 1) * duty% / 100) (50% fixed for the
    // square wave); CCR above ARR means constant high, so clamp to the period.
    function dutyRealPercent(waveform, dutyIn, per) {
        const dutyEff = (waveform === 0) ? 50 : dutyIn;
        const compare = (waveform === 2) ? per.ticks : Math.floor((per.ticks + 1) * dutyEff / 100);
        return 100 * Math.min(compare, per.ticks) / per.ticks;
    }
    // Nearest attainable ("staircase") frequency the timer can produce near
    // the wanted value. Firmware decodes a sent integer Hz s into
    //   period_cyc = floor(84e6 / s)  [runtime uint division]
    // so the attainable staircase entries are the canonical sent values
    //   s(n) = floor(84e6 / n)  for n = ticks per period (>= 2, cap 42 MHz).
    // pwmRealFreq(s(n)) is a fixed point there: re-snapping never drifts the
    // knob value (quantizeCore used twice settles rare sub-10 kHz pc shifts).
    function quantizeCore(x) {
        x = Math.max(1, Math.min(42000000, Math.round(x) || 1));
        // n0 is the entry at/above x (CLK/n0 >= x); the entry below is n0+1.
        // The n0-1 entry is always farther than n0 when x < CLK/n0, so two
        // candidates suffice.
        const n0 = Math.max(2, Math.floor(SIG_TIM_CLK / x));
        let bestS = Math.floor(SIG_TIM_CLK / n0);          // entry at/above x
        let bestErr = Math.abs(pwmRealFreq(bestS) - x);
        const sDn = Math.floor(SIG_TIM_CLK / (n0 + 1));    // entry below x
        const errDn = Math.abs(pwmRealFreq(sDn) - x);
        if (errDn < bestErr) { bestErr = errDn; bestS = sDn; }
        return bestS;
    }
    function quantizeFreq(freq) {
        freq = Math.max(1, Math.min(42000000, Math.round(freq) || 1));
        // below ~13 kHz attainable entries are < 2 Hz apart (comparable with
        // the floor-rounding offset of canonical sent values) — snapping there
        // fights fractal pc-band edges; send the rounded value, the display
        // still shows the firmware-exact real frequency.
        if (freq < 13000) return freq;
        // snap to the nearest canonical attainable entry (two candidate ticks:
        // the packet above x and the one below; settle capped at 2 passes)
        let s = quantizeCore(freq);
        for (let i = 0; i < 2; i++) {
            const t = quantizeCore(s);
            if (t === s) break;
            s = t;
        }
        return s;
    }
    // Jump target to the adjacent attainable entry (period = n timer ticks):
    // filled in when a classic ladder step lands inside the same entry.
    function nextAttainable(f, dir) {
        f = Math.max(1, Math.min(42000000, Math.round(f) || 1));
        const n = Math.max(2, Math.floor(SIG_TIM_CLK / f));
        if (dir > 0) {
            return n <= 2 ? null : Math.floor(SIG_TIM_CLK / (n - 1));   // cap 42 MHz
        }
        const s = Math.floor(SIG_TIM_CLK / (n + 1));
        return s >= 1 ? s : null;
    }

    function handleKnobMove(e) {
        if (!isKnobDragging || !freqKnob) return;
        e.preventDefault();
        
        const rect = freqKnob.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        let clientX = e.clientX;
        let clientY = e.clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        }
        
        const currentAngle = Math.atan2(clientY - centerY, clientX - centerX) * 180 / Math.PI;
        let delta = currentAngle - lastKnobAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        
        lastKnobAngle = currentAngle;
        
        dragTurns = Math.max(0, Math.min(MAX_TURNS, dragTurns + (delta / 360)));
        
        let newFreq = turnsToFreq(dragTurns);
        newFreq = quantizeFreq(newFreq);

        if (cfgSigFreq && parseFloat(cfgSigFreq.value) !== newFreq) {
            cfgSigFreq.value = newFreq;
            cfgSigFreq.dispatchEvent(new Event('input'));
            debouncedSendSigStart();
        }
    }

    if (freqKnob) {
        freqKnob.addEventListener('mousedown', (e) => handleKnobStart(e));
        freqKnob.addEventListener('touchstart', (e) => handleKnobStart(e), {passive: false});
        
        document.addEventListener('mousemove', (e) => handleKnobMove(e));
        document.addEventListener('touchmove', (e) => handleKnobMove(e), {passive: false});
        
        document.addEventListener('mouseup', () => { isKnobDragging = false; });
        document.addEventListener('touchend', () => { isKnobDragging = false; });
        
        freqKnob.addEventListener('wheel', adjustFreqByWheel, { passive: false });
    }

    // --- Duty Cycle Knob Logic (PWM) ---
    const dutyKnobPwm = document.getElementById('dutyKnobPwm');
    const dutyKnobFillPwm = document.getElementById('dutyKnobFillPwm');
    const dutyKnobThumbPwm = document.getElementById('dutyKnobThumbPwm');
    const dutyKnobTextPwm = document.getElementById('dutyKnobTextPwm');

    let isDutyDraggingPwm = false;
    let lastDutyAnglePwm = 0;

    function updateDutyKnobPwmUI(duty, realPct, ticks) {
        if (!dutyKnobFillPwm || !dutyKnobThumbPwm || !dutyKnobTextPwm) return;
        const norm = Math.max(0, Math.min(100, duty)) / 100.0;
        const totalDash = 251.33;
        dutyKnobFillPwm.style.strokeDashoffset = totalDash - (norm * totalDash);

        const angle = -90 + (norm * 360);
        const rad = angle * Math.PI / 180;
        dutyKnobThumbPwm.setAttribute('cx', 50 + 40 * Math.cos(rad));
        dutyKnobThumbPwm.setAttribute('cy', 50 + 40 * Math.sin(rad));

        // Text shows the REAL duty the compare register yields at this
        // frequency (nominal display percent collapses into compare ticks),
        // with enough decimals to distinguish adjacent attainable steps.
        const shown = (realPct === undefined) ? Math.round(duty) : realPct;
        const dec = ticks === undefined ? 0 : (ticks < 100 ? 2 : (ticks < 2000 ? 1 : 0));
        dutyKnobTextPwm.innerHTML = shown.toFixed(dec) + '<br><span style="font-size:12px; color: #94a3b8">%</span>';

        if (dutyKnobPwm) {
            dutyKnobPwm.style.opacity = cfgSigDuty?.disabled ? '0.5' : '1';
            dutyKnobPwm.style.pointerEvents = cfgSigDuty?.disabled ? 'none' : 'auto';
        }
    }

    function handleDutyKnobStartPwm(e) {
        if (!dutyKnobPwm || cfgSigDuty?.disabled) return;
        isDutyDraggingPwm = true;

        const rect = dutyKnobPwm.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let clientX = e.clientX;
        let clientY = e.clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        }

        lastDutyAnglePwm = Math.atan2(clientY - centerY, clientX - centerX) * 180 / Math.PI;
    }

    function handleDutyKnobMovePwm(e) {
        if (!isDutyDraggingPwm || !dutyKnobPwm || cfgSigDuty?.disabled) return;
        e.preventDefault();

        const rect = dutyKnobPwm.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let clientX = e.clientX;
        let clientY = e.clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        }

        const currentAngle = Math.atan2(clientY - centerY, clientX - centerX) * 180 / Math.PI;
        let delta = currentAngle - lastDutyAnglePwm;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;

        lastDutyAnglePwm = currentAngle;

        const currentDuty = Math.max(0, Math.min(100, parseFloat(cfgSigDuty?.value || 50)));
        const newDuty = Math.max(0, Math.min(100, Math.round(currentDuty + delta / 3.6)));

        if (cfgSigDuty && parseFloat(cfgSigDuty.value) !== newDuty) {
            cfgSigDuty.value = newDuty;
            cfgSigDuty.dispatchEvent(new Event('input'));
            debouncedSendSigStart();
        }
    }

    if (dutyKnobPwm) {
        dutyKnobPwm.addEventListener('mousedown', (e) => handleDutyKnobStartPwm(e));
        dutyKnobPwm.addEventListener('touchstart', (e) => handleDutyKnobStartPwm(e), {passive: false});

        document.addEventListener('mousemove', (e) => handleDutyKnobMovePwm(e));
        document.addEventListener('touchmove', (e) => handleDutyKnobMovePwm(e), {passive: false});

        document.addEventListener('mouseup', () => { isDutyDraggingPwm = false; });
        document.addEventListener('touchend', () => { isDutyDraggingPwm = false; });

        dutyKnobPwm.addEventListener('wheel', (e) => {
            if (cfgSigDuty?.disabled) return;
            e.preventDefault();
            const dir = e.deltaY < 0 ? 1 : -1;

            // One wheel tick = one attainable duty step: 100/ticks percent,
            // where ticks follow the current frequency (13% per tick at
            // 10.5 MHz, 2% at 1 MHz, 1% below ~100 kHz). Ctrl/Shift = 5 ticks.
            const freq = Math.max(1, Math.min(42000000, parseInt(cfgSigFreq?.value || '1000')));
            const per = pwmPeriod(freq);
            let step = Math.max(1, Math.ceil(100.0 / per.ticks));
            if (e.shiftKey || e.ctrlKey) step *= 5;

            const currentDuty = Math.max(0, Math.min(100, parseFloat(cfgSigDuty?.value || 50)));
            let newDuty = Math.max(0, Math.min(100, currentDuty + dir * step));

            // Skip percent values that collapse into the same compare register
            // value (no-op ticks at tick boundaries, e.g. 91%->100% at 8 ticks
            // are both 100% real duty) so every wheel tick changes the output.
            let guard = 0;
            while (newDuty !== (dir > 0 ? 100 : 0) &&
                   dutyRealPercent(1, newDuty, per) === dutyRealPercent(1, currentDuty, per) &&
                   guard++ < 5) {
                newDuty = Math.max(0, Math.min(100, newDuty + dir * step));
            }

            if (cfgSigDuty) {
                cfgSigDuty.value = newDuty;
                if (cfgSigDutyRange) cfgSigDutyRange.value = newDuty;
                cfgSigDuty.dispatchEvent(new Event('input'));
            }
        }, { passive: false });
    }

    // Initial render & resize observer for tab switching    // Initialize view
    updateCalculationsAndPreview();
    
    // Remaining code intact

    setTimeout(updateCalculationsAndPreview, 50);
    setTimeout(updateCalculationsAndPreview, 200);

    window.addEventListener('resize', updateCalculationsAndPreview);

    // Watch container size changes (e.g. when switching to Signal Gen tab)
    if (window.ResizeObserver && canvas && canvas.parentElement) {
        const resizeObserver = new ResizeObserver(() => {
            if (canvas.parentElement.clientWidth > 0) {
                updateCalculationsAndPreview();
            }
        });
        resizeObserver.observe(canvas.parentElement);
    }
});
