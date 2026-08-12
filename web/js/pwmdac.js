// DAC & 2nd-Order Sigma-Delta (Σ-Δ) DAC Controller for MicroTester (42 MHz SPI+DMA)

document.addEventListener('DOMContentLoaded', () => {
    // --- UI Elements ---
    const cfgPwmDacWaveform  = document.getElementById('cfgPwmDacWaveform');
    const cfgPwmDacFreq      = document.getElementById('cfgPwmDacFreq');
    const cfgPwmDacFreqRange = document.getElementById('cfgPwmDacFreqRange');
    const cfgPwmDacDuty      = document.getElementById('cfgPwmDacDuty');
    const cfgPwmDacDutyRange = document.getElementById('cfgPwmDacDutyRange');
    const cfgPwmDacPin       = document.getElementById('cfgPwmDacPin');

    const btnPwmDacStart = document.getElementById('btnPwmDacStart');
    const btnPwmDacStop  = document.getElementById('btnPwmDacStop');

    // Display Elements
    const lblPwmDacPeriod = document.getElementById('lblPwmDacPeriod');
    const lblPwmDacTHigh  = document.getElementById('lblPwmDacTHigh');
    const lblPwmDacTLow   = document.getElementById('lblPwmDacTLow');
    const lblPwmDacResolution    = document.getElementById('lblPwmDacResolution');
    const lblPwmDacStepPrecision = document.getElementById('lblPwmDacStepPrecision');
    const lblPwmDacStatus = document.getElementById('lblPwmDacStatus');
    const pwmDacIndicator = document.getElementById('pwmDacIndicator');
    const canvas       = document.getElementById('pwmDacWaveCanvas');

    let isRunning = false;

    // --- Enable/Disable Buttons based on USB Connection ---
    setInterval(() => {
        const connected = !!(microTester && microTester.device);
        if (btnPwmDacStart) btnPwmDacStart.disabled = !connected || isRunning;
        if (btnPwmDacStop)  btnPwmDacStop.disabled  = !connected || !isRunning;
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

    // --- 2nd-Order Sigma-Delta (Σ-Δ) Modulator Bitstream Generator ---
    function generateSigmaDeltaBitstream(mode, freqHz, dutyPct = 50) {
        const SPI_FREQ = 42000000; // 42 MHz SPI Bit Rate
        const MAX_BYTES = 16000;   // 16 KB buffer = 128,000 bits
        const MAX_BITS = MAX_BYTES * 8;

        let idealPeriodBits = SPI_FREQ / Math.max(1, freqHz);
        let numBytes = MAX_BYTES;
        let numCycles = 1;

        if (idealPeriodBits >= MAX_BITS) {
            // BUG FIX 1: Fractional Phase Discontinuity.
            // If the requested frequency is too low to fit 1 full cycle in 4KB (< 1281 Hz),
            // we MUST force exactly 1 full cycle to fit in the maximum buffer to prevent phase jumps.
            numBytes = MAX_BYTES;
            numCycles = 1; 
        } else {
            // Medium/High frequency: find optimal integer number of full cycles that fit into MAX_BYTES
            let maxK = Math.floor(MAX_BITS / idealPeriodBits);
            if (maxK < 1) maxK = 1;

            let bestBytes = MAX_BYTES;
            let bestK = 1;
            let minErr = Infinity;

            for (let k = maxK; k >= 1; k--) {
                let targetBits = k * idealPeriodBits;
                let bytes = Math.round(targetBits / 8);
                if (bytes > MAX_BYTES) continue;
                if (bytes < 1) bytes = 1;
                let actualBits = bytes * 8;
                let err = Math.abs(actualBits - targetBits);
                if (err < minErr) {
                    minErr = err;
                    bestBytes = bytes;
                    bestK = k;
                    if (err < 0.1) break;
                }
            }
            numBytes = bestBytes;
            numCycles = bestK;
        }

        let totalBits = numBytes * 8;
        const buffer = new Uint8Array(numBytes);
        
        let integ1 = 0.0;
        let integ2 = 0.0;
        let y_prev = 0.0;

        // BUG FIX 2: State Warm-up (Pre-roll).
        // Run the modulator for one full buffer length WITHOUT saving bits to let the 
        // 2nd-order chaotic state variables reach a steady-state limit cycle.
        // This eliminates the audible click/glitch at the DMA wrap-around point!
        for (let i = 0; i < totalBits; i++) {
            const phase = (i / totalBits) * numCycles;
            const normPhase = phase % 1.0;
            let normVal = 0.0;
            switch (mode) {
                case 'sd_sine': normVal = Math.sin(2 * Math.PI * normPhase); break;
                case 'sd_saw': normVal = 2.0 * normPhase - 1.0; break;
                case 'sd_tri': normVal = (normPhase < 0.5) ? (4.0 * normPhase - 1.0) : (3.0 - 4.0 * normPhase); break;
                case 'sd_square': normVal = (normPhase < (dutyPct / 100.0)) ? 1.0 : -1.0; break; // BUG FIX 3: 1.0 amplitude
                case 'sd_dc': normVal = (dutyPct / 100.0) * 2.0 - 1.0; break; // BUG FIX 3: 2.0 multiplier
                default: normVal = Math.sin(2 * Math.PI * normPhase); break;
            }
            const x = normVal * 0.88;
            integ1 += x - y_prev;
            integ2 += integ1 - y_prev;
            y_prev = (integ2 >= 0) ? 1.0 : -1.0;
        }

        // Main generation loop
        for (let i = 0; i < totalBits; i++) {
            const phase = (i / totalBits) * numCycles;
            const normPhase = phase % 1.0;
            let normVal = 0.0;

            switch (mode) {
                case 'sd_sine': normVal = Math.sin(2 * Math.PI * normPhase); break;
                case 'sd_saw': normVal = 2.0 * normPhase - 1.0; break;
                case 'sd_tri': normVal = (normPhase < 0.5) ? (4.0 * normPhase - 1.0) : (3.0 - 4.0 * normPhase); break;
                case 'sd_square': normVal = (normPhase < (dutyPct / 100.0)) ? 1.0 : -1.0; break;
                case 'sd_dc': normVal = (dutyPct / 100.0) * 2.0 - 1.0; break;
                default: normVal = Math.sin(2 * Math.PI * normPhase); break;
            }

            // Scale to prevent second-order modulator overflow saturation
            // Max stable amplitude for 2nd order BW modulator is ~0.75
            const x = normVal * 0.75;

            // 2nd-Order Error Diffusion / Sigma-Delta Equations
            const diff1 = x - y_prev;
            integ1 += diff1;
            const diff2 = integ1 - y_prev;
            integ2 += diff2;

            const bit = (integ2 >= 0) ? 1 : 0;
            y_prev = (bit === 1) ? 1.0 : -1.0;

            const byteIdx = Math.floor(i / 8);
            const bitIdx = 7 - (i % 8); // MSB First
            if (bit) {
                buffer[byteIdx] |= (1 << bitIdx);
            }
        }

        const actualFreq = (SPI_FREQ * numCycles) / totalBits;
        return { buffer, totalBits, numBytes, actualFreq };
    }

    // --- Update Parameters & Waveform Canvas Preview ---
    function updateCalculationsAndPreview() {
        const mode = cfgPwmDacWaveform?.value || 'sd_sine';
        const isSigmaDelta = mode.startsWith('sd_');
        const freq = Math.max(1, Math.min(1000000, parseInt(cfgPwmDacFreq?.value || '1000')));
        const duty = (mode === '0') ? 50 : ((mode === '2' || mode === 'sd_dc') ? 100 : Math.min(100, Math.max(0, parseInt(cfgPwmDacDuty?.value || '50'))));

        const isDc = (mode === '2' || mode === 'sd_dc');
        if (cfgPwmDacFreq) cfgPwmDacFreq.disabled = isDc;
        if (cfgPwmDacFreqRange) cfgPwmDacFreqRange.disabled = isDc;
        const freqKnob = document.getElementById('freqKnobDac');
        if (freqKnob) freqKnob.style.opacity = isDc ? '0.5' : '1';
        if (freqKnob) freqKnob.style.pointerEvents = isDc ? 'none' : 'auto';
        const isDutyDisabled = (mode === '0' || mode === 'sd_sine' || mode === 'sd_saw' || mode === 'sd_tri');
        if (cfgPwmDacDuty) cfgPwmDacDuty.disabled = isDutyDisabled;
        if (cfgPwmDacDutyRange) cfgPwmDacDutyRange.disabled = isDutyDisabled;
        const dutyKnob = document.getElementById('dutyKnobDac');
        if (dutyKnob) dutyKnob.style.opacity = isDutyDisabled ? '0.5' : '1';
        if (dutyKnob) dutyKnob.style.pointerEvents = isDutyDisabled ? 'none' : 'auto';

        updateKnobUI(freq);
        updateDutyKnobUI(duty);

        if (isDc) {
            if (lblPwmDacPeriod) lblPwmDacPeriod.innerText = 'DC';
            if (lblPwmDacTHigh)  lblPwmDacTHigh.innerText  = 'Continuous';
            if (lblPwmDacTLow)   lblPwmDacTLow.innerText   = '0 ms';
            if (lblPwmDacResolution)    lblPwmDacResolution.innerText    = '42 MHz Σ-Δ PDM';
            if (lblPwmDacStepPrecision) lblPwmDacStepPrecision.innerText = '16-bit ENOB';
        } else {
            const periodSec = 1.0 / freq;
            const tHighSec  = periodSec * (duty / 100.0);
            const tLowSec   = periodSec - tHighSec;

            if (lblPwmDacPeriod) lblPwmDacPeriod.innerText = formatTime(periodSec);
            if (lblPwmDacTHigh)  lblPwmDacTHigh.innerText  = formatTime(tHighSec);
            if (lblPwmDacTLow)   lblPwmDacTLow.innerText   = formatTime(tLowSec);

            // Dynamic ENOB & OverSampling Ratio (OSR) Calculation
            const osr = Math.max(1, Math.round(42000000 / freq));
            let enob = Math.min(16, Math.max(1, Math.round(2.5 * Math.log2(osr) - 1.5)));
            const levels = Math.pow(2, enob);
            const stepPct = (100.0 / levels).toFixed(enob >= 10 ? 3 : 1);

            if (lblPwmDacResolution)    lblPwmDacResolution.innerText    = `${enob}-bit ENOB (${levels.toLocaleString()} levels @ OSR=${osr.toLocaleString()})`;
            if (lblPwmDacStepPrecision) lblPwmDacStepPrecision.innerText = `±${stepPct}%`;
        }

        // Canvas Rendering
        if (canvas) {
            const ctx = canvas.getContext('2d');
            const w = canvas.width = canvas.parentElement ? canvas.parentElement.clientWidth : 600;
            const h = canvas.height = 160;

            ctx.clearRect(0, 0, w, h);

            // Grid
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            for (let x = 0; x < w; x += 40) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            }
            for (let y = 0; y < h; y += 32) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
            }

            const yMid  = h / 2;
            const yAmp  = (h / 2) - 25;

            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 3;
            ctx.shadowColor = 'rgba(56, 189, 248, 0.5)';
            ctx.shadowBlur = 10;

            let waveformName = 'SINE WAVE';
            if (mode === 'sd_saw') waveformName = 'SAWTOOTH';
            else if (mode === 'sd_tri') waveformName = 'TRIANGLE';
            else if (mode === 'sd_square') waveformName = 'SQUARE WAVE';
            else if (mode === 'sd_dc') waveformName = `DC VOLTAGE (${(3.3 * duty / 100).toFixed(2)}V)`;

            const points = 300;
            ctx.beginPath();
            for (let i = 0; i <= points; i++) {
                const px = (i / points) * w;
                const phase = (i / points) * 3.0; // 3 periods
                const normPhase = phase % 1.0;
                let val = 0;

                if (mode === 'sd_sine') val = Math.sin(2 * Math.PI * phase);
                else if (mode === 'sd_saw') val = 2.0 * normPhase - 1.0;
                else if (mode === 'sd_tri') val = (normPhase < 0.5) ? (4.0 * normPhase - 1.0) : (3.0 - 4.0 * normPhase);
                else if (mode === 'sd_square' || mode === '0') val = (normPhase < (duty / 100.0)) ? 1.0 : -1.0;
                else if (mode === 'sd_dc' || mode === '2') val = (duty / 100.0) * 2.0 - 1.0;
                else val = (normPhase < (duty / 100.0)) ? 1.0 : -1.0;

                const py = yMid - val * yAmp;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.stroke();
            ctx.shadowBlur = 0;

            const osr = Math.max(1, Math.round(42000000 / freq));
            let enob = Math.min(16, Math.max(1, Math.round(2.5 * Math.log2(osr) - 1.5)));

            // Text Labels & Info Overlay
            ctx.fillStyle = '#38bdf8';
            ctx.font = 'bold 13px JetBrains Mono, Consolas, monospace';
            ctx.fillText(`▶ ${waveformName}`, 16, 25);

            ctx.fillStyle = '#94a3b8';
            ctx.font = '11px JetBrains Mono, Consolas, monospace';
            ctx.fillText(`3.3V`, 16, 45);
            ctx.fillText(`0.0V`, 16, h - 12);

            const infoStr = isDc ? `DC Level: ${(3.3 * duty / 100).toFixed(2)}V  |  Pin: PB5 (42MHz SPI DMA)` : `Freq: ${formatFreq(freq)}  |  ENOB: ${enob}-bit  |  Pin: PB5 (42MHz SPI DMA)`;
            ctx.fillStyle = '#cbd5e1';
            ctx.fillText(infoStr, w - ctx.measureText(infoStr).width - 16, 25);
        }
    }

    // --- Send Command Helper ---
    async function sendPwmDacStart() {
        if (!microTester || !microTester.device) return;

        const mode = cfgPwmDacWaveform?.value || 'sd_sine';
        const isSigmaDelta = mode.startsWith('sd_');

        if (isSigmaDelta) {
            const freq = Math.max(1, Math.min(42000000, parseInt(cfgPwmDacFreq?.value || '1000')));
            const duty = parseInt(cfgPwmDacDuty?.value || '50');
            const { buffer, numBytes } = generateSigmaDeltaBitstream(mode, freq, duty);

            // Chunk transfer over WebUSB
            const pinSelect = document.getElementById('cfgPwmDacPin');
            const pinVal = pinSelect ? parseInt(pinSelect.value) : 0; // 0=PB5, 1=PA7
            const CHUNK_SIZE = 32;
            let offset = 0;

            // Header Packet: CMD_SIGMA_DELTA_START [pin, bufSize_lo, bufSize_hi, data...]
            const firstChunkLen = Math.min(numBytes, CHUNK_SIZE);
            const startPayload = new Uint8Array(3 + firstChunkLen);
            startPayload[0] = pinVal;
            startPayload[1] = numBytes & 0xFF;
            startPayload[2] = (numBytes >> 8) & 0xFF;
            startPayload.set(buffer.subarray(0, firstChunkLen), 3);

            await microTester.sendCommand(CMD_SIGMA_DELTA_START, startPayload);
            offset += firstChunkLen;

            // Remaining data chunks
            while (offset < numBytes) {
                const len = Math.min(numBytes - offset, CHUNK_SIZE);
                const chunkPayload = new Uint8Array(2 + len);
                chunkPayload[0] = offset & 0xFF;
                chunkPayload[1] = (offset >> 8) & 0xFF;
                chunkPayload.set(buffer.subarray(offset, offset + len), 2);

                await microTester.sendCommand(CMD_SIGMA_DELTA_DATA, chunkPayload);
                offset += len;
            }
        } else {
            const pin      = parseInt(cfgPwmDacPin?.value || '0');
            const waveform = parseInt(mode);
            const freq     = Math.max(1, Math.min(42000000, parseInt(cfgPwmDacFreq?.value || '1000')));
            const duty     = Math.min(100, Math.max(0, parseInt(cfgPwmDacDuty?.value || '50')));

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
    }

    function sendPwmDacStop() {
        if (!microTester || !microTester.device) return;
        microTester.sendCommand(CMD_SIGMA_DELTA_STOP);
        microTester.sendCommand(CMD_SIG_STOP);
    }


    let dacStartTimeout = null;
    function debouncedPwmDacStart() {
        if (!isRunning) return;
        if (dacStartTimeout) clearTimeout(dacStartTimeout);
        dacStartTimeout = setTimeout(() => {
            sendPwmDacStart();
        }, 500);
    }

    // --- Event Listeners for Live Inputs ---
    if (cfgPwmDacFreq && cfgPwmDacFreqRange) {
        cfgPwmDacFreq.addEventListener('input', () => {
            const freqVal = Math.max(1, Math.min(42000000, parseFloat(cfgPwmDacFreq.value) || 1));
            if (cfgPwmDacFreqRange) cfgPwmDacFreqRange.value = Math.log10(freqVal);
            updateCalculationsAndPreview();
            debouncedPwmDacStart();
        });
        cfgPwmDacFreqRange.addEventListener('input', () => {
            const freqHz = Math.min(42000000, Math.round(Math.pow(10, parseFloat(cfgPwmDacFreqRange.value))));
            cfgPwmDacFreq.value = freqHz;
            updateCalculationsAndPreview();
            debouncedPwmDacStart();
        });
    }

    if (cfgPwmDacDuty && cfgPwmDacDutyRange) {
        cfgPwmDacDuty.addEventListener('input', () => {
            cfgPwmDacDutyRange.value = cfgPwmDacDuty.value;
            updateCalculationsAndPreview();
            debouncedPwmDacStart();
        });
        cfgPwmDacDutyRange.addEventListener('input', () => {
            cfgPwmDacDuty.value = cfgPwmDacDutyRange.value;
            updateCalculationsAndPreview();
            debouncedPwmDacStart();
        });
    }

    // --- Mouse Wheel Adjustment Handlers ---
    function adjustFreqByWheel(e) {
        if (cfgPwmDacFreq?.disabled) return;
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const isFast = e.shiftKey || e.ctrlKey;
        const currentFreq = Math.max(1, Math.min(42000000, parseFloat(cfgPwmDacFreq?.value || 1000)));

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
        if (cfgPwmDacFreq) cfgPwmDacFreq.value = newFreq;
        updateCalculationsAndPreview();
        debouncedPwmDacStart();
    }

    if (cfgPwmDacFreq) cfgPwmDacFreq.addEventListener('wheel', adjustFreqByWheel, { passive: false });
    if (cfgPwmDacFreqRange) cfgPwmDacFreqRange.addEventListener('wheel', adjustFreqByWheel, { passive: false });

    if (cfgPwmDacWaveform) {
        cfgPwmDacWaveform.addEventListener('change', () => {
            updateCalculationsAndPreview();
            debouncedPwmDacStart();
        });
    }

    if (cfgPwmDacPin) {
        cfgPwmDacPin.addEventListener('change', () => {
            debouncedPwmDacStart();
        });
    }

    // Preset Frequency Buttons
    document.querySelectorAll('.pwm-dac-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = parseInt(btn.getAttribute('data-freq'));
            if (val && cfgPwmDacFreq) {
                cfgPwmDacFreq.value = val;
                if (cfgPwmDacFreqRange) cfgPwmDacFreqRange.value = Math.log10(val);
                updateCalculationsAndPreview();
                debouncedPwmDacStart();
            }
        });
    });

    // Preset Resolution Buttons
    document.querySelectorAll('.pwm-dac-res-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const bits = parseInt(btn.getAttribute('data-res'));
            if (bits && cfgPwmDacFreq) {
                const targetSteps = Math.pow(2, bits);
                const freqHz = Math.round(84000000 / targetSteps);
                cfgPwmDacFreq.value = freqHz;
                if (cfgPwmDacFreqRange) cfgPwmDacFreqRange.value = Math.log10(freqHz);
                updateCalculationsAndPreview();
                debouncedPwmDacStart();
            }
        });
    });

    // --- Start / Stop Handlers ---
    if (btnPwmDacStart) {
        btnPwmDacStart.addEventListener('click', () => {
            if (!microTester || !microTester.device) return alert("Connect USB first!");

            sendPwmDacStart();
            isRunning = true;

            if (lblPwmDacStatus) {
                lblPwmDacStatus.innerText = 'GENERATING';
                lblPwmDacStatus.className = 'status-badge active';
            }
            if (pwmDacIndicator) pwmDacIndicator.classList.add('active');

            if (btnPwmDacStart) btnPwmDacStart.disabled = true;
            if (btnPwmDacStop) btnPwmDacStop.disabled = false;
        });
    }

    if (btnPwmDacStop) {
        btnPwmDacStop.addEventListener('click', () => {
            sendPwmDacStop();
            isRunning = false;

            if (lblPwmDacStatus) {
                lblPwmDacStatus.innerText = 'STOPPED';
                lblPwmDacStatus.className = 'status-badge stopped';
            }
            if (pwmDacIndicator) pwmDacIndicator.classList.remove('active');

            if (btnPwmDacStart) btnPwmDacStart.disabled = false;
            if (btnPwmDacStop) btnPwmDacStop.disabled = true;
        });
    }

    if (typeof microTester !== 'undefined') {
        const origDis = microTester.onDisconnect;
        microTester.onDisconnect = function() {
            if (origDis) origDis.apply(this, arguments);
            isRunning = false;
            if (lblPwmDacStatus) {
                lblPwmDacStatus.innerText = 'STOPPED';
                lblPwmDacStatus.className = 'status-badge stopped';
            }
            if (pwmDacIndicator) pwmDacIndicator.classList.remove('active');
            if (btnPwmDacStart) btnPwmDacStart.disabled = false;
            if (btnPwmDacStop) btnPwmDacStop.disabled = true;
        };
    }

    // Expose update function globally
    window.updatePwmDacPreview = updateCalculationsAndPreview;

    // Multi-Turn Knob Slider Logic
    const freqKnob = document.getElementById('freqKnobDac');
    const freqKnobFill = document.getElementById('freqKnobFillDac');
    const freqKnobThumb = document.getElementById('freqKnobThumbDac');
    const freqKnobText = document.getElementById('freqKnobTextDac');
    
    let isKnobDragging = false;
    let lastKnobAngle = 0;
    const MAX_TURNS = 5.0;

    function freqToTurns(freq) {
        freq = Math.max(1, Math.min(1000000, freq));
        if (freq <= 100)        return 0.0 + (freq - 1) / 99;
        if (freq <= 1000)       return 1.0 + (freq - 100) / 900;
        if (freq <= 10000)      return 2.0 + (freq - 1000) / 9000;
        if (freq <= 100000)     return 3.0 + (freq - 10000) / 90000;
        return 4.0 + (freq - 100000) / 900000;
    }

    function turnsToFreq(turns) {
        turns = Math.max(0, Math.min(MAX_TURNS, turns));
        let f;
        if (turns <= 1.0)      f = 1 + turns * 99;
        else if (turns <= 2.0) f = 100 + (turns - 1.0) * 900;
        else if (turns <= 3.0) f = 1000 + (turns - 2.0) * 9000;
        else if (turns <= 4.0) f = 10000 + (turns - 3.0) * 90000;
        else                   f = 100000 + (turns - 4.0) * 900000;
        return Math.round(f);
    }

    function updateKnobUI(freq) {
        if (!freqKnobFill || !freqKnobThumb || !freqKnobText) return;
        const turns = freqToTurns(freq);
        let turnFraction = turns % 1.0;
        if (turns >= MAX_TURNS) turnFraction = turns - Math.floor(turns);
        
        const totalDash = 251.33;
        freqKnobFill.style.strokeDashoffset = totalDash - (turnFraction * totalDash);
        
        const angle = -90 + (turnFraction * 360);
        const rad = angle * Math.PI / 180;
        freqKnobThumb.setAttribute('cx', 50 + 40 * Math.cos(rad));
        freqKnobThumb.setAttribute('cy', 50 + 40 * Math.sin(rad));
        
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
        
        const currentFreq = Math.max(1, Math.min(1000000, parseFloat(cfgPwmDacFreq?.value || 1000)));
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
        freq = Math.max(1, Math.min(1000000, freq));
        let step = 1;
        if (freq < 100)          step = 1;         // 1 - 100 Hz -> 1 Hz
        else if (freq < 1000)    step = 10;        // 100 - 1000 Hz -> 10 Hz
        else if (freq < 10000)   step = 100;       // 1 - 10 kHz -> 100 Hz (1.1, 1.2 kHz)
        else if (freq < 100000)  step = 1000;      // 10 - 100 kHz -> 1 kHz (10, 11, 12... 100 kHz)
        else                     step = 10000;     // 100 - 1000 kHz -> 10 kHz (100, 110, 120... 1000 kHz)

        return Math.min(1000000, Math.max(1, Math.round(freq / step) * step));
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

        if (cfgPwmDacFreq && parseFloat(cfgPwmDacFreq.value) !== newFreq) {
            cfgPwmDacFreq.value = newFreq;
            cfgPwmDacFreq.dispatchEvent(new Event('input'));
        }
    }

    // --- Duty Cycle Knob Logic ---
    const dutyKnob = document.getElementById('dutyKnobDac');
    const dutyKnobFill = document.getElementById('dutyKnobFillDac');
    const dutyKnobThumb = document.getElementById('dutyKnobThumbDac');
    const dutyKnobText = document.getElementById('dutyKnobTextDac');

    let isDutyKnobDragging = false;
    let lastDutyKnobAngle = 0;

    function updateDutyKnobUI(duty) {
        if (!dutyKnobFill || !dutyKnobThumb || !dutyKnobText) return;
        const clampedDuty = Math.max(0, Math.min(100, duty));
        const turnFraction = clampedDuty / 100.0;
        
        const totalDash = 251.33;
        dutyKnobFill.style.strokeDashoffset = totalDash - (turnFraction * totalDash);
        
        const angle = -90 + (turnFraction * 360);
        const rad = angle * Math.PI / 180;
        dutyKnobThumb.setAttribute('cx', 50 + 40 * Math.cos(rad));
        dutyKnobThumb.setAttribute('cy', 50 + 40 * Math.sin(rad));
        
        dutyKnobText.innerHTML = clampedDuty.toFixed(0) + '<br><span style="font-size:11px; color: #94a3b8">%</span>';
    }

    function handleDutyKnobStart(e) {
        if (!dutyKnob) return;
        isDutyKnobDragging = true;
        
        const rect = dutyKnob.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        let clientX = e.clientX;
        let clientY = e.clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        }
        
        lastDutyKnobAngle = Math.atan2(clientY - centerY, clientX - centerX) * 180 / Math.PI;
    }

    function handleDutyKnobMove(e) {
        if (!isDutyKnobDragging || !dutyKnob) return;
        e.preventDefault();
        
        const rect = dutyKnob.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        let clientX = e.clientX;
        let clientY = e.clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        }
        
        const currentAngle = Math.atan2(clientY - centerY, clientX - centerX) * 180 / Math.PI;
        let delta = currentAngle - lastDutyKnobAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        
        lastDutyKnobAngle = currentAngle;
        
        const currentDuty = Math.max(0, Math.min(100, parseFloat(cfgPwmDacDuty?.value || 50)));
        let newDuty = Math.max(0, Math.min(100, Math.round(currentDuty + (delta / 3.6))));
        
        if (cfgPwmDacDuty) {
            cfgPwmDacDuty.value = newDuty;
            cfgPwmDacDuty.dispatchEvent(new Event('input'));
        }
    }

    if (freqKnob) {
        freqKnob.addEventListener('mousedown', (e) => handleKnobStart(e));
        freqKnob.addEventListener('touchstart', (e) => handleKnobStart(e), {passive: false});
        
        freqKnob.addEventListener('wheel', adjustFreqByWheel, { passive: false });
    }

    if (dutyKnob) {
        dutyKnob.addEventListener('mousedown', (e) => handleDutyKnobStart(e));
        dutyKnob.addEventListener('touchstart', (e) => handleDutyKnobStart(e), {passive: false});
        
        dutyKnob.addEventListener('wheel', (e) => {
            if (cfgPwmDacDuty?.disabled) return;
            e.preventDefault();
            const dir = e.deltaY < 0 ? 1 : -1;
            const currentDuty = parseFloat(cfgPwmDacDuty?.value || 50);
            const step = e.shiftKey ? 5 : 1;
            const newDuty = Math.min(100, Math.max(0, currentDuty + dir * step));
            if (cfgPwmDacDuty) {
                cfgPwmDacDuty.value = newDuty;
                cfgPwmDacDuty.dispatchEvent(new Event('input'));
            }
        }, { passive: false });
    }

    document.addEventListener('mousemove', (e) => { handleKnobMove(e); handleDutyKnobMove(e); });
    document.addEventListener('touchmove', (e) => { handleKnobMove(e); handleDutyKnobMove(e); }, {passive: false});
    
    document.addEventListener('mouseup', () => { isKnobDragging = false; isDutyKnobDragging = false; });
    document.addEventListener('touchend', () => { isKnobDragging = false; isDutyKnobDragging = false; });

    // Initial render
    updateCalculationsAndPreview();
    setTimeout(updateCalculationsAndPreview, 50);
    setTimeout(updateCalculationsAndPreview, 200);

    window.addEventListener('resize', updateCalculationsAndPreview);

    if (window.ResizeObserver && canvas && canvas.parentElement) {
        const resizeObserver = new ResizeObserver(() => {
            if (canvas.parentElement.clientWidth > 0) {
                updateCalculationsAndPreview();
            }
        });
        resizeObserver.observe(canvas.parentElement);
    }
});
