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
        activeChannels: [0],
        multiChannel: false,
        currentMultiIdx: 0,
        multiFrames: [null, null, null, null],
        syncPending: false,
        oversample: 0,
        sampleRateKHz: 100,   // default (100 kHz), synced from UI select at init
        acqMode: 'realtime', // Real-time | ETS | Auto HF | Aliasing | Undersample (Mode selector)
        vRef: 3.3,
        adcRes: 4095,         // 12-bit resolution
        divider: 1.0,
        biasEnabled: true,
        autoPolarity: false,   // ±30V Auto-Polarity mode: switch bias automatically
        autoBiasVotes: 0,      // consecutive frames voting for a bias switch
        autoBiasLastSwitch: 0, // cooldown timestamp (ms)

        resolution: 12,

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
        sessionId: 0,
        framesCollectedInSession: 0,

        // Data
        currentFrame: null,
        isEts: false,          // true when equivalent-time sampling is active
        reqSamplesSent: 0,     // reqSamples sent to firmware (for decimation time base)

        // Auto Aliasing (undersampling heterodyne): sampler is the mixer, LO = Fs.
        // Carrier is solved on the host from aliases at several rates (sine ≤ ~12 MHz).
        aliasMode: false,      // display stream carries an aliased waveform + carrier estimate
        aliasFreqHz: 0,        // estimated true carrier frequency (0 = no signal / not solved)
        aliasAmbiguous: false, // true when several carriers explain the aliases
        aliasScanning: false,  // true while the multi-rate scan is in progress
        aliasScanIdx: 0,       // 1-based scan point index for the overlay (0 = idle)
        aliasScanTot: 0,       // total scan points in the current run
        aliasPts: 0,           // usable alias points produced by the last scan (0..4)

        // Undersampling (bandpass sampling): Fs is placed so the known carrier
        // lands at Fs/4 of a Nyquist zone; the shown wave IS the downconverted
        // signal (time-reversed when the zone is odd). usMode: null|'manual'|'auto'.
        usMode: null,
        usLocked: false,       // true once Fs is locked to a zone
        usScanning: false,
        usFcHz: 0,             // carrier the lock was planned from
        usFcEstHz: 0,          // live carrier estimate (lock readout tracking)
        usAmbiguous: false,    // auto mode: solver was ambiguous
        usFsKHz: 0, usFsHz: 0, // locked sample rate
        usK: 0, usS: 1,        // fold branch: carrier ≈ usK*usFsHz + usS*IF
        usZone: 0, usMirrored: false,
        usTargetIFHz: 0,       // planned IF (Fs/4)
        usLastRecenter: 0,     // throttle for drift re-lock restarts
        usSavedCh: null,       // channel selection saved before forcing single-ch
        usSavedTrig: null, usSavedRes: null, usSavedAdc: null,

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

    function rawToVolts(raw, ch) {
        if (ch === undefined) ch = oscState.multiChannel ? oscState.activeChannels[oscState.currentMultiIdx] : oscState.channel;
        if (ch === 0 || ch <= 3) {
            let freqComp = 0;
            if (oscState.biasEnabled) {
                let maxRate = oscState.resolution === 12 ? 2800 : 3818;
                let actualRateKHz = Math.min(oscState.sampleRateKHz, maxRate);
                // Roll-off compensation applies only ABOVE 1 MHz. Below that it must be 0,
                // otherwise it injects a large negative DC shift (e.g. -1.98 V @ 100 kHz).
                freqComp = Math.max(0, actualRateKHz - 1000) * 0.0022;
            }

            if (window.Calibration) {
                return window.Calibration.calculateVolts(oscState.biasEnabled, ch, raw, oscState.resolution, oscState.divider, freqComp)
                    + getRateZeroCorr(ch);
            }
            return 0;
        } else {
            // Logic mode or unsupported
            return raw > 127 ? 3.3 : 0.0;
        }
    }

    // ======================== Per-Rate Zero Calibration ========================
    // Stores, for every oscilloscope mode (resolution x sample rate) and channel,
    // the zero CORRECTION in probe/display volts: how much the voltage reading
    // must be raised (positive) or lowered (negative) so a shorted probe sits at 0 V.
    // The correction is measured end-to-end on displayed values, so it automatically
    // includes bias offset, divider error and freqComp roll-off compensation.

    // Storage layout: { [resolution]: { [rateKey]: [ch0, ch1, ch2, ch3] } }
    // rateKey = "<rate>" for bias OFF, "<rate>b" for bias ON — zero differs per bias.
    // v4: entries are probe-referred corrections (V), not pin-referred zeros.
    // v5: separate entries per bias state (auto-polarity switches bias dynamically).
    const RATE_ZERO_KEY = 'microtester_osc_rate_zero_v5';
    const RATE_ZERO_MODES = {
        12: [1, 10, 50, 100, 250, 500, 1000, 2000, 2800],
        8: [1, 10, 50, 100, 250, 500, 1000, 2000, 2800, 3818, 5000, 10000, 20000]
    };

    const rateZeroRateKey = (rate, biasEnabled) => String(rate) + (biasEnabled ? 'b' : '');

    // In-memory cache — avoids JSON.parse on every sample.
    let rateZeroCache = (() => {
        try { return JSON.parse(localStorage.getItem(RATE_ZERO_KEY)) || {}; }
        catch (e) { return {}; }
    })();
    if (Array.isArray(rateZeroCache)) rateZeroCache = {}; // guard against legacy array format

    function loadRateZeroMap() {
        return rateZeroCache;
    }

    function saveRateZeroMap(map) {
        rateZeroCache = map;
        try { localStorage.setItem(RATE_ZERO_KEY, JSON.stringify(map)); } catch (e) { /* storage full */ }
    }

    // Correction (probe volts) for the current mode/channel/bias. 0 = uncalibrated.
    function getRateZeroCorr(ch) {
        if (!isOsc30VMode()) return 0;
        if (oscRateCapture && oscRateCapture.active) return 0; // don't apply while measuring
        const resMap = rateZeroCache[String(oscState.resolution)];
        if (!resMap) return 0;
        const entry = resMap[rateZeroRateKey(oscState.sampleRateKHz, oscState.biasEnabled)];
        const v = entry ? entry[ch] : undefined;
        return (typeof v === 'number' && !isNaN(v)) ? v : 0;
    }

    let oscRateCapture = null; // active raw-ADC capture: { active, ch, sum, count }

    // Rate-zero calibration is valid only for the ±30V Auto-Polarity range
    // (divider ~11). In direct 0..3.3V mode there is no divider offset to cancel.
    function isOsc30VMode() {
        const sel = document.getElementById('cfgOscVoltRange');
        if (sel) return sel.value === '±30';
        return oscState.divider > 1.0;
    }

    // Acquisition mode: ETS is explicit (oscState.acqMode from the Mode selector),
    // never inferred from the rate number; multi-channel always forces realtime.
    // Falls back to the legacy rate threshold before UI init.
    function isEtsMode() {
        if (oscState.multiChannel) return false;
        if (oscState.acqMode) return oscState.acqMode === 'ets';
        return oscState.sampleRateKHz >= 5000;
    }

    function getRateZeroModeCount(ch) {
        const map = loadRateZeroMap();
        let total = 0, calibrated = 0;
        for (const resKey in RATE_ZERO_MODES) {
            for (const rate of RATE_ZERO_MODES[resKey]) {
                total++;
                const entry = map[resKey] && map[resKey][rateZeroRateKey(rate, oscState.biasEnabled)];
                const v = entry ? entry[ch] : undefined;
                if (typeof v === 'number' && !isNaN(v)) calibrated++;
            }
        }
        return { calibrated, total };
    }

    const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

    // Measures the zero offset (shorted probe) for every oscilloscope mode
    // (resolution x sample rate) on the given channel and stores the correction
    // in probe volts per mode: how much to raise/lower the displayed voltage.
    // options.bias          — force a specific bias state during the run (restored after)
    // options.skipBusyCheck — caller (calibration wizard) manages _calibrationBusy itself
    async function runRateZeroCalibration(channel, progressCb, options) {
        options = options || {};
        if (typeof microTester === 'undefined' || !microTester.device) {
            throw new Error("Device not connected");
        }
        if (!isOsc30VMode()) {
            throw new Error("Set Voltage Range to ±30V first — rate-zero calibration applies only to the ±30V range");
        }
        if (window.Calibration && window.Calibration._calibrationBusy && !options.skipBusyCheck) {
            throw new Error("Another calibration is in progress");
        }
        const report = (msg) => { if (progressCb) { try { progressCb(msg); } catch (e) { } } };

        const wasRunning = oscState.running;
        const orig = {
            rate: oscState.sampleRateKHz,
            channel: oscState.channel,
            multiChannel: oscState.multiChannel,
            activeChannels: [...oscState.activeChannels],
            triggerMode: oscState.triggerMode,
            oversample: oscState.oversample,
            resolution: oscState.resolution,
            adcRes: oscState.adcRes,
            biasEnabled: oscState.biasEnabled,
            divider: oscState.divider
        };
        const forcedBias = (typeof options.bias === 'boolean') ? options.bias : null;

        if (window.Calibration) window.Calibration._calibrationBusy = true;

        if (forcedBias !== null && forcedBias !== oscState.biasEnabled) {
            oscState.biasEnabled = forcedBias;
            oscState.divider = forcedBias ? 21.0 : 11.0;
        }

        const grabFrame = () => oscState.currentFrame;
        // Measures the displayed zero midpoint (Vmax+Vmin)/2 averaged over several frames
        const measureMidpoint = async (frames) => {
            let lastSeq = oscState.frameSeq || 0;
            let acc = 0, used = 0;
            for (let f = 0; f < frames; f++) {
                const t0 = performance.now();
                while ((oscState.frameSeq || 0) === lastSeq && performance.now() - t0 < 600) {
                    await sleepMs(10);
                }
                if ((oscState.frameSeq || 0) === lastSeq) break; // stream stalled
                lastSeq = oscState.frameSeq;
                const fr = grabFrame();
                if (!fr || fr.length === 0) continue;
                let mn = Infinity, mx = -Infinity;
                for (let i = 0; i < fr.length; i++) {
                    if (fr[i] < mn) mn = fr[i];
                    if (fr[i] > mx) mx = fr[i];
                }
                acc += (mn + mx) / 2;
                used++;
            }
            return used > 0 ? (acc / used) : null;
        };

        try {
            if (wasRunning) stopOsc();
            await sleepMs(150);

            // Force single-channel auto-trigger streaming on the selected channel
            oscState.multiChannel = false;
            oscState.channel = channel;
            oscState.activeChannels = [channel];
            oscState.triggerMode = 'auto';

            const map = loadRateZeroMap();
            const errors = [];
            let step = 0;
            let totalSteps = 0;
            for (const resKey in RATE_ZERO_MODES) totalSteps += RATE_ZERO_MODES[resKey].length;

            for (const resKey in RATE_ZERO_MODES) {
                const res = parseInt(resKey, 10);
                oscState.resolution = res;
                oscState.adcRes = (res === 12) ? 4095 : 255;
                const resSel = document.getElementById('cfgOscResolution');
                if (resSel) resSel.value = String(res);

                if (!map[resKey]) map[resKey] = {};

                for (const rate of RATE_ZERO_MODES[resKey]) {
                    step++;
                    const biasLabel = oscState.biasEnabled ? "BIAS " : "NO-BIAS ";
                    const modeLabel = `${res}-bit ${rate >= 5000 ? "(ETS) " : ""}@ ${rate} kHz (${biasLabel})`;
                    report(`Calibrating zero ${modeLabel} (${step}/${totalSteps})...`);

                    oscState.sampleRateKHz = rate;
                    startOsc();              // running=true, sessionId++, streams frames
                    await sleepMs(350);      // settle

                    const mid = await measureMidpoint(12);

                    stopOsc();
                    await sleepMs(80);

                    if (mid === null) {
                        errors.push(modeLabel);
                        continue; // skip failed mode, keep going
                    }

                    // Correction: how much to RAISE the reading so the zero sits at 0 V
                    const corr = -mid;
                    const rateKey = rateZeroRateKey(rate, oscState.biasEnabled);
                    if (!map[resKey][rateKey]) map[resKey][rateKey] = [null, null, null, null];
                    map[resKey][rateKey][channel] = corr;
                    saveRateZeroMap(map);
                }
            }
            if (errors.length > 0) {
                report(`Done with errors on: ${errors.join(", ")}`);
            } else {
                report('Done — corrections stored for all modes');
            }
            return map;
        } finally {
            oscState.sampleRateKHz = orig.rate;
            oscState.channel = orig.channel;
            oscState.multiChannel = orig.multiChannel;
            oscState.activeChannels = orig.activeChannels;
            oscState.triggerMode = orig.triggerMode;
            oscState.oversample = orig.oversample;
            oscState.resolution = orig.resolution;
            oscState.adcRes = orig.adcRes;
            const resSel = document.getElementById('cfgOscResolution');
            if (resSel) resSel.value = String(orig.resolution);
            oscState.biasEnabled = orig.biasEnabled;
            oscState.divider = orig.divider;
            oscRateCapture = null;
            if (window.Calibration) window.Calibration._calibrationBusy = false;
            if (wasRunning) {
                startOsc();
            } else if (oscState.running) {
                stopOsc();
            }
        }
    }

    // ======================== Ring Buffer ========================    // Buffer logic removed (handled by hardware frames now)}

    // ======================== Signal Period & PLL Trigger ========================
    function findSignalPeriod(samples) {
        // Obsolete, replaced by robust logic in computeMeasurements
        return 0;
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
        const vPP_raw = vMax - vMin;

        let freq = 0, period = 0, duty = 0;

        if (vPP_raw > 0.05) {
            const isEts = isEtsMode();
            const isDecimated = !isEts && (samples.length === 1600);

            const wave = [];
            if (isDecimated) {
                for (let i = 0; i < samples.length; i += 2) {
                    wave.push((samples[i] + samples[i + 1]) / 2);
                }
            } else {
                for (let i = 0; i < samples.length; i++) {
                    wave.push(samples[i]);
                }
            }

            // --- Robust Top and Base (Histogram Method) ---
            const BINS = 100;
            const hist = new Int32Array(BINS);
            for (let i = 0; i < wave.length; i++) {
                let bin = Math.floor(((wave[i] - vMin) / vPP_raw) * (BINS - 1));
                if (bin < 0) bin = 0;
                if (bin >= BINS) bin = BINS - 1;
                hist[bin]++;
            }

            let maxLowBin = 0, maxLowCount = -1;
            for (let i = 0; i < BINS / 2; i++) {
                if (hist[i] > maxLowCount) {
                    maxLowCount = hist[i];
                    maxLowBin = i;
                }
            }
            let maxHighBin = BINS / 2, maxHighCount = -1;
            for (let i = Math.floor(BINS / 2); i < BINS; i++) {
                if (hist[i] > maxHighCount) {
                    maxHighCount = hist[i];
                    maxHighBin = i;
                }
            }

            const vBase = vMin + (maxLowBin / (BINS - 1)) * vPP_raw;
            const vTop = vMin + (maxHighBin / (BINS - 1)) * vPP_raw;
            const vAmp = vTop - vBase;

            // If the signal is too noisy or doesn't have clear levels, fallback to vMin/vMax
            const mid = vAmp > 0.05 ? vBase + vAmp * 0.5 : vMin + vPP_raw * 0.5;
            const hyst = vAmp > 0.05 ? vAmp * 0.05 : vPP_raw * 0.05;

            // --- Edge Detection ---
            const risingEdges = [];
            const fallingEdges = [];

            if (wave.length > 0) {
                let state = wave[0] > mid ? 1 : 0;
                for (let i = 1; i < wave.length; i++) {
                    const prev = wave[i - 1];
                    const curr = wave[i];

                    if (state === 0 && curr > mid + hyst) {
                        const frac = (curr !== prev) ? (mid - prev) / (curr - prev) : 0;
                        risingEdges.push(i - 1 + frac);
                        state = 1;
                    } else if (state === 1 && curr < mid - hyst) {
                        const frac = (curr !== prev) ? (mid - prev) / (curr - prev) : 0;
                        fallingEdges.push(i - 1 + frac);
                        state = 0;
                    }
                }
            }

            // Match the firmware's exact decimation logic to get the TRUE time window
            let effRate = sampleRate;
            if (isDecimated && oscState.reqSamplesSent > 0) {
                const numBuckets = samples.length / 2; // 800
                let step = Math.floor(oscState.reqSamplesSent / numBuckets);
                if (step < 1) step = 1;
                const actualSamplesCovered = step * numBuckets;
                effRate = (sampleRate * numBuckets) / actualSamplesCovered;
            } else if (isDecimated) {
                effRate = (sampleRate * samples.length / 2) / samples.length;
            }

            // --- Median Period Filtering ---
            const allDists = [];
            for (let i = 1; i < risingEdges.length; i++) {
                allDists.push(risingEdges[i] - risingEdges[i - 1]);
            }
            for (let i = 1; i < fallingEdges.length; i++) {
                allDists.push(fallingEdges[i] - fallingEdges[i - 1]);
            }

            if (allDists.length > 0) {
                // Find median period distance
                allDists.sort((a, b) => a - b);
                const medianPeriod = allDists[Math.floor(allDists.length / 2)];

                // Average only valid distances close to median (+/- 20%) to ignore missed/spurious edges
                let validSum = 0, validCount = 0;
                for (let i = 0; i < allDists.length; i++) {
                    if (Math.abs(allDists[i] - medianPeriod) < medianPeriod * 0.2) {
                        validSum += allDists[i];
                        validCount++;
                    }
                }

                const avgPeriodSamples = validCount > 0 ? validSum / validCount : medianPeriod;
                period = avgPeriodSamples / effRate;
                freq = period > 0 ? 1 / period : 0;

                // --- Robust Duty Cycle ---
                let highSum = 0, highCount = 0;
                let lowSum = 0, lowCount = 0;

                const allEdges = [];
                for (let i = 0; i < risingEdges.length; i++) allEdges.push({ pos: risingEdges[i], type: 'rising' });
                for (let i = 0; i < fallingEdges.length; i++) allEdges.push({ pos: fallingEdges[i], type: 'falling' });
                allEdges.sort((a, b) => a.pos - b.pos);

                for (let i = 1; i < allEdges.length; i++) {
                    const prevEdge = allEdges[i - 1];
                    const currEdge = allEdges[i];
                    const dist = currEdge.pos - prevEdge.pos;

                    // Ensure we only sum valid distances (e.g. less than 90% of full period)
                    if (dist > 0 && dist < avgPeriodSamples * 0.9) {
                        if (prevEdge.type === 'rising' && currEdge.type === 'falling') {
                            highSum += dist;
                            highCount++;
                        } else if (prevEdge.type === 'falling' && currEdge.type === 'rising') {
                            lowSum += dist;
                            lowCount++;
                        }
                    }
                }

                const avgHigh = highCount > 0 ? highSum / highCount : 0;
                const avgLow = lowCount > 0 ? lowSum / lowCount : 0;

                if (avgHigh + avgLow > 0) {
                    duty = (avgHigh / (avgHigh + avgLow)) * 100;
                }
            }
        }

        // Flag Min/Max-decimated frames: freq/duty there come from the midpoint
        // envelope, not raw samples — consumers must not trust them for IF readout.
        const frameDecimated = !isEtsMode() && samples.length === 1600;

        // Return the absolute peak-to-peak for UI, as is standard
        return { vMin, vMax, vPP: vPP_raw, vAvg, freq, period, duty, decimated: frameDecimated };
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

    // Red input voltage limit lines.
    // Divider probe (±30V): always drawn as in bias-ON mode —
    // +/- (vDda/2)*21 (~+/-34.65 V nominal), regardless of the actual bias state.
    // Direct input (0..3.3V): 0 .. vDda (~+3.3 V).
    function drawLimitLines(w, h) {
        const vDda = (window.Calibration && window.Calibration.vDda) || oscState.vRef || 3.3;

        let vMaxLim, vMinLim, lblMax, lblMin;
        if (oscState.divider > 1.0) {
            const divider = 21.0;
            vMaxLim = (vDda / 2.0) * divider;
            vMinLim = -(vDda / 2.0) * divider;
            lblMax = '+' + vMaxLim.toFixed(1) + 'V MAX';
            lblMin = vMinLim.toFixed(1) + 'V MIN';
        } else {
            vMaxLim = vDda;
            vMinLim = 0.0;
            lblMax = '+' + vMaxLim.toFixed(1) + 'V MAX';
            lblMin = '0V MIN';
        }

        const totalVolts = oscState.voltsPerDiv * GRID_DIVISIONS_Y;
        const centerV = oscState.yOffset * oscState.voltsPerDiv;
        const toY = (v) => h / 2 - ((v - centerV) / totalVolts) * h;

        ctx.font = '9px JetBrains Mono, monospace';

        [[vMaxLim, lblMax], [vMinLim, lblMin]].forEach(([vLim, label]) => {
            const y = toY(vLim);

            // Fill the out-of-range zone between the line and the screen edge
            if (y > 0 && vLim === vMaxLim && y < h) {
                ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
                ctx.fillRect(0, 0, w, y);
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(0, Math.round(y) + 0.5);
                ctx.lineTo(w, Math.round(y) + 0.5);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#ef4444';
                ctx.fillText(label, w - ctx.measureText(label).width - 6, y - 4);
            } else if (y >= 0 && vLim === vMinLim && y < h) {
                ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
                ctx.fillRect(0, y, w, h - y);
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(0, Math.round(y) + 0.5);
                ctx.lineTo(w, Math.round(y) + 0.5);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#ef4444';
                ctx.fillText(label, w - ctx.measureText(label).width - 6, y + 11);
            }
        });
    }

    function drawWaveform(samples, w, h, triggerRes, colorIdx) {
        if (!samples || samples.length < 2) return;

        const totalVolts = oscState.voltsPerDiv * GRID_DIVISIONS_Y;
        const centerV = oscState.yOffset * oscState.voltsPerDiv;

        // ETS only runs single-channel. Multi-channel and realtime use trigger-at-center.
        const isEts = isEtsMode();

        // Target trigger position: locked at index 0 for ETS, 50% center for non-ETS
        const targetTrigPx = isEts ? 0 : (w * 0.5);
        const trigSamplePos = isEts ? 0 : (samples.length * 0.5);

        // Determine if this is a decimated Min/Max frame (only in non-ETS mode when length is 1600)
        const isDecimated = !isEts && (samples.length === 1600);

        // Horizontal pixel scale.
        // In ETS the frame always spans the full real capture window (samples.length / rateHz),
        // so we fit the whole frame onto the screen width regardless of user's timePerDiv.
        // The time labels are drawn from actualEtsWindowSec (see drawLabels).
        const pxPerSample = isDecimated ? (w / (samples.length / 2)) : (w / samples.length);

        // Glow effect
        let strokeColor = '#22d3ee';
        if (colorIdx === 0) strokeColor = '#3b82f6';
        else if (colorIdx === 1) strokeColor = '#22c55e';
        else if (colorIdx === 2) strokeColor = '#ef4444';
        else if (colorIdx === 3) strokeColor = '#eab308';

        ctx.shadowColor = strokeColor;
        ctx.shadowBlur = 6;

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        let first = true;
        let prevY = 0;

        if (isDecimated) {
            // Draw Min/Max continuous envelope
            for (let i = 0; i < samples.length; i += 2) {
                const x = (i / 2) * pxPerSample;
                const minV = samples[i];
                const maxV = samples[i + 1];

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
            // Draw Raw sequential samples (ETS or raw realtime)
            for (let i = 0; i < samples.length; i++) {
                const x = targetTrigPx + (i - trigSamplePos) * pxPerSample;
                if (x < -50) continue;
                if (x > w + 50) break;

                const v = samples[i];
                const y = h / 2 - ((v - centerV) / totalVolts) * h;

                if (first) {
                    ctx.moveTo(x, y);
                    first = false;
                } else {
                    if (Math.abs(y - prevY) > (h * 0.05) && pxPerSample > 2.0) {
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

        // Time labels at bottom.
        // In ETS (single-channel) the screen fits the real capture window (samples / rate).
        // In realtime mode (single OR multi-channel), timePerDiv reflects the actual sample rate directly.
        const numCh = oscState.multiChannel ? Math.max(1, oscState.activeChannels.length) : 1;
        const perChRateKHz = oscState.sampleRateKHz;   // per-channel rate requested (multi-mode: ADC interleaves, each channel gets this rate)
        const isEts = isEtsMode();
        const truePerChRateKHz = isEts ? Math.min(perChRateKHz, 6000) : perChRateKHz;
        const frameSamples = (oscState.currentFrame && oscState.currentFrame.length > 0) ? oscState.currentFrame.length : 1600;
        const effTimePerDiv = isEts
            ? (frameSamples / (truePerChRateKHz * 1000)) / GRID_DIVISIONS_X   // reqRate kHz -> Hz
            : oscState.timePerDiv;

        ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
        const dx = w / GRID_DIVISIONS_X;
        for (let i = 0; i <= GRID_DIVISIONS_X; i++) {
            let t;
            if (isEts) {
                // Trigger is at left edge (index 0) in ETS mode
                t = i * effTimePerDiv;
            } else {
                t = (i - GRID_DIVISIONS_X / 2) * effTimePerDiv;
            }
            const label = formatTime(Math.abs(t));
            const prefix = (!isEts && t < 0) ? '-' : '';
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

        if (isEtsMode()) {
            ctx.fillStyle = '#8b5cf6';
            ctx.fillText('ETS', w - 60, 42);
        }

        if (oscState.aliasMode) {
            ctx.fillStyle = '#8b5cf6';
            const aHz = oscState.aliasFreqHz || 0;
            const aTxt = aHz > 0
                ? ('≈ ' + (aHz >= 1000000 ? (aHz / 1000000).toFixed(2) + ' MHz' : (aHz / 1000).toFixed(1) + ' kHz'))
                : (oscState.aliasPts === 1 ? 'weak (1 pt)' : 'no signal');
            ctx.fillText('ALIAS ' + aTxt + (oscState.aliasAmbiguous ? ' ?' : ''), w - 60, 70);
        }

        if (oscState.usMode) {
            ctx.fillStyle = '#8b5cf6';
            let uTxt;
            if (!oscState.usLocked) {
                uTxt = (oscState.usMode === 'auto' ? 'AUTO-HF' : 'US') + ' no lock';
            } else if (oscState.usMode === 'aliasman') {
                const f = oscState.usFcEstHz || 0;
                uTxt = 'ALIAS-M ' + (f > 0
                    ? (f >= 1000000 ? (f / 1000000).toFixed(2) + ' MHz' : (f / 1000).toFixed(1) + ' kHz')
                    : 'no signal') + ' z' + oscState.usZone + (oscState.usMirrored ? ' MIR' : '');
            } else {
                const f = oscState.usFcEstHz || oscState.usFcHz;
                const fTxt = f >= 1000000 ? (f / 1000000).toFixed(2) + ' MHz' : (f / 1000).toFixed(1) + ' kHz';
                const ifTxt = oscState.usTargetIFHz >= 1000 ? (oscState.usTargetIFHz / 1000).toFixed(0) + 'k' : oscState.usTargetIFHz.toFixed(0);
                uTxt = 'US ' + fTxt + ' z' + oscState.usZone + (oscState.usMirrored ? ' MIR' : '') + ' IF' + ifTxt;
            }
            ctx.fillText(uTxt + (oscState.usAmbiguous ? ' ?' : ''), w - 60, 70);
        }

        // Multi-rate scan progress (Auto Aliasing / Auto HF)
        if (oscState.aliasScanning || oscState.usScanning) {
            ctx.fillStyle = '#f59e0b';
            const n = oscState.aliasScanIdx || 0;
            const tot = oscState.aliasScanTot || 4;
            ctx.fillText('SCAN ' + n + '/' + tot, w - 60, 84);
        }

        // Bias state indicator (30V modes; static ON in Forced Bias, switching in Auto-Polarity)
        if (isOsc30VMode()) {
            ctx.fillStyle = oscState.biasEnabled ? '#22c55e' : '#64748b';
            ctx.fillText(oscState.biasEnabled ? 'BIAS ON' : 'BIAS OFF', w - 60, 56);
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
        drawLimitLines(w, h);

        const sampleRate = oscState.calculatedSampleRate || 913000;

        if (oscState.multiChannel) {
            let anyTriggered = false;
            let measSamples = new Float64Array(0);
            for (let c = 0; c < 4; c++) {
                if (!oscState.activeChannels.includes(c)) continue;
                let samples = (oscState.multiFrames && oscState.multiFrames[c]) ? oscState.multiFrames[c] : new Float64Array(0);
                if (samples.length > 0) {
                    measSamples = samples;
                    let triggerRes = { index: samples.length / 2, frac: 0 };
                    drawWaveform(samples, w, h, triggerRes, c);
                    anyTriggered = true;
                }
            }
            oscState.triggered = anyTriggered;
            if (oscState.triggerMode === 'single' && anyTriggered && !oscState.singleCaptured) {
                oscState.singleCaptured = true;
            } else if (!anyTriggered && oscState.triggerMode === 'normal') {
                oscState.animFrameId = requestAnimationFrame(renderFrame);
                return;
            }
            drawTriggerLine(w, h);
            drawLabels(w, h);
            drawStatusOverlay(w, h);

            if (measSamples.length > 10) {
                const isEts = isEtsMode();
                const rateKHz = isEts ? Math.min(oscState.sampleRateKHz, 6000) : oscState.sampleRateKHz;
                const sampleRate = rateKHz * 1000;
                const meas = computeMeasurements(measSamples, sampleRate);
                updateMeasurementsUI(meas);
            }
        } else {
            const displaySamples = usViewSamples(oscState.currentFrame || new Float64Array(0));

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

            drawWaveform(displaySamples, w, h, triggerRes, oscState.channel);
            drawTriggerLine(w, h);
            drawLabels(w, h);
            drawStatusOverlay(w, h);

            // Update measurements
            if (displaySamples.length > 10) {
                const isEts = isEtsMode();
                const rateKHz = isEts ? Math.min(oscState.sampleRateKHz, 6000) : oscState.sampleRateKHz;
                const sampleRate = rateKHz * 1000;
                const meas = computeMeasurements(displaySamples, sampleRate);
                updateMeasurementsUI(meas);
            }
        }

        oscState.animFrameId = requestAnimationFrame(renderFrame);
    }

    // ======================== Auto Aliasing (undersampling heterodyne) ========================
    // No extra hardware: the ADC sampler is the mixer, TIM2 rate Fs is the LO,
    // the measured alias fa = |f - round(f/Fs)*Fs| folded to [0, Fs/2] is the IF.
    // The host solves for the carrier f from aliases taken at several rates.
    // Limits: stable periodic input (sine best); solver grid 0..ALIAS_FMAX_HZ;
    // above ~12 MHz the F401 track-and-hold rolls off and aliases get unreliable.
    // ===== AutoAliasingSolverBegin =====
    const ALIAS_FMAX_HZ = 12000000; // ~12 MHz max identifiable carrier
    // Scan rates are deliberately NOT harmonically nested (their joint fold-over
    // period is far above Fmax): with nested rates like 500/1000/2000 every carrier
    // would be indistinguishable from f ± 2 MHz, making the solver useless.
    // Four rates make exact collisions (same aliases at ALL rates) vanishingly rare.
    // All ≤ 2800 kHz (12-bit realtime ceiling).
    const ALIAS_SCAN_RATES_KHZ = [600, 1300, 1900, 2700]; // 12-bit scan rates for the solver
    const ALIAS_GRID_STEP_HZ = 1000;
    // Raw capture size per scan point. req <= 800 keeps the firmware in the raw
    // path (no Min/Max decimation), whose midpoint envelope distorts fa.
    const ALIAS_SCAN_REQ_SAMPLES = 700;
    function aliasPredictHz(fHz, fsHz) {
        const k = Math.round(fHz / fsHz);
        const d = Math.abs(fHz - k * fsHz);
        return Math.min(d, fsHz - d);
    }
    // meas: [{fsHz, faHz}] with faHz in [0, fsHz/2].
    // Returns {fHz, ok, matches, err}. ok=false when fewer than all rates match
    // or a runner-up carrier explains the aliases almost as well (genuine
    // fold-over ambiguity — physics, not a bug; shown with a '?' badge).
    function aliasSolveEstimate(meas, fMaxHz) {
        const fMax = fMaxHz || ALIAS_FMAX_HZ;
        if (!meas || meas.length === 0) return { fHz: 0, ok: false, matches: 0, err: Infinity };
        const tols = meas.map(m => Math.max(1500, 0.04 * m.faHz));
        const score = (f) => {
            let matches = 0, err = 0;
            for (let i = 0; i < meas.length; i++) {
                const e = Math.abs(aliasPredictHz(f, meas[i].fsHz) - meas[i].faHz);
                if (e <= tols[i]) { matches++; err += e / tols[i]; }
                else { err += 1 + e / tols[i]; }
            }
            return { matches, err };
        };
        const better = (a, b) => {
            if (!b) return true;
            if (a.matches !== b.matches) return a.matches > b.matches;
            return a.err < b.err;
        };
        let best = null;
        for (let f = 0; f <= fMax; f += ALIAS_GRID_STEP_HZ) {
            const s = score(f);
            const cand = { fHz: f, matches: s.matches, err: s.err };
            if (better(cand, best)) best = cand;
        }
        // Refine around the winner (±1 grid step, 100 Hz)
        if (best) {
            for (let f = Math.max(0, best.fHz - ALIAS_GRID_STEP_HZ); f <= best.fHz + ALIAS_GRID_STEP_HZ; f += 100) {
                const s = score(f);
                if (s.matches > best.matches || (s.matches === best.matches && s.err < best.err)) {
                    best = { fHz: f, matches: s.matches, err: s.err };
                }
            }
        }
        // Runner-up must be a DISTINCT carrier, not a grid neighbour of the winner
        // (neighbours of the same peak trivially explain the aliases just as well).
        let second = null;
        if (best) {
            for (let f = 0; f <= fMax; f += ALIAS_GRID_STEP_HZ) {
                if (Math.abs(f - best.fHz) < 10000) continue;
                const s = score(f);
                const cand = { fHz: f, matches: s.matches, err: s.err };
                if (better(cand, second)) second = cand;
            }
        }
        const full = best && best.matches === meas.length;
        const margin = !second || second.matches < (best ? best.matches : 0) ||
            second.err > Math.max(0.5, (best ? best.err : Infinity) * 3);
        return {
            fHz: best ? best.fHz : 0,
            ok: !!(full && margin),
            matches: best ? best.matches : 0,
            err: best ? best.err : Infinity
        };
    }
    // ===== AutoAliasingSolverEnd =====

    // ===== UndersampleBegin =====
    // Bandpass (undersampling) placement: pick integer-kHz Fs ≤ maxFs so the
    // carrier lands at Fs/4 (max distance from DC and Nyquist). Zone
    // k = floor(fc/(Fs/2)); odd zones mirror the spectrum (time reversal).
    // Returns {fsKHz, fsHz, k, s, ifHz, zone, mirrored} or null.
    function undersamplePlan(fcHz, maxFsKHz) {
        if (!(fcHz > 0) || !(maxFsKHz > 0)) return null;
        const maxFs = maxFsKHz * 1000;
        for (let m = 1; m <= 300; m++) {
            const fsF = (4 * fcHz) / (2 * m - 1);
            if (fsF > maxFs) continue;
            let fs = Math.round(fsF / 1000);
            if (fs < 1) continue;
            if (fs * 1000 > maxFs) fs -= 1;
            if (fs < 1) continue;
            const fsHz = fs * 1000;
            const nyq = fsHz / 2;
            const k = Math.round(fcHz / fsHz);
            const d = fcHz - k * fsHz;
            const ifHz = Math.abs(d);
            if (ifHz < 0.08 * nyq || ifHz > 0.92 * nyq) continue; // keep clear of DC/Nyquist
            const zone = Math.floor(fcHz / nyq);
            return { fsKHz: fs, fsHz, k, s: d >= 0 ? 1 : -1, ifHz, zone, mirrored: (zone % 2) === 1 };
        }
        return null;
    }
    // ===== UndersampleEnd =====

    // ===== ManualAliasBegin =====
    // Manual aliasing: the user asserts the Nyquist zone z of a known band and
    // drives Fs by hand. Unfold: even zone z → f = z*Fs/2 + fa;
    // odd zone z → f = (z+1)*Fs/2 − fa (mirrored).
    // Returns {fHz, k, s, mirrored} with carrier = k*Fs + s*fa.
    function aliasUnfoldZone(zone, fsHz, faHz) {
        const z = Math.max(0, Math.floor(zone));
        if (!(fsHz > 0) || !(faHz >= 0)) return null;
        if (z % 2 === 0) return { fHz: (z * fsHz) / 2 + faHz, k: z / 2, s: 1, mirrored: false };
        return { fHz: ((z + 1) * fsHz) / 2 - faHz, k: (z + 1) / 2, s: -1, mirrored: true };
    }
    // ===== ManualAliasEnd =====

    function usMaxFsKHz() {
        return oscState.resolution === 12 ? 2800 : 3818;
    }

    // ====================== Single-channel acquisition modes ======================
    // ETS, Auto HF и все виды Aliasing/Undersampling снимают ровно один канал:
    // сканы Fs и локи имеют смысл только для одной площадки захвата.
    function isSingleChAcq(mode) {
        return mode === 'ets' || mode === 'autohf' || mode === 'alias' || mode === 'malias' || mode === 'usample';
    }

    // Канал, который остаётся активным при блокировке: текущий трек, если он
    // отмечен; иначе первая отмеченная площадка.
    function lockedChannelFrom(candidates) {
        let ch = oscState.channel;
        if (!(ch >= 0 && ch <= 3) || !candidates.includes(ch)) {
            ch = (candidates && candidates.length) ? candidates[0] : 0;
        }
        return Math.max(0, Math.min(3, ch | 0));
    }

    function lockedAcqChannel() {
        const checked = [];
        for (let i = 0; i < 4; i++) {
            const el = document.getElementById('cfgOscCh' + i);
            if (el && el.checked) checked.push(i);
        }
        if (!checked.length) {
            const act = oscState.activeChannels;
            if (act && act.length) checked.push(act[0]);
        }
        if (!checked.length) checked.push(0);
        return lockedChannelFrom(checked);
    }

    // Disable/grey out the locked-off channel pills + inline hint.
    function applyChannelBoxLock() {
        const single = isSingleChAcq(oscState.acqMode || 'realtime');
        for (let i = 0; i < 4; i++) {
            const el = document.getElementById('cfgOscCh' + i);
            if (!el) continue;
            if (single) {
                el.disabled = (i !== oscState.channel);
                if (el.disabled) el.title = 'Хватает CH' + (oscState.channel + 1) + ': ETS/Aliasing/Undersampling снимают один канал';
                else el.removeAttribute('title');
            } else {
                el.disabled = false;
                el.removeAttribute('title');
            }
        }
        const hint = document.getElementById('oscSingleChHint');
        if (hint) hint.style.display = single ? '' : 'none';
    }

    // Full policy: remember the multi selection once (recovered on switching to Real-time),
    // squeeze the state to one channel and lock the pills.
    function applySingleChannelLock() {
        if (!isSingleChAcq(oscState.acqMode || 'realtime')) {
            applyChannelBoxLock();
            return false;
        }
        if (!oscState.usSavedCh) oscState.usSavedCh = usSaveChannelState();
        usForceSingle(lockedAcqChannel());
        applyChannelBoxLock();
        return true;
    }

    function usSaveChannelState() {
        return {
            multi: oscState.multiChannel, act: [...oscState.activeChannels], ch: oscState.channel,
            boxes: [0, 1, 2, 3].map(i => {
                const el = document.getElementById('cfgOscCh' + i);
                return el ? !!el.checked : (i === 0);
            })
        };
    }

    // Undersampling needs a known per-channel Fs: force single-channel display.
    function usForceSingle(ch) {
        for (let i = 0; i < 4; i++) {
            const el = document.getElementById('cfgOscCh' + i);
            if (el) el.checked = (i === ch);
        }
        oscState.activeChannels = [ch];
        oscState.channel = ch;
        oscState.multiChannel = false;
        oscState.currentMultiIdx = 0;
        if (oscState.multiFrames) for (let i = 0; i < 4; i++) if (i !== ch) oscState.multiFrames[i] = null;
        oscState.framesCollectedInSession = 0;
        const w = document.getElementById('oscDesyncWarning');
        if (w) w.style.display = 'none';
    }

    function usRestoreChannels() {
        const saved = oscState.usSavedCh;
        oscState.usSavedCh = null;
        if (!saved) return;
        for (let i = 0; i < 4; i++) {
            const el = document.getElementById('cfgOscCh' + i);
            if (el) el.checked = !!saved.boxes[i];
        }
        oscState.activeChannels = [...saved.act];
        oscState.multiChannel = saved.multi;
        oscState.channel = saved.ch;
        oscState.currentMultiIdx = 0;
        oscState.framesCollectedInSession = 0;
    }

    function usClearState() {
        oscState.aliasMode = false;
        oscState.aliasFreqHz = 0;
        oscState.aliasAmbiguous = false;
        oscState.aliasScanning = false;
        oscState.aliasScanIdx = 0;
        oscState.aliasScanTot = 0;
        oscState.aliasPts = 0;
        oscState.usMode = null;
        oscState.usLocked = false;
        oscState.usScanning = false;
        oscState.usFcHz = 0;
        oscState.usFcEstHz = 0;
        oscState.usAmbiguous = false;
        oscState.usFsKHz = 0; oscState.usFsHz = 0;
        oscState.usK = 0; oscState.usS = 1;
        oscState.usZone = 0; oscState.usMirrored = false;
        oscState.usTargetIFHz = 0;
        oscState.usLastRecenter = 0;
    }

    function usSyncFcVisibility() {
        const sel = document.getElementById('cfgOscMode');
        const mode = sel ? sel.value : '';
        const f = document.getElementById('cfgUndersampleFcField');
        if (f) f.style.display = (mode === 'usample') ? '' : 'none';
        const zf = document.getElementById('cfgAliasZoneField');
        if (zf) zf.style.display = (mode === 'malias') ? '' : 'none';
    }

    function usReadZone() {
        const el = document.getElementById('cfgAliasZone');
        const z = el ? parseInt(el.value) : NaN;
        if (isNaN(z) || z < 0) return 0;
        if (z > 128) return 128;
        return Math.floor(z);
    }

    // (Re)lock the manual-alias branch from the zone input + current rate.
    // Returns false when not running (nothing to do).
    function usRelockManual() {
        if (!oscState.running) return false;
        const zone = usReadZone();
        const fsKHz = oscState.sampleRateKHz;
        if (!(fsKHz >= 1)) return false;
        const fsHz = fsKHz * 1000;
        const un = aliasUnfoldZone(zone, fsHz, 0);
        if (!un) return false;
        oscState.usLocked = true;
        oscState.usAmbiguous = false;
        oscState.usFsKHz = fsKHz;
        oscState.usFsHz = fsHz;
        oscState.usK = un.k;
        oscState.usS = un.s;
        oscState.usZone = zone;
        oscState.usMirrored = un.mirrored;
        oscState.usTargetIFHz = fsHz / 4;
        oscState.usFcEstHz = un.fHz;
        oscState.usLastRecenter = performance.now();
        return true;
    }

    // Manual Aliasing: user drives Fs (rate select) and asserts the zone.
    // No scan — lock immediately and stream.
    function runManualAliasFlow() {
        usRestoreChannels();
        usClearState();
        oscState.usMode = 'aliasman';
        const ch = oscState.multiChannel ? oscState.activeChannels[0] : oscState.channel;
        oscState.usSavedCh = usSaveChannelState();
        usForceSingle(ch);
        // No trigger forcing needed: there is no scan, the lock only replays Fs.
        usRelockManual();
        oscState.usFcHz = oscState.usFcEstHz;
        if (!oscState.running) return;
        restartOsc();
    }

    // Odd-zone folding mirrors the spectrum: show the time-reversed copy so the
    // shape matches the true IF waveform (matters for non-sine periodic signals).
    function usViewSamples(fr) {
        if (!oscState.usMode || !oscState.usLocked || !oscState.usMirrored || !fr || fr.length < 2) return fr;
        const out = new Float64Array(fr.length);
        for (let i = 0; i < fr.length; i++) out[i] = fr[fr.length - 1 - i];
        return out;
    }

    // Multi-rate alias capture. Requires: running, single-channel, 12-bit, auto
    // trigger already configured by the caller. Returns [{fsHz, faHz}].
    // Capture conditions are forced here (not caller duties): oversample 0 and a
    // small window so every point is a RAW frame; the first frame after each
    // restart is discarded (its pre-trigger part may still hold old-rate samples
    // from the DMA ring). User's oversample/time/div are restored afterwards.
    async function aliasScanCapture() {
        const meas = [];
        const savedOver = oscState.oversample;
        const savedTpd = oscState.timePerDiv;
        oscState.oversample = 0; // averaging low-passes out the high-fa aliases
        oscState.aliasScanTot = ALIAS_SCAN_RATES_KHZ.length;
        try {
            for (let i = 0; i < ALIAS_SCAN_RATES_KHZ.length; i++) {
                const r = ALIAS_SCAN_RATES_KHZ[i];
                if (!oscState.running) break;
                oscState.aliasScanIdx = i + 1;
                oscState.timePerDiv = ALIAS_SCAN_REQ_SAMPLES / (GRID_DIVISIONS_X * r * 1000); // req = 700
                oscState.sampleRateKHz = r;
                restartOsc();
                await aliasWaitFrame(3000); // discard frame 1
                const got = await aliasWaitFrame(3000);
                const fr = got ? oscState.currentFrame : null;
                if (!fr || fr.length < 10) continue;
                const m = computeMeasurements(fr, r * 1000);
                if (!m || m.decimated || m.vPP < 0.05 || m.freq <= 0) continue;
                meas.push({ fsHz: r * 1000, faHz: m.freq });
            }
        } finally {
            oscState.oversample = savedOver;
            oscState.timePerDiv = savedTpd;
            oscState.aliasScanIdx = 0;
            oscState.aliasScanTot = 0;
        }
        return meas;
    }

    function usEnterNoLock() {
        if (!oscState.running) return;
        oscState.usLocked = false;
        oscState.usFcEstHz = 0;
        oscState.sampleRateKHz = 1000;
        restartOsc();
    }

    function usApplyLock(fcHz, ambiguous) {
        const plan = undersamplePlan(fcHz, usMaxFsKHz());
        if (!plan || !oscState.running) return false;
        oscState.usLocked = true;
        oscState.usFcHz = fcHz;
        oscState.usFcEstHz = fcHz;
        oscState.usAmbiguous = !!ambiguous;
        oscState.usFsKHz = plan.fsKHz;
        oscState.usFsHz = plan.fsHz;
        oscState.usK = plan.k;
        oscState.usS = plan.s;
        oscState.usZone = plan.zone;
        oscState.usMirrored = plan.mirrored;
        oscState.usTargetIFHz = plan.ifHz;
        oscState.usLastRecenter = performance.now();
        oscState.sampleRateKHz = plan.fsKHz;
        restartOsc();
        return true;
    }

    // Standalone Undersample (manualFcMHz>0) or Auto HF (manualFcMHz=null → alias scan first).
    async function runUndersampleFlow(manualFcMHz) {
        usRestoreChannels();
        usClearState();
        oscState.usMode = manualFcMHz ? 'manual' : 'auto';
        oscState.usScanning = true;
        const ch = oscState.multiChannel ? oscState.activeChannels[0] : oscState.channel;
        oscState.usSavedCh = usSaveChannelState();
        oscState.usSavedTrig = oscState.triggerMode;
        oscState.usSavedRes = oscState.resolution;
        oscState.usSavedAdc = oscState.adcRes;
        usForceSingle(ch);
        oscState.triggerMode = 'auto';
        try {
            let fcHz = manualFcMHz ? manualFcMHz * 1000000 : 0;
            let ambiguous = false;
            if (!fcHz) {
                // Auto: find the carrier with the alias scan (forced 12-bit)
                oscState.resolution = 12;
                oscState.adcRes = 4095;
                const meas = await aliasScanCapture();
                oscState.resolution = oscState.usSavedRes;
                oscState.adcRes = oscState.usSavedAdc;
                if (!oscState.running) return;
                if (meas.length >= 2) {
                    const sol = aliasSolveEstimate(meas, ALIAS_FMAX_HZ);
                    fcHz = sol.fHz || 0;
                    ambiguous = !sol.ok;
                }
                if (!fcHz) { usEnterNoLock(); return; }
            }
            oscState.triggerMode = oscState.usSavedTrig;
            if (!oscState.running) return;
            if (!usApplyLock(fcHz, ambiguous)) usEnterNoLock();
        } finally {
            oscState.triggerMode = oscState.usSavedTrig;
            if (oscState.usSavedRes !== null && !oscState.usLocked) {
                oscState.resolution = oscState.usSavedRes;
                oscState.adcRes = oscState.usSavedAdc;
            }
            oscState.usScanning = false;
        }
    }

    async function aliasWaitFrame(timeoutMs) {
        const s0 = oscState.frameSeq || 0;
        const t0 = performance.now();
        while ((oscState.frameSeq || 0) === s0 && performance.now() - t0 < timeoutMs) {
            await sleepMs(25);
            if (!oscState.running || (!oscState.aliasScanning && !oscState.usScanning)) return false;
        }
        return (oscState.frameSeq || 0) !== s0;
    }

    // Multi-rate scan on the current channel (forced single-channel 12-bit),
    // then a continuous 1 MHz display stream showing the heterodyned waveform
    // with the solved carrier in the overlay / Freq field.
    async function runAliasFlow() {
        usRestoreChannels();
        usClearState();
        oscState.aliasScanning = true;
        const ch = oscState.multiChannel ? oscState.activeChannels[0] : oscState.channel;
        const saved = {
            multi: oscState.multiChannel, act: [...oscState.activeChannels], ch: oscState.channel,
            rate: oscState.sampleRateKHz, res: oscState.resolution, adc: oscState.adcRes,
            trig: oscState.triggerMode
        };
        const meas = [];
        try {
            oscState.multiChannel = false;
            oscState.channel = ch;
            oscState.activeChannels = [ch];
            oscState.resolution = 12;
            oscState.adcRes = 4095;
            oscState.triggerMode = 'auto';
            const got = await aliasScanCapture();
            for (const m of got) meas.push(m);
        } finally {
            // Mode owns single-ness: never resurrect the multi selection inside it
            oscState.multiChannel = false;
            oscState.activeChannels = [ch];
            oscState.channel = ch;
            oscState.resolution = saved.res;
            oscState.adcRes = saved.adc;
            oscState.triggerMode = saved.trig;
        }
        oscState.aliasScanning = false;
        applyChannelBoxLock();
        if (!oscState.running) return;
        oscState.aliasMode = true;
        oscState.aliasPts = meas.length;
        if (meas.length < 2) {
            oscState.aliasFreqHz = 0; // no usable signal at any scan rate
            oscState.aliasAmbiguous = true;
        } else {
            const sol = aliasSolveEstimate(meas, ALIAS_FMAX_HZ);
            oscState.aliasFreqHz = sol.fHz || 0;
            oscState.aliasAmbiguous = !sol.ok;
        }
        // Display stream: 1 MHz realtime with the user's (restored) channel config
        oscState.sampleRateKHz = 1000;
        restartOsc();
    }

    // ======================== Measurements UI ========================
    let smoothFreq = 0;
    let smoothDuty = 0;

    function updateMeasurementsUI(m) {
        if (!m) return;

        // Auto Aliasing: show the solved carrier instead of the IF (alias) frequency
        if (oscState.aliasMode && oscState.aliasFreqHz > 0) {
            m = Object.assign({}, m, { freq: oscState.aliasFreqHz, duty: 0 });
        }

        // Undersampling: unfold the measured IF back to the carrier.
        // carrier ≈ usK*usFs + usS*IF (branch stored at lock time).
        // Duty is preserved under folding, so it is shown as measured.
        // Min/Max-decimated frames measure the IF from the midpoint envelope —
        // unreliable there: keep the last trusted carrier and skip recentering.
        if (oscState.usMode && oscState.usLocked) {
            if (m.freq > 0 && !m.decimated) {
                const ifMeas = m.freq;
                const fsHz = oscState.usFsHz;
                const carrier = oscState.usK * fsHz + oscState.usS * ifMeas;
                oscState.usFcEstHz = carrier;
                m = Object.assign({}, m, { freq: carrier });
                // Drift tracking: if the IF hugs DC or Nyquist, recenter Fs (throttled).
                // Manual aliasing excluded: the user owns Fs there, readout just follows.
                const nyq = fsHz / 2, edge = 0.05 * nyq;
                const now = performance.now();
                if (oscState.usMode !== 'aliasman' && (ifMeas < edge || ifMeas > nyq - edge) && now - (oscState.usLastRecenter || 0) > 3000 &&
                    oscState.running && !oscState.usScanning && !oscState.aliasScanning) {
                    oscState.usLastRecenter = now;
                    const plan = undersamplePlan(carrier, usMaxFsKHz());
                    if (plan && plan.fsKHz !== oscState.sampleRateKHz) {
                        oscState.usFsKHz = plan.fsKHz;
                        oscState.usFsHz = plan.fsHz;
                        oscState.usK = plan.k;
                        oscState.usS = plan.s;
                        oscState.usZone = plan.zone;
                        oscState.usMirrored = plan.mirrored;
                        oscState.usTargetIFHz = plan.ifHz;
                        oscState.sampleRateKHz = plan.fsKHz;
                        restartOsc();
                    }
                }
            } else if (m.decimated) {
                m = Object.assign({}, m, { freq: oscState.usFcEstHz || 0 });
            }
        }

        // Reset smoothing if frequency jumps significantly or drops to 0
        if (m.freq === 0 || smoothFreq === 0 || Math.abs(m.freq - smoothFreq) > smoothFreq * 0.5) {
            smoothFreq = m.freq;
        } else {
            smoothFreq = smoothFreq * 0.8 + m.freq * 0.2;
        }

        if (m.duty === 0 || smoothDuty === 0 || Math.abs(m.duty - smoothDuty) > 20) {
            smoothDuty = m.duty;
        } else {
            smoothDuty = smoothDuty * 0.8 + m.duty * 0.2;
        }

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.innerText = val;
        };
        set('oscVmax', formatVoltage(m.vMax));
        set('oscVmin', formatVoltage(m.vMin));
        set('oscVpp', formatVoltage(m.vPP));
        set('oscFreq', smoothFreq > 0 ? (smoothFreq >= 1000 ? (smoothFreq / 1000).toFixed(2) + ' kHz' : smoothFreq.toFixed(1) + ' Hz') : '-- Hz');
        set('oscDuty', smoothDuty > 0 ? smoothDuty.toFixed(1) + ' %' : '-- %');
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

            // Valid packets: 0x10 (Volt), 0x12 (Osc), 0x20 (Vref), 0x40 (Logic), 0x50 (Comp)
            if (pktType !== 0x10 && pktType !== 0x12 && pktType !== 0x20 && pktType !== 0x40 && pktType !== 0x50) {
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

                if (pktType === 0x20) { // PKT_VREF_DATA (Sync Token)
                    oscState.syncPending = false;
                } else if (pktType === 0x12) { // PKT_OSCILLOSCOPE_DATA
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
        // Frame layout: [sessionId][chMask][data...]
        // chMask = 0 for single-channel/ETS (data = one channel); else bitmask of channels.
        if (payload.length <= 2) return;
        if (!oscState.running) return;

        if (oscState.syncPending) return; // Drop stale frames while waiting for sync

        let frameSessionId = payload[0];
        if (frameSessionId !== oscState.sessionId) return; // Drop stale frames

        const chMask = payload[1];
        const dataPayload = payload.slice(2);

        // Don't push new data if single-captured
        if (oscState.triggerMode === 'single' && oscState.singleCaptured) return;

        // Auto-polarity: switch bias between frames (like the voltmeter)
        maybeAutoBias(dataPayload, (oscState.resolution === 12) ? 2 : 1);

        const bytesPerSample = (oscState.resolution === 12) ? 2 : 1;

        const convertChannel = (bytes, ch) => {
            const n = Math.floor(bytes.length / bytesPerSample);
            const f = new Float64Array(n);
            const cap = oscRateCapture;
            const captureRaw = cap && cap.active && cap.ch === ch;
            if (bytesPerSample === 2) {
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                for (let i = 0; i < n; i++) {
                    const raw = view.getUint16(i * 2, true);
                    if (captureRaw) { cap.sum += raw; cap.count++; }
                    f[i] = rawToVolts(raw, ch);
                }
            } else {
                for (let i = 0; i < n; i++) {
                    const raw = bytes[i];
                    if (captureRaw) { cap.sum += raw; cap.count++; }
                    f[i] = rawToVolts(raw, ch);
                }
            }
            return f;
        };

        if (chMask !== 0 && oscState.multiChannel) {
            // Multi-channel synchronized frame: channels laid out sequentially
            const chs = [];
            for (let i = 0; i < 4; i++) if (chMask & (1 << i)) chs.push(i);
            if (chs.length === 0) return;
            const perChBytes = Math.floor(dataPayload.length / chs.length / bytesPerSample) * bytesPerSample;
            if (!oscState.multiFrames) oscState.multiFrames = [null, null, null, null];
            for (let k = 0; k < chs.length; k++) {
                const slice = dataPayload.slice(k * perChBytes, (k + 1) * perChBytes);
                oscState.multiFrames[chs[k]] = convertChannel(slice, chs[k]);
            }
            oscState.framesCollectedInSession = chs.length;
            if (oscState.triggerMode === 'single') {
                oscState.singleCaptured = true;
            }
            // No restartOsc — firmware continuously streams frames at rateKHz per channel
        } else {
            // Single channel (or legacy) frame
            const frame = convertChannel(dataPayload, oscState.channel);
            oscState.currentFrame = frame;
        }

        oscState.frameSeq = (oscState.frameSeq || 0) + 1;

        // Update actual rate based on frames received (optional, mostly for debugging)
        oscState.actualRateSamples += 1; // 1 frame
        let now = performance.now();
        if (now - oscState.actualRateTimestamp >= 1000) {
            let fps = (oscState.actualRateSamples * 1000) / (now - oscState.actualRateTimestamp);
            oscState.calculatedSampleRate = fps;
            let el = document.getElementById('cfgOscActualRate');
            if (el) el.innerText = fps.toFixed(1) + " Frames/s";

            oscState.actualRateSamples = 0;
            oscState.actualRateTimestamp = now;
        }
    }

    // ======================== Auto-Polarity (Bias) ========================
    // Like the voltmeter: with bias OFF, a negative input clamps the ADC at 0 raw
    // (maxRaw <= 2) -> turn bias ON. With bias ON, a floating or positive input sits
    // at/above mid-rail (avgRaw >= 2000) -> turn bias OFF. Requires several
    // consecutive frames to vote and a cooldown, and only switches between frames.
    function maybeAutoBias(dataPayload, bytesPerSample) {
        if (!oscState.autoPolarity) return;
        if (!isOsc30VMode()) return;
        if (window.Calibration && window.Calibration._calibrationBusy) return;
        const now = performance.now();
        if (now - oscState.autoBiasLastSwitch < 1000) return;

        let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
        if (bytesPerSample === 2) {
            const view = new DataView(dataPayload.buffer, dataPayload.byteOffset, dataPayload.byteLength);
            for (let i = 0; i + 1 < dataPayload.length; i += 2) {
                const v = view.getUint16(i, true);
                if (v < mn) mn = v;
                if (v > mx) mx = v;
                sum += v;
                n++;
            }
        } else {
            for (let i = 0; i < dataPayload.length; i++) {
                const v = dataPayload[i];
                if (v < mn) mn = v;
                if (v > mx) mx = v;
                sum += v;
                n++;
            }
        }
        if (n === 0) return;
        const avg = sum / n;

        let want = null;
        if (!oscState.biasEnabled && mx <= 2) {
            want = true;   // clamped at GND -> negative input, need bias
        } else if (oscState.biasEnabled && avg >= 2000) {
            want = false;  // at/above mid-rail -> floating or positive
        }

        if (want === null || want === oscState.biasEnabled) {
            oscState.autoBiasVotes = 0;
            return;
        }

        oscState.autoBiasVotes++;
        if (oscState.autoBiasVotes >= 4) {
            oscState.autoBiasVotes = 0;
            oscState.autoBiasLastSwitch = now;
            oscState.biasEnabled = want;
            oscState.divider = want ? 21.0 : 11.0;
            restartOsc(); // bias flag + trigger level are sent in the start payload
        }
    }

    // ======================== UI Controls ========================
    document.addEventListener('DOMContentLoaded', () => {
        initCanvas();

        // --- Start / Stop ---
        const btnOscStartStop = document.getElementById('btnOscStartStop');
        if (btnOscStartStop) {
            btnOscStartStop.addEventListener('click', async () => {
                if (!microTester.device) {
                    const ok = await microTester.connect();
                    if (!ok || !microTester.device) return alert("Connect USB first!");
                }
                if (window.Calibration && window.Calibration._calibrationBusy) return alert("Calibration is currently in progress. Please wait until finished.");

                if (oscState.running) {
                    stopOsc();
                } else {
                    startOsc();
                }
            });
        }

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
        const updateChannels = () => {
            let chs = [];
            for (let i = 0; i < 4; i++) {
                if (document.getElementById('cfgOscCh' + i)?.checked) {
                    chs.push(i);
                }
            }
            if (chs.length === 0) {
                let cb = document.getElementById('cfgOscCh0');
                if (cb) cb.checked = true;
                chs.push(0);
            }
            oscState.activeChannels = chs;
            const wasMulti = oscState.multiChannel;
            oscState.multiChannel = chs.length > 1;
            oscState.currentMultiIdx = 0;
            if (oscState.multiChannel && isSingleChAcq(oscState.acqMode)) {
                // ETS/Aliasing/Undersampling own single-channel capture: squeeze back
                // to one platform instead of dropping the mode
                usForceSingle(lockedChannelFrom(chs));
                oscState.activeChannels = [oscState.channel];
                oscState.multiChannel = false;
                oscState.currentMultiIdx = 0;
                chs = [oscState.channel];
                applyChannelBoxLock();
            }
            if (!oscState.multiChannel) {
                oscState.channel = chs[0];
            }
            for (let i = 0; i < 4; i++) {
                if (!chs.includes(i) && oscState.multiFrames) {
                    oscState.multiFrames[i] = null;
                }
            }
            oscState.framesCollectedInSession = 0;

            // Sync warning is obsolete: channels are hardware-synchronized (interleaved scan)
            const warningEl = document.getElementById('oscDesyncWarning');
            if (warningEl) {
                warningEl.style.display = 'none';
            }
            // ETS is disabled in multi-channel; re-evaluate allowed rates
            // (guard: updateSampleRateOptions may not be initialized yet on first call)
            if (wasMulti !== oscState.multiChannel) {
                try { updateSampleRateOptions(); } catch (e) { /* TDZ on first boot, ignore */ }
            }

            if (oscState.running) restartOsc();
        };

        for (let i = 0; i < 4; i++) {
            const el = document.getElementById('cfgOscCh' + i);
            if (el) el.addEventListener('change', updateChannels);
        }
        updateChannels();

        // --- Voltage Range ---
        const cfgOscVoltRange = document.getElementById('cfgOscVoltRange');
        function applyVoltageRangeOsc() {
            if (!cfgOscVoltRange) return;
            const sel = cfgOscVoltRange.options[cfgOscVoltRange.selectedIndex];
            const gainRatio = parseFloat(sel.getAttribute('data-divider')) || 1.0;
            const biasEnabled = sel.getAttribute('data-bias') === 'true';
            const autoPolarity = sel.getAttribute('data-autopolarity') === 'true';

            oscState.divider = gainRatio;
            oscState.biasEnabled = biasEnabled;
            oscState.autoPolarity = autoPolarity;
            oscState.autoBiasVotes = 0;
            oscState.autoBiasLastSwitch = performance.now(); // cooldown after manual change
        }

        if (cfgOscVoltRange) {
            cfgOscVoltRange.addEventListener('change', () => {
                applyVoltageRangeOsc();
                if (oscState.running) restartOsc();
            });
            applyVoltageRangeOsc();
        }

        // --- Sample Rate & Resolution ---
        const cfgOscSampleRate = document.getElementById('cfgOscSampleRate');
        const cfgOscResolution = document.getElementById('cfgOscResolution');

        function updateSampleRateOptions() {
            if (!cfgOscSampleRate) return;
            const mode = oscState.acqMode || 'realtime';
            const is12bit = oscState.resolution === 12;
            const isMulti = oscState.multiChannel;

            const options = cfgOscSampleRate.options;
            for (let i = 0; i < options.length; i++) {
                const rateVal = parseInt(options[i].value);
                let hide = false;
                if (mode === 'ets') {
                    hide = rateVal < 5000;   // ETS mode: only 5/10/20 MHz steps
                } else {
                    hide = rateVal >= 5000;  // other modes: no ETS steps
                }
                if (is12bit && rateVal > 2800 && rateVal < 5000) hide = true; // 12-bit realtime ceiling
                if (isMulti && rateVal >= 5000) hide = true;         // ETS not available in multi-channel (hardware scan is used)
                if (hide) {
                    options[i].style.display = 'none';
                    options[i].disabled = true;
                } else {
                    options[i].style.display = '';
                    options[i].disabled = false;
                }
            }
            const isHidden = (v) => {
                for (let i = 0; i < options.length; i++) {
                    if (parseInt(options[i].value) === v) return options[i].disabled;
                }
                return true;
            };

            let cappedVal = parseInt(cfgOscSampleRate.value);
            if (isNaN(cappedVal) || isHidden(cappedVal)) cappedVal = (mode === 'ets') ? 5000 : 100;
            if (mode !== 'ets') {
                if (is12bit && cappedVal > 2800) cappedVal = 2800;
                if (cappedVal >= 5000) cappedVal = 100;
            }
            cfgOscSampleRate.value = String(cappedVal);
            oscState.sampleRateKHz = cappedVal;
            // Scan/lock modes manage Fs internally: rate select is display-only there.
            // Manual aliasing is the exception: the user drives Fs by hand.
            cfgOscSampleRate.disabled = (mode !== 'realtime' && mode !== 'ets' && mode !== 'malias');
        }

        if (cfgOscSampleRate) {
            cfgOscSampleRate.addEventListener('change', () => {
                oscState.sampleRateKHz = parseInt(cfgOscSampleRate.value) || 100;
                if (oscState.acqMode === 'malias' && oscState.usMode === 'aliasman') {
                    usRelockManual(); // user drives Fs: re-derive the fold branch, no rescan
                }
                if (oscState.running) restartOsc();
            });
            usSyncFcVisibility();
        }

        if (cfgOscResolution) {
            cfgOscResolution.addEventListener('change', () => {
                oscState.resolution = parseInt(cfgOscResolution.value) || 8;
                oscState.adcRes = oscState.resolution === 12 ? 4095 : 255;
                if (oscState.acqMode === 'ets' && oscState.resolution !== 8) {
                    // ETS is 8-bit only in firmware: fall back to Real-time
                    oscState.acqMode = 'realtime';
                    const modeSel = document.getElementById('cfgOscMode');
                    if (modeSel) modeSel.value = 'realtime';
                }
                updateSampleRateOptions();
                if (oscState.running) restartOsc();
            });
            // Initial setup
            oscState.resolution = parseInt(cfgOscResolution.value) || 8;
            oscState.adcRes = oscState.resolution === 12 ? 4095 : 255;
            updateSampleRateOptions();
        }

        // --- Acquisition Mode: Real-time | ETS | Auto HF | Aliasing | Undersample ---
        const cfgOscMode = document.getElementById('cfgOscMode');
        function applyOscMode() {
            const mode = cfgOscMode ? cfgOscMode.value : 'realtime';
            usRestoreChannels();
            usClearState();
            oscState.acqMode = mode;
            if (mode === 'ets' && oscState.resolution !== 8) {
                // ETS is 8-bit only in firmware: switch resolution with the mode
                oscState.resolution = 8;
                oscState.adcRes = 255;
                const resSel = document.getElementById('cfgOscResolution');
                if (resSel) resSel.value = '8';
            }
            // ETS/Aliasing/Undersampling are single-channel: lock pills after restore
            applySingleChannelLock();
            updateSampleRateOptions();
            usSyncFcVisibility();
            if (oscState.running) startOsc();
        }
        if (cfgOscMode) {
            cfgOscMode.addEventListener('change', applyOscMode);
            oscState.acqMode = cfgOscMode.value || 'realtime';
            usSyncFcVisibility();
            applySingleChannelLock(); // boot: honour the pre-selected mode
        }

        // --- Manual aliasing zone input: clamp + re-derive lock live ---
        const cfgAliasZone = document.getElementById('cfgAliasZone');
        if (cfgAliasZone) {
            cfgAliasZone.addEventListener('change', () => {
                cfgAliasZone.value = String(usReadZone());
                if (oscState.acqMode === 'malias' && oscState.usMode === 'aliasman') {
                    usRelockManual();
                    if (oscState.running) restartOsc();
                }
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
            if (!window.Calibration) return;
            // Show the per-mode correction (what actually affects the display);
            // fall back to the global bias/zero offset if the mode isn't calibrated.
            let offset = getRateZeroCorr(oscState.channel);
            if (offset === 0) {
                offset = oscState.biasEnabled
                    ? (window.Calibration.biasOffsets[oscState.channel] || 0.0)
                    : (window.Calibration.zeroOffsets[oscState.channel] || 0.0);
            }
            const hasOffset = Math.abs(offset) > 0.0001;
            const txt = (offset >= 0 ? '+' : '') + offset.toFixed(3) + ' V';

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

        let oscZeroCalibBusy = false;
        const doCalibOscZero = async () => {
            if (!window.Calibration || oscZeroCalibBusy) return;
            const ch = oscState.channel;
            const btns = [btnOscZeroCalib, btnOscCalibTab].filter(Boolean);
            const origLabels = btns.map(b => b.innerHTML);
            const setBtns = (t, dis) => btns.forEach((b, i) => { if (t !== null) b.innerHTML = t; b.disabled = dis; });

            oscZeroCalibBusy = true;
            setBtns('0%', true);
            const wasRunning = oscState.running;
            try {
                if (!wasRunning) startOsc();

                // Oversample the zero: average the (Vmax+Vmin)/2 midpoint of many
                // frames so the trace is re-centered exactly on 0 V.
                const FRAMES = 24;
                const grabFrame = () => oscState.multiChannel
                    ? (oscState.multiFrames && oscState.multiFrames[ch])
                    : oscState.currentFrame;
                let lastSeq = oscState.frameSeq || 0;
                let acc = 0, used = 0;
                for (let f = 0; f < FRAMES; f++) {
                    const t0 = performance.now();
                    while ((oscState.frameSeq || 0) === lastSeq && performance.now() - t0 < 600) {
                        await sleepMs(10);
                    }
                    if ((oscState.frameSeq || 0) === lastSeq) break; // stream stalled
                    lastSeq = oscState.frameSeq;
                    const fr = grabFrame();
                    if (!fr || fr.length === 0) continue;
                    let mn = Infinity, mx = -Infinity;
                    for (let i = 0; i < fr.length; i++) {
                        if (fr[i] < mn) mn = fr[i];
                        if (fr[i] > mx) mx = fr[i];
                    }
                    acc += (mn + mx) / 2;
                    used++;
                    setBtns(Math.round((used / FRAMES) * 100) + '%', true);
                }
                if (!wasRunning) stopOsc();

                if (used === 0) {
                    alert("No frames captured — connect the probe and make sure the trigger mode allows capture (Auto).");
                    return;
                }
                const avg = acc / used;

                // Store the correction (how much to raise the reading) for the
                // current mode — resolution x sample rate x bias x channel.
                const corr = -avg;
                const map = loadRateZeroMap();
                const resKey = String(oscState.resolution);
                const rateKey = rateZeroRateKey(oscState.sampleRateKHz, oscState.biasEnabled);
                if (!map[resKey]) map[resKey] = {};
                if (!map[resKey][rateKey]) map[resKey][rateKey] = [null, null, null, null];
                map[resKey][rateKey][ch] = corr;
                saveRateZeroMap(map);
            } finally {
                oscZeroCalibBusy = false;
                btns.forEach((b, i) => { b.innerHTML = origLabels[i]; b.disabled = false; });
                updateOscZeroBadge();
            }
        };

        const doResetOscZero = (e) => {
            if (e) { e.preventDefault(); e.stopPropagation(); }
            if (!window.Calibration) return;
            window.Calibration.resetZero(oscState.biasEnabled, oscState.channel);
            // Also clear the per-mode correction for the current mode
            const map = loadRateZeroMap();
            const resMap = map[String(oscState.resolution)];
            const rateKey = rateZeroRateKey(oscState.sampleRateKHz, oscState.biasEnabled);
            if (resMap && Array.isArray(resMap[rateKey])) {
                resMap[rateKey][oscState.channel] = null;
                saveRateZeroMap(map);
            }
            updateOscZeroBadge();
        };

        if (btnOscZeroCalib) btnOscZeroCalib.addEventListener('click', doCalibOscZero);
        if (btnOscCalibTab) btnOscCalibTab.addEventListener('click', doCalibOscZero);
        if (btnOscResetZero) btnOscResetZero.addEventListener('click', doResetOscZero);
        if (btnOscResetTab) btnOscResetTab.addEventListener('click', doResetOscZero);

        setInterval(updateOscZeroBadge, 1000);
        updateOscZeroBadge();

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

        // --- Per-Rate Zero Calibration (Manual, Calibration panel) ---
        window.OscilloscopeCalibration = { runRateZeroCalibration, loadRateZeroMap };

        const btnOscRateZero = document.getElementById('btnOscRateZeroCalib');
        const btnOscRateZeroReset = document.getElementById('btnOscRateZeroReset');
        const rateZeroChSel = document.getElementById('oscRateZeroCh');
        const rateZeroStatus = document.getElementById('oscRateZeroStatus');
        const rateZeroInfo = document.getElementById('oscRateZeroInfo');

        const updateRateZeroInfo = () => {
            if (!rateZeroInfo || !rateZeroChSel) return;
            const ch = parseInt(rateZeroChSel.value, 10);
            const { calibrated, total } = getRateZeroModeCount(ch);
            if (calibrated === 0) {
                rateZeroInfo.innerHTML = `No rate-zero data for CH${ch + 1} (${oscState.biasEnabled ? 'BIAS' : 'NO-BIAS'}) yet`;
                return;
            }
            // Show only the current mode's correction, not the whole table
            const corr = getRateZeroCorr(ch);
            rateZeroInfo.innerHTML =
                `Calibrated modes: ${calibrated}/${total} for CH${ch + 1} (${oscState.biasEnabled ? 'BIAS' : 'NO-BIAS'}). ` +
                `Current mode (${oscState.resolution}-bit @ ${oscState.sampleRateKHz} kHz): ` +
                `<b style="color:#4ade80">${corr >= 0 ? '+' : ''}${corr.toFixed(2)} V</b>`;
        };

        if (btnOscRateZero) {
            btnOscRateZero.addEventListener('click', async () => {
                const ch = rateZeroChSel ? parseInt(rateZeroChSel.value, 10) : oscState.channel;
                btnOscRateZero.disabled = true;
                try {
                    await runRateZeroCalibration(ch, (msg) => { if (rateZeroStatus) rateZeroStatus.innerText = msg; });
                    if (rateZeroStatus && !rateZeroStatus.innerText.startsWith('Done')) {
                        rateZeroStatus.innerText = 'Done — corrections stored for all modes';
                    }
                } catch (e) {
                    console.error(e);
                    if (rateZeroStatus) rateZeroStatus.innerText = 'Error: ' + e.message;
                }
                btnOscRateZero.disabled = false;
                updateRateZeroInfo();
            });
        }

        if (btnOscRateZeroReset) {
            btnOscRateZeroReset.addEventListener('click', () => {
                const ch = rateZeroChSel ? parseInt(rateZeroChSel.value, 10) : oscState.channel;
                const map = loadRateZeroMap();
                for (const resKey in map) {
                    for (const rateKey in map[resKey]) {
                        if (Array.isArray(map[resKey][rateKey])) map[resKey][rateKey][ch] = null;
                    }
                }
                saveRateZeroMap(map);
                if (rateZeroStatus) rateZeroStatus.innerText = 'Reset';
                updateRateZeroInfo();
            });
        }

        if (rateZeroChSel) rateZeroChSel.addEventListener('change', updateRateZeroInfo);
        updateRateZeroInfo();
    });

    // ======================== Start / Stop / Restart ========================
    function startOsc() {
        const btnOscStartStop = document.getElementById('btnOscStartStop');

        oscState.running = true;
        oscState.singleCaptured = false;
        oscState.frozenWaveform = null;
        oscPacketBuffer = new Uint8Array(0);
        oscState.sessionId = (oscState.sessionId + 1) % 256;
        oscState.framesCollectedInSession = 0;

        if (btnOscStartStop) {
            btnOscStartStop.innerHTML = '■ Stop';
            btnOscStartStop.classList.remove('btn-success');
            btnOscStartStop.classList.add('btn-danger');
        }

        // Scan/lock acquisition modes with internal rate management.
        // Real-time and ETS go through the normal payload path below.
        const _mode = oscState.acqMode || 'realtime';
        if (_mode === 'alias' || _mode === 'usample' || _mode === 'autohf' || _mode === 'malias') {
            if (_mode === 'usample') {
                const _fcEl = document.getElementById('cfgUndersampleFc');
                const _fcMHz = _fcEl ? parseFloat(_fcEl.value) : NaN;
                if (!(_fcMHz >= 0.05 && _fcMHz <= 40)) {
                    stopOsc();
                    alert('Enter Undersample carrier in MHz (0.05…40)');
                    return;
                }
            }
            if (window.syncSignalGeneratorRamPreset) {
                window.syncSignalGeneratorRamPreset();
            }
            if (oscState.animFrameId) cancelAnimationFrame(oscState.animFrameId);
            oscState.animFrameId = requestAnimationFrame(renderFrame);
            updateOscIndicator();
            usSyncFcVisibility();
            if (_mode === 'alias') runAliasFlow();
            else if (_mode === 'usample') {
                const _fcEl = document.getElementById('cfgUndersampleFc');
                runUndersampleFlow(parseFloat(_fcEl.value));
            }
            else if (_mode === 'malias') runManualAliasFlow();
            else runUndersampleFlow(null);
            return;
        }

        // Send command: [pinMask, oversample, rateKHz_lo, rateKHz_hi, trigEdge, trigLevel_lo, trigLevel_hi, trigMode, reqSamples_lo, reqSamples_hi, enableBias, bitness12, sessionId, trigCh]
        // pinMask: bitmask of active channels (bit i = CH i). Trigger happens on `trigCh`.
        // reqSamples is per-channel when pinMask has >1 bit; total = reqSamples * popcount(pinMask).
        // Hard guarantee: ETS/Aliasing/Undersampling always capture one channel.
        if (isSingleChAcq(_mode) && (oscState.multiChannel || oscState.activeChannels.length > 1)) {
            applySingleChannelLock();
        }
        if (oscState.multiChannel) {
            oscState.currentMultiIdx = 0;
            oscState.multiFrames = [null, null, null, null];
        }

        const reqChannel = oscState.multiChannel ? oscState.activeChannels[0] : oscState.channel;
        const pinMask = oscState.multiChannel
            ? oscState.activeChannels.reduce((m, c) => m | (1 << c), 0)
            : (1 << oscState.channel);
        const reqRate = oscState.sampleRateKHz;

        const payload = new Uint8Array(14);
        payload[0] = pinMask;
        payload[1] = oscState.oversample;
        payload[2] = reqRate & 0xFF;
        payload[3] = (reqRate >> 8) & 0xFF;

        payload[4] = oscState.triggerEdge === 'rising' ? 1 : 0;

        // Convert trigger voltage to raw ADC (0-255 for 8-bit mode)
        let trigV = oscState.triggerLevel;
        let vz = 0;
        if (window.Calibration) {
            vz = oscState.biasEnabled ? (window.Calibration.biasOffsets[reqChannel] || 0) : (window.Calibration.zeroOffsets[reqChannel] || 0);
        }
        if (oscState.biasEnabled && vz === 0) {
            vz = ((window.Calibration && window.Calibration.vDda) || oscState.vRef) / 2.0; // Mid-rail bias
        }
        trigV = (trigV / oscState.divider) + vz;
        let trigRaw = (trigV / oscState.vRef) * oscState.adcRes;
        trigRaw = Math.max(0, Math.min(oscState.adcRes, Math.round(trigRaw)));

        payload[5] = trigRaw & 0xFF;
        payload[6] = (trigRaw >> 8) & 0xFF;

        // Trigger mode: 0=auto, 1=normal, 2=single
        const modeMap = { 'auto': 0, 'normal': 1, 'single': 2 };
        payload[7] = modeMap[oscState.triggerMode] || 0;

        const isEtsReq = isEtsMode();
        const maxHwRate = oscState.resolution === 12 ? 2800 : 3818;
        const effectiveRateKHz = isEtsReq ? Math.min(reqRate, 6000) : Math.min(reqRate, maxHwRate);
        const numCh = oscState.multiChannel ? oscState.activeChannels.length : 1;

        const totalTime = oscState.timePerDiv * GRID_DIVISIONS_X;
        const perChannelRateKHz = oscState.multiChannel ? (effectiveRateKHz / numCh) : effectiveRateKHz;
        const sampleRate = perChannelRateKHz * 1000;
        let samplesOnScreen = Math.round(totalTime * sampleRate);
        if (samplesOnScreen < 20) samplesOnScreen = 20;

        const maxSamplesTotal = oscState.resolution === 12 ? 7500 : 15000;
        const maxSamplesPerCh = Math.floor(maxSamplesTotal / numCh);
        if (samplesOnScreen > maxSamplesPerCh) samplesOnScreen = maxSamplesPerCh;

        payload[8] = samplesOnScreen & 0xFF;
        payload[9] = (samplesOnScreen >> 8) & 0xFF;
        payload[10] = oscState.biasEnabled ? 1 : 0;
        payload[11] = oscState.resolution === 12 ? 1 : 0;
        payload[12] = oscState.sessionId;
        payload[13] = reqChannel;  // trigger channel index (for single mode == only channel)

        // Remember what we asked firmware for (used by measurements & decimation logic)
        oscState.isEts = isEtsReq;
        oscState.reqSamplesSent = samplesOnScreen;

        microTester.sendCommand(CMD_OSC_START, payload);
        if (window.syncSignalGeneratorRamPreset) {
            window.syncSignalGeneratorRamPreset();
        }

        // Start rendering
        if (oscState.animFrameId) cancelAnimationFrame(oscState.animFrameId);
        oscState.animFrameId = requestAnimationFrame(renderFrame);
        updateOscIndicator();
    }

    function stopOsc() {
        const btnOscStartStop = document.getElementById('btnOscStartStop');

        oscState.running = false;
        usRestoreChannels();
        usClearState();
        microTester.sendCommand(CMD_OSC_STOP);
        if (window.syncSignalGeneratorRamPreset) {
            window.syncSignalGeneratorRamPreset();
        }

        if (btnOscStartStop) {
            btnOscStartStop.innerHTML = '▶ Start';
            btnOscStartStop.classList.remove('btn-danger');
            btnOscStartStop.classList.add('btn-success');
        }

        if (oscState.animFrameId) {
            cancelAnimationFrame(oscState.animFrameId);
            oscState.animFrameId = null;
        }
        updateOscIndicator();
    }
    window.stopOsc = stopOsc;

    // USB unplug: stop the capture and clear the green indicator dot
    if (typeof microTester !== 'undefined' && microTester.addDisconnectListener) {
        microTester.addDisconnectListener(() => { if (oscState.running) stopOsc(); });
    }

    function updateOscIndicator() {
        const oscIndicator = document.getElementById('oscIndicator');
        if (oscIndicator) {
            if (oscState.running) {
                oscIndicator.classList.add('active');
            } else {
                oscIndicator.classList.remove('active');
            }
        }
    }

    function restartOsc() {
        if (!oscState.running) return;
        microTester.sendCommand(CMD_OSC_STOP);

        oscState.sessionId = (oscState.sessionId + 1) % 256;
        oscState.framesCollectedInSession = 0;
        oscState.syncPending = false;

        const chs = oscState.multiChannel ? oscState.activeChannels : [oscState.channel];
        const pinMask = chs.reduce((m, c) => m | (1 << c), 0);
        const reqChannel = chs[0];  // trigger channel = first active channel in mask order
        const reqRate = oscState.sampleRateKHz;

        const payload = new Uint8Array(14);
        payload[0] = pinMask;
        payload[1] = oscState.oversample;
        payload[2] = reqRate & 0xFF;
        payload[3] = (reqRate >> 8) & 0xFF;

        payload[4] = oscState.triggerEdge === 'rising' ? 1 : 0;
        let trigV = oscState.triggerLevel;
        let vz = 0;
        if (window.Calibration) {
            vz = oscState.biasEnabled ? (window.Calibration.biasOffsets[reqChannel] || 0) : (window.Calibration.zeroOffsets[reqChannel] || 0);
        }
        if (oscState.biasEnabled && vz === 0) {
            vz = ((window.Calibration && window.Calibration.vDda) || oscState.vRef) / 2.0; // Mid-rail bias
        }
        trigV = (trigV / oscState.divider) + vz;
        let trigRaw = Math.max(0, Math.min(oscState.adcRes, Math.round((trigV / oscState.vRef) * oscState.adcRes)));
        payload[5] = trigRaw & 0xFF;
        payload[6] = (trigRaw >> 8) & 0xFF;

        const modeMap = { 'auto': 0, 'normal': 1, 'single': 2 };
        payload[7] = modeMap[oscState.triggerMode] || 0;

        const isEtsReq = isEtsMode();
        const maxHwRate = oscState.resolution === 12 ? 2800 : 3818;
        const effectiveRateKHz = isEtsReq ? Math.min(reqRate, 6000) : Math.min(reqRate, maxHwRate);
        const numCh = oscState.multiChannel ? chs.length : 1;

        const totalTime = oscState.timePerDiv * GRID_DIVISIONS_X;
        const perChannelRateKHz = oscState.multiChannel ? (effectiveRateKHz / numCh) : effectiveRateKHz;
        const sampleRate = perChannelRateKHz * 1000;
        let samplesOnScreen = Math.round(totalTime * sampleRate);
        if (samplesOnScreen < 20) samplesOnScreen = 20;

        const maxSamplesTotal = oscState.resolution === 12 ? 7500 : 15000;
        const maxSamplesPerCh = Math.floor(maxSamplesTotal / numCh);
        if (samplesOnScreen > maxSamplesPerCh) samplesOnScreen = maxSamplesPerCh;

        payload[8] = samplesOnScreen & 0xFF;
        payload[9] = (samplesOnScreen >> 8) & 0xFF;
        payload[10] = oscState.biasEnabled ? 1 : 0;
        payload[11] = oscState.resolution === 12 ? 1 : 0;
        payload[12] = oscState.sessionId;
        payload[13] = reqChannel;

        // Remember what we asked firmware for
        oscState.isEts = isEtsReq;
        oscState.reqSamplesSent = samplesOnScreen;

        microTester.sendCommand(CMD_OSC_START, payload);
        if (window.syncSignalGeneratorRamPreset) {
            window.syncSignalGeneratorRamPreset();
        }
    }

    function autoScale() {
        let samples;
        if (oscState.multiChannel) {
            let activeCh = oscState.activeChannels[oscState.currentMultiIdx] ?? oscState.activeChannels[0];
            samples = oscState.multiFrames ? oscState.multiFrames[activeCh] : null;
        } else {
            samples = oscState.currentFrame;
        }
        if (!samples || samples.length < 10) return;

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
