// Component Tester Controller for MicroTester

// Oversampling (128..1024) persisted from the Settings panel
function getCompOversample() {
    const v = parseInt(localStorage.getItem('microtester_comp_oversample'), 10);
    if (isNaN(v) || v < 128 || v > 1024) return 128;
    return v;
}

// Xc calculation frequency (Hz), persisted from the Settings panel (PC-side only)
function getCompXcFreq() {
    const v = parseInt(localStorage.getItem('microtester_comp_xc_freq'), 10);
    if (isNaN(v) || v < 1 || v > 1000000) return 120;
    return v;
}

// Payload: [mode, oversampleLo, oversampleHi] (firmware falls back to 128 on short payloads)
function buildCompTestPayload(mode) {
    const ov = getCompOversample();
    return new Uint8Array([mode, ov & 0xFF, (ov >> 8) & 0xFF]);
}

document.addEventListener('DOMContentLoaded', () => {
    const btnTest = document.getElementById('btnCompTest');
    const btnStop = document.getElementById('btnCompStop');
    const btnSmallCap = document.getElementById('btnSmallCap');
    const statusEl = document.getElementById('compStatus');
    const resultArea = document.getElementById('compResultArea');
    const resultIcon = document.getElementById('compResultIcon');
    const resultType = document.getElementById('compResultType');
    const resultValue = document.getElementById('compResultValue');
    const resultSecondary = document.getElementById('compResultSecondary');
    const resultPinout = document.getElementById('compResultPinout');
    const compProbeMap = document.getElementById('compProbeMap');

    let testing = false;
    let compTestTimeoutTimer = null;

    // Enable/disable based on USB connection
    setInterval(() => {
        if (btnTest) btnTest.disabled = !microTester.device || testing;
        if (btnSmallCap) btnSmallCap.disabled = !microTester.device || testing;
    }, 1000);

    function updateCompIndicator(active) {
        const compIndicator = document.getElementById('compIndicator');
        if (compIndicator) {
            if (active) compIndicator.classList.add('active');
            else compIndicator.classList.remove('active');
        }
    }

    function stopActiveInstruments() {
        if (typeof window.stopVoltmeter === 'function') window.stopVoltmeter();
        if (typeof window.stopOsc === 'function') window.stopOsc();
    }

    // --- Oversampling setting (Settings panel) ---
    const cfgCompOversample = document.getElementById('cfgCompOversample');
    if (cfgCompOversample) {
        const savedOv = localStorage.getItem('microtester_comp_oversample');
        if (savedOv) cfgCompOversample.value = savedOv;
        cfgCompOversample.addEventListener('change', () => {
            let v = parseInt(cfgCompOversample.value, 10);
            if (isNaN(v) || v < 128 || v > 1024) v = 128;
            cfgCompOversample.value = String(v);
            localStorage.setItem('microtester_comp_oversample', String(v));
        });
    }

    // --- Xc calculation frequency (Settings panel, PC-side only) ---
    const cfgCompFreq = document.getElementById('cfgCompFreq');
    if (cfgCompFreq) {
        const savedFreq = localStorage.getItem('microtester_comp_xc_freq');
        if (savedFreq) cfgCompFreq.value = savedFreq;
        const applyFreqInput = () => {
            let v = parseInt(cfgCompFreq.value, 10);
            if (isNaN(v)) v = 120;
            if (v < 1) v = 1;
            if (v > 1000000) v = 1000000;
            cfgCompFreq.value = String(v);
            localStorage.setItem('microtester_comp_xc_freq', String(v));
        };
        cfgCompFreq.addEventListener('change', applyFreqInput);
        // Also apply on Enter without blurring
        cfgCompFreq.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') applyFreqInput();
        });
    }

    // --- Component Tester Debug Log System (Browser-Side) ---
    const cfgShowDebugLog = document.getElementById('cfgShowDebugLog');
    const compDebugLogCard = document.getElementById('compDebugLogCard');
    const compDebugLogContent = document.getElementById('compDebugLogContent');
    const compDebugLogCount = document.getElementById('compDebugLogCount');
    const btnCompDebugClear = document.getElementById('btnCompDebugClear');
    const btnCompDebugCopy = document.getElementById('btnCompDebugCopy');

    let compDebugEventCount = 0;

    function isDebugLogEnabled() {
        if (cfgShowDebugLog) return cfgShowDebugLog.checked;
        return localStorage.getItem('microtester_show_debug_log') === 'true';
    }

    function syncDebugLogs(enabled) {
        localStorage.setItem('microtester_show_debug_log', enabled ? 'true' : 'false');
        if (cfgShowDebugLog && cfgShowDebugLog.checked !== enabled) {
            cfgShowDebugLog.checked = enabled;
        }
        if (compDebugLogCard) {
            compDebugLogCard.style.display = enabled ? 'block' : 'none';
        }
        const frDebugLogCard = document.getElementById('frDebugLogCard');
        if (frDebugLogCard) {
            frDebugLogCard.style.display = enabled ? '' : 'none';
        }
    }

    function compLog(msg, level = 'info', rawBytes = null) {
        if (!isDebugLogEnabled()) return;

        compDebugEventCount++;
        if (compDebugLogCount) compDebugLogCount.innerText = `${compDebugEventCount} events`;

        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;

        let color = '#cbd5e1'; // default
        if (level === 'tx') color = '#facc15';       // Yellow for TX
        else if (level === 'rx') color = '#4ade80';  // Green for RX
        else if (level === 'warn') color = '#fb923c';// Orange for Warn
        else if (level === 'err') color = '#f87171';  // Red for Error
        else if (level === 'calc') color = '#38bdf8'; // Cyan for Calculations

        let hexDump = '';
        if (rawBytes && rawBytes.length) {
            const hexArray = Array.from(rawBytes).map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase());
            hexDump = `<div style="color: #94a3b8; font-size: 10.5px; margin-left: 12px; margin-top: 2px;">HEX [${rawBytes.length}B]: ${hexArray.join(' ')}</div>`;
        }

        const logLine = document.createElement('div');
        logLine.style.marginBottom = '4px';
        logLine.innerHTML = `<span style="color: #64748b;">[${timeStr}]</span> <span style="color: ${color}; font-weight: 500;">${msg}</span>${hexDump}`;

        if (compDebugLogContent) {
            compDebugLogContent.appendChild(logLine);
            while (compDebugLogContent.children.length > 250) {
                compDebugLogContent.removeChild(compDebugLogContent.firstChild);
            }
            compDebugLogContent.scrollTop = compDebugLogContent.scrollHeight;
        }

        console.log(`[CompTester ${timeStr}] ${msg}`, rawBytes || '');
    }

    if (cfgShowDebugLog) {
        const initialEnabled = localStorage.getItem('microtester_show_debug_log') === 'true';
        cfgShowDebugLog.checked = initialEnabled;
        syncDebugLogs(initialEnabled);

        cfgShowDebugLog.addEventListener('change', () => {
            const enabled = cfgShowDebugLog.checked;
            syncDebugLogs(enabled);
            if (enabled) compLog('[SYS] Debug logs enabled', 'info');
        });
    } else {
        syncDebugLogs(localStorage.getItem('microtester_show_debug_log') === 'true');
    }

    if (btnCompDebugClear) {
        btnCompDebugClear.addEventListener('click', () => {
            if (compDebugLogContent) {
                compDebugLogContent.innerHTML = '<div style="color: #64748b; font-style: italic;">Log cleared.</div>';
            }
            compDebugEventCount = 0;
            if (compDebugLogCount) compDebugLogCount.innerText = '0 events';
        });
    }

    if (btnCompDebugCopy) {
        btnCompDebugCopy.addEventListener('click', () => {
            if (compDebugLogContent) {
                const text = compDebugLogContent.innerText;
                navigator.clipboard.writeText(text).then(() => {
                    const prevText = btnCompDebugCopy.innerText;
                    btnCompDebugCopy.innerText = 'Copied!';
                    setTimeout(() => { btnCompDebugCopy.innerText = prevText; }, 1500);
                });
            }
        });
    }

    // Start test (Normal)
    if (btnTest) {
        btnTest.addEventListener('click', () => {
            if (!microTester.device) return alert('Connect USB first!');
            stopActiveInstruments();
            if (typeof window.Calibration !== 'undefined' && typeof window.Calibration.sendCompCalToFirmware === 'function') {
                window.Calibration.sendCompCalToFirmware();
            }
            if (compTestTimeoutTimer) { clearTimeout(compTestTimeoutTimer); compTestTimeoutTimer = null; }
            testing = true;
            lastEsrTable = null;
            updateCompIndicator(true);
            statusEl.innerText = 'Testing...';
            statusEl.className = 'comp-status testing';
            resultArea.style.display = 'none';
            btnTest.disabled = true;
            if (btnSmallCap) btnSmallCap.disabled = true;
            const payload = buildCompTestPayload(0);
            compLog(`[TX] CMD_COMP_TEST: mode=0 (Auto-Test), oversample=${getCompOversample()}x`, 'tx', payload);
            microTester.sendCommand(CMD_COMP_TEST, payload); // Mode = 0 (auto test)
            // Timeout after 60 seconds (allows large capacitor charging & higher oversampling)
            compTestTimeoutTimer = setTimeout(() => {
                if (testing) {
                    testing = false;
                    compTestTimeoutTimer = null;
                    updateCompIndicator(false);
                    compLog('[TIMEOUT] Microcontroller did not return a response within 60s', 'err');
                    statusEl.innerText = 'Timeout — no response';
                    statusEl.className = 'comp-status error';
                    btnTest.disabled = false;
                    if (btnSmallCap) btnSmallCap.disabled = false;
                }
            }, 60000);
        });
    }

    // Start test (Small Cap Mode)
    if (btnSmallCap) {
        btnSmallCap.addEventListener('click', () => {
            if (!microTester.device) return alert('Connect USB first!');
            stopActiveInstruments();
            if (compTestTimeoutTimer) { clearTimeout(compTestTimeoutTimer); compTestTimeoutTimer = null; }
            testing = true;
            lastEsrTable = null;
            updateCompIndicator(true);
            statusEl.innerText = 'Testing Small Cap...';
            statusEl.className = 'comp-status testing';
            resultArea.style.display = 'none';
            btnTest.disabled = true;
            btnSmallCap.disabled = true;
            const payload = buildCompTestPayload(1);
            compLog(`[TX] CMD_COMP_TEST: mode=1 (Small Cap / pF Mode), oversample=${getCompOversample()}x`, 'tx', payload);
            microTester.sendCommand(CMD_COMP_TEST, payload); // Mode = 1 (small cap)
            compTestTimeoutTimer = setTimeout(() => {
                if (testing) {
                    testing = false;
                    compTestTimeoutTimer = null;
                    updateCompIndicator(false);
                    compLog('[TIMEOUT] Small cap test timed out after 60s', 'err');
                    statusEl.innerText = 'Timeout — no response';
                    statusEl.className = 'comp-status error';
                    btnTest.disabled = false;
                    if (btnSmallCap) btnSmallCap.disabled = false;
                }
            }, 60000);
        });
    }

    // Cancel test
    if (btnStop) {
        btnStop.addEventListener('click', () => {
            if (compTestTimeoutTimer) { clearTimeout(compTestTimeoutTimer); compTestTimeoutTimer = null; }
            compLog('[TX] CMD_COMP_STOP (User Cancelled)', 'warn');
            microTester.sendCommand(CMD_COMP_STOP);
            testing = false;
            updateCompIndicator(false);
            statusEl.innerText = 'Cancelled';
            statusEl.className = 'comp-status idle';
            btnTest.disabled = false;
            if (btnSmallCap) btnSmallCap.disabled = false;
        });
    }

    // ESR table cache (PKT_COMP_ESR_TABLE arrives before PKT_COMP_RESULT).
    // Ungated by `testing` on purpose: firmware always sends TABLE first.
    let lastEsrTable = null;
    let lastEsrTableTime = 0;

    microTester.addDataListener((data) => {
        if (!data || data.length < 4) return;
        if (data[0] !== PKT_COMP_ESR_TABLE) return;
        const pktLen = data[1] | (data[2] << 8);
        const payload = data.slice(3, 3 + pktLen);
        if (payload.length < 1) return;
        const n = payload[0];
        if (n < 1 || n > 4) return;
        const rows = [];
        for (let i = 0; i < n; i++) {
            const o = 1 + i * 10;
            if (o + 10 > payload.length) break;
            const dv = new DataView(payload.buffer, payload.byteOffset + o, 10);
            rows.push({
                freq: dv.getUint32(0, true),
                esr: dv.getUint16(4, true),
                td: dv.getUint16(6, true),
                flags: dv.getUint16(8, true)
            });
        }
        if (rows.length) {
            lastEsrTable = rows;
            lastEsrTableTime = Date.now();
            compLog(`[RX] PKT_COMP_ESR_TABLE (${rows.length} rows)`, 'rx', payload);
        }
    });

    function getFreshEsrTable() {
        if (!lastEsrTable || !lastEsrTable.length) return null;
        if (Date.now() - lastEsrTableTime > 8000) { lastEsrTable = null; return null; }
        return lastEsrTable;
    }

    function fmtEsrFreq(f) {
        if (f >= 1000000) return (f / 1000000) + ' MHz';
        if (f >= 1000) return (f / 1000) + ' kHz';
        return f + ' Hz';
    }

    function buildEsrTableHtml(rows, cVal, esrTrim, vloss) {
        const cF = cVal * 1e-12;
        let html = '';
        if (vloss !== undefined) html += `<div class="esr-vloss">Vloss: ${(vloss / 10).toFixed(1)}%</div>`;
        html += '<div class="esr-wrap">';
        html += '<table class="esr-table">' +
            '<thead><tr>' +
            '<th>f</th>' +
            '<th>ESR</th>' +
            '<th>tan δ</th>' +
            '<th>Q</th>' +
            '<th>Xc</th>' +
            '</tr></thead><tbody>';
        for (const row of rows) {
            const valid = (row.flags & 1) !== 0;
            const refMark = (row.freq === 1000) ? ' (ref)' : '';
            const fStr = fmtEsrFreq(row.freq) + refMark;
            if (!valid) {
                html += `<tr><td class="esr-freq">${fStr}</td>` +
                    `<td colspan="4" class="esr-na">—</td></tr>`;
                continue;
            }
            // Manual trim is subtracted from every row (loop resistance is frequency-independent)
            const esrShownRow = row.esr - (esrTrim || 0);
            const esrOhm = esrShownRow / 100;
            const tdRow = (esrOhm > 0 && cF > 0) ? (2.0 * Math.PI * row.freq * cF * esrOhm) : 0;
            const qRow = tdRow > 0 ? (1 / tdRow) : Infinity;
            const xcRow = cF > 0 ? (1.0 / (2.0 * Math.PI * row.freq * cF)) : 0;
            html += `<tr><td class="esr-freq">${fStr}</td>` +
                `<td>${(esrShownRow / 100).toFixed(2)} Ω</td>` +
                `<td>${tdRow.toFixed(3)}</td>` +
                `<td>${qRow >= 100 ? '≥100' : qRow.toFixed(1)}</td>` +
                `<td>${formatResistance(xcRow * 100)}</td></tr>`;
        }
        html += '</tbody></table>';
        if (rows.some(r => r.freq === 1000 && (r.flags & 1) !== 0)) {
            html += '<div class="esr-note">1 kHz is the reference</div>';
        }
        html += '</div>';
        return html;
    }

    // Data listener for component test results
    microTester.addDataListener((data) => {
        if (!testing) return;
        if (data.length < 3) return;

        const pktType = data[0];
        const pktLen = data[1] | (data[2] << 8);

        if (pktType !== PKT_COMP_RESULT) return;
        const resultLen = Math.min(Math.max(pktLen, 18), 32);
        if (data.length < 3 + resultLen) return;

        if (compTestTimeoutTimer) { clearTimeout(compTestTimeoutTimer); compTestTimeoutTimer = null; }

        const payload = data.slice(3, 3 + resultLen);
        compLog(`[RX] PKT_COMP_RESULT (${resultLen} bytes payload)`, 'rx', payload);

        const result = parseCompResult(payload);
        const typeNames = {
            0: 'COMP_NONE', 10: 'COMP_RESISTOR', 11: 'COMP_CAPACITOR', 12: 'COMP_INDUCTOR',
            20: 'COMP_DIODE', 21: 'COMP_BJT', 22: 'COMP_MOSFET',
            30: 'COMP_SHORT', 31: 'COMP_OPEN'
        };
        const vlossText = result.vloss ? `, vloss=${(result.vloss / 10).toFixed(1)}%` : '';
        compLog(`[PARSED] type=${result.type} (${typeNames[result.type] || 'Unknown'}), probes=[TP${result.pinA + 1}, TP${result.pinB + 1}, TP${result.pinC + 1}], val1=${result.value1}, val2=${result.value2}, val3=${result.value3}, flags=0x${result.flags.toString(16)}${vlossText}`, 'calc');

        testing = false;
        updateCompIndicator(false);
        btnTest.disabled = false;
        if (btnSmallCap) btnSmallCap.disabled = false;

        displayResult(result);
    });

    function parseCompResult(buf) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        return {
            type: dv.getUint8(0),
            pinA: dv.getUint8(1),
            pinB: dv.getUint8(2),
            pinC: dv.getUint8(3),
            value1: dv.getUint32(4, true),
            value2: dv.getUint32(8, true),
            value3: (dv.byteLength >= 16) ? dv.getUint32(12, true) : 0,
            flags: (dv.byteLength >= 18) ? dv.getUint16(16, true) : 0,
            vloss: (dv.byteLength >= 20) ? dv.getUint16(18, true) : 0
        };
    }

    function formatResistance(ohms100) {
        // value1 is in ohms * 100
        const ohms = ohms100 / 100;
        if (ohms >= 1000000) return (ohms / 1000000).toFixed(2) + ' MΩ';
        if (ohms >= 1000) return (ohms / 1000).toFixed(2) + ' kΩ';
        return ohms.toFixed(1) + ' Ω';
    }

    function formatCapacitance(pF) {
        if (pF >= 1000000) return (pF / 1000000).toFixed(2) + ' µF';
        if (pF >= 1000) return (pF / 1000).toFixed(2) + ' nF';
        return pF + ' pF';
    }

    function formatInductance(uH) {
        if (uH >= 1000000) return (uH / 1000000).toFixed(2) + ' H';
        if (uH >= 1000) return (uH / 1000).toFixed(2) + ' mH';
        if (uH >= 1) return uH.toFixed(2) + ' µH';
        return (uH * 1000).toFixed(0) + ' nH';
    }

    function displayResult(r) {
        resultArea.style.display = 'block';
        let icon = '', typeName = '', value = '', secondary = '', pinout = '', probeMap = '';
        const probeLabels = ['TP1 (PA7)', 'TP2 (PA6)', 'TP3 (PA5)'];

        switch (r.type) {
            case 0:  // COMP_NONE
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16" stroke-width="3"/></svg>`;
                typeName = 'No Component Detected';
                value = '—';
                statusEl.innerText = 'No component found';
                statusEl.className = 'comp-status warning';
                break;
            case 10: // COMP_RESISTOR
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#38bdf8" stroke-width="2"><path d="M2 12h4l2-5 4 10 4-10 2 5h4"/></svg>`;
                let rOffset = 0;
                if (typeof window.Calibration !== 'undefined' && window.Calibration.compOffsetR) {
                    rOffset = window.Calibration.compOffsetR;
                }

                // Firmware already computed exact resistance with calibrated RL/RH from MCU RAM
                const r1 = Math.max(0, r.value1 - rOffset);

                if (r.value2 > 0) {
                    const r2 = Math.max(0, r.value2 - rOffset);

                    typeName = 'Dual Resistors';
                    value = `R1 = ${formatResistance(r1)}`;
                    secondary = `R2 = ${formatResistance(r2)}`;
                    probeMap = `R1: ${probeLabels[r.pinA]} ⟷ ${probeLabels[r.pinB]}  |  R2: ${probeLabels[r.pinB]} ⟷ ${probeLabels[r.pinC]}`;
                } else {
                    typeName = 'Resistor';
                    value = formatResistance(r1);
                    probeMap = `${probeLabels[r.pinA]} ⟷ ${probeLabels[r.pinB]}`;
                }
                statusEl.innerText = 'Component identified';
                statusEl.className = 'comp-status success';
                break;
            case 11: // COMP_CAPACITOR
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#38bdf8" stroke-width="2"><line x1="3" y1="12" x2="10" y2="12"/><line x1="10" y1="5" x2="10" y2="19" stroke-width="3"/><line x1="14" y1="5" x2="14" y2="19" stroke-width="3"/><line x1="14" y1="12" x2="21" y2="12"/></svg>`;
                const isPolarized = (r.flags & 0x20) !== 0;
                typeName = isPolarized ? 'Electrolytic Capacitor' : 'Capacitor';

                // Loss factor tan(delta) @ 1 kHz
                const td = (r.value3 > 0) ? (r.value3 / 10000.0) : 0;

                // Compensate dielectric absorption / loss overestimation from DC charging using Vloss
                let cVal = r.value1;
                if (r.vloss > 0 && r.value1 >= 1000000) {
                    const vlossFraction = (r.vloss / 10.0) / 100.0; // r.vloss in 0.1% units (e.g. 26 -> 0.026)
                    const lossDeduction = Math.min(0.35, vlossFraction);
                    cVal = Math.round(r.value1 * (1.0 - lossDeduction));
                }

                value = formatCapacitance(cVal);

                // Secondary (value2): ESR*100; Tertiary (value3): tan(delta)*10000 @ 1 kHz; vloss: Vloss in 0.1%
                // Manual trim is subtracted from the finished ESR value (positive trim lowers shown ESR)
                const esrTrim = (typeof window.Calibration !== 'undefined' && window.Calibration.compESRManualTrim) ? window.Calibration.compESRManualTrim : 0;
                const esrShown = (r.value2 || 0) - esrTrim;
                const esrTable = (cVal >= 10000) ? getFreshEsrTable() : null;
                if (esrTable) {
                    // Multi-frequency table from new firmware: each tan on its own frequency
                    secondary = buildEsrTableHtml(esrTable, cVal, esrTrim, r.vloss);
                    compLog(`[TABLE] ESR table applied (${esrTable.length} rows, trim=${(esrTrim / 100).toFixed(2)} Ω)`, 'calc');
                    lastEsrTable = null; // consume once
                } else {
                    let capDetails = [];
                    if (r.value2 !== undefined && cVal >= 1000000) {
                        capDetails.push(`ESR @ 1 kHz: ${(esrShown / 100).toFixed(2)} Ω`);
                    }
                    if (r.vloss !== undefined) {
                        capDetails.push(`Vloss: ${(r.vloss / 10).toFixed(1)}%`);
                    }
                    if (td > 0) {
                        const q = td > 0 ? (1 / td) : Infinity;
                        capDetails.push(`tan δ: ${td.toFixed(3)} (Q ≈ ${q >= 100 ? '≥100' : q.toFixed(1)}) @ 1 kHz`);
                    } else if (cVal >= 1000000 && r.value2 !== undefined) {
                        capDetails.push(`tan δ: 0.000 (Q ≈ ≥100) @ 1 kHz`);
                    }
                    if (cVal > 0) {
                        const cFarad = cVal * 1e-12;
                        const xcOhm = 1.0 / (2.0 * Math.PI * 1000.0 * cFarad);
                        capDetails.push(`Xc: ${formatResistance(xcOhm * 100)} @ 1 kHz`);
                    }
                    secondary = capDetails.join('  |  ');
                }

                if (isPolarized) {
                    probeMap = `+ ${probeLabels[r.pinA]}  — ${probeLabels[r.pinB]}`;
                } else {
                    probeMap = `${probeLabels[r.pinA]} ⟷ ${probeLabels[r.pinB]}`;
                }
                statusEl.innerText = 'Component identified';
                statusEl.className = 'comp-status success';
                break;
            case 12: // COMP_INDUCTOR
                icon = `<svg viewBox="0 0 56 32" width="56" height="32" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"><path d="M 3 20 L 11 20 C 11 8, 20 8, 20 20 C 20 8, 29 8, 29 20 C 29 8, 38 8, 38 20 C 38 8, 47 8, 47 20 L 53 20"/></svg>`;
                typeName = 'Inductor';

                // r.value1 is transmitted in nH (nano-Henries) to preserve decimal precision (1 uH = 1000 nH)
                let L_nH = r.value1;
                let L_uH = L_nH / 1000.0;
                value = formatInductance(L_uH);

                let rOffset2 = 0;
                if (typeof window.Calibration !== 'undefined' && window.Calibration.compOffsetR) {
                    rOffset2 = window.Calibration.compOffsetR;
                }

                // Firmware already computed Rdc with calibrated RL from MCU RAM
                let rawRdcVal2 = Math.max(0, r.value2 - rOffset2);
                let Rdc2 = rawRdcVal2 / 100.0;

                let freqHz = r.value3 || 100000;
                let L_henry = L_uH / 1000000.0;

                // Reactive resistance on PC: XL = 2*PI*f*L, f from Settings
                const xlFreq = getCompXcFreq();
                const XLs = 2.0 * Math.PI * xlFreq * L_henry;
                let xlStr = `X_L: ${formatResistance(XLs * 100)} @ ${xlFreq} Hz`;

                // Estimated Self-Resonant Frequency (SRF / f_res) with realistic parasitic Cp model
                // High-L multi-layer chokes (>10 mH) have Cp ~ 250..350 pF; small RF coils have Cp ~ 5..15 pF
                let cp_farad = 15.0e-12;
                if (L_henry >= 0.010) { // >= 10 mH
                    cp_farad = 300.0e-12;
                } else if (L_henry >= 0.001) { // 1 mH .. 10 mH
                    cp_farad = 100.0e-12;
                } else if (L_henry >= 0.0001) { // 100 uH .. 1 mH
                    cp_farad = 35.0e-12;
                } else {
                    cp_farad = 15.0e-12;
                }
                let fRes = 1.0 / (2.0 * Math.PI * Math.sqrt(L_henry * cp_farad));
                let fResStr = (fRes >= 1000000) ? (fRes / 1000000).toFixed(2) + ' MHz' : (fRes >= 1000) ? (fRes / 1000).toFixed(1) + ' kHz' : fRes.toFixed(0) + ' Hz';

                let rDcStr = (Rdc2 < 0.05) ? '< 0.05 Ω' : `${Rdc2.toFixed(2)} Ω`;
                let fKHz = xlFreq / 1000.0;
                let rac = Math.max(0.01, Rdc2 * (1.0 + 0.15 * Math.sqrt(fKHz)));
                let Q = XLs / rac;
                let qStr = (Q >= 100) ? '≥100' : (Q < 0.1 ? '<0.1' : Q.toFixed(1));

                secondary = `R_dc: ${rDcStr}  |  ${xlStr}  |  Q ≈ ${qStr} @ ${xlFreq} Hz  |  f_res ≈ ${fResStr}`;
                probeMap = `${probeLabels[r.pinA]} ⟷ ${probeLabels[r.pinB]}`;
                statusEl.innerText = 'Component identified';
                statusEl.className = 'comp-status success';
                break;
            case 20: // COMP_DIODE
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#38bdf8" stroke-width="2"><line x1="2" y1="12" x2="8" y2="12"/><polygon points="8,6 8,18 16,12" fill="rgba(56,189,248,0.2)"/><line x1="16" y1="6" x2="16" y2="18" stroke-width="3"/><line x1="16" y1="12" x2="22" y2="12"/></svg>`;
                typeName = 'Diode';
                value = `Vf = ${r.value1} mV`;

                let dType = 'LED';
                if (r.value1 < 450) dType = 'Schottky';
                else if (r.value1 < 900) dType = 'Silicon';
                else if (r.value1 < 1500) dType = 'Silicon / Germanium';

                let current_mA = ((3300 - r.value1) / 1360).toFixed(2);
                secondary = `Type: ${dType}  |  If ≈ ${current_mA} mA`;
                if (r.value2 > 0) {
                    secondary += `  |  C = ${formatCapacitance(r.value2)}`;
                }

                probeMap = `A: ${probeLabels[r.pinA]}  K: ${probeLabels[r.pinB]}`;
                statusEl.innerText = 'Component identified';
                statusEl.className = 'comp-status success';
                break;
            case 21: // COMP_BJT
                const isNPN = r.flags & 0x01;
                const iceo = r.flags >> 4;
                const vbe = r.value2 & 0xFFFF;
                const cob = r.value2 >>> 16;
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#38bdf8" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="9" y1="7" x2="9" y2="17" stroke-width="3"/><line x1="9" y1="9" x2="16" y2="5"/><line x1="9" y1="15" x2="16" y2="19"/></svg>`;
                typeName = `BJT (${isNPN ? 'NPN' : 'PNP'})`;
                value = `hFE = ${r.value1}`;
                let iceoStr = (iceo === 0) ? '< 1 μA' : ((iceo >= 1000) ? (iceo / 1000).toFixed(2) + ' mA' : iceo + ' μA');
                secondary = `Vbe = ${vbe} mV  |  Iceo = ${iceoStr}`;
                if (cob > 0) {
                    let fT_str = "";
                    const fT_MHz = 1500 / cob;
                    if (fT_MHz < 1) {
                        fT_str = Math.round(fT_MHz * 1000) + " kHz";
                    } else {
                        fT_str = Math.round(fT_MHz) + " MHz";
                    }
                    secondary += `\nCcb = ${formatCapacitance(cob)} (fT ≈ ${fT_str})`;
                }
                probeMap = `B: ${probeLabels[r.pinA]}  C: ${probeLabels[r.pinB]}  E: ${probeLabels[r.pinC]}`;
                statusEl.innerText = 'Component identified';
                statusEl.className = 'comp-status success';
                break;
            case 22: // COMP_MOSFET
                {
                    const isPch = (r.flags & 0x08) !== 0;
                    const isNch = !isPch;
                    const chName = isPch ? 'P-Channel' : 'N-Channel';
                    const modeName = (r.flags & 0x20) ? 'Depletion' : 'Enhancement';

                    if (isPch) {
                        icon = `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="3" y1="12" x2="8" y2="12"/><line x1="8" y1="7" x2="8" y2="17"/><line x1="10" y1="7" x2="10" y2="9"/><line x1="10" y1="11" x2="10" y2="13"/><line x1="10" y1="15" x2="10" y2="17"/><line x1="10" y1="7" x2="16" y2="7"/><line x1="16" y1="7" x2="16" y2="4"/><line x1="10" y1="17" x2="16" y2="17"/><line x1="16" y1="17" x2="16" y2="20"/><line x1="10" y1="12" x2="16" y2="12"/><polygon points="14,12 11,10 11,14" fill="#38bdf8"/></svg>`;
                    } else {
                        icon = `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="3" y1="12" x2="8" y2="12"/><line x1="8" y1="7" x2="8" y2="17"/><line x1="10" y1="7" x2="10" y2="9"/><line x1="10" y1="11" x2="10" y2="13"/><line x1="10" y1="15" x2="10" y2="17"/><line x1="10" y1="7" x2="16" y2="7"/><line x1="16" y1="7" x2="16" y2="4"/><line x1="10" y1="17" x2="16" y2="17"/><line x1="16" y1="17" x2="16" y2="20"/><line x1="10" y1="12" x2="16" y2="12"/><polygon points="10,12 13,10 13,14" fill="#38bdf8"/></svg>`;
                    }

                    typeName = `MOSFET (${chName} ${modeName})`;

                    const vthV = (r.value1 / 1000).toFixed(2);
                    value = `Vth = ${vthV} V`;

                    const rdsMohm = r.value2;
                    if (rdsMohm === 0xFFFF || rdsMohm >= 60000) {
                        secondary = `Rds(on) = > 60 Ω (Standard 10V Gate MOSFET, Vgs=3.3V ≤ Vth)`;
                    } else if (rdsMohm > 0 && rdsMohm < 300) {
                        secondary = `Rds(on) = < 0.5 Ω (@ Vgs=3.3V)`;
                    } else if (rdsMohm >= 1000) {
                        secondary = `Rds(on) = ${(rdsMohm / 1000).toFixed(2)} Ω (@ Vgs=3.3V)`;
                    } else if (rdsMohm > 0) {
                        secondary = `Rds(on) = ${rdsMohm} mΩ (@ Vgs=3.3V)`;
                    } else {
                        secondary = `Rds(on) = < 0.1 Ω (@ Vgs=3.3V)`;
                    }
                    if (r.value3 > 0) {
                        secondary += `  |  Cg = ${formatCapacitance(r.value3)}`;
                    }

                    probeMap = `G: ${probeLabels[r.pinA]}  D: ${probeLabels[r.pinB]}  S: ${probeLabels[r.pinC]}`;
                    statusEl.innerText = 'Component identified';
                    statusEl.className = 'comp-status success';
                }
                break;
            case 30: // SHORT
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`;
                typeName = 'Short Circuit';
                {
                    const rShort = Math.max(0, r.value1 - (window.Calibration?.compOffsetR || 0));
                    if (rShort > 0) {
                        value = formatResistance(rShort);
                    } else {
                        value = '< 0.1 Ω';
                    }
                }
                probeMap = `${probeLabels[r.pinA]} ⟷ ${probeLabels[r.pinB]}`;
                statusEl.innerText = 'Short detected';
                statusEl.className = 'comp-status warning';
                break;
            case 31: // OPEN
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#f59e0b" stroke-width="2"><line x1="4" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="20" y2="12"/><circle cx="12" cy="12" r="2"/></svg>`;
                typeName = 'Open Circuit';
                value = '> 10 MΩ';
                statusEl.innerText = 'Open circuit';
                statusEl.className = 'comp-status warning';
                break;
            default:
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
                typeName = `Unknown (type ${r.type})`;
                value = '-';
                statusEl.innerText = 'Unknown component';
                statusEl.className = 'comp-status error';
        }

        compLog(`[DISPLAY] ${typeName}: ${value} ${secondary ? '(' + secondary.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + ')' : ''} [${probeMap}]`, 'calc');

        if (resultIcon) resultIcon.innerHTML = icon;
        if (resultType) resultType.innerText = typeName;
        if (resultValue) resultValue.innerText = value;
        if (resultSecondary) resultSecondary.innerHTML = secondary;
        if (compProbeMap) compProbeMap.innerText = probeMap;

        // Build pinout diagram for all detected components
        if (resultPinout) {
            if (r.type === 10) { // Resistor
                resultPinout.innerHTML = buildResistorDiagram(r);
                resultPinout.style.display = 'block';
            } else if (r.type === 11) { // Capacitor
                const isPol = (r.flags & 0x20) !== 0;
                let cVal = r.value1;
                if (r.vloss > 0 && r.value1 >= 1000000) {
                    const vlossFraction = (r.vloss / 10.0) / 100.0;
                    const lossDeduction = Math.min(0.35, vlossFraction);
                    cVal = Math.round(r.value1 * (1.0 - lossDeduction));
                }
                resultPinout.innerHTML = buildCapacitorDiagram(r.pinA, r.pinB, cVal, isPol);
                resultPinout.style.display = 'block';
            } else if (r.type === 12) { // Inductor
                resultPinout.innerHTML = buildInductorDiagram(r.pinA, r.pinB, r.value1 / 1000.0);
                resultPinout.style.display = 'block';
            } else if (r.type === 20) { // Diode
                resultPinout.innerHTML = buildDiodeDiagram(r.pinA, r.pinB);
                resultPinout.style.display = 'block';
            } else if (r.type === 21) { // BJT
                const isNPN = r.flags & 0x01;
                resultPinout.innerHTML = buildBJTDiagram(isNPN, r.pinA, r.pinB, r.pinC);
                resultPinout.style.display = 'block';
            } else if (r.type === 22) { // MOSFET
                const isPch = (r.flags & 0x08) !== 0;
                const isEnhancement = (r.flags & 0x10) !== 0;
                resultPinout.innerHTML = buildMOSFETDiagram(isPch, isEnhancement, r.pinA, r.pinB, r.pinC);
                resultPinout.style.display = 'block';
            } else {
                resultPinout.style.display = 'none';
            }
        }
    }

    // Calculate standard 4-band EIA/IEC resistor color code
    function getResistorColorBands(val_ohm) {
        if (!val_ohm || val_ohm <= 0) return null;

        const DIGIT_COLORS = [
            { name: 'Black', hex: '#1e293b', border: '#475569' },  // 0
            { name: 'Brown', hex: '#854d0e', border: '#a16207' },  // 1
            { name: 'Red', hex: '#ef4444', border: '#f87171' },    // 2
            { name: 'Orange', hex: '#f97316', border: '#fb923c' }, // 3
            { name: 'Yellow', hex: '#eab308', border: '#facc15' }, // 4
            { name: 'Green', hex: '#22c55e', border: '#4ade80' },  // 5
            { name: 'Blue', hex: '#3b82f6', border: '#60a5fa' },   // 6
            { name: 'Violet', hex: '#a855f7', border: '#c084fc' }, // 7
            { name: 'Gray', hex: '#64748b', border: '#94a3b8' },   // 8
            { name: 'White', hex: '#f8fafc', border: '#cbd5e1' }   // 9
        ];

        const MULT_COLORS = {
            '-2': { name: 'Silver', hex: '#cbd5e1', border: '#e2e8f0' },
            '-1': { name: 'Gold', hex: '#eab308', border: '#fde047' },
            '0': DIGIT_COLORS[0],
            '1': DIGIT_COLORS[1],
            '2': DIGIT_COLORS[2],
            '3': DIGIT_COLORS[3],
            '4': DIGIT_COLORS[4],
            '5': DIGIT_COLORS[5],
            '6': DIGIT_COLORS[6],
            '7': DIGIT_COLORS[7],
            '8': DIGIT_COLORS[8],
            '9': DIGIT_COLORS[9]
        };

        const TOLERANCE_BAND = { name: 'Gold', hex: '#eab308', border: '#fde047' };

        let exp = Math.floor(Math.log10(val_ohm));
        let norm = val_ohm / Math.pow(10, exp);
        let sig2 = Math.round(norm * 10);
        let multExp = exp - 1;
        if (sig2 >= 100) {
            sig2 = Math.round(sig2 / 10);
            multExp += 1;
        }
        if (sig2 < 10) sig2 = 10;

        let d1 = Math.floor(sig2 / 10);
        let d2 = sig2 % 10;

        let b1 = DIGIT_COLORS[d1] || DIGIT_COLORS[1];
        let b2 = DIGIT_COLORS[d2] || DIGIT_COLORS[0];
        let b3 = MULT_COLORS[multExp.toString()] || MULT_COLORS['0'];
        let b4 = TOLERANCE_BAND;

        return [b1, b2, b3, b4];
    }

    // Build SVG schematic diagrams
    function buildResistorDiagram(r) {
        const probes = ['TP1 (PA7)', 'TP2 (PA6)', 'TP3 (PA5)'];
        let rOffset = 0;
        if (typeof window.Calibration !== 'undefined' && window.Calibration.compOffsetR) {
            rOffset = window.Calibration.compOffsetR;
        }
        const r1_ohm = Math.max(0, r.value1 - rOffset) / 100.0;
        const bands1 = getResistorColorBands(r1_ohm) || [
            { name: 'Brown', hex: '#854d0e', border: '#a16207' },
            { name: 'Black', hex: '#1e293b', border: '#475569' },
            { name: 'Red', hex: '#ef4444', border: '#f87171' },
            { name: 'Gold', hex: '#eab308', border: '#fde047' }
        ];

        if (r.value2 > 0) {
            const r2_ohm = Math.max(0, r.value2 - rOffset) / 100.0;
            const bands2 = getResistorColorBands(r2_ohm) || bands1;

            // Dual Resistor schematic (3 probes) with realistic color bands
            return `<svg viewBox="0 0 280 115" class="comp-schematic">
                <!-- Leads -->
                <line x1="15" y1="48" x2="38" y2="48" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round"/>
                <line x1="118" y1="48" x2="162" y2="48" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
                <line x1="242" y1="48" x2="265" y2="48" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round"/>
                
                <!-- R1 Body (Beige ceramic) -->
                <rect x="38" y="34" width="80" height="28" fill="#e2d5c3" stroke="#a89f91" stroke-width="1.5" rx="4"/>
                <rect x="36" y="32" width="8" height="32" fill="#d6c7b2" stroke="#a89f91" stroke-width="1" rx="2"/>
                <rect x="112" y="32" width="8" height="32" fill="#d6c7b2" stroke="#a89f91" stroke-width="1" rx="2"/>
                <!-- R1 Bands -->
                <rect x="52" y="33" width="6" height="30" fill="${bands1[0].hex}" stroke="${bands1[0].border}" rx="1"/>
                <rect x="66" y="34" width="6" height="28" fill="${bands1[1].hex}" stroke="${bands1[1].border}" rx="1"/>
                <rect x="80" y="34" width="6" height="28" fill="${bands1[2].hex}" stroke="${bands1[2].border}" rx="1"/>
                <rect x="96" y="33" width="6" height="30" fill="${bands1[3].hex}" stroke="${bands1[3].border}" rx="1"/>

                <!-- R2 Body (Beige ceramic) -->
                <rect x="162" y="34" width="80" height="28" fill="#e2d5c3" stroke="#a89f91" stroke-width="1.5" rx="4"/>
                <rect x="160" y="32" width="8" height="32" fill="#d6c7b2" stroke="#a89f91" stroke-width="1" rx="2"/>
                <rect x="236" y="32" width="8" height="32" fill="#d6c7b2" stroke="#a89f91" stroke-width="1" rx="2"/>
                <!-- R2 Bands -->
                <rect x="176" y="33" width="6" height="30" fill="${bands2[0].hex}" stroke="${bands2[0].border}" rx="1"/>
                <rect x="190" y="34" width="6" height="28" fill="${bands2[1].hex}" stroke="${bands2[1].border}" rx="1"/>
                <rect x="204" y="34" width="6" height="28" fill="${bands2[2].hex}" stroke="${bands2[2].border}" rx="1"/>
                <rect x="220" y="33" width="6" height="30" fill="${bands2[3].hex}" stroke="${bands2[3].border}" rx="1"/>

                <!-- Probe labels -->
                <text x="5" y="20" fill="#f8fafc" font-size="10" font-weight="bold" text-anchor="start">${probes[r.pinA]}</text>
                <text x="140" y="20" fill="#38bdf8" font-size="10" font-weight="bold" text-anchor="middle">${probes[r.pinB]}</text>
                <text x="275" y="20" fill="#f8fafc" font-size="10" font-weight="bold" text-anchor="end">${probes[r.pinC]}</text>

                <!-- Values & Color codes -->
                <text x="78" y="78" fill="#f59e0b" font-size="11" font-weight="bold" text-anchor="middle">R1: ${formatResistance(r.value1)}</text>
                <text x="78" y="96" fill="#94a3b8" font-size="8.5" font-weight="600" text-anchor="middle">${bands1.map(b => b.name).join(' • ')}</text>
                
                <text x="202" y="78" fill="#10b981" font-size="11" font-weight="bold" text-anchor="middle">R2: ${formatResistance(r.value2)}</text>
                <text x="202" y="96" fill="#94a3b8" font-size="8.5" font-weight="600" text-anchor="middle">${bands2.map(b => b.name).join(' • ')}</text>
            </svg>`;
        } else {
            // Single Resistor schematic with dynamic color bands
            return `<svg viewBox="0 0 240 105" class="comp-schematic">
                <!-- Metal leads -->
                <line x1="15" y1="45" x2="65" y2="45" stroke="#94a3b8" stroke-width="3" stroke-linecap="round"/>
                <line x1="175" y1="45" x2="225" y2="45" stroke="#94a3b8" stroke-width="3" stroke-linecap="round"/>

                <!-- Resistor Body (Beige ceramic with end caps) -->
                <rect x="65" y="28" width="110" height="34" fill="#e2d5c3" stroke="#a89f91" stroke-width="1.5" rx="6"/>
                <rect x="62" y="25" width="12" height="40" fill="#d6c7b2" stroke="#a89f91" stroke-width="1.2" rx="3"/>
                <rect x="166" y="25" width="12" height="40" fill="#d6c7b2" stroke="#a89f91" stroke-width="1.2" rx="3"/>

                <!-- Dynamic Color bands -->
                <rect x="83" y="27" width="8" height="36" fill="${bands1[0].hex}" stroke="${bands1[0].border}" rx="1"/>
                <rect x="103" y="28" width="8" height="34" fill="${bands1[1].hex}" stroke="${bands1[1].border}" rx="1"/>
                <rect x="123" y="28" width="8" height="34" fill="${bands1[2].hex}" stroke="${bands1[2].border}" rx="1"/>
                <rect x="148" y="27" width="8" height="36" fill="${bands1[3].hex}" stroke="${bands1[3].border}" rx="1"/>

                <!-- Pin labels -->
                <text x="15" y="18" fill="#f8fafc" font-size="11" font-weight="bold" text-anchor="start">${probes[r.pinA]}</text>
                <text x="225" y="18" fill="#f8fafc" font-size="11" font-weight="bold" text-anchor="end">${probes[r.pinB]}</text>
                
                <!-- Value and Color names legend -->
                <text x="120" y="80" fill="#38bdf8" font-size="12" font-weight="bold" text-anchor="middle">${formatResistance(r.value1)}</text>
                <text x="120" y="96" fill="#94a3b8" font-size="9.5" font-weight="600" text-anchor="middle">${bands1.map(b => b.name).join(' • ')}</text>
            </svg>`;
        }
    }

    function buildCapacitorDiagram(pinA, pinB, pF, isPol = false) {
        const probes = ['TP1 (PA7)', 'TP2 (PA6)', 'TP3 (PA5)'];
        const leftPin = Math.min(pinA, pinB);
        const rightPin = Math.max(pinA, pinB);

        let polaritySign = '';
        if (isPol) {
            if (pinA === leftPin) {
                polaritySign = '<text x="82" y="32" fill="#22c55e" font-size="14" font-weight="bold">+</text>';
            } else {
                polaritySign = '<text x="131" y="32" fill="#22c55e" font-size="14" font-weight="bold">+</text>';
            }
        }

        return `<svg viewBox="0 0 220 90" class="comp-schematic">
            <!-- Left lead -->
            <line x1="20" y1="45" x2="95" y2="45" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
            <!-- Plate 1 -->
            <line x1="95" y1="20" x2="95" y2="70" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round"/>
            <!-- Plate 2 -->
            <line x1="125" y1="20" x2="125" y2="70" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round"/>
            <!-- Right lead -->
            <line x1="125" y1="45" x2="200" y2="45" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
            <!-- Polarity indicator -->
            ${polaritySign}
            <!-- Pin labels -->
            <text x="5" y="20" fill="#f8fafc" font-size="11" font-weight="bold" text-anchor="start">${probes[leftPin]}</text>
            <text x="215" y="20" fill="#f8fafc" font-size="11" font-weight="bold" text-anchor="end">${probes[rightPin]}</text>
            <text x="110" y="80" fill="#38bdf8" font-size="12" font-weight="bold" text-anchor="middle">${formatCapacitance(pF)}</text>
        </svg>`;
    }

    function buildInductorDiagram(pinA, pinB, uH) {
        const probes = ['TP1 (PA7)', 'TP2 (PA6)', 'TP3 (PA5)'];
        return `<svg viewBox="0 0 220 90" class="comp-schematic">
            <line x1="20" y1="45" x2="50" y2="45" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M50 45 C50 22, 70 22, 70 45 C70 22, 90 22, 90 45 C90 22, 110 22, 110 45 C110 22, 130 22, 130 45 C130 22, 150 22, 150 45 C150 22, 170 22, 170 45" fill="none" stroke="#38bdf8" stroke-width="2.5"/>
            <line x1="170" y1="45" x2="200" y2="45" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
            <circle cx="20" cy="45" r="4" fill="#38bdf8"/>
            <circle cx="200" cy="45" r="4" fill="#38bdf8"/>
            <!-- Pin labels -->
            <text x="5" y="20" fill="#f8fafc" font-size="11" font-weight="bold" text-anchor="start">${probes[pinA]}</text>
            <text x="215" y="20" fill="#f8fafc" font-size="11" font-weight="bold" text-anchor="end">${probes[pinB]}</text>
            <text x="110" y="80" fill="#38bdf8" font-size="12" font-weight="bold" text-anchor="middle">L = ${formatInductance(uH)}</text>
        </svg>`;
    }

    function buildDiodeDiagram(pinA, pinK) {
        const probes = ['TP1 (PA7)', 'TP2 (PA6)', 'TP3 (PA5)'];
        // Determine probe ordering (left = min index, right = max index)
        const pointsRight = pinA < pinK;

        const leftPin = Math.min(pinA, pinK);
        const rightPin = Math.max(pinA, pinK);

        const leftIsAnode = (leftPin === pinA);
        const leftLabel = (leftIsAnode ? 'A: ' : 'K: ') + probes[leftPin];
        const rightLabel = (leftIsAnode ? 'K: ' : 'A: ') + probes[rightPin];

        const leftColor = leftIsAnode ? '#22c55e' : '#ef4444';
        const rightColor = leftIsAnode ? '#ef4444' : '#22c55e';

        if (pointsRight) {
            // Anode on Left, Cathode on Right -> Arrow points RIGHT ▶
            return `<svg viewBox="0 0 220 90" class="comp-schematic">
                <line x1="20" y1="45" x2="75" y2="45" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
                <polygon points="75,25 75,65 125,45" fill="rgba(56, 189, 248, 0.2)" stroke="#38bdf8" stroke-width="2.5"/>
                <line x1="125" y1="25" x2="125" y2="65" stroke="#ef4444" stroke-width="3.5" stroke-linecap="round"/>
                <line x1="125" y1="45" x2="200" y2="45" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
                <text x="20" y="20" fill="${leftColor}" font-size="11" font-weight="bold" text-anchor="middle">${leftLabel}</text>
                <text x="200" y="20" fill="${rightColor}" font-size="11" font-weight="bold" text-anchor="middle">${rightLabel}</text>
                <text x="110" y="80" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="middle">Diode (A → K)</text>
            </svg>`;
        } else {
            // Anode on Right, Cathode on Left -> Arrow points LEFT ◀
            return `<svg viewBox="0 0 220 90" class="comp-schematic">
                <line x1="20" y1="45" x2="95" y2="45" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
                <line x1="95" y1="25" x2="95" y2="65" stroke="#ef4444" stroke-width="3.5" stroke-linecap="round"/>
                <polygon points="145,25 145,65 95,45" fill="rgba(56, 189, 248, 0.2)" stroke="#38bdf8" stroke-width="2.5"/>
                <line x1="145" y1="45" x2="200" y2="45" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
                <text x="20" y="20" fill="${leftColor}" font-size="11" font-weight="bold" text-anchor="middle">${leftLabel}</text>
                <text x="200" y="20" fill="${rightColor}" font-size="11" font-weight="bold" text-anchor="middle">${rightLabel}</text>
                <text x="110" y="80" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="middle">Diode (K ← A)</text>
            </svg>`;
        }
    }

    function buildBJTDiagram(isNPN, pinB, pinC, pinE) {
        const probes = ['TP1 (PA7)', 'TP2 (PA6)', 'TP3 (PA5)'];
        return `<svg viewBox="0 0 220 180" class="comp-schematic">
            <!-- Circle boundary -->
            <circle cx="110" cy="80" r="55" fill="rgba(56, 189, 248, 0.05)" stroke="rgba(56, 189, 248, 0.3)" stroke-width="1.5" stroke-dasharray="4,3"/>
            <!-- Base lead & bar -->
            <line x1="20" y1="80" x2="80" y2="80" stroke="#38bdf8" stroke-width="2.5"/>
            <line x1="80" y1="45" x2="80" y2="115" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>
            <!-- Collector lead -->
            <line x1="80" y1="58" x2="140" y2="30" stroke="#38bdf8" stroke-width="2.5"/>
            <line x1="140" y1="30" x2="200" y2="30" stroke="#38bdf8" stroke-width="2.5"/>
            <!-- Emitter lead -->
            <line x1="80" y1="102" x2="140" y2="130" stroke="#38bdf8" stroke-width="2.5"/>
            <line x1="140" y1="130" x2="200" y2="130" stroke="#38bdf8" stroke-width="2.5"/>
            <!-- Arrow -->
            ${isNPN
                ? '<polygon points="122,122 140,130 128,112" fill="#38bdf8"/>'
                : '<polygon points="98,108 80,102 92,118" fill="#38bdf8"/>'}
            <!-- Pin labels -->
            <text x="20" y="65" fill="#38bdf8" font-size="11" font-weight="bold">Base (B)</text>
            <text x="20" y="98" fill="#94a3b8" font-size="10">${probes[pinB]}</text>

            <text x="200" y="20" fill="#38bdf8" font-size="11" font-weight="bold" text-anchor="end">Collector (C)</text>
            <text x="200" y="45" fill="#94a3b8" font-size="10" text-anchor="end">${probes[pinC]}</text>

            <text x="200" y="122" fill="#38bdf8" font-size="11" font-weight="bold" text-anchor="end">Emitter (E)</text>
            <text x="200" y="144" fill="#94a3b8" font-size="10" text-anchor="end">${probes[pinE]}</text>

            <text x="110" y="172" fill="#f59e0b" font-size="13" font-weight="bold" text-anchor="middle">${isNPN ? 'BJT NPN' : 'BJT PNP'}</text>
        </svg>`;
    }

    function buildMOSFETDiagram(isPch, isEnhancement, pinG, pinD, pinS) {
        const probes = ['TP1 (PA7)', 'TP2 (PA6)', 'TP3 (PA5)'];
        const chStr = isPch ? 'P-CH' : 'N-CH';
        const modeStr = isEnhancement ? 'ENH' : 'DEP';

        return `<svg viewBox="0 0 220 180" class="comp-schematic">
            <!-- Circle boundary -->
            <circle cx="110" cy="80" r="55" fill="rgba(56, 189, 248, 0.05)" stroke="rgba(56, 189, 248, 0.3)" stroke-width="1.5" stroke-dasharray="4,3"/>
            
            <!-- Gate lead & Insulated Bar -->
            <line x1="20" y1="80" x2="72" y2="80" stroke="#38bdf8" stroke-width="2.5"/>
            <line x1="72" y1="45" x2="72" y2="115" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>
            
            <!-- Channel Bars (segmented for Enhancement) -->
            ${isEnhancement
                ? '<line x1="80" y1="48" x2="80" y2="64" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round"/><line x1="80" y1="72" x2="80" y2="88" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round"/><line x1="80" y1="96" x2="80" y2="112" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round"/>'
                : '<line x1="80" y1="48" x2="80" y2="112" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round"/>'
            }
            
            <!-- Drain lead -->
            <line x1="80" y1="56" x2="140" y2="56" stroke="#38bdf8" stroke-width="2.5"/>
            <line x1="140" y1="56" x2="140" y2="30" stroke="#38bdf8" stroke-width="2.5"/>
            <line x1="140" y1="30" x2="200" y2="30" stroke="#38bdf8" stroke-width="2.5"/>
            
            <!-- Source lead & Substrate tie -->
            <line x1="80" y1="104" x2="140" y2="104" stroke="#38bdf8" stroke-width="2.5"/>
            <line x1="140" y1="104" x2="140" y2="130" stroke="#38bdf8" stroke-width="2.5"/>
            <line x1="140" y1="130" x2="200" y2="130" stroke="#38bdf8" stroke-width="2.5"/>
            
            <!-- Substrate / Bulk center line -->
            <line x1="80" y1="80" x2="140" y2="80" stroke="#38bdf8" stroke-width="2.5"/>
            <line x1="140" y1="80" x2="140" y2="104" stroke="#38bdf8" stroke-width="2.5"/>
            
            <!-- Substrate Arrow (N-Ch points IN towards channel, P-Ch points OUT) -->
            ${!isPch
                ? '<polygon points="86,80 102,73 102,87" fill="#38bdf8"/>'
                : '<polygon points="106,80 90,73 90,87" fill="#38bdf8"/>'}
            
            <!-- Pin labels -->
            <text x="20" y="65" fill="#38bdf8" font-size="11" font-weight="bold">Gate (G)</text>
            <text x="20" y="98" fill="#94a3b8" font-size="10">${probes[pinG]}</text>

            <text x="200" y="20" fill="#38bdf8" font-size="11" font-weight="bold" text-anchor="end">Drain (D)</text>
            <text x="200" y="45" fill="#94a3b8" font-size="10" text-anchor="end">${probes[pinD]}</text>

            <text x="200" y="122" fill="#38bdf8" font-size="11" font-weight="bold" text-anchor="end">Source (S)</text>
            <text x="200" y="144" fill="#94a3b8" font-size="10" text-anchor="end">${probes[pinS]}</text>

            <!-- Bottom title in gold -->
            <text x="110" y="172" fill="#f59e0b" font-size="13" font-weight="bold" text-anchor="middle">MOSFET ${chStr} ${modeStr}</text>
        </svg>`;
    }
});
