// Oscilloscope Logic & Canvas Rendering for MicroTester
// Protocol constants (CMD_OSC_START, CMD_OSC_STOP, PKT_OSCILLOSCOPE_DATA) defined in usb_protocol.js

(function () {
    'use strict';

    // ======================== Configuration ========================
    const OSC_BUFFER_SIZE = 500000;  // large ring buffer for 900+ kSPS continuous stream
    const GRID_DIVISIONS_X = 10;
    const GRID_DIVISIONS_Y = 8;

    // ======================== State ========================
    const oscState = {
        running: false,
        channel: 0,
        oversample: 0,
        sampleRateKHz: 913,   // default estimate, updated by actual throughput
        vRef: 3.3,
        adcRes: 255,          // 8-bit resolution
        divider: 1.0,
        biasEnabled: true,

        // Display
        timePerDiv: 0.002,    // seconds per division (2ms default)
        voltsPerDiv: 5.0,     // volts per division
        yOffset: 0,           // vertical offset in divisions
        zeroOffset: parseFloat(localStorage.getItem('microtester_osc_zero_offset')) || 0.0,

        // Trigger
        triggerMode: 'auto', // auto, normal, single
        triggerEdge: 'rising', // rising, falling
        triggerLevel: 0,
        triggered: false,
        singleCaptured: false,

        // Data
        currentFrame: null,

        // Actual PC Rate
        actualRateSamples: 0,
        actualRateTimestamp: performance.now(),
        calculatedSampleRate: 913000, // measured dynamically


        // Animation
        animFrameId: null,
    };

    // Make accessible globally
    window.oscState = oscState;

    // ======================== Time/Div & V/Div presets ========================
    const TIME_DIVS = [
        0.0000001, 0.0000002, 0.0000005, // 100ns, 200ns, 500ns
        0.000001, 0.000002, 0.000005,    // 1us, 2us, 5us
        0.00001, 0.00002, 0.00005,       // 10us, 20us, 50us
        0.0001, 0.0002, 0.0005,
        0.001, 0.002, 0.005,
        0.01, 0.02, 0.05,
        0.1, 0.2, 0.5
    ];
    const VOLT_DIVS = [0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0];

    // ======================== Helpers ========================
    function formatTime(seconds) {
        if (seconds >= 1) return seconds.toFixed(1) + ' s';
        if (seconds >= 0.001) return (seconds * 1000).toFixed(1) + ' ms';
        if (seconds >= 0.000001) return (seconds * 1000000).toFixed(1) + ' µs';
        return (seconds * 1000000000).toFixed(0) + ' ns';
    }

    function formatVoltage(v) {
        if (Math.abs(v) >= 1) return v.toFixed(2) + ' V';
        return (v * 1000).toFixed(0) + ' mV';
    }

    function rawToVolts(raw) {
        const vAdc = (raw / oscState.adcRes) * oscState.vRef;
        // Resistor Divider: 10k GND, 10k 3.3V, 100k Vin => Vin = 21.0 * Vadc - 33.0
        const uncal = 21.0 * vAdc - 33.0;
        return uncal - (oscState.zeroOffset || 0);
    }

    // ======================== Ring Buffer ========================    // Buffer logic removed (handled by hardware frames now)}

    // ======================== Signal Period & PLL Trigger ========================
    function findSignalPeriod(samples) {
        if (!samples || samples.length < 20) return 0;

        let minV = Infinity, maxV = -Infinity;
        for (let i = 0; i < samples.length; i++) {
            const v = samples[i];
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }
        const vPP = maxV - minV;
        if (vPP < 0.03) return 0;

        const level = minV + vPP * 0.5;
        const rising = oscState.triggerEdge === 'rising';
        const hyst = vPP * 0.04;

        const edges = [];
        for (let i = 1; i < samples.length - 1; i++) {
            const prev = samples[i - 1];
            const curr = samples[i];

            let isEdge = false;
            if (rising) {
                if (prev <= (level - hyst) && curr >= (level + hyst)) isEdge = true;
                else if (prev < level && curr >= level) isEdge = true;
            } else {
                if (prev >= (level + hyst) && curr <= (level - hyst)) isEdge = true;
                else if (prev > level && curr <= level) isEdge = true;
            }

            if (isEdge) {
                const frac = (curr !== prev) ? Math.max(0, Math.min(1, (level - prev) / (curr - prev))) : 0;
                edges.push(i + frac);
            }
        }

        if (edges.length < 2) return 0;

        let totalDist = 0;
        let count = 0;
        for (let k = 1; k < edges.length; k++) {
            const dist = edges[k] - edges[k - 1];
            if (dist > 1.5) {
                totalDist += dist;
                count++;
            }
        }
        return count > 0 ? (totalDist / count) : 0;
    }

    let pllLockedTrigPos = null;

    function findTriggerPoint(samples, samplesOnScreen) {
        if (!samples || samples.length < 10) return { index: -1, frac: 0 };

        let minV = Infinity, maxV = -Infinity;
        for (let i = 0; i < samples.length; i++) {
            const v = samples[i];
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }
        const vPP = maxV - minV;

        if (vPP < 0.02) {
            pllLockedTrigPos = null;
            return { index: -1, frac: 0 };
        }

        let level = oscState.triggerLevel;
        let rising = oscState.triggerEdge === 'rising';
        let hyst = vPP * 0.02; 
        
        let postTrigSamples = Math.floor(samplesOnScreen * 0.5);
        if (postTrigSamples < 1) postTrigSamples = 1;
        
        let searchEnd = samples.length - postTrigSamples - 1;
        let searchStart = Math.floor(samplesOnScreen * 0.5); 
        if (searchStart < 1) searchStart = 1;
        
        // Search backwards to find the most recent edge (lowest latency)
        for (let i = searchEnd; i >= searchStart; i--) {
            const prev = samples[i - 1];
            const curr = samples[i];
            
            if (rising) {
                if (prev < level && curr >= level) {
                    // Check simple hysteresis using a slightly older sample
                    const older = (i > 3) ? samples[i - 3] : prev;
                    if (older < level - hyst) {
                        let frac = (curr !== prev) ? (level - prev) / (curr - prev) : 0;
                        return { index: i, frac: frac };
                    }
                }
            } else {
                if (prev > level && curr <= level) {
                    const older = (i > 3) ? samples[i - 3] : prev;
                    if (older > level + hyst) {
                        let frac = (curr !== prev) ? (level - prev) / (curr - prev) : 0;
                        return { index: i, frac: frac };
                    }
                }
            }
        }
        return { index: -1, frac: 0 };
    }

    // ======================== Measurements ========================
    function computeMeasurements(samples, sampleRate) {
        if (!samples || samples.length === 0) return null;

        let vMin = Infinity, vMax = -Infinity, sum = 0;
        for (let i = 0; i < samples.length; i++) {
            const v = samples[i];
            if (v < vMin) vMin = v;
            if (v > vMax) vMax = v;
            sum += v;
        }
        const vAvg = sum / samples.length;
        const vPP = vMax - vMin;

        let freq = 0, period = 0;
        // Only calculate frequency if VPP is above 50 mV noise threshold
        if (vPP > 0.05) {
            const isDecimated = (samples.length === 1600);
            let crossings = 0;
            if (isDecimated) {
                for (let i = 2; i < samples.length; i += 2) {
                    const prevAvg = (samples[i - 2] + samples[i - 1]) / 2;
                    const currAvg = (samples[i] + samples[i + 1]) / 2;
                    if (prevAvg < vAvg && currAvg >= vAvg) crossings++;
                }
                const totalTime = oscState.timePerDiv * GRID_DIVISIONS_X;
                freq = crossings > 0 ? crossings / totalTime : 0;
            } else {
                for (let i = 1; i < samples.length; i++) {
                    if (samples[i - 1] < vAvg && samples[i] >= vAvg) crossings++;
                }
                freq = crossings > 0 ? (crossings * sampleRate) / samples.length : 0;
            }
            period = freq > 0 ? 1 / freq : 0;
        }

        return { vMin, vMax, vPP, vAvg, freq, period };
    }

    // ======================== Canvas Rendering ========================
    let canvas, ctx;

    function initCanvas() {
        canvas = document.getElementById('oscCanvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
    }

    function resizeCanvas() {
        if (!canvas) return;
        const container = canvas.parentElement;
        const dpr = window.devicePixelRatio || 1;
        const w = container.clientWidth;
        const h = container.clientHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawGrid(w, h) {
        const dx = w / GRID_DIVISIONS_X;
        const dy = h / GRID_DIVISIONS_Y;

        // Background
        ctx.fillStyle = '#0a0e14';
        ctx.fillRect(0, 0, w, h);

        // Grid lines
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i < GRID_DIVISIONS_X; i++) {
            ctx.moveTo(Math.round(i * dx) + 0.5, 0);
            ctx.lineTo(Math.round(i * dx) + 0.5, h);
        }
        for (let i = 1; i < GRID_DIVISIONS_Y; i++) {
            ctx.moveTo(0, Math.round(i * dy) + 0.5);
            ctx.lineTo(w, Math.round(i * dy) + 0.5);
        }
        ctx.stroke();

        // Center cross — brighter
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        // Vertical center
        ctx.moveTo(Math.round(w / 2) + 0.5, 0);
        ctx.lineTo(Math.round(w / 2) + 0.5, h);
        // Horizontal center
        ctx.moveTo(0, Math.round(h / 2) + 0.5);
        ctx.lineTo(w, Math.round(h / 2) + 0.5);
        ctx.stroke();

        // Tick marks on center lines
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
        ctx.beginPath();
        // Vertical ticks on horizontal center
        for (let i = 0; i <= GRID_DIVISIONS_X; i++) {
            for (let j = 1; j < 5; j++) {
                const x = Math.round(i * dx + j * dx / 5) + 0.5;
                ctx.moveTo(x, h / 2 - 3);
                ctx.lineTo(x, h / 2 + 3);
            }
        }
        // Horizontal ticks on vertical center
        for (let i = 0; i <= GRID_DIVISIONS_Y; i++) {
            for (let j = 1; j < 5; j++) {
                const y = Math.round(i * dy + j * dy / 5) + 0.5;
                ctx.moveTo(w / 2 - 3, y);
                ctx.lineTo(w / 2 + 3, y);
            }
        }
        ctx.stroke();
    }

    function drawTriggerLine(w, h) {
        // Draw horizontal trigger level line
        const totalVolts = oscState.voltsPerDiv * GRID_DIVISIONS_Y;
        const centerV = oscState.yOffset * oscState.voltsPerDiv;
        const trigV = oscState.triggerLevel;
        const y = h / 2 - ((trigV - centerV) / totalVolts) * h;

        if (y >= 0 && y <= h) {
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(0, Math.round(y) + 0.5);
            ctx.lineTo(w, Math.round(y) + 0.5);
            ctx.stroke();
            ctx.setLineDash([]);

            // Trigger level label on right edge
            ctx.fillStyle = '#f59e0b';
            ctx.font = '9px JetBrains Mono, monospace';
            ctx.fillText('T', w - 12, y - 4);
        }
    }

    function drawWaveform(samples, w, h, triggerRes) {
        if (!samples || samples.length < 2) return;

        const totalVolts = oscState.voltsPerDiv * GRID_DIVISIONS_Y;
        const centerV = oscState.yOffset * oscState.voltsPerDiv;

        // Target trigger position locked at 50% X position (center line of screen)
        const targetTrigPx = w * 0.5;

        // In frame-based architecture, trigger is always exactly in the middle of the array
        const trigSamplePos = samples.length * 0.5;

        // Determine if this is a decimated Min/Max frame (length exactly 1600)
        const isDecimated = (samples.length === 1600);
        
        // If decimated, we have 800 buckets (1600 samples total, min/max pairs).
        // Each bucket represents 1 column (pixel).
        const pxPerSample = isDecimated ? (w / (samples.length / 2)) : (w / samples.length);

        // Glow effect
        ctx.shadowColor = '#22d3ee';
        ctx.shadowBlur = 6;

        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        let first = true;
        let prevY = 0;

        if (isDecimated) {
            // Draw Min/Max continuous envelope
            for (let i = 0; i < samples.length; i += 2) {
                const x = (i / 2) * pxPerSample;
                const minV = samples[i];
                const maxV = samples[i+1];
                
                let y1 = h / 2 - ((minV - centerV) / totalVolts) * h;
                let y2 = h / 2 - ((maxV - centerV) / totalVolts) * h;

                let yTop = Math.min(y1, y2);
                let yBot = Math.max(y1, y2);

                // Ensure at least 1px height so 0-amplitude noise forms a solid 1px line
                if (yBot - yTop < 1) {
                    yBot = yTop + 1;
                }

                if (first) {
                    ctx.moveTo(x, yTop);
                    ctx.lineTo(x, yBot);
                    first = false;
                } else {
                    ctx.lineTo(x, yTop);
                    ctx.lineTo(x, yBot);
                }
            }
        } else {
            // Draw Raw
            for (let i = 0; i < samples.length; i++) {
                const x = targetTrigPx + (i - trigSamplePos) * pxPerSample;
                if (x < -20) continue;
                if (x > w + 20) break;

                const v = samples[i];
                const y = h / 2 - ((v - centerV) / totalVolts) * h;

                if (first) {
                    ctx.moveTo(x, y);
                    first = false;
                } else {
                    if (Math.abs(y - prevY) > (h * 0.12) && pxPerSample > 2.5) {
                        ctx.lineTo(x, prevY);
                        ctx.lineTo(x, y);
                    } else {
                        ctx.lineTo(x, y);
                    }
                }
                prevY = y;
            }
        }
        
        ctx.stroke();

        // Reset shadow
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
    }

    function drawLabels(w, h) {
        ctx.font = '10px JetBrains Mono, monospace';

        // Time labels at bottom
        ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
        const dx = w / GRID_DIVISIONS_X;
        for (let i = 0; i <= GRID_DIVISIONS_X; i++) {
            const t = (i - GRID_DIVISIONS_X / 2) * oscState.timePerDiv;
            const label = formatTime(Math.abs(t));
            const prefix = t < 0 ? '-' : (t > 0 ? '' : '');
            ctx.fillText(prefix + label, i * dx + 3, h - 4);
        }

        // Voltage labels on left
        const dy = h / GRID_DIVISIONS_Y;
        for (let i = 0; i <= GRID_DIVISIONS_Y; i++) {
            const v = (GRID_DIVISIONS_Y / 2 - i) * oscState.voltsPerDiv + oscState.yOffset * oscState.voltsPerDiv;
            ctx.fillText(formatVoltage(v), 3, i * dy + 12);
        }
    }

    function drawStatusOverlay(w, h) {
        // Top-left: Run/Stop indicator
        const isRun = oscState.running;
        ctx.font = 'bold 11px JetBrains Mono, monospace';

        if (isRun) {
            ctx.fillStyle = '#22c55e';
            ctx.fillText('● RUN', w - 60, 14);
        } else {
            ctx.fillStyle = '#ef4444';
            ctx.fillText('■ STOP', w - 60, 14);
        }

        if (oscState.sampleRateKHz >= 5000) {
            ctx.fillStyle = '#8b5cf6';
            ctx.fillText('ETS', w - 60, 42);
        }



        // Trigger status
        if (oscState.running) {
            if (oscState.triggerMode === 'auto') {
                ctx.fillStyle = '#f59e0b';
                ctx.fillText('AUTO', w - 60, 28);
            } else if (oscState.triggerMode === 'normal') {
                ctx.fillStyle = oscState.triggered ? '#22c55e' : '#ef4444';
                ctx.fillText(oscState.triggered ? 'TRIG\'D' : 'READY', w - 60, 28);
            } else {
                ctx.fillStyle = oscState.singleCaptured ? '#22c55e' : '#f59e0b';
                ctx.fillText(oscState.singleCaptured ? 'CAPTURED' : 'ARMED', w - 70, 28);
            }
        }
    }

    function renderFrame() {
        if (!canvas || !ctx) return;

        const container = canvas.parentElement;
        const w = container.clientWidth;
        const h = container.clientHeight;

        if (w === 0 || h === 0) {
            oscState.animFrameId = requestAnimationFrame(renderFrame);
            return;
        }

        // Auto-resize if container dimensions changed (e.g. after tab switch)
        if (parseInt(canvas.style.width) !== w || parseInt(canvas.style.height) !== h) {
            resizeCanvas();
        }

        drawGrid(w, h);

        const sampleRate = oscState.calculatedSampleRate || 913000;

        const displaySamples = oscState.currentFrame || new Float64Array(0);

        let triggerRes = { index: -1, frac: 0 };
        if (displaySamples.length > 0) {
            triggerRes = { index: displaySamples.length / 2, frac: 0 };
            oscState.triggered = true;
            if (oscState.triggerMode === 'single' && !oscState.singleCaptured) {
                oscState.singleCaptured = true;
            }
        } else {
            oscState.triggered = false;
            if (oscState.triggerMode === 'normal') {
                oscState.animFrameId = requestAnimationFrame(renderFrame);
                return;
            }
        }

        drawWaveform(displaySamples, w, h, triggerRes);
        drawTriggerLine(w, h);
        drawLabels(w, h);
        drawStatusOverlay(w, h);

        // Update measurements
        if (displaySamples.length > 10) {
            const sampleRate = oscState.sampleRateKHz * 1000;
            const meas = computeMeasurements(displaySamples, sampleRate);
            updateMeasurementsUI(meas);
        }

        oscState.animFrameId = requestAnimationFrame(renderFrame);
    }

    // ======================== Measurements UI ========================
    function updateMeasurementsUI(m) {
        if (!m) return;
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.innerText = val;
        };
        set('oscVmax', formatVoltage(m.vMax));
        set('oscVmin', formatVoltage(m.vMin));
        set('oscVpp', formatVoltage(m.vPP));
        set('oscFreq', m.freq > 0 ? (m.freq >= 1000 ? (m.freq / 1000).toFixed(2) + ' kHz' : m.freq.toFixed(1) + ' Hz') : '-- Hz');
        set('oscPeriod', m.period > 0 ? formatTime(m.period) : '--');
    }

    // ======================== Data Receiver ========================
    let oscPacketBuffer = new Uint8Array(0);

    function onUsbData(data) {
        if (!oscState.running) return;

        // Append to buffer
        const newBuf = new Uint8Array(oscPacketBuffer.length + data.length);
        newBuf.set(oscPacketBuffer);
        newBuf.set(data, oscPacketBuffer.length);
        oscPacketBuffer = newBuf;

        // Parse packets
        while (oscPacketBuffer.length >= 3) {
            const pktType = oscPacketBuffer[0];
            
            // Valid packets: 0x10 (Volt), 0x12 (Osc), 0x40 (Logic), 0x50 (Comp)
            if (pktType !== 0x10 && pktType !== 0x12 && pktType !== 0x40 && pktType !== 0x50) {
                oscPacketBuffer = oscPacketBuffer.slice(1);
                continue;
            }

            const length = (oscPacketBuffer[2] << 8) | oscPacketBuffer[1];

            if (length > 8192) {
                oscPacketBuffer = oscPacketBuffer.slice(1);
                continue;
            }

            if (oscPacketBuffer.length >= length + 3) {
                const payload = oscPacketBuffer.slice(3, length + 3);

                if (pktType === 0x12) { // PKT_OSCILLOSCOPE_DATA
                    try {
                        processOscData(payload);
                    } catch (e) {
                        console.error("Error processing oscilloscope data:", e);
                    }
                }

                oscPacketBuffer = oscPacketBuffer.slice(length + 3);
            } else {
                break;
            }
        }
    }

    function processOscData(payload) {
        // Frame received
        if (payload.length === 0) return;

        // Don't push new data if single-captured
        if (oscState.triggerMode === 'single' && oscState.singleCaptured) return;

        const frame = new Float64Array(payload.length);
        for (let i = 0; i < payload.length; i++) {
            frame[i] = rawToVolts(payload[i]);
        }
        
        oscState.currentFrame = frame;

        // Update actual rate based on frames received (optional, mostly for debugging)
        oscState.actualRateSamples += 1; // 1 frame
        let now = performance.now();
        if (now - oscState.actualRateTimestamp >= 1000) {
            let fps = (oscState.actualRateSamples * 1000) / (now - oscState.actualRateTimestamp);
            oscState.calculatedSampleRate = fps;
            let el = document.getElementById('cfgOscActualRate');
            if (el) el.innerText = fps.toFixed(1) + " FPS";
            
            oscState.actualRateSamples = 0;
            oscState.actualRateTimestamp = now;
        }
    }

    // ======================== UI Controls ========================
    document.addEventListener('DOMContentLoaded', () => {
        initCanvas();

        // --- Start / Stop ---
        const btnOscStartStop = document.getElementById('btnOscStartStop');
        if (btnOscStartStop) {
            btnOscStartStop.addEventListener('click', () => {
                if (!microTester.device) return alert("Connect USB first!");

                if (oscState.running) {
                    stopOsc();
                } else {
                    startOsc();
                }
            });
        }

        // Enable button if connected
        setInterval(() => {
            if (btnOscStartStop) {
                btnOscStartStop.disabled = !microTester.device;
            }
        }, 1000);

        // --- Time/Div ---
        const btnTimeDivDown = document.getElementById('btnTimeDivDown');
        const btnTimeDivUp = document.getElementById('btnTimeDivUp');
        const lblTimeDiv = document.getElementById('lblTimeDiv');

        function updateTimeDivLabel() {
            if (lblTimeDiv) lblTimeDiv.innerText = formatTime(oscState.timePerDiv);
        }

        if (btnTimeDivDown) {
            btnTimeDivDown.addEventListener('click', () => {
                const idx = TIME_DIVS.indexOf(oscState.timePerDiv);
                if (idx > 0) {
                    oscState.timePerDiv = TIME_DIVS[idx - 1];
                    updateTimeDivLabel();
                    if (oscState.running) restartOsc();
                }
            });
        }
        if (btnTimeDivUp) {
            btnTimeDivUp.addEventListener('click', () => {
                const idx = TIME_DIVS.indexOf(oscState.timePerDiv);
                if (idx < TIME_DIVS.length - 1) {
                    oscState.timePerDiv = TIME_DIVS[idx + 1];
                    updateTimeDivLabel();
                    if (oscState.running) restartOsc();
                }
            });
        }

        // --- V/Div ---
        const btnVDivDown = document.getElementById('btnVDivDown');
        const btnVDivUp = document.getElementById('btnVDivUp');
        const lblVDiv = document.getElementById('lblVDiv');

        function updateVDivLabel() {
            if (lblVDiv) lblVDiv.innerText = formatVoltage(oscState.voltsPerDiv);
        }

        if (btnVDivDown) {
            btnVDivDown.addEventListener('click', () => {
                const idx = VOLT_DIVS.indexOf(oscState.voltsPerDiv);
                if (idx > 0) {
                    oscState.voltsPerDiv = VOLT_DIVS[idx - 1];
                    updateVDivLabel();
                }
            });
        }
        if (btnVDivUp) {
            btnVDivUp.addEventListener('click', () => {
                const idx = VOLT_DIVS.indexOf(oscState.voltsPerDiv);
                if (idx < VOLT_DIVS.length - 1) {
                    oscState.voltsPerDiv = VOLT_DIVS[idx + 1];
                    updateVDivLabel();
                }
            });
        }

        // --- Trigger Mode ---
        const cfgTrigMode = document.getElementById('cfgOscTrigMode');
        if (cfgTrigMode) {
            cfgTrigMode.addEventListener('change', () => {
                oscState.triggerMode = cfgTrigMode.value;
                if (oscState.triggerMode === 'single') {
                    oscState.singleCaptured = false;
                    oscState.frozenWaveform = null;
                }
                if (oscState.running) restartOsc();
            });
        }

        // --- Trigger Edge ---
        const cfgTrigEdge = document.getElementById('cfgOscTrigEdge');
        if (cfgTrigEdge) {
            cfgTrigEdge.addEventListener('change', () => {
                oscState.triggerEdge = cfgTrigEdge.value;
                if (oscState.running) restartOsc();
            });
        }

        // --- Trigger Level ---
        const cfgTrigLevel = document.getElementById('cfgOscTrigLevel');
        if (cfgTrigLevel) {
            cfgTrigLevel.addEventListener('input', () => {
                oscState.triggerLevel = parseFloat(cfgTrigLevel.value) || 0;
            });
            cfgTrigLevel.addEventListener('change', () => {
                oscState.triggerLevel = parseFloat(cfgTrigLevel.value) || 0;
                if (oscState.running) restartOsc();
            });
        }

        // --- Channel ---
        const cfgOscChannel = document.getElementById('cfgOscChannel');
        if (cfgOscChannel) {
            cfgOscChannel.addEventListener('change', () => {
                oscState.channel = parseInt(cfgOscChannel.value);
                if (oscState.running) restartOsc();
            });
        }

        // --- Sample Rate ---
        const cfgOscSampleRate = document.getElementById('cfgOscSampleRate');
        if (cfgOscSampleRate) {
            cfgOscSampleRate.addEventListener('change', () => {
                oscState.sampleRateKHz = parseInt(cfgOscSampleRate.value) || 10;
                if (oscState.running) restartOsc();
            });
        }

        // --- Oversampling ---
        const cfgOscOversample = document.getElementById('cfgOscOversample');
        if (cfgOscOversample) {
            cfgOscOversample.addEventListener('change', () => {
                oscState.oversample = parseInt(cfgOscOversample.value);
                if (oscState.running) restartOsc();
            });
        }

        // --- Auto Scale ---
        const btnAutoScale = document.getElementById('btnOscAutoScale');
        if (btnAutoScale) {
            btnAutoScale.addEventListener('click', autoScale);
        }

        // --- Oscilloscope Zero Calibration ---
        const btnOscZeroCalib = document.getElementById('btnOscZeroCalib');
        const oscZeroOffsetBadge = document.getElementById('oscZeroOffsetBadge');
        const oscZeroOffsetVal = document.getElementById('oscZeroOffsetVal');
        const btnOscResetZero = document.getElementById('btnOscResetZero');

        const btnOscCalibTab = document.getElementById('btnOscCalibTab');
        const oscZeroBadgeTab = document.getElementById('oscZeroBadgeTab');
        const oscZeroValTab = document.getElementById('oscZeroValTab');
        const btnOscResetTab = document.getElementById('btnOscResetTab');

        function updateOscZeroBadge() {
            const hasOffset = Math.abs(oscState.zeroOffset) > 0.0001;
            const txt = (oscState.zeroOffset >= 0 ? '+' : '') + oscState.zeroOffset.toFixed(3) + ' V';

            if (oscZeroOffsetBadge && oscZeroOffsetVal) {
                if (hasOffset) {
                    oscZeroOffsetVal.innerText = txt;
                    oscZeroOffsetBadge.style.display = 'inline-flex';
                } else {
                    oscZeroOffsetBadge.style.display = 'none';
                }
            }
            if (oscZeroBadgeTab && oscZeroValTab) {
                if (hasOffset) {
                    oscZeroValTab.innerText = txt;
                    oscZeroBadgeTab.style.display = 'inline-flex';
                } else {
                    oscZeroBadgeTab.style.display = 'none';
                }
            }
        }

        const doCalibOscZero = () => {
            if (!oscState.currentFrame || oscState.currentFrame.length === 0) {
                alert("Please Start Oscilloscope first to capture zero baseline.");
                return;
            }
            let sum = 0;
            for (let i = 0; i < oscState.currentFrame.length; i++) {
                sum += oscState.currentFrame[i] + (oscState.zeroOffset || 0);
            }
            const avg = sum / oscState.currentFrame.length;
            oscState.zeroOffset = avg;
            localStorage.setItem('microtester_osc_zero_offset', oscState.zeroOffset.toString());
            updateOscZeroBadge();
        };

        const doResetOscZero = (e) => {
            if (e) { e.preventDefault(); e.stopPropagation(); }
            oscState.zeroOffset = 0.0;
            localStorage.removeItem('microtester_osc_zero_offset');
            updateOscZeroBadge();
        };

        if (btnOscZeroCalib) btnOscZeroCalib.addEventListener('click', doCalibOscZero);
        if (btnOscCalibTab) btnOscCalibTab.addEventListener('click', doCalibOscZero);
        if (btnOscResetZero) btnOscResetZero.addEventListener('click', doResetOscZero);
        if (btnOscResetTab) btnOscResetTab.addEventListener('click', doResetOscZero);

        updateOscZeroBadge();

        // --- Osc Settings Toggle ---
        const btnOscSettings = document.getElementById('btnOscSettings');
        const oscConfigPanel = document.getElementById('oscConfigPanel');
        if (btnOscSettings && oscConfigPanel) {
            btnOscSettings.addEventListener('click', () => {
                oscConfigPanel.classList.toggle('collapsed');
            });
        }

        // Set initial labels
        updateTimeDivLabel();
        updateVDivLabel();

        // Register data listener
        microTester.addDataListener(onUsbData);
    });

    // ======================== Start / Stop / Restart ========================
    function startOsc() {
        const btnOscStartStop = document.getElementById('btnOscStartStop');

        oscState.running = true;
        oscState.singleCaptured = false;
        oscState.frozenWaveform = null;
        oscState.ringHead = 0;
        oscState.ringCount = 0;
        oscPacketBuffer = new Uint8Array(0);

        if (btnOscStartStop) {
            btnOscStartStop.innerHTML = '■ Stop';
            btnOscStartStop.classList.remove('btn-success');
            btnOscStartStop.classList.add('btn-danger');
        }

        // Send command: [pin, oversample, rateKHz_lo, rateKHz_hi, trigEdge, trigLevel_lo, trigLevel_hi, trigMode, reqSamples_lo, reqSamples_hi]
        const payload = new Uint8Array(10);
        payload[0] = oscState.channel;
        payload[1] = oscState.oversample;
        payload[2] = oscState.sampleRateKHz & 0xFF;
        payload[3] = (oscState.sampleRateKHz >> 8) & 0xFF;

        payload[4] = oscState.triggerEdge === 'rising' ? 1 : 0;

        // Convert trigger voltage to raw ADC (0-255 for 8-bit mode)
        let trigV = oscState.triggerLevel / oscState.divider;
        if (oscState.biasEnabled) trigV += 1.65;
        let trigRaw = (trigV / oscState.vRef) * oscState.adcRes;
        trigRaw = Math.max(0, Math.min(oscState.adcRes, Math.round(trigRaw)));

        payload[5] = trigRaw & 0xFF;
        payload[6] = (trigRaw >> 8) & 0xFF;

        // Trigger mode: 0=auto, 1=normal, 2=single
        const modeMap = { 'auto': 0, 'normal': 1, 'single': 2 };
        payload[7] = modeMap[oscState.triggerMode] || 0;

        const totalTime = oscState.timePerDiv * GRID_DIVISIONS_X;
        const sampleRate = oscState.sampleRateKHz * 1000;
        let samplesOnScreen = Math.round(totalTime * sampleRate);
        if (samplesOnScreen < 20) samplesOnScreen = 20;
        if (samplesOnScreen > 20000) samplesOnScreen = 20000; // MCU memory limit

        payload[8] = samplesOnScreen & 0xFF;
        payload[9] = (samplesOnScreen >> 8) & 0xFF;

        microTester.sendCommand(CMD_OSC_START, payload);

        // Start rendering
        if (oscState.animFrameId) cancelAnimationFrame(oscState.animFrameId);
        oscState.animFrameId = requestAnimationFrame(renderFrame);
    }

    function stopOsc() {
        const btnOscStartStop = document.getElementById('btnOscStartStop');

        oscState.running = false;
        microTester.sendCommand(CMD_OSC_STOP);

        if (btnOscStartStop) {
            btnOscStartStop.innerHTML = '▶ Start';
            btnOscStartStop.classList.remove('btn-danger');
            btnOscStartStop.classList.add('btn-success');
        }

        if (oscState.animFrameId) {
            cancelAnimationFrame(oscState.animFrameId);
            oscState.animFrameId = null;
        }
    }

    function restartOsc() {
        if (!oscState.running) return;
        microTester.sendCommand(CMD_OSC_STOP);
        oscState.ringHead = 0;
        oscState.ringCount = 0;

        const payload = new Uint8Array(10);
        payload[0] = oscState.channel;
        payload[1] = oscState.oversample;
        payload[2] = oscState.sampleRateKHz & 0xFF;
        payload[3] = (oscState.sampleRateKHz >> 8) & 0xFF;

        payload[4] = oscState.triggerEdge === 'rising' ? 1 : 0;
        let trigV = oscState.triggerLevel / oscState.divider;
        if (oscState.biasEnabled) trigV += 1.65;
        let trigRaw = Math.max(0, Math.min(oscState.adcRes, Math.round((trigV / oscState.vRef) * oscState.adcRes)));
        payload[5] = trigRaw & 0xFF;
        payload[6] = (trigRaw >> 8) & 0xFF;

        const modeMap = { 'auto': 0, 'normal': 1, 'single': 2 };
        payload[7] = modeMap[oscState.triggerMode] || 0;

        const totalTime = oscState.timePerDiv * GRID_DIVISIONS_X;
        const sampleRate = oscState.sampleRateKHz * 1000;
        let samplesOnScreen = Math.round(totalTime * sampleRate);
        if (samplesOnScreen < 20) samplesOnScreen = 20;
        if (samplesOnScreen > 20000) samplesOnScreen = 20000;

        payload[8] = samplesOnScreen & 0xFF;
        payload[9] = (samplesOnScreen >> 8) & 0xFF;

        microTester.sendCommand(CMD_OSC_START, payload);
    }

    function autoScale() {
        if (oscState.ringCount < 10) return;
        const samples = getSamples(oscState.ringCount);
        const meas = computeMeasurements(samples, oscState.sampleRateKHz * 1000);
        if (!meas) return;

        // Auto V/Div: fit waveform in ~6 divisions
        const targetVpp = meas.vPP * 1.3; // 30% margin
        let bestVDiv = VOLT_DIVS[VOLT_DIVS.length - 1];
        for (const vd of VOLT_DIVS) {
            if (vd * 6 >= targetVpp) {
                bestVDiv = vd;
                break;
            }
        }
        oscState.voltsPerDiv = bestVDiv;

        // Auto Time/Div: show ~2-3 periods
        if (meas.freq > 0) {
            const targetTime = (3 / meas.freq) / GRID_DIVISIONS_X;
            let bestTDiv = TIME_DIVS[TIME_DIVS.length - 1];
            for (const td of TIME_DIVS) {
                if (td >= targetTime) {
                    bestTDiv = td;
                    break;
                }
            }
            oscState.timePerDiv = bestTDiv;
        }

        // Auto trigger level: center of waveform
        oscState.triggerLevel = meas.vAvg;
        const trigLevelInput = document.getElementById('cfgOscTrigLevel');
        if (trigLevelInput) trigLevelInput.value = meas.vAvg.toFixed(3);

        // Update labels
        const lblTimeDiv = document.getElementById('lblTimeDiv');
        const lblVDiv = document.getElementById('lblVDiv');
        if (lblTimeDiv) lblTimeDiv.innerText = formatTime(oscState.timePerDiv);
        if (lblVDiv) lblVDiv.innerText = formatVoltage(oscState.voltsPerDiv);

        // Reset Y offset
        oscState.yOffset = 0;
    }

})();
