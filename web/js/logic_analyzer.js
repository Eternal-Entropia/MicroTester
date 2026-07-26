// 8-Channel Logic Analyzer Controller for MicroTester

document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    // --- DOM Elements ---
    const canvas = document.getElementById('logicCanvas');
    const btnLogicStart = document.getElementById('btnLogicStart');
    const btnLogicStop  = document.getElementById('btnLogicStop');

    const cfgLogicSampleRate = document.getElementById('cfgLogicSampleRate');
    const cfgLogicTrigChannel = document.getElementById('cfgLogicTrigChannel');
    const cfgLogicTrigEdge    = document.getElementById('cfgLogicTrigEdge');
    const cfgLogicDecoder     = document.getElementById('cfgLogicDecoder');

    const lblLogicStatus  = document.getElementById('lblLogicStatus');
    const lblLogicDeltaT  = document.getElementById('lblLogicDeltaT');
    const lblLogicFreq    = document.getElementById('lblLogicFreq');
    const lblLogicCursor1 = document.getElementById('lblLogicCursor1');
    const lblLogicCursor2 = document.getElementById('lblLogicCursor2');
    const lblLogicDecode  = document.getElementById('lblLogicDecodeData');

    const btnZoomIn  = document.getElementById('btnLogicZoomIn');
    const btnZoomOut = document.getElementById('btnLogicZoomOut');
    const btnZoomFit = document.getElementById('btnLogicZoomFit');

    // --- State ---
    let isRunning = false;
    const MAX_SAMPLES = 2048;
    const sampleBuffer = new Uint8Array(MAX_SAMPLES);
    let sampleCount = 0;
    let sampleRateHz = 100000; // 100 kHz

    // Channel Config
    const CHANNEL_COLORS = [
        '#38bdf8', // D0: Sky Blue
        '#facc15', // D1: Yellow
        '#4ade80', // D2: Green
        '#f472b6', // D3: Pink
        '#fb923c', // D4: Orange
        '#818cf8', // D5: Indigo
        '#c084fc', // D6: Purple
        '#f87171'  // D7: Red
    ];
    const channelEnabled = [true, true, true, true, true, true, true, true];

    // View & Zoom State
    let zoomLevel = 1.0; // 1.0 = fit buffer width
    let panOffsetPx = 0;
    let isDragging = false;
    let dragStartX = 0;

    // Measurement Cursors (in sample indices)
    let cursor1Index = -1;
    let cursor2Index = -1;

    // --- Enable/Disable Buttons based on USB Connection ---
    setInterval(() => {
        const connected = !!(microTester && microTester.device);
        if (btnLogicStart) btnLogicStart.disabled = !connected || isRunning;
        if (btnLogicStop)  btnLogicStop.disabled  = !connected || !isRunning;
    }, 500);

    // --- Format Helper ---
    function formatTime(seconds) {
        if (isNaN(seconds) || !isFinite(seconds)) return '--';
        if (Math.abs(seconds) < 1e-6) return (seconds * 1e9).toFixed(1) + ' ns';
        if (Math.abs(seconds) < 1e-3) return (seconds * 1e6).toFixed(2) + ' µs';
        if (Math.abs(seconds) < 1)    return (seconds * 1e3).toFixed(2) + ' ms';
        return seconds.toFixed(3) + ' s';
    }

    function formatFreq(hz) {
        if (isNaN(hz) || !isFinite(hz) || hz <= 0) return '--';
        if (hz >= 1e6) return (hz / 1e6).toFixed(3) + ' MHz';
        if (hz >= 1e3) return (hz / 1e3).toFixed(2) + ' kHz';
        return hz.toFixed(1) + ' Hz';
    }

    // --- Logic Packet Receiver ---
    if (window.microTester) {
        microTester.addDataListener((data) => {
            if (!isRunning) return;

            // Packet format: [PKT_LOGIC_DATA(0x40)] [Len_Lo] [Len_Hi] [Payload...]
            if (data.length >= 4 && data[0] === PKT_LOGIC_DATA) {
                const len = data[1] | (data[2] << 8);
                const payload = data.subarray(3, 3 + len);
                
                // Copy into ring/sample buffer
                const copyLen = Math.min(payload.length, MAX_SAMPLES);
                sampleBuffer.set(payload.subarray(0, copyLen), 0);
                sampleCount = copyLen;

                renderCanvas();
                runProtocolDecoder();
            }
        });
    }

    // --- Rendering Main Logic Waveforms ---
    function renderCanvas() {
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const w = canvas.width = canvas.parentElement ? canvas.parentElement.clientWidth : 800;
        const h = canvas.height = 360;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, w, h);

        const activeChannels = channelEnabled.filter(Boolean).length;
        if (activeChannels === 0 || sampleCount === 0) {
            ctx.fillStyle = '#64748b';
            ctx.font = '14px JetBrains Mono, monospace';
            ctx.textAlign = 'center';
            ctx.fillText(isRunning ? 'Waiting for logic samples...' : 'Click ▶ Start Capture to record digital signals', w / 2, h / 2);
            return;
        }

        const channelHeight = (h - 30) / 8; // 8 channels
        const sampleStepPx = ((w - 60) / sampleCount) * zoomLevel;

        // Draw Background Grid & Timeline
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;

        for (let ch = 0; ch < 8; ch++) {
            const yTop = 25 + ch * channelHeight;
            ctx.beginPath();
            ctx.moveTo(50, yTop + channelHeight);
            ctx.lineTo(w, yTop + channelHeight);
            ctx.stroke();

            // Channel Label
            ctx.fillStyle = channelEnabled[ch] ? CHANNEL_COLORS[ch] : '#475569';
            ctx.font = '12px JetBrains Mono, monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`D${ch}`, 40, yTop + channelHeight / 2 + 4);
        }

        // Draw Digital Waveforms for 8 Channels
        const xOffset = 50 + panOffsetPx;

        for (let ch = 0; ch < 8; ch++) {
            if (!channelEnabled[ch]) continue;

            const yHigh = 25 + ch * channelHeight + 6;
            const yLow  = 25 + ch * channelHeight + channelHeight - 8;

            ctx.strokeStyle = CHANNEL_COLORS[ch];
            ctx.lineWidth = 2;
            ctx.shadowColor = CHANNEL_COLORS[ch];
            ctx.shadowBlur = 4;

            ctx.beginPath();

            let lastState = (sampleBuffer[0] >> ch) & 1;
            let currentX = xOffset;
            ctx.moveTo(currentX, lastState ? yHigh : yLow);

            for (let i = 1; i < sampleCount; i++) {
                const nextState = (sampleBuffer[i] >> ch) & 1;
                const nextX = xOffset + i * sampleStepPx;

                if (nextX < 45) {
                    lastState = nextState;
                    ctx.moveTo(nextX, nextState ? yHigh : yLow);
                    continue;
                }
                if (currentX > w) break;

                // Horizontal line
                ctx.lineTo(nextX, lastState ? yHigh : yLow);

                // Vertical edge transition if state changed
                if (nextState !== lastState) {
                    ctx.lineTo(nextX, nextState ? yHigh : yLow);
                    lastState = nextState;
                }
                currentX = nextX;
            }
            ctx.stroke();
            ctx.shadowBlur = 0; // reset shadow
        }

        // Draw Cursors
        drawCursor(ctx, cursor1Index, '#eab308', 'C1', xOffset, sampleStepPx, h);
        drawCursor(ctx, cursor2Index, '#ec4899', 'C2', xOffset, sampleStepPx, h);

        // Update Cursor Measurement Stats
        updateCursorStats();
    }

    function drawCursor(ctx, sampleIdx, color, label, xOffset, sampleStepPx, h) {
        if (sampleIdx < 0 || sampleIdx >= sampleCount) return;

        const x = xOffset + sampleIdx * sampleStepPx;
        if (x < 50 || x > ctx.canvas.width) return;

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);

        ctx.beginPath();
        ctx.moveTo(x, 20);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label flag
        ctx.fillStyle = color;
        ctx.fillRect(x - 12, 4, 24, 16);
        ctx.fillStyle = '#000000';
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, x, 16);
    }

    function updateCursorStats() {
        if (cursor1Index >= 0 && sampleRateHz > 0) {
            const t1 = cursor1Index / sampleRateHz;
            if (lblLogicCursor1) lblLogicCursor1.innerText = formatTime(t1);
        } else if (lblLogicCursor1) {
            lblLogicCursor1.innerText = '--';
        }

        if (cursor2Index >= 0 && sampleRateHz > 0) {
            const t2 = cursor2Index / sampleRateHz;
            if (lblLogicCursor2) lblLogicCursor2.innerText = formatTime(t2);
        } else if (lblLogicCursor2) {
            lblLogicCursor2.innerText = '--';
        }

        if (cursor1Index >= 0 && cursor2Index >= 0 && sampleRateHz > 0) {
            const deltaSamples = Math.abs(cursor2Index - cursor1Index);
            const deltaT = deltaSamples / sampleRateHz;
            const freq = deltaT > 0 ? (1.0 / deltaT) : 0;

            if (lblLogicDeltaT) lblLogicDeltaT.innerText = formatTime(deltaT);
            if (lblLogicFreq)   lblLogicFreq.innerText   = formatFreq(freq);
        } else {
            if (lblLogicDeltaT) lblLogicDeltaT.innerText = '--';
            if (lblLogicFreq)   lblLogicFreq.innerText   = '--';
        }
    }

    // --- Protocol Decoder (UART / SPI / I2C) ---
    function runProtocolDecoder() {
        if (!lblLogicDecode || !cfgLogicDecoder) return;

        const mode = cfgLogicDecoder.value;
        if (mode === 'none' || sampleCount < 16) {
            lblLogicDecode.innerText = 'Select a protocol (UART, SPI, I2C) to decode signals.';
            return;
        }

        if (mode === 'uart') {
            // Decode UART on D0 (Rx)
            let uartText = '';
            let bitSamples = Math.round(sampleRateHz / 9600); // 9600 baud default
            if (bitSamples < 1) bitSamples = 1;

            let i = 0;
            while (i < sampleCount - (bitSamples * 9)) {
                // Find Start bit (falling edge on D0)
                if (((sampleBuffer[i] >> 0) & 1) === 0 && ((sampleBuffer[Math.max(0, i - 1)] >> 0) & 1) === 1) {
                    // Sample 8 data bits at mid-cell
                    let byteVal = 0;
                    for (let b = 0; b < 8; b++) {
                        const sampleIdx = Math.round(i + bitSamples * 1.5 + b * bitSamples);
                        if (sampleIdx < sampleCount) {
                            const bit = (sampleBuffer[sampleIdx] >> 0) & 1;
                            byteVal |= (bit << b);
                        }
                    }
                    if (byteVal >= 32 && byteVal <= 126) {
                        uartText += String.fromCharCode(byteVal);
                    } else {
                        uartText += `[0x${byteVal.toString(16).toUpperCase().padStart(2, '0')}] `;
                    }
                    i += bitSamples * 10;
                } else {
                    i++;
                }
            }
            lblLogicDecode.innerText = uartText ? `UART (9600 Baud): ${uartText}` : 'UART: No valid start/data bits detected.';
        } else if (mode === 'spi') {
            // SPI: D0 = SCK, D1 = MOSI, D2 = CS
            let spiText = '';
            for (let i = 1; i < sampleCount; i++) {
                const prevSck = (sampleBuffer[i - 1] >> 0) & 1;
                const currSck = (sampleBuffer[i] >> 0) & 1;
                const cs = (sampleBuffer[i] >> 2) & 1;

                if (cs === 0 && prevSck === 0 && currSck === 1) { // Rising SCK edge
                    const mosi = (sampleBuffer[i] >> 1) & 1;
                    spiText += mosi ? '1' : '0';
                }
            }
            lblLogicDecode.innerText = spiText ? `SPI Bits (MSB..LSB): ${spiText}` : 'SPI: Waiting for SCK transitions while CS is LOW.';
        } else if (mode === 'i2c') {
            lblLogicDecode.innerText = 'I2C: SDA (D0), SCL (D1) — Ready to capture I2C Address & Data packets.';
        }
    }

    // --- Interactive Mouse Events (Pan, Zoom, Cursor Click) ---
    if (canvas) {
        canvas.addEventListener('mousedown', (e) => {
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;

            if (e.shiftKey) {
                // Shift + Click sets Cursor 2
                const sampleStepPx = ((canvas.width - 60) / sampleCount) * zoomLevel;
                cursor2Index = Math.round((mouseX - (50 + panOffsetPx)) / sampleStepPx);
                cursor2Index = Math.max(0, Math.min(sampleCount - 1, cursor2Index));
                renderCanvas();
            } else if (e.altKey || e.button === 2) {
                // Alt + Click sets Cursor 1
                const sampleStepPx = ((canvas.width - 60) / sampleCount) * zoomLevel;
                cursor1Index = Math.round((mouseX - (50 + panOffsetPx)) / sampleStepPx);
                cursor1Index = Math.max(0, Math.min(sampleCount - 1, cursor1Index));
                renderCanvas();
            } else {
                // Drag to Pan
                isDragging = true;
                dragStartX = mouseX - panOffsetPx;
            }
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            panOffsetPx = mouseX - dragStartX;
            renderCanvas();
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
        });

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.deltaY < 0) {
                zoomLevel = Math.min(10.0, zoomLevel * 1.25);
            } else {
                zoomLevel = Math.max(0.5, zoomLevel / 1.25);
            }
            renderCanvas();
        }, { passive: false });
    }

    // Zoom Buttons
    if (btnZoomIn)  btnZoomIn.addEventListener('click', () => { zoomLevel = Math.min(10.0, zoomLevel * 1.5); renderCanvas(); });
    if (btnZoomOut) btnZoomOut.addEventListener('click', () => { zoomLevel = Math.max(0.5, zoomLevel / 1.5); renderCanvas(); });
    if (btnZoomFit) btnZoomFit.addEventListener('click', () => { zoomLevel = 1.0; panOffsetPx = 0; renderCanvas(); });

    // Decoder Selector Change
    if (cfgLogicDecoder) cfgLogicDecoder.addEventListener('change', runProtocolDecoder);

    // --- Command Start / Stop Helpers ---
    function sendLogicStart() {
        if (!microTester || !microTester.device) return;

        const rateKHz   = parseInt(cfgLogicSampleRate?.value || '100');
        const trigChan  = parseInt(cfgLogicTrigChannel?.value || '0');
        const trigEdge  = parseInt(cfgLogicTrigEdge?.value || '3');

        sampleRateHz = rateKHz * 1000;

        // Payload: [rateKHz_lo, rateKHz_hi, trigChannel, trigEdge, samples_lo, samples_hi]
        const payload = new Uint8Array(6);
        payload[0] = rateKHz & 0xFF;
        payload[1] = (rateKHz >> 8) & 0xFF;
        payload[2] = trigChan;
        payload[3] = trigEdge;
        payload[4] = MAX_SAMPLES & 0xFF;
        payload[5] = (MAX_SAMPLES >> 8) & 0xFF;

        microTester.sendCommand(CMD_LOGIC_START, payload);
    }

    function sendLogicStop() {
        if (!microTester || !microTester.device) return;
        microTester.sendCommand(CMD_LOGIC_STOP);
    }

    if (btnLogicStart) {
        btnLogicStart.addEventListener('click', () => {
            if (!microTester || !microTester.device) return alert("Connect USB first!");

            sendLogicStart();
            isRunning = true;

            if (lblLogicStatus) {
                lblLogicStatus.innerText = 'CAPTURING';
                lblLogicStatus.className = 'status-badge active';
            }
            if (btnLogicStart) btnLogicStart.disabled = true;
            if (btnLogicStop)  btnLogicStop.disabled  = false;
        });
    }

    if (btnLogicStop) {
        btnLogicStop.addEventListener('click', () => {
            sendLogicStop();
            isRunning = false;

            if (lblLogicStatus) {
                lblLogicStatus.innerText = 'STOPPED';
                lblLogicStatus.className = 'status-badge stopped';
            }
            if (btnLogicStart) btnLogicStart.disabled = false;
            if (btnLogicStop)  btnLogicStop.disabled  = true;
        });
    }

    // Expose update function globally
    window.updateLogicPreview = renderCanvas;

    // Initial Render & Resize Observer
    renderCanvas();
    setTimeout(renderCanvas, 50);

    if (window.ResizeObserver && canvas && canvas.parentElement) {
        const observer = new ResizeObserver(() => {
            if (canvas.parentElement.clientWidth > 0) {
                renderCanvas();
            }
        });
        observer.observe(canvas.parentElement);
    }
});
