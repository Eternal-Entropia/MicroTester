// Voltmeter Logic & Signal Processing for MicroTester
// Protocol constants (CMD_VOLT_START, CMD_VOLT_STOP, PKT_VOLTMETER_DATA) defined in usb_protocol.js

// Device config state — global so app.js can set mode
window.voltConfig = {
    running: false,
    zeroOffset: parseFloat(localStorage.getItem('microtester_volt_zero_offset')) || 0.0,
    gainRatio: 11.0,      // Vin = Vadc * 11.0 (100k / 10k Divider, PB9 Hi-Z)
    baseOffset: 0.0,      // No bias offset in voltmeter mode
    vRef: 3.3,
    adcRes: 4096,       // 12-bit ADC
    mode: 'dc',         // 'dc' or 'ac'
    biasEnabled: false,  // PB9 bias state (Hi-Z)
    lastRawVin: 0.0,    // Uncalibrated Vin for zero offset calibration
    channel: 0          // Currently selected channel
};

// Alias for convenience
let voltConfig = window.voltConfig;

// UI Elements
const uiVoltValue = document.getElementById('voltValue');
const uiVoltRawAdc = document.getElementById('voltRawAdc');
const uiVoltAdcMv = document.getElementById('voltAdcMv');

// Initialization
document.addEventListener('DOMContentLoaded', () => {

    const btnStartStop = document.getElementById('btnStartStop');
    const btnZeroCalib = document.getElementById('btnZeroCalib');
    const zeroOffsetBadge = document.getElementById('zeroOffsetBadge');
    const zeroOffsetVal = document.getElementById('zeroOffsetVal');
    const btnResetZero = document.getElementById('btnResetZero');

    const btnVoltCalibTab = document.getElementById('btnVoltCalibTab');
    const voltZeroBadgeTab = document.getElementById('voltZeroBadgeTab');
    const voltZeroValTab = document.getElementById('voltZeroValTab');
    const btnVoltResetTab = document.getElementById('btnVoltResetTab');

    function updateZeroBadge() {
        if (!window.Calibration) return;
        const offset = window.Calibration.zeroOffsets[voltConfig.channel] || 0.0;
        const hasOffset = Math.abs(offset) > 0.0001;
        const txt = (offset >= 0 ? '+' : '') + offset.toFixed(3) + ' V';

        if (zeroOffsetBadge && zeroOffsetVal) {
            if (hasOffset) {
                zeroOffsetVal.innerText = txt;
                zeroOffsetBadge.style.display = 'inline-flex';
            } else {
                zeroOffsetBadge.style.display = 'none';
            }
        }
        if (voltZeroBadgeTab && voltZeroValTab) {
            if (hasOffset) {
                voltZeroValTab.innerText = txt;
                voltZeroBadgeTab.style.display = 'inline-flex';
            } else {
                voltZeroBadgeTab.style.display = 'none';
            }
        }
    }

    const doCalibZero = () => {
        if (!window.Calibration) return;
        window.Calibration.calibrateZero(voltConfig.channel, voltConfig.lastRawVin);
        updateZeroBadge();
    };

    const doResetZero = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (!window.Calibration) return;
        window.Calibration.resetZero(voltConfig.channel);
        updateZeroBadge();
    };

    if (btnZeroCalib) btnZeroCalib.addEventListener('click', doCalibZero);
    if (btnVoltCalibTab) btnVoltCalibTab.addEventListener('click', doCalibZero);
    if (btnResetZero) btnResetZero.addEventListener('click', doResetZero);
    if (btnVoltResetTab) btnVoltResetTab.addEventListener('click', doResetZero);

    // Call updateZeroBadge occasionally to sync with shared Calibration
    setInterval(updateZeroBadge, 1000);
    updateZeroBadge();

    // Enable button if connected
    setInterval(() => {
        if (btnStartStop) {
            btnStartStop.disabled = !microTester.device;
        }
    }, 1000);



    // --- Voltage Range Preset ---
    const cfgVoltRange = document.getElementById('cfgVoltRange');
    function applySelectedRange() {
        if (!cfgVoltRange) return;
        const sel = cfgVoltRange.options[cfgVoltRange.selectedIndex];
        const gainRatio = parseFloat(sel.getAttribute('data-divider')) || 1.0;
        const baseOffset = parseFloat(sel.getAttribute('data-baseoffset')) || 0.0;
        const biasEnabled = sel.getAttribute('data-bias') === 'true';
        const autoPolarity = sel.getAttribute('data-autopolarity') === 'true';
        const maxV = sel.value;

        // Update info labels
        const voltMaxInput = document.getElementById('voltMaxInput');
        const voltDivRatio = document.getElementById('voltDivRatio');
        const voltDivRatioInfo = document.getElementById('voltDivRatioInfo');
        if (voltMaxInput) voltMaxInput.innerText = maxV + 'V';
        if (voltDivRatio) voltDivRatio.innerText = gainRatio.toFixed(1) + 'x';
        if (voltDivRatioInfo) voltDivRatioInfo.innerText = gainRatio.toFixed(1) + 'x';

        // Apply configuration
        voltConfig.gainRatio = gainRatio;
        voltConfig.baseOffset = baseOffset;
        voltConfig.biasEnabled = biasEnabled;
        voltConfig.autoPolarity = autoPolarity;
    }

    if (cfgVoltRange) {
        cfgVoltRange.addEventListener('change', () => {
            applySelectedRange();
            reapplyIfRunning();
        });
        applySelectedRange(); // Set initial range configuration
    }

    // --- Helper: re-send voltmeter start command with current settings ---
    function reapplyIfRunning() {
        const oversample = parseInt(document.getElementById('cfgVoltOversampling').value) || 0;
        const osLabel = document.getElementById('voltOversampling');
        const effBitsLabel = document.getElementById('voltEffBits');
        if (osLabel) osLabel.innerText = '+' + oversample + ' bits';
        if (effBitsLabel) effBitsLabel.innerText = (12 + oversample).toString();

        if (!voltConfig.running || !microTester.device) return;

        const pin = parseInt(document.getElementById('cfgVoltChannel').value) || 0;
        voltConfig.channel = pin;
        applySelectedRange();

        const biasMode = (voltConfig.biasEnabled || voltConfig.baseOffset > 0) ? 1 : 0;
        microTester.sendCommand(CMD_VOLT_STOP);
        microTester.sendCommand(CMD_VOLT_START, new Uint8Array([pin, oversample, biasMode]));
    }

    // --- Live-apply: Channel & Oversampling & Sample Rate ---
    const cfgVoltChannel = document.getElementById('cfgVoltChannel');
    if (cfgVoltChannel) {
        cfgVoltChannel.addEventListener('change', () => {
            voltConfig.channel = parseInt(cfgVoltChannel.value) || 0;
            reapplyIfRunning();
        });
        voltConfig.channel = parseInt(cfgVoltChannel.value) || 0;
    }
    const cfgVoltOversampling = document.getElementById('cfgVoltOversampling');
    if (cfgVoltOversampling) {
        cfgVoltOversampling.addEventListener('change', reapplyIfRunning);
    }
    const cfgVoltSampleRate = document.getElementById('cfgVoltSampleRate');
    if (cfgVoltSampleRate) {
        cfgVoltSampleRate.addEventListener('change', reapplyIfRunning);
    }

    // --- Start / Stop ---
    if (btnStartStop) {
        btnStartStop.addEventListener('click', () => {
            if (!microTester.device) return alert("Connect USB first!");

            if (voltConfig.running) {
                // Stop
                voltConfig.running = false;
                microTester.sendCommand(CMD_VOLT_STOP);
                btnStartStop.innerHTML = '▶ Start';
                btnStartStop.classList.remove('btn-danger');
                btnStartStop.classList.add('btn-success');
            } else {
                // Start — read settings
                const pin = parseInt(document.getElementById('cfgVoltChannel').value) || 0;
                voltConfig.channel = pin;
                const oversample = parseInt(document.getElementById('cfgVoltOversampling').value);

                applySelectedRange();
                const biasMode = (voltConfig.biasEnabled || voltConfig.baseOffset > 0) ? 1 : 0;

                voltConfig.running = true;
                btnStartStop.innerHTML = '■ Stop';
                btnStartStop.classList.remove('btn-success');
                btnStartStop.classList.add('btn-danger');

                microTester.sendCommand(CMD_VOLT_START, new Uint8Array([pin, oversample, biasMode]));
            }
        });
    }

    // --- USB Data Receiver ---
    let packetBuffer = new Uint8Array(0);

    function onVoltData(data) {
        if (!voltConfig.running) return;

        // Append to buffer
        const newBuffer = new Uint8Array(packetBuffer.length + data.length);
        newBuffer.set(packetBuffer);
        newBuffer.set(data, packetBuffer.length);
        packetBuffer = newBuffer;

        // Parse packets
        while (packetBuffer.length >= 3) {
            const pktType = packetBuffer[0];
            
            // Valid packets: 0x10 (Volt), 0x12 (Osc), 0x40 (Logic), 0x50 (Comp)
            if (pktType !== 0x10 && pktType !== 0x12 && pktType !== 0x40 && pktType !== 0x50) {
                packetBuffer = packetBuffer.slice(1);
                continue;
            }

            const length = (packetBuffer[2] << 8) | packetBuffer[1];

            if (length > 8192) {
                packetBuffer = packetBuffer.slice(1);
                continue;
            }

            if (packetBuffer.length >= length + 3) {
                const payload = packetBuffer.slice(3, length + 3);

                if (pktType === 0x10) { // PKT_VOLTMETER_DATA
                    try {
                        processVoltmeterData(payload);
                    } catch (e) {
                        console.error("Error processing voltmeter data:", e);
                    }
                }

                packetBuffer = packetBuffer.slice(length + 3);
            } else {
                break;
            }
        }
    }

    microTester.addDataListener(onVoltData);
});

