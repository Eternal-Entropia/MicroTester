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
    
    // Start test (Normal)
    if (btnTest) {
        btnTest.addEventListener('click', () => {
            if (!microTester.device) return alert('Connect USB first!');
            testing = true;
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
            testing = true;
            statusEl.innerText = '⚡ Testing Small Cap...';
            statusEl.className = 'comp-status testing';
            resultArea.style.display = 'none';
            btnTest.disabled = true;
            btnSmallCap.disabled = true;
            microTester.sendCommand(CMD_COMP_TEST, new Uint8Array([1])); // Mode = 1
            setTimeout(() => {
                if (testing) {
                    testing = false;
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
        if (data.length < 3 + 16) return;
        
        const payload = data.slice(3, 3 + 16);
        const result = parseCompResult(payload);
        testing = false;
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
            flags: dv.getUint16(12, true)
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
                if (r.value2 > 0) {
                    typeName = 'Dual Resistors';
                    value = `R1 = ${formatResistance(r.value1)}`;
                    secondary = `R2 = ${formatResistance(r.value2)}`;
                    probeMap = `R1: ${probeLabels[r.pinA]} ⟷ ${probeLabels[r.pinB]}  |  R2: ${probeLabels[r.pinB]} ⟷ ${probeLabels[r.pinC]}`;
                } else {
                    typeName = 'Resistor';
                    value = formatResistance(r.value1);
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
            case 20: // COMP_DIODE
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#38bdf8" stroke-width="2"><line x1="2" y1="12" x2="8" y2="12"/><polygon points="8,6 8,18 16,12" fill="rgba(56,189,248,0.2)"/><line x1="16" y1="6" x2="16" y2="18" stroke-width="3"/><line x1="16" y1="12" x2="22" y2="12"/></svg>`;
                typeName = 'Diode';
                value = `Vf = ${r.value1} mV`;
                
                let dType = 'LED';
                if (r.value1 < 450) dType = 'Schottky';
                else if (r.value1 < 900) dType = 'Silicon';
                else if (r.value1 < 1500) dType = 'Silicon / Germanium';
                
                secondary = `Type: ${dType}`;
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
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#38bdf8" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="9" y1="7" x2="9" y2="17" stroke-width="3"/><line x1="9" y1="9" x2="16" y2="5"/><line x1="9" y1="15" x2="16" y2="19"/></svg>`;
                typeName = `BJT (${isNPN ? 'NPN' : 'PNP'})`;
                value = `hFE = ${r.value1}`;
                secondary = `Vbe = ${r.value2} mV\nIceo = ${iceo} μA`;
                probeMap = `B: ${probeLabels[r.pinA]}  C: ${probeLabels[r.pinB]}  E: ${probeLabels[r.pinC]}`;
                statusEl.innerText = 'Component identified';
                statusEl.className = 'comp-status success';
                break;
            case 30: // SHORT
                icon = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`;
                typeName = 'Short Circuit';
                value = '< 1 Ω';
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
            } else if (r.type === 20) { // Diode
                resultPinout.innerHTML = buildDiodeDiagram(r.pinA, r.pinB);
                resultPinout.style.display = 'block';
            } else if (r.type === 21) { // BJT
                const isNPN = r.flags & 0x01;
                resultPinout.innerHTML = buildBJTDiagram(isNPN, r.pinA, r.pinB, r.pinC);
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
            <text x="110" y="82" fill="#94a3b8" font-size="11" font-weight="600" text-anchor="middle">Capacitor</text>
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
        return `<svg viewBox="0 0 220 160" class="comp-schematic">
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

            <text x="200" y="125" fill="#38bdf8" font-size="11" font-weight="bold" text-anchor="end">Emitter (E)</text>
            <text x="200" y="150" fill="#94a3b8" font-size="10" text-anchor="end">${probes[pinE]}</text>

            <text x="110" y="155" fill="#f59e0b" font-size="13" font-weight="bold" text-anchor="middle">${isNPN ? 'BJT NPN' : 'BJT PNP'}</text>
        </svg>`;
    }
});
