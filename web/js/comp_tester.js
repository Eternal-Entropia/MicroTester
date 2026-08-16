// Component Tester Controller for MicroTester

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

    // Start test (Normal)
    if (btnTest) {
        btnTest.addEventListener('click', () => {
            if (!microTester.device) return alert('Connect USB first!');
            stopActiveInstruments();
            testing = true;
            updateCompIndicator(true);
            statusEl.innerText = '🔄 Testing...';
            statusEl.className = 'comp-status testing';
            resultArea.style.display = 'none';
            btnTest.disabled = true;
            if (btnSmallCap) btnSmallCap.disabled = true;
            microTester.sendCommand(CMD_COMP_TEST, new Uint8Array([0])); // Mode = 0
            // Timeout after 40 seconds (allows large capacitor charging & discharging)
            setTimeout(() => {
                if (testing) {
                    testing = false;
                    updateCompIndicator(false);
                    statusEl.innerText = '⏱ Timeout — no response';
                    statusEl.className = 'comp-status error';
                    btnTest.disabled = false;
                    if (btnSmallCap) btnSmallCap.disabled = false;
                }
            }, 40000);
        });
    }

    // Start test (Small Cap Mode)
    if (btnSmallCap) {
        btnSmallCap.addEventListener('click', () => {
            if (!microTester.device) return alert('Connect USB first!');
            stopActiveInstruments();
            testing = true;
            updateCompIndicator(true);
            statusEl.innerText = '⚡ Testing Small Cap...';
            statusEl.className = 'comp-status testing';
            resultArea.style.display = 'none';
            btnTest.disabled = true;
            btnSmallCap.disabled = true;
            microTester.sendCommand(CMD_COMP_TEST, new Uint8Array([1])); // Mode = 1
            setTimeout(() => {
                if (testing) {
                    testing = false;
                    updateCompIndicator(false);
                    statusEl.innerText = '⏱ Timeout — no response';
                    statusEl.className = 'comp-status error';
                    btnTest.disabled = false;
                    btnSmallCap.disabled = false;
                }
            }, 40000);
        });
    }

    // Cancel test
    if (btnStop) {
        btnStop.addEventListener('click', () => {
            microTester.sendCommand(CMD_COMP_STOP);
            testing = false;
            updateCompIndicator(false);
            statusEl.innerText = 'Cancelled';
            statusEl.className = 'comp-status idle';
            btnTest.disabled = false;
        });
    }
    
    // Data listener for component test results
    microTester.addDataListener((data) => {
        if (!testing) return;
        if (data.length < 3) return;
        
        const pktType = data[0];
        const pktLen = data[1] | (data[2] << 8);
        
        if (pktType !== PKT_COMP_RESULT) return;
        // CompResult payload = 18 usable bytes + 2 struct padding (ARM EABI);
        // firmware reports sizeof() in the header. Floored at 18 so flags is readable.
        const resultLen = Math.min(Math.max(pktLen, 18), 32);
        if (data.length < 3 + resultLen) return;
        
        const payload = data.slice(3, 3 + resultLen);
        const result = parseCompResult(payload);
        testing = false;
        updateCompIndicator(false);
        btnTest.disabled = false;
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
            flags: (dv.byteLength >= 18) ? dv.getUint16(16, true) : 0
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
                let rlA = 680, rlB = 680, rlC = 680;
                let rhA = 470000, rhB = 470000, rhC = 470000;
                if (typeof window.Calibration !== 'undefined') {
                    if (window.Calibration.compOffsetR) rOffset = window.Calibration.compOffsetR;
                    if (window.Calibration.compRL) {
                        rlA = window.Calibration.compRL[r.pinA] || 680;
                        rlB = window.Calibration.compRL[r.pinB] || 680;
                        if (r.pinC < 3) rlC = window.Calibration.compRL[r.pinC] || 680;
                    }
                    if (window.Calibration.compRH) {
                        rhA = window.Calibration.compRH[r.pinA] || 470000;
                        rhB = window.Calibration.compRH[r.pinB] || 470000;
                        if (r.pinC < 3) rhC = window.Calibration.compRH[r.pinC] || 470000;
                    }
                }
                
                // Calibration scaling factor for resistor measurement
                // RL range (<= 138.6kOhm): nominal sum is 680 + 680 = 1360 Ohms
                // RH range (> 138.6kOhm): nominal sum is 470k + 470k = 940000 Ohms
                let r1_raw = r.value1 / 100;
                const scale1 = (r1_raw > 138600) ? ((rhA + rhB) / 940000.0) : ((rlA + rlB) / 1360.0);
                const r1 = Math.max(0, (r.value1 * scale1) - rOffset);
                
                if (r.value2 > 0) {
                    let r2_raw = r.value2 / 100;
                    const scale2 = (r2_raw > 138600) ? ((rhB + rhC) / 940000.0) : ((rlB + rlC) / 1360.0);
                    const r2 = Math.max(0, (r.value2 * scale2) - rOffset);
                    
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
                typeName = 'Capacitor';
                value = formatCapacitance(r.value1);
                if (r.value2 > 0) secondary = `ESR: ${(r.value2/100).toFixed(1)} Ω (1 kHz)`;
                probeMap = `+ ${probeLabels[r.pinA]}  — ${probeLabels[r.pinB]}`;
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
                let rlA2 = 680, rlB2 = 680;
                if (typeof window.Calibration !== 'undefined') {
                    if (window.Calibration.compOffsetR) rOffset2 = window.Calibration.compOffsetR;
                    if (window.Calibration.compRL) {
                        rlA2 = window.Calibration.compRL[r.pinA] || 680;
                        rlB2 = window.Calibration.compRL[r.pinB] || 680;
                    }
                }
                
                // Scale Rdc with RL calibration and subtract probe lead resistance (identical to Resistor)
                let scaleRdc2 = (rlA2 + rlB2) / 1360.0;
                let rawRdcVal2 = Math.max(0, (r.value2 * scaleRdc2) - rOffset2);
                let Rdc2 = rawRdcVal2 / 100.0;
                
                let freqHz = r.value3 || 100000;
                let L_henry = L_uH / 1000000.0;
                
                // Inductive Reactance XL = 2 * pi * f * L
                let XL = 2.0 * Math.PI * freqHz * L_henry;
                let xlStr = (XL >= 1000) ? (XL / 1000).toFixed(1) + ' kΩ' : XL.toFixed(1) + ' Ω';
                
                // Estimated Self-Resonant Frequency (SRF / f_res) with parasitic C ~ 30 pF
                let fRes = 1.0 / (2.0 * Math.PI * Math.sqrt(L_henry * 30.0e-12));
                let fResStr = (fRes >= 1000000) ? (fRes / 1000000).toFixed(2) + ' MHz' : (fRes >= 1000) ? (fRes / 1000).toFixed(1) + ' kHz' : fRes.toFixed(0) + ' Hz';
                
                let testFreqStr = (freqHz >= 1000000) ? (freqHz / 1000000).toFixed(0) + ' MHz' : (freqHz >= 1000) ? (freqHz / 1000).toFixed(0) + ' kHz' : freqHz + ' Hz';
                
                if (Rdc2 < 0.05) {
                    secondary = `R_dc: < 0.1 Ω  |  X_L = ${xlStr}  |  f_res ≈ ${fResStr} (@ ${testFreqStr})`;
                } else {
                    let fKHz = freqHz / 1000.0;
                    let rac = Rdc2 * (1.0 + 0.15 * Math.sqrt(fKHz));
                    let Q = XL / rac;
                    let qStr = (Q >= 100) ? Q.toFixed(0) : Q.toFixed(1);
                    secondary = `R_dc: ${Rdc2.toFixed(2)} Ω  |  X_L = ${xlStr}  |  Q = ${qStr}  |  f_res ≈ ${fResStr} (@ ${testFreqStr})`;
                }
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
        
        if (resultIcon) resultIcon.innerHTML = icon;
        if (resultType) resultType.innerText = typeName;
        if (resultValue) resultValue.innerText = value;
        if (resultSecondary) resultSecondary.innerText = secondary;
        if (compProbeMap) compProbeMap.innerText = probeMap;
        
        // Build pinout diagram for all detected components
        if (resultPinout) {
            if (r.type === 10) { // Resistor
                resultPinout.innerHTML = buildResistorDiagram(r);
                resultPinout.style.display = 'block';
            } else if (r.type === 11) { // Capacitor
                resultPinout.innerHTML = buildCapacitorDiagram(r.pinA, r.pinB, r.value1);
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
    
    // Build SVG schematic diagrams
    function buildResistorDiagram(r) {
        const probes = ['TP1 (PA7)', 'TP2 (PA6)', 'TP3 (PA5)'];
        if (r.value2 > 0) {
            // Dual Resistor schematic (3 probes)
            return `<svg viewBox="0 0 220 100" class="comp-schematic">
                <line x1="20" y1="50" x2="45" y2="50" stroke="#38bdf8" stroke-width="2"/>
                <rect x="45" y="38" width="50" height="24" fill="rgba(56, 189, 248, 0.1)" stroke="#38bdf8" stroke-width="2" rx="3"/>
                <line x1="95" y1="50" x2="125" y2="50" stroke="#38bdf8" stroke-width="2"/>
                <rect x="125" y="38" width="50" height="24" fill="rgba(56, 189, 248, 0.1)" stroke="#38bdf8" stroke-width="2" rx="3"/>
                <line x1="175" y1="50" x2="200" y2="50" stroke="#38bdf8" stroke-width="2"/>
                <text x="5" y="25" fill="#f8fafc" font-size="10" font-weight="bold" text-anchor="start">${probes[r.pinA]}</text>
                <text x="110" y="25" fill="#38bdf8" font-size="10" font-weight="bold" text-anchor="middle">${probes[r.pinB]}</text>
                <text x="215" y="25" fill="#f8fafc" font-size="10" font-weight="bold" text-anchor="end">${probes[r.pinC]}</text>
                <text x="70" y="80" fill="#f59e0b" font-size="10" font-weight="bold" text-anchor="middle">R1: ${formatResistance(r.value1)}</text>
                <text x="150" y="80" fill="#10b981" font-size="10" font-weight="bold" text-anchor="middle">R2: ${formatResistance(r.value2)}</text>
            </svg>`;
        } else {
            // Single Resistor schematic
            return `<svg viewBox="0 0 220 90" class="comp-schematic">
                <!-- Left lead -->
                <line x1="20" y1="45" x2="60" y2="45" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
                <!-- Resistor body (IEC rectangle) -->
                <rect x="60" y="30" width="100" height="30" fill="rgba(56, 189, 248, 0.1)" stroke="#38bdf8" stroke-width="2.5" rx="4"/>
                <!-- Color bands decoration -->
                <line x1="80" y1="30" x2="80" y2="60" stroke="#f59e0b" stroke-width="4"/>
                <line x1="100" y1="30" x2="100" y2="60" stroke="#ef4444" stroke-width="4"/>
                <line x1="120" y1="30" x2="120" y2="60" stroke="#10b981" stroke-width="4"/>
                <line x1="140" y1="30" x2="140" y2="60" stroke="#a855f7" stroke-width="3"/>
                <!-- Right lead -->
                <line x1="160" y1="45" x2="200" y2="45" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
                <!-- Pin labels -->
                <text x="5" y="20" fill="#f8fafc" font-size="11" font-weight="bold" text-anchor="start">${probes[r.pinA]}</text>
                <text x="215" y="20" fill="#f8fafc" font-size="11" font-weight="bold" text-anchor="end">${probes[r.pinB]}</text>
                <text x="110" y="78" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="middle">Resistor</text>
            </svg>`;
        }
    }

    function buildCapacitorDiagram(pinA, pinB, pF) {
        const probes = ['TP1 (PA7)', 'TP2 (PA6)', 'TP3 (PA5)'];
        const leftPin = Math.min(pinA, pinB);
        const rightPin = Math.max(pinA, pinB);
        
        let polaritySign = '';
        // Consider >= 1uF as electrolytic
        if (pF >= 1000000) {
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
