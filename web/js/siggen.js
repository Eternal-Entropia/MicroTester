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
    const lblSigStatus = document.getElementById('lblSigStatus');
    const sigGenIndicator = document.getElementById('sigGenIndicator');
    const canvas       = document.getElementById('sigWaveCanvas');

    let isRunning = false;

    // --- Enable/Disable Buttons based on USB Connection ---
    setInterval(() => {
        const connected = !!(microTester && microTester.device);
        if (btnSigStart) btnSigStart.disabled = !connected || isRunning;
        if (btnSigStop)  btnSigStop.disabled  = !connected || !isRunning;
    }, 500);

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

        // Update Knob UI
        updateKnobUI(freq);
        updateDutyKnobPwmUI(duty);

        if (isDc) {
            if (lblSigPeriod) lblSigPeriod.innerText = 'DC';
            if (lblSigTHigh)  lblSigTHigh.innerText  = 'Continuous';
            if (lblSigTLow)   lblSigTLow.innerText   = '0 ms';
            if (lblSigResolution)    lblSigResolution.innerText    = 'N/A (DC)';
            if (lblSigStepPrecision) lblSigStepPrecision.innerText = 'N/A';
        } else {
            const periodSec = 1.0 / freq;
            const tHighSec  = periodSec * (duty / 100.0);
            const tLowSec   = periodSec - tHighSec;

            if (lblSigPeriod) lblSigPeriod.innerText = formatTime(periodSec);
            if (lblSigTHigh)  lblSigTHigh.innerText  = formatTime(tHighSec);
            if (lblSigTLow)   lblSigTLow.innerText   = formatTime(tLowSec);

            // Compute Timer PWM Resolution (STM32 Timer Clock = 84 MHz)
            const resSteps = Math.max(2, Math.floor(84000000 / freq));
            const resBits  = Math.log2(resSteps).toFixed(1);
            const stepPct  = (100.0 / resSteps);
            const fmtPct   = stepPct < 0.01 ? stepPct.toFixed(4) : (stepPct < 1 ? stepPct.toFixed(2) : stepPct.toFixed(1));

            if (lblSigResolution)    lblSigResolution.innerText    = `${resSteps.toLocaleString()} steps (${resBits} bit)`;
            if (lblSigStepPrecision) lblSigStepPrecision.innerText = `±${fmtPct}%`;
        }

        // Draw Canvas Preview
        if (canvas) {
            const ctx = canvas.getContext('2d');
            const w = canvas.width = canvas.parentElement ? canvas.parentElement.clientWidth : 600;
            const h = canvas.height = 160;

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
                ctx.fillText(`3.3V (DC HIGH)`, 25, yHigh - 10);
                ctx.fillText(`Mode: DC (Constant 3.3V)`, w - 240, 24);
            } else {
                // Draw Waveform Line
                const periodPx = 180; // 180px per full period
                const highPx = periodPx * (duty / 100.0);

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
                ctx.fillText(`3.3V (HIGH)`, 25, yHigh - 10);
                ctx.fillText(`0V (LOW)`, 25, yLow + 20);
                ctx.fillText(`Freq: ${formatFreq(freq)}  |  Duty: ${duty}%`, w - 240, 24);
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
        cfgSigFreqRange.addEventListener('input', () => {
            const freqHz = Math.min(42000000, Math.round(Math.pow(10, parseFloat(cfgSigFreqRange.value))));
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

        let step = 1;
        if (dir > 0) {
            if (currentFreq < 100) step = 1;
            else if (currentFreq < 1000) step = 10;
            else if (currentFreq < 10000) step = 100;
            else if (currentFreq < 100000) step = 1000;
            else if (currentFreq < 1000000) step = 10000;
            else if (currentFreq < 10000000) step = 100000;
            else step = 1000000;
        } else {
            if (currentFreq <= 100) step = 1;
            else if (currentFreq <= 1000) step = 10;
            else if (currentFreq <= 10000) step = 100;
            else if (currentFreq <= 100000) step = 1000;
            else if (currentFreq <= 1000000) step = 10000;
            else if (currentFreq <= 10000000) step = 100000;
            else step = 1000000;
        }

        if (isFast) step *= 5;

        const newFreq = Math.min(42000000, Math.max(1, currentFreq + dir * step));
        if (cfgSigFreq) cfgSigFreq.value = newFreq;
        updateCalculationsAndPreview();
        debouncedSendSigStart();
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

    if (canvas) {
        canvas.addEventListener('wheel', (e) => {
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            if (mouseX > rect.width * 0.6 && !cfgSigDuty?.disabled) {
                adjustDutyByWheel(e);
            } else {
                adjustFreqByWheel(e);
            }
        }, { passive: false });
    }

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
                cfgSigFreq.value = val;
                if (cfgSigFreqRange) cfgSigFreqRange.value = Math.log10(val);
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
                cfgSigFreq.value = freqHz;
                if (cfgSigFreqRange) cfgSigFreqRange.value = Math.log10(freqHz);
                updateCalculationsAndPreview();
                if (isRunning) sendSigStart();
            }
        });
    });

    // --- Start / Stop Handlers ---
    if (btnSigStart) {
        btnSigStart.addEventListener('click', () => {
            if (!microTester || !microTester.device) return alert("Connect USB first!");

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
        
        // Update Text
        if (freq >= 1e6) {
            freqKnobText.innerHTML = (freq / 1e6).toFixed(2) + '<br><span style="font-size:12px; color: #94a3b8">MHz</span>';
        } else if (freq >= 1e3) {
            freqKnobText.innerHTML = (freq / 1e3).toFixed(2) + '<br><span style="font-size:12px; color: #94a3b8">kHz</span>';
        } else {
            freqKnobText.innerHTML = freq.toFixed(0) + '<br><span style="font-size:12px; color: #94a3b8">Hz</span>';
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

    function quantizeFreq(freq) {
        freq = Math.max(1, Math.min(42000000, freq));
        let step = 1;
        if (freq < 100)           step = 1;           // 1 - 100 Hz -> 1 Hz
        else if (freq < 1000)     step = 10;          // 100 - 1000 Hz -> 10 Hz
        else if (freq < 10000)    step = 100;         // 1 - 10 kHz -> 100 Hz
        else if (freq < 100000)   step = 1000;        // 10 - 100 kHz -> 1 kHz
        else if (freq < 1000000)  step = 10000;       // 100 - 1000 kHz -> 10 kHz
        else if (freq < 10000000) step = 100000;      // 1 - 10 MHz -> 100 kHz
        else                      step = 1000000;     // 10 - 42 MHz -> 1 MHz

        return Math.min(42000000, Math.max(1, Math.round(freq / step) * step));
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

    function updateDutyKnobPwmUI(duty) {
        if (!dutyKnobFillPwm || !dutyKnobThumbPwm || !dutyKnobTextPwm) return;
        const norm = Math.max(0, Math.min(100, duty)) / 100.0;
        const totalDash = 251.33;
        dutyKnobFillPwm.style.strokeDashoffset = totalDash - (norm * totalDash);

        const angle = -90 + (norm * 360);
        const rad = angle * Math.PI / 180;
        dutyKnobThumbPwm.setAttribute('cx', 50 + 40 * Math.cos(rad));
        dutyKnobThumbPwm.setAttribute('cy', 50 + 40 * Math.sin(rad));

        dutyKnobTextPwm.innerHTML = Math.round(duty) + '<br><span style="font-size:12px; color: #94a3b8">%</span>';

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
            const step = e.shiftKey ? 5 : 1;
            const dir = e.deltaY < 0 ? 1 : -1;
            const currentDuty = Math.max(0, Math.min(100, parseFloat(cfgSigDuty?.value || 50)));
            const newDuty = Math.max(0, Math.min(100, currentDuty + dir * step));
            if (cfgSigDuty) {
                cfgSigDuty.value = newDuty;
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