// Signal Processing

// Global Sample History for Software Oversampling
const MAX_HISTORY = 65536;
const sampleHistory = new Uint16Array(MAX_HISTORY);
let historyIdx = 0;
let historyCount = 0;

function processVoltmeterData(payload) {
    const samples = new Uint16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2);
    if (samples.length === 0) return;

    // 1. Push all new samples into the global circular history
    for (let i = 0; i < samples.length; i++) {
        sampleHistory[historyIdx] = samples[i];
        historyIdx = (historyIdx + 1) % MAX_HISTORY;
        if (historyCount < MAX_HISTORY) historyCount++;
    }

    // Throttle UI updates based on target sample rate
    const targetRate = parseInt(document.getElementById('cfgVoltSampleRate').value) || 8;
    const now = performance.now();
    if (now - (voltConfig.lastUiUpdate || 0) < 1000 / targetRate) return;
    voltConfig.lastUiUpdate = now;

    // 2. Determine target oversampling count
    const oversampleSetting = parseInt(document.getElementById('cfgVoltOversampling').value) || 6;
    let targetSamples = 1;
    if (oversampleSetting > 0) {
        targetSamples = 1 << (oversampleSetting * 2);
    }
    
    if (targetSamples > historyCount) {
        targetSamples = historyCount; // Wait until we have enough data
    }
    if (targetSamples === 0) return;

    // Helper to convert raw ADC reading to Vin input voltage
    function rawToVin(raw) {
        if (!window.Calibration) return 0;
        let vin = window.Calibration.calculateVolts(voltConfig.channel, raw, 12, voltConfig.gainRatio, voltConfig.baseOffset, 0);
        if (Math.abs(vin) < 0.05) vin = 0.0;
        return vin;
    }
    
    // Formatters
    function formatVolt(v) {
        if (isNaN(v)) return '-.--- V';
        if (Math.abs(v) >= 1) return v.toFixed(3) + ' V';
        return (v * 1000).toFixed(1) + ' mV';
    }

    function formatFreq(f) {
        if (isNaN(f) || f <= 0) return '-- Hz';
        if (f >= 1000) return (f / 1000).toFixed(2) + ' kHz';
        return f.toFixed(1) + ' Hz';
    }

    // 3. Compute Stats over the target window
    let sum = 0;
    let minRaw = 65535;
    let maxRaw = 0;

    let readIdx = (historyIdx - targetSamples + MAX_HISTORY) % MAX_HISTORY;
    for (let i = 0; i < targetSamples; i++) {
        const val = sampleHistory[readIdx];
        sum += val;
        if (val < minRaw) minRaw = val;
        if (val > maxRaw) maxRaw = val;
        readIdx = (readIdx + 1) % MAX_HISTORY;
    }

    const avgRaw = sum / targetSamples;

    // Browser-Side Auto-Polarity via WebUSB CMD_VOLT_SET_BIAS (0x14)
    if (voltConfig.autoPolarity) {
        // If bias is OFF, only turn ON if maxRaw is very low (clamped to 0V/negative, NO positive noise).
        // Floating probes will pick up positive noise (maxRaw > 5) and won't trigger this.
        if (!voltConfig.biasEnabled && maxRaw <= 2) {
            voltConfig.biasEnabled = true;
            voltConfig.baseOffset = 33.0;
            voltConfig.gainRatio = 21.0;
            if (microTester.device) microTester.sendCommand(CMD_VOLT_SET_BIAS, new Uint8Array([1]));
        } 
        // If bias is ON, 0V is ~1950. Floating is ~2048. 
        // Turn OFF if avgRaw >= 2000 (meaning it's floating or positive).
        else if (voltConfig.biasEnabled && avgRaw >= 2000) {
            voltConfig.biasEnabled = false;
            voltConfig.baseOffset = 0.0;
            voltConfig.gainRatio = 11.0;
            if (microTester.device) microTester.sendCommand(CMD_VOLT_SET_BIAS, new Uint8Array([0]));
        }
    }

    // Calculate uncalibrated voltage for zero-offset calibration
    if (window.Calibration) {
        let uncal = window.Calibration.calculateVolts(-1, avgRaw, 12, voltConfig.gainRatio, voltConfig.baseOffset, 0);
        if (Math.abs(uncal) < 0.05) uncal = 0.0;
        voltConfig.lastRawVin = uncal;
    }

    const vDc = rawToVin(avgRaw);
    const vMax = rawToVin(maxRaw);
    const vMin = rawToVin(minRaw);
    const vPP = Math.max(0, vMax - vMin);

    // AC RMS (deviation from mean) & True RMS & Mean Crossings
    let sqSumAc = 0;
    let sqSumTrue = 0;
    let crossings = 0;
    readIdx = (historyIdx - targetSamples + MAX_HISTORY) % MAX_HISTORY;
    let prevVal = sampleHistory[readIdx];

    for (let i = 0; i < targetSamples; i++) {
        const rawVal = sampleHistory[readIdx];
        const vin = rawToVin(rawVal);
        
        sqSumAc += Math.pow(vin - vDc, 2);
        sqSumTrue += Math.pow(vin, 2);

        if (i > 0 && prevVal < avgRaw && rawVal >= avgRaw) {
            crossings++;
        }
        prevVal = rawVal;
        readIdx = (readIdx + 1) % MAX_HISTORY;
    }

    const acRmsVolts = Math.sqrt(sqSumAc / targetSamples);
    const trueRmsVolts = Math.sqrt(sqSumTrue / targetSamples);

    // Crest Factor: Vpeak / VacRms
    const vPeak = Math.max(Math.abs(vMax - vDc), Math.abs(vMin - vDc));
    const crestFactor = acRmsVolts > 0.005 ? (vPeak / acRmsVolts) : 0;

    // Frequency estimate (Voltmeter hardware rate is 10kHz = 10000 SPS)
    const timeSpanSec = targetSamples / 10000.0;
    const acFreq = (vPP > 0.05 && crossings > 0 && timeSpanSec > 0) ? (crossings / timeSpanSec) : 0;

    voltConfig.lastRawVin = rawToVin(avgRaw) + (voltConfig.zeroOffset || 0);

    let displayVoltage;
    const uiVoltUnit = document.getElementById('voltUnit');

    if (voltConfig.mode === 'dc') {
        displayVoltage = vDc;
        if (uiVoltUnit) uiVoltUnit.innerText = 'V (DC)';
    } else {
        displayVoltage = acRmsVolts;
        if (uiVoltUnit) uiVoltUnit.innerText = 'V (RMS)';
    }

    // Update main display & raw info
    if (uiVoltValue) uiVoltValue.innerText = displayVoltage.toFixed(3);
    if (uiVoltRawAdc) uiVoltRawAdc.innerText = Math.round(avgRaw);
    if (uiVoltAdcMv) {
        const rawToAdcVolts = (raw) => (raw / voltConfig.adcRes) * voltConfig.vRef;
        let adcMv = rawToAdcVolts(avgRaw) * 1000;
        uiVoltAdcMv.innerText = Math.round(adcMv) + ' mV';
    }

    // Update AC Indicators Panel visibility & values
    const elAcCard = document.getElementById('voltAcMetricsCard');
    if (elAcCard) {
        elAcCard.style.display = (voltConfig.mode === 'ac') ? 'block' : 'none';
    }

    if (voltConfig.mode === 'ac') {
        const elVoltAcRms = document.getElementById('voltAcRms');
        const elVoltVpp = document.getElementById('voltVpp');
        const elVoltVmax = document.getElementById('voltVmax');
        const elVoltVmin = document.getElementById('voltVmin');
        const elVoltVdc = document.getElementById('voltVdc');
        const elVoltTrueRms = document.getElementById('voltTrueRms');
        const elVoltCrestFactor = document.getElementById('voltCrestFactor');
        const elVoltAcFreq = document.getElementById('voltAcFreq');

        if (elVoltAcRms) elVoltAcRms.innerText = formatVolt(acRmsVolts);
        if (elVoltVpp) elVoltVpp.innerText = formatVolt(vPP);
        if (elVoltVmax) elVoltVmax.innerText = formatVolt(vMax);
        if (elVoltVmin) elVoltVmin.innerText = formatVolt(vMin);
        if (elVoltVdc) elVoltVdc.innerText = formatVolt(vDc);
        if (elVoltTrueRms) elVoltTrueRms.innerText = formatVolt(trueRmsVolts);
        if (elVoltCrestFactor) elVoltCrestFactor.innerText = crestFactor > 0 ? crestFactor.toFixed(2) : '--';
        if (elVoltAcFreq) elVoltAcFreq.innerText = formatFreq(acFreq);
    }
}
