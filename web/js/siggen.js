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
        const freq = Math.max(1, parseInt(cfgSigFreq?.value || '1000'));
        const duty = (waveform === 0) ? 50 : ((waveform === 2) ? 100 : Math.min(100, Math.max(0, parseInt(cfgSigDuty?.value || '50'))));

        // Disable/enable controls based on waveform type
        const isDc = (waveform === 2);
        if (cfgSigFreq) cfgSigFreq.disabled = isDc;
        if (cfgSigFreqRange) cfgSigFreqRange.disabled = isDc;
        if (cfgSigDuty) cfgSigDuty.disabled = (waveform === 0 || isDc);
        if (cfgSigDutyRange) cfgSigDutyRange.disabled = (waveform === 0 || isDc);

        if (isDc) {
            if (lblSigPeriod) lblSigPeriod.innerText = 'DC';
            if (lblSigTHigh)  lblSigTHigh.innerText  = 'Continuous';
            if (lblSigTLow)   lblSigTLow.innerText   = '0 ms';
        } else {
            const periodSec = 1.0 / freq;
            const tHighSec  = periodSec * (duty / 100.0);
            const tLowSec   = periodSec - tHighSec;

            if (lblSigPeriod) lblSigPeriod.innerText = formatTime(periodSec);
            if (lblSigTHigh)  lblSigTHigh.innerText  = formatTime(tHighSec);
            if (lblSigTLow)   lblSigTLow.innerText   = formatTime(tLowSec);
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
        const freq     = Math.max(1, parseInt(cfgSigFreq?.value || '1000'));
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
            if (cfgSigFreqRange) cfgSigFreqRange.value = Math.log10(Math.max(1, parseFloat(cfgSigFreq.value) || 1));
            updateCalculationsAndPreview();
            if (isRunning) sendSigStart();
        });
        cfgSigFreqRange.addEventListener('input', () => {
            const freqHz = Math.round(Math.pow(10, parseFloat(cfgSigFreqRange.value)));
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

    // Expose update function globally
    window.updateSigPreview = updateCalculationsAndPreview;

    // Initial render & resize observer for tab switching / window resize
    updateCalculationsAndPreview();
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
