window.Calibration = {
    vDda: 3.30, // Default fallback
    zeroOffsets: [0, 0, 0, 0, 0],
    biasOffsets: [0, 0, 0, 0, 0],
    dividerOff: [11.0, 11.0, 11.0, 11.0, 11.0],
    dividerOn: [21.0, 21.0, 21.0, 21.0, 21.0],
    gainCorrection: [1.0, 1.0, 1.0, 1.0, 1.0], // fine-tune divider ratio (1.0 = nominal)
    _calibrationBusy: false,                   // mutex: blocks volt/osc while calibrating
    compOffsetR: 0, // Component Tester Short resistance offset (milliohms)
    compOffsetESR: 0, // Component Tester 1 kHz ESR Zero offset (milliohms)
    compESRManualTrim: 0, // Manual PC-side ESR trim in 0.01 ohm units (-500..+500 = -5.00..+5.00 ohm)
    compRL: [680, 680, 680], // Component Tester pull-down resistances for TP1, TP2, TP3
    compRH: [470000, 470000, 470000], // Component Tester 470k resistances for TP1, TP2, TP3

    init: function() {
        // Load saved VDDA / VREF from localStorage
        try {
            const savedVdda = localStorage.getItem('microtester_vdda');
            if (savedVdda) {
                const parsed = parseFloat(savedVdda);
                if (!isNaN(parsed) && parsed >= 2.0 && parsed <= 4.0) {
                    this.vDda = parsed;
                    console.log(`Loaded saved VDDA: ${this.vDda.toFixed(3)} V`);
                }
            }
        } catch (e) {
            console.error("Error loading VDDA from localStorage", e);
        }

        // Load saved offsets & dividers from localStorage
        try {
            const zo = localStorage.getItem('microtester_unified_zero_offsets');
            if (zo) this.zeroOffsets = JSON.parse(zo) || this.zeroOffsets;
            const bo = localStorage.getItem('microtester_unified_bias_offsets');
            if (bo) this.biasOffsets = JSON.parse(bo) || this.biasOffsets;

            const doff = localStorage.getItem('microtester_divider_off');
            if (doff) {
                const arr = JSON.parse(doff);
                if (Array.isArray(arr) && arr.length >= 5) this.dividerOff = [...arr];
            }
            const don = localStorage.getItem('microtester_divider_on');
            if (don) {
                const arr = JSON.parse(don);
                if (Array.isArray(arr) && arr.length >= 5) this.dividerOn = [...arr];
            }

            const gc = localStorage.getItem('microtester_gain_correction');
            if (gc) {
                const arr = JSON.parse(gc);
                if (Array.isArray(arr) && arr.length >= 5) this.gainCorrection = [...arr];
            }

            // Legacy migration from original zero_offsets
            const saved = localStorage.getItem('microtester_zero_offsets');
            if (saved && !zo) {
                const arr = JSON.parse(saved);
                if (Array.isArray(arr) && arr.length >= 5) {
                    this.zeroOffsets = [...arr];
                }
            }
        } catch (e) {
            console.error("Error loading offsets", e);
        }

        // Load saved Comp offset with validation
        try {
            const savedCompR = localStorage.getItem('microtester_comp_offset_r');
            if (savedCompR) {
                const parsedR = parseInt(savedCompR, 10);
                if (!isNaN(parsedR) && parsedR >= 0 && parsedR <= 5000) this.compOffsetR = parsedR;
            }
            const savedCompESR = localStorage.getItem('microtester_comp_offset_esr');
            if (savedCompESR) {
                const parsedESR = parseInt(savedCompESR, 10);
                if (!isNaN(parsedESR) && parsedESR >= 0 && parsedESR <= 5000) this.compOffsetESR = parsedESR;
            }
            const savedEsrTrim = localStorage.getItem('microtester_comp_esr_manual');
            if (savedEsrTrim !== null && savedEsrTrim !== '') {
                const parsedTrim = parseInt(savedEsrTrim, 10);
                if (!isNaN(parsedTrim) && parsedTrim >= -500 && parsedTrim <= 500) this.compESRManualTrim = parsedTrim;
            }
            const savedRL = localStorage.getItem('microtester_comp_RL');
            if (savedRL) {
                const arr = JSON.parse(savedRL);
                if (Array.isArray(arr) && arr.length >= 3) {
                    const valid = arr.map(v => (typeof v === 'number' && !isNaN(v) && v >= 300 && v <= 1000) ? v : 680);
                    this.compRL = valid;
                }
            }
            const savedRH = localStorage.getItem('microtester_comp_RH');
            if (savedRH) {
                const arr = JSON.parse(savedRH);
                if (Array.isArray(arr) && arr.length >= 3) {
                    const valid = arr.map(v => (typeof v === 'number' && !isNaN(v) && v >= 100000 && v <= 1000000) ? v : 470000);
                    this.compRH = valid;
                }
            }
        } catch (e) {
            this.compOffsetR = 0;
            this.compRL = [680, 680, 680];
            this.compRH = [470000, 470000, 470000];
        }

        // Listen for VREF data packet
        if (typeof microTester !== 'undefined') {
            microTester.addDataListener((data) => {
                if (!data || data.length < 5) return;
                const type = data[0];
                const len = data[1] | (data[2] << 8);
                if (type === 0x20 /* PKT_VREF_DATA */) {
                    const payload = data.slice(3, 3 + len);
                    let vref_raw = 0;
                    if (len === 2) {
                        vref_raw = payload[0] | (payload[1] << 8);
                    } else if (len === 4) {
                        const vref_sum = payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24);
                        vref_raw = vref_sum / 4096.0; // 4096 samples oversampling
                    }
                    if (vref_raw > 0) {
                        // V_DDA = 1.21V * 4095 / VREFINT_ADC
                        this.vDda = (1.21 * 4095) / vref_raw;
                        try {
                            localStorage.setItem('microtester_vdda', this.vDda.toString());
                        } catch (err) {}
                        console.log(`Measured VREF: ${vref_raw.toFixed(2)}, VDDA: ${this.vDda.toFixed(3)} V (Saved to localStorage)`);
                        
                        // Trigger UI update
                        window.dispatchEvent(new CustomEvent('calibration-vdda-updated', { detail: this.vDda }));
                    }
                }
                if (type === 0x50 /* PKT_COMP_RESULT */) {
                    if (window.Calibration._isCompCalibrating) {
                        window.Calibration._isCompCalibrating = false;
                        const payload = data.slice(3, 3 + len);
                        if (payload.length >= 16) {
                            const compType = payload[0];
                            if (compType === 30 /* COMP_SHORT */) {
                                if (payload[3] === 255) {
                                    const val1 = payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24);
                                    const val2 = payload[8] | (payload[9] << 8) | (payload[10] << 16) | (payload[11] << 24);
                                    const val3 = payload[12] | (payload[13] << 8) | (payload[14] << 16) | (payload[15] << 24);
                                    
                                    const RL0 = val1 & 0xFFFF;
                                    const RL1 = (val1 >> 16) & 0xFFFF;
                                    const RL2 = val2 & 0xFFFF;
                                    const wireR = (val2 >> 16) & 0xFFFF;
                                    const esrZero = (payload.length >= 18) ? (payload[16] | (payload[17] << 8)) : wireR;
                                    
                                    const RH1 = val3 & 0xFFFF;
                                    const RH2 = (val3 >> 16) & 0xFFFF;
                                    
                                    window.Calibration.compOffsetR = wireR;
                                    window.Calibration.compOffsetESR = esrZero;
                                    window.Calibration.compRL = [RL0 / 10, RL1 / 10, RL2 / 10];
                                    window.Calibration.compRH = [470000, RH1 * 10, RH2 * 10];
                                    
                                    localStorage.setItem('microtester_comp_offset_r', wireR.toString());
                                    localStorage.setItem('microtester_comp_offset_esr', esrZero.toString());
                                    localStorage.setItem('microtester_comp_RL', JSON.stringify(window.Calibration.compRL));
                                    localStorage.setItem('microtester_comp_RH', JSON.stringify(window.Calibration.compRH));
                                    window.dispatchEvent(new Event('comp-calib-updated'));
                                    
                                    if (typeof this._finishCompWizard === 'function') {
                                        this._finishCompWizard(wireR, esrZero, window.Calibration.compRL, window.Calibration.compRH, true);
                                    }
                                } else {
                                    const val1 = payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24);
                                    window.Calibration.compOffsetR = val1;
                                    localStorage.setItem('microtester_comp_offset_r', val1.toString());
                                    window.dispatchEvent(new Event('comp-calib-updated'));
                                    
                                    if (typeof this._finishCompWizard === 'function') {
                                        this._finishCompWizard(val1, val1, [680, 680, 680], [470000, 470000, 470000], false);
                                    }
                                }
                            } else {
                                if (typeof this._failCompWizard === 'function') {
                                    this._failCompWizard("Please make sure all 3 probes (TP1, TP2, TP3) are firmly shorted together!");
                                }
                            }
                        }
                    }
                }
            });
        }
    },

    requestVref: function() {
        if (typeof microTester !== 'undefined' && microTester.device) {
            microTester.sendCommand(CMD_GET_VREF);
        }
    },

    requestVrefPromise: function() {
        return new Promise((resolve) => {
            if (typeof microTester === 'undefined' || !microTester.device) {
                return resolve(this.vDda);
            }
            let handler = null;
            let timeoutId = null;

            const cleanup = () => {
                if (handler) window.removeEventListener('calibration-vdda-updated', handler);
                if (timeoutId) clearTimeout(timeoutId);
            };

            timeoutId = setTimeout(() => {
                cleanup();
                resolve(this.vDda);
            }, 3000);

            handler = (e) => {
                cleanup();
                resolve(e.detail || this.vDda);
            };

            window.addEventListener('calibration-vdda-updated', handler);
            this.requestVref();
        });
    },

    resetVdda: function() {
        this.vDda = 3.30;
        try {
            localStorage.removeItem('microtester_vdda');
        } catch (e) {}
        console.log("Reset VDDA to default: 3.300 V");
        window.dispatchEvent(new CustomEvent('calibration-vdda-updated', { detail: 3.30 }));
    },

    sendCompCalToFirmware: function() {
        if (typeof microTester === 'undefined' || !microTester.device) return;

        const vddaMv = Math.round((this.vDda || 3.30) * 1000);
        const rl = (this.compRL || [680, 680, 680]).map(v => Math.round((v || 680) * 10)); // into 0.1 ohm units
        const rh = (this.compRH || [470000, 470000, 470000]).map(v => Math.round(v || 470000)); // in 1 ohm units
        // ESR zero: loop switch+lead resistance from probe-short calibration.
        // compOffsetESR / compOffsetR is stored in 0.01 ohm units - same unit used by firmware
        const esrZeroX100 = Math.min(65000, Math.max(0, Math.round(this.compOffsetESR || this.compOffsetR || 0)));

        const buf = new Uint8Array(22);
        buf[0] = vddaMv & 0xFF;
        buf[1] = (vddaMv >> 8) & 0xFF;
        buf[2] = rl[0] & 0xFF; buf[3] = (rl[0] >> 8) & 0xFF;
        buf[4] = rl[1] & 0xFF; buf[5] = (rl[1] >> 8) & 0xFF;
        buf[6] = rl[2] & 0xFF; buf[7] = (rl[2] >> 8) & 0xFF;
        for (let i = 0; i < 3; i++) {
            const v = rh[i];
            const idx = 8 + i * 4;
            buf[idx] = v & 0xFF;
            buf[idx + 1] = (v >> 8) & 0xFF;
            buf[idx + 2] = (v >> 16) & 0xFF;
            buf[idx + 3] = (v >> 24) & 0xFF;
        }
        buf[20] = esrZeroX100 & 0xFF;
        buf[21] = (esrZeroX100 >> 8) & 0xFF;

        microTester.sendCommand(0x52 /* CMD_COMP_SET_CAL */, buf);
        console.log("Sent CMD_COMP_SET_CAL to STM32:", { vddaMv, rl, rh, esrZeroX100 });
    },

    setCompESRManual: function(x100) {
        let v = Math.round(x100 || 0);
        if (v < -500) v = -500;
        if (v > 500) v = 500;
        this.compESRManualTrim = v;
        try {
            localStorage.setItem('microtester_comp_esr_manual', String(v));
        } catch (e) {}
        window.dispatchEvent(new CustomEvent('comp-esr-trim-updated', { detail: v }));
    },

    adjustCompESRManual: function(deltaX100) {
        this.setCompESRManual((this.compESRManualTrim || 0) + (deltaX100 || 0));
    },

    // Store a software zero offset from a probe-referred voltage reading
    // (e.g. average of a captured frame with shorted probe).
    calibrateZero: function(biasEnabled, channel, probeVolts) {
        if (channel >= 0 && channel <= 4 && typeof probeVolts === 'number' && !isNaN(probeVolts)) {
            const divider = biasEnabled ? (this.dividerOn[channel] || 21.0) : (this.dividerOff[channel] || 11.0);
            // Convert probe-referred volts to ADC pin volts (virtual zero)
            const vz = (biasEnabled ? this.vDda / 2.0 : 0.0) + probeVolts / divider;
            if (biasEnabled) {
                this.biasOffsets[channel] = vz;
                localStorage.setItem('microtester_unified_bias_offsets', JSON.stringify(this.biasOffsets));
            } else {
                this.zeroOffsets[channel] = vz;
                localStorage.setItem('microtester_unified_zero_offsets', JSON.stringify(this.zeroOffsets));
            }
        }
    },

    resetZero: function(biasEnabled, channel) {
        if (channel >= 0 && channel <= 4) {
            if (biasEnabled) {
                this.biasOffsets[channel] = 0;
                this.dividerOn[channel] = 21.0;
                localStorage.setItem('microtester_unified_bias_offsets', JSON.stringify(this.biasOffsets));
                localStorage.setItem('microtester_divider_on', JSON.stringify(this.dividerOn));
            } else {
                this.zeroOffsets[channel] = 0;
                this.dividerOff[channel] = 11.0;
                localStorage.setItem('microtester_unified_zero_offsets', JSON.stringify(this.zeroOffsets));
                localStorage.setItem('microtester_divider_off', JSON.stringify(this.dividerOff));
            }
            if (this.gainCorrection) {
                this.gainCorrection[channel] = 1.0;
                localStorage.setItem('microtester_gain_correction', JSON.stringify(this.gainCorrection));
            }
        }
    },

    calculateVolts: function(biasEnabled, channel, rawAdc, resolution, divider, freqComp = 0, zeroOverride = null) {
        const adcMax = (resolution === 12) ? 4095 : 255;
        let pinVolts = (rawAdc / adcMax) * this.vDda;
        
        let vz = 0;
        let actualDivider = (divider !== undefined && divider !== null) ? divider : (biasEnabled ? 21.0 : 11.0);

        if (divider === 1.0) {
             actualDivider = 1.0;
             vz = 0.0;
        } else if (channel >= 0 && channel <= 4) {
             actualDivider = biasEnabled ? (this.dividerOn[channel] || 21.0) : (this.dividerOff[channel] || 11.0);
             vz = biasEnabled ? this.biasOffsets[channel] : this.zeroOffsets[channel];
        } else {
             vz = biasEnabled ? (this.vDda / actualDivider) : 0.0;
        }
        
        if (biasEnabled && vz === 0) {
            vz = this.vDda / 2.0; // Theoretical mid-rail bias point at the ADC pin
        }

        // Per-sample-rate oscilloscope zero override (highest priority)
        if (typeof zeroOverride === 'number' && !isNaN(zeroOverride)) {
            vz = zeroOverride;
        }
        
        let probeVolts = (pinVolts - vz) * actualDivider;
        probeVolts += freqComp;
        
        return probeVolts;
    },

    startActiveCalibration: function(biasEnabled, channel, buttonElement, badgeUpdateFn) {
        if (typeof microTester === 'undefined' || !microTester.device) {
            alert("Please connect the device first.");
            return;
        }
        
        const wasVoltRunning = (typeof voltConfig !== 'undefined' && voltConfig.running);
        const wasOscRunning = (typeof oscState !== 'undefined' && oscState.running);
        
        if (wasVoltRunning) microTester.sendCommand(0x11); // CMD_VOLT_STOP
        if (wasOscRunning) microTester.sendCommand(0x13); // CMD_OSC_STOP
        
        buttonElement.disabled = true;
        buttonElement.innerText = "Calibrating...";
        
        // Oversample 6 = 64x averaging
        const biasMode = biasEnabled ? 1 : 0;
        microTester.sendCommand(0x10, new Uint8Array([channel, 6, biasMode])); // CMD_VOLT_START
        
        // We will collect exactly 16384 samples for massive oversampling (takes ~1.6s at 10kHz)
        let sum = 0;
        let count = 0;
        const TARGET_SAMPLES = 16384;
        let calibListener = null;
        let timeoutId = null;
        
        let divider = biasEnabled ? 21.0 : 11.0;
        
        const finishCalibration = () => {
            if (calibListener) microTester.removeDataListener(calibListener);
            if (timeoutId) clearTimeout(timeoutId);
            
            microTester.sendCommand(0x11); // CMD_VOLT_STOP
            
            if (count > 0) {
                const avgRaw = sum / count;
                // Calculate Virtual Zero (ADC pin voltage)
                const adcMax = 4095;
                let vz = (avgRaw / adcMax) * window.Calibration.vDda;
                
                if (biasEnabled) {
                    window.Calibration.biasOffsets[channel] = vz; // Store Virtual Zero
                    localStorage.setItem('microtester_unified_bias_offsets', JSON.stringify(window.Calibration.biasOffsets));
                } else {
                    window.Calibration.zeroOffsets[channel] = vz; // Store Virtual Zero
                    localStorage.setItem('microtester_unified_zero_offsets', JSON.stringify(window.Calibration.zeroOffsets));
                }
                
                if (badgeUpdateFn) badgeUpdateFn();
            } else {
                alert("Calibration failed: no data received.");
            }
            
            if (biasEnabled) buttonElement.innerHTML = 'Calibrate Bias';
            else buttonElement.innerHTML = 'Calibrate Zero';
            buttonElement.disabled = false;
            
            if (wasVoltRunning) {
                const vBtn = document.getElementById('btnStartStop');
                if (vBtn && vBtn.innerText.includes('Start')) vBtn.click();
            } else if (wasOscRunning) {
                const oBtn = document.getElementById('btnOscStartStop');
                if (oBtn && oBtn.innerText.includes('Start')) oBtn.click();
            }
        };

        // Timeout fallback if device disconnects (10 seconds)
        timeoutId = setTimeout(finishCalibration, 10000);
        
        calibListener = (data) => {
            if (data[0] === 0x10) { // PKT_VOLTMETER_DATA
                const len = data[1] | (data[2] << 8);
                const payload = data.slice(3, 3 + len);
                for (let i = 0; i < len; i += 2) {
                    if (count >= TARGET_SAMPLES) break;
                    const raw = payload[i] | (payload[i+1] << 8);
                    sum += raw;
                    count++;
                }
                
                // Update UI progress occasionally
                if (count % 2000 < 50) {
                    const pct = Math.floor((count / TARGET_SAMPLES) * 100);
                    buttonElement.innerText = `Calibrating (${pct}%)`;
                }

                if (count >= TARGET_SAMPLES) {
                    finishCalibration();
                }
            }
        };
        microTester.addDataListener(calibListener);
    },

    _sampleRawPromise: function(channel, biasEnabled, targetSamples, progressFn) {
        return new Promise((resolve, reject) => {
            if (typeof microTester === 'undefined' || !microTester.device) {
                return reject(new Error("Device disconnected"));
            }

            let sum = 0;
            let count = 0;
            let calibListener = null;
            let timeoutId = null;

            const cleanup = () => {
                if (calibListener) microTester.removeDataListener(calibListener);
                if (timeoutId) clearTimeout(timeoutId);
                microTester.sendCommand(0x11); // CMD_VOLT_STOP
            };

            timeoutId = setTimeout(() => {
                cleanup();
                if (count > 0) resolve(sum / count);
                else reject(new Error("Sampling timeout"));
            }, 12000);

            calibListener = (data) => {
                if (data[0] === 0x10) { // PKT_VOLTMETER_DATA
                    const len = data[1] | (data[2] << 8);
                    const payload = data.slice(3, 3 + len);
                    for (let i = 0; i < len; i += 2) {
                        if (count >= targetSamples) break;
                        const raw = payload[i] | (payload[i+1] << 8);
                        sum += raw;
                        count++;
                    }

                    if (progressFn && targetSamples > 0) {
                        const pct = Math.min(100, Math.floor((count / targetSamples) * 100));
                        progressFn(pct);
                    }

                    if (count >= targetSamples) {
                        cleanup();
                        resolve(sum / count);
                    }
                }
            };

            microTester.addDataListener(calibListener);
            const biasMode = biasEnabled ? 1 : 0;
            microTester.sendCommand(0x10, new Uint8Array([channel, 6, biasMode])); // 6 = 64x oversample
        });
    },

    startUnifiedWizard: function(channel) {
        if (typeof microTester === 'undefined' || !microTester.device) {
            return alert("Please connect the device first.");
        }
        if (this._calibrationBusy) return;

        const wasVoltRunning = (typeof voltConfig !== 'undefined' && voltConfig.running);
        const wasOscRunning = (typeof oscState !== 'undefined' && oscState.running);
        if (wasVoltRunning) microTester.sendCommand(0x11);
        if (wasOscRunning) microTester.sendCommand(0x13);

        this._calibrationBusy = true;

        const modal = document.getElementById('modalUnifiedCalib');
        const chLabel = document.getElementById('calibModalChLabel');
        const stepDesc = document.getElementById('calibModalStepDesc');
        const oversampleRow = document.getElementById('calibModalOversampleRow');
        const oversampleSelect = document.getElementById('calibProbeOversampleSelect');
        const progContainer = document.getElementById('calibModalProgressContainer');
        const statusText = document.getElementById('calibModalStatusText');
        const progressBar = document.getElementById('calibProgressBar');
        const resultsEl = document.getElementById('calibModalResults');
        const btnNext = document.getElementById('btnCalibModalNext');
        const btnCancel = document.getElementById('btnCalibModalCancel');
        const btnClose = document.getElementById('btnCalibModalClose');

        if (!modal) return;

        let currentStep = 1;
        let rawOffShort = 0;
        let rawOnShort = 0;
        let rawOnOpen = 0;
        let probeSummary = '';
        let zeroNote = '';

        const chName = `CH${channel + 1} (PA${channel + 1})`;
        if (chLabel) chLabel.innerText = chName;

        if (oversampleSelect) {
            const saved = localStorage.getItem('microtester_probe_calib_oversample');
            if (saved) oversampleSelect.value = saved;
            oversampleSelect.onchange = () => {
                localStorage.setItem('microtester_probe_calib_oversample', oversampleSelect.value);
            };
        }

        const resetModalState = () => {
            currentStep = 1;
            if (stepDesc) {
                stepDesc.style.display = 'block';
                stepDesc.innerHTML = `Step 1 of 3: Please short probe <strong style="color: #38bdf8;">${chName}</strong> firmly to Ground (GND).`;
            }
            if (oversampleRow) oversampleRow.style.display = 'flex';
            if (progContainer) progContainer.style.display = 'none';
            if (resultsEl) resultsEl.style.display = 'none';
            if (btnNext) {
                btnNext.style.display = 'inline-block';
                btnNext.innerText = 'Continue ▶';
                btnNext.disabled = false;
            }
            if (btnCancel) btnCancel.disabled = false;
            if (btnClose) btnClose.disabled = false;
            if (progressBar) progressBar.style.width = '0%';
        };

        const closeModalWizard = () => {
            modal.classList.remove('active');
            this._calibrationBusy = false;
            if (window.updateCalibBadgesGlobal) window.updateCalibBadgesGlobal();

            if (wasVoltRunning) {
                const vBtn = document.getElementById('btnStartStop');
                if (vBtn && vBtn.innerText.includes('Start')) vBtn.click();
            } else if (wasOscRunning) {
                const oBtn = document.getElementById('btnOscStartStop');
                if (oBtn && oBtn.innerText.includes('Start')) oBtn.click();
            }
        };

        resetModalState();
        modal.classList.add('active');

        // Measure fresh VREF/VDDA before user shorts probes
        if (progContainer) progContainer.style.display = 'block';
        if (statusText) statusText.innerText = "Requesting initial V_DDA reference voltage...";
        if (btnNext) btnNext.disabled = true;

        this.requestVrefPromise().then((freshVdda) => {
            if (progContainer) progContainer.style.display = 'none';
            if (stepDesc) {
                stepDesc.innerHTML = `<div style="color: #4ade80; margin-bottom: 8px; font-weight: 600;">✓ Current V<sub>DDA</sub> measured: <strong>${freshVdda.toFixed(3)} V</strong></div>Step 1 of 3: Please short probe <strong style="color: #38bdf8;">${chName}</strong> firmly to Ground (GND).`;
            }
            if (btnNext) btnNext.disabled = false;
        }).catch(() => {
            if (progContainer) progContainer.style.display = 'none';
            if (btnNext) btnNext.disabled = false;
        });

        const handleCancel = () => {
            closeModalWizard();
        };

        btnCancel.onclick = handleCancel;
        btnClose.onclick = handleCancel;

        btnNext.onclick = async () => {
            const targetSamples = parseInt(oversampleSelect?.value || '16384', 10);
            if (oversampleRow) oversampleRow.style.display = 'none';

            if (currentStep === 1) {
                btnNext.disabled = true;
                btnCancel.disabled = true;
                if (progContainer) progContainer.style.display = 'block';

                try {
                    if (statusText) statusText.innerText = `1/3: Measuring Zero Offset (Bias OFF, ${targetSamples}x)...`;
                    rawOffShort = await this._sampleRawPromise(channel, false, targetSamples, pct => {
                        if (progressBar) progressBar.style.width = (pct * 0.5) + '%';
                    });

                    if (statusText) statusText.innerText = `1/3: Measuring Short Offset (Bias ON, ${targetSamples}x)...`;
                    rawOnShort = await this._sampleRawPromise(channel, true, targetSamples, pct => {
                        if (progressBar) progressBar.style.width = (50 + pct * 0.5) + '%';
                    });

                    currentStep = 2;
                    if (progContainer) progContainer.style.display = 'none';
                    if (stepDesc) {
                        stepDesc.innerHTML = `Step 2 of 3: Please disconnect probe <strong style="color: #38bdf8;">${chName}</strong> (leave it floating / open circuit).`;
                    }
                    btnNext.disabled = false;
                    btnCancel.disabled = false;
                } catch (e) {
                    alert("Calibration failed: " + e.message);
                    closeModalWizard();
                }
            } else if (currentStep === 2) {
                btnNext.disabled = true;
                btnCancel.disabled = true;
                if (progContainer) progContainer.style.display = 'block';

                try {
                    if (statusText) statusText.innerText = `2/3: Measuring Open Circuit (Bias ON, ${targetSamples}x)...`;
                    rawOnOpen = await this._sampleRawPromise(channel, true, targetSamples, pct => {
                        if (progressBar) progressBar.style.width = pct + '%';
                    });

                    const vDda = this.vDda;
                    const v0 = (rawOffShort / 4095.0) * vDda;
                    const v1 = (rawOnShort / 4095.0) * vDda;
                    const v2 = (rawOnOpen / 4095.0) * vDda;

                    const v2_corr = v1 - v0;
                    const v3_corr = v2 - v0;

                    let divOff = 11.0;
                    let divOn = 21.0;
                    let gainCorr = 1.0;

                    if (v3_corr > 0.05 && v2_corr > 0.05) {
                        const K = (vDda / v3_corr) - 1.0;
                        if (K > 0) {
                            const ratio = (v2_corr * K) / (vDda - v2_corr * (K + 1.0));
                            if (ratio > 0) {
                                const r_sb = ratio / K;
                                divOff = 1.0 + ratio;
                                divOn = 1.0 + ratio + r_sb;
                                gainCorr = divOn / 21.0;
                            }
                        }
                    }

                    this.zeroOffsets[channel] = v0;
                    this.biasOffsets[channel] = v1;
                    this.dividerOff[channel] = divOff;
                    this.dividerOn[channel] = divOn;
                    this.gainCorrection[channel] = gainCorr;

                    localStorage.setItem('microtester_unified_zero_offsets', JSON.stringify(this.zeroOffsets));
                    localStorage.setItem('microtester_unified_bias_offsets', JSON.stringify(this.biasOffsets));
                    localStorage.setItem('microtester_divider_off', JSON.stringify(this.dividerOff));
                    localStorage.setItem('microtester_divider_on', JSON.stringify(this.dividerOn));
                    localStorage.setItem('microtester_gain_correction', JSON.stringify(this.gainCorrection));

                    probeSummary =
                        `<div>• Zero Offset (Bias OFF): <strong>${v0 >= 0 ? '+' : ''}${v0.toFixed(3)} V</strong></div>` +
                        `<div>• Bias Offset (Bias ON):  <strong>${v1 >= 0 ? '+' : ''}${v1.toFixed(3)} V</strong></div>` +
                        `<div>• Calibrated Divider OFF: <strong>${divOff.toFixed(2)}x</strong> (Nominal 11.0x)</div>` +
                        `<div>• Calibrated Divider ON:  <strong>${divOn.toFixed(2)}x</strong> (Nominal 21.0x)</div>` +
                        `<div>• Gain Factor: <strong>${gainCorr.toFixed(4)}</strong></div>`;

                    // Step 3: oscilloscope zero calibration (only for the ±30V range)
                    const voltRangeSel = document.getElementById('cfgOscVoltRange');
                    const is30V = !voltRangeSel || voltRangeSel.value === '±30';
                    const runRateZero = window.OscilloscopeCalibration && window.OscilloscopeCalibration.runRateZeroCalibration;

                    if (!is30V) {
                        zeroNote = `<div style="color:#f59e0b">• Oscilloscope zero: skipped (Voltage Range is not ±30V)</div>`;
                        await this._finishCalibWizard(chName, probeSummary, zeroNote);
                        currentStep = 4;
                        return;
                    }
                    if (!runRateZero) {
                        zeroNote = `<div style="color:#f59e0b">• Oscilloscope zero: skipped (module not loaded)</div>`;
                        await this._finishCalibWizard(chName, probeSummary, zeroNote);
                        currentStep = 4;
                        return;
                    }

                    currentStep = 3;
                    if (progContainer) progContainer.style.display = 'none';
                    if (stepDesc) {
                        stepDesc.style.display = 'block';
                        stepDesc.innerHTML = `Step 3 of 3: Please <strong style="color:#f59e0b;">DISCONNECT</strong> probe <strong style="color: #38bdf8;">${chName}</strong> (leave it floating — do <strong style="color:#ef4444;">NOT</strong> short it to Ground).<br><span style="color:#94a3b8; font-size:12px;">This calibrates the oscilloscope zero for ALL modes — 12/8-bit, every sample rate, BIAS ON and OFF.</span>`;
                    }
                    btnNext.disabled = false;
                    btnCancel.disabled = false;
                } catch (e) {
                    alert("Calibration failed: " + e.message);
                    closeModalWizard();
                }
            } else if (currentStep === 3) {
                btnNext.disabled = true;
                btnCancel.disabled = true;
                if (progContainer) progContainer.style.display = 'block';

                try {
                    const run = window.OscilloscopeCalibration.runRateZeroCalibration;
                    const parsePct = (msg) => {
                        const m = msg.match(/\((\d+)\/(\d+)\)/);
                        return m ? (+m[1]) / (+m[2]) : null;
                    };

                    if (statusText) statusText.innerText = "3/3 (BIAS ON): starting...";
                    await run(channel, (msg) => {
                        if (statusText) statusText.innerText = "3/3 (BIAS ON): " + msg;
                        const p = parsePct(msg);
                        if (p !== null && progressBar) progressBar.style.width = (p * 50) + '%';
                    }, { bias: true, skipBusyCheck: true });

                    if (statusText) statusText.innerText = "3/3 (BIAS OFF): starting...";
                    await run(channel, (msg) => {
                        if (statusText) statusText.innerText = "3/3 (BIAS OFF): " + msg;
                        const p = parsePct(msg);
                        if (p !== null && progressBar) progressBar.style.width = (50 + p * 50) + '%';
                    }, { bias: false, skipBusyCheck: true });

                    if (progressBar) progressBar.style.width = '100%';
                    zeroNote = `<div>• Oscilloscope zero: calibrated for all modes (BIAS ON &amp; OFF)</div>`;

                    await this._finishCalibWizard(chName, probeSummary, zeroNote);
                    currentStep = 4;
                } catch (e) {
                    alert("Calibration failed: " + e.message);
                    closeModalWizard();
                }
            } else if (currentStep === 4) {
                closeModalWizard();
            }
        };
    },

    // Shows the final results screen of the calibration wizard
    _finishCalibWizard: function(chName, probeSummary, zeroNote) {
        const modal = document.getElementById('modalUnifiedCalib');
        const stepDesc = document.getElementById('calibModalStepDesc');
        const progContainer = document.getElementById('calibModalProgressContainer');
        const resultsEl = document.getElementById('calibModalResults');
        const btnNext = document.getElementById('btnCalibModalNext');
        const btnCancel = document.getElementById('btnCalibModalCancel');

        if (progContainer) progContainer.style.display = 'none';
        if (stepDesc) stepDesc.style.display = 'none';
        if (resultsEl) {
            resultsEl.innerHTML = `
                <div style="color: #4ade80; font-weight: bold; margin-bottom: 8px;">Calibration Successful for ${chName}!</div>
                ${probeSummary}
                ${zeroNote}
            `;
            resultsEl.style.display = 'block';
        }
        if (btnNext) {
            btnNext.innerText = 'Done';
            btnNext.disabled = false;
        }
        if (btnCancel) btnCancel.disabled = false;
    },

    startCompWizard: function() {
        if (typeof microTester === 'undefined' || !microTester.device) {
            return alert("Please connect the device first.");
        }
        if (this._calibrationBusy) return;

        const modal = document.getElementById('modalCompCalib');
        const stepDesc = document.getElementById('compModalStepDesc');
        const oversampleRow = document.getElementById('compModalOversampleRow');
        const progContainer = document.getElementById('compModalProgressContainer');
        const statusText = document.getElementById('compModalStatusText');
        const resultsEl = document.getElementById('compModalResults');
        const btnStart = document.getElementById('btnCompModalNext');
        const btnCancel = document.getElementById('btnCompModalCancel');
        const btnClose = document.getElementById('btnCompModalClose');
        const oversampleSelect = document.getElementById('compCalibOversampleSelect');

        if (!modal) return;

        let isDone = false;

        const resetModalState = () => {
            isDone = false;
            if (stepDesc) {
                stepDesc.style.display = 'block';
                stepDesc.innerHTML = `Step 1 of 1: Please short all three measurement probes (<strong style="color: #38bdf8;">TP1, TP2, TP3</strong>) firmly together.`;
            }
            if (oversampleRow) oversampleRow.style.display = 'flex';
            if (progContainer) progContainer.style.display = 'none';
            if (resultsEl) resultsEl.style.display = 'none';
            if (btnStart) {
                btnStart.style.display = 'inline-block';
                btnStart.innerText = 'Start Calibration ▶';
                btnStart.disabled = false;
            }
            if (btnCancel) btnCancel.disabled = false;
            if (btnClose) btnClose.disabled = false;
        };

        const closeModal = () => {
            if (this._isCompCalibrating) {
                microTester.sendCommand(0x51 /* CMD_COMP_STOP */, new Uint8Array(0));
            }
            modal.classList.remove('active');
            this._calibrationBusy = false;
            this._isCompCalibrating = false;
        };

        if (oversampleSelect) {
            const saved = localStorage.getItem('microtester_comp_calib_oversample');
            if (saved) oversampleSelect.value = saved;
            oversampleSelect.onchange = () => {
                localStorage.setItem('microtester_comp_calib_oversample', oversampleSelect.value);
            };
        }

        resetModalState();
        modal.classList.add('active');

        if (btnCancel) btnCancel.onclick = closeModal;
        if (btnClose) btnClose.onclick = closeModal;

        if (btnStart) {
            btnStart.onclick = () => {
                if (isDone) {
                    closeModal();
                    return;
                }

                this._calibrationBusy = true;
                this._isCompCalibrating = true;

                const oversample = parseInt(oversampleSelect?.value || '256', 10);
                const is65k = (oversample >= 65536);
                const ovVal = is65k ? 0 : oversample;
                const payload = new Uint8Array([0, ovVal & 0xFF, (ovVal >> 8) & 0xFF]);

                if (oversampleRow) oversampleRow.style.display = 'none';
                if (stepDesc) stepDesc.innerHTML = `<span style="color: #38bdf8;">Calibration in progress... Please keep TP1, TP2, TP3 shorted.</span>`;
                if (progContainer) progContainer.style.display = 'block';
                if (statusText) statusText.innerText = `Sampling hardware (${oversample}x oversampling)...`;
                btnStart.disabled = true;
                if (btnCancel) btnCancel.disabled = false;

                microTester.sendCommand(0x50, payload);
            };
        }
    },

    _finishCompWizard: function(wireR, esrZero, RL, RH, isFull) {
        const stepDesc = document.getElementById('compModalStepDesc');
        const oversampleRow = document.getElementById('compModalOversampleRow');
        const progContainer = document.getElementById('compModalProgressContainer');
        const resultsEl = document.getElementById('compModalResults');
        const btnStart = document.getElementById('btnCompModalNext');
        const btnCancel = document.getElementById('btnCompModalCancel');

        setTimeout(() => {
            if (progContainer) progContainer.style.display = 'none';
            if (stepDesc) stepDesc.style.display = 'none';
            if (oversampleRow) oversampleRow.style.display = 'none';
            if (resultsEl) {
                if (isFull) {
                    resultsEl.innerHTML = `
                        <div style="color: #4ade80; font-weight: bold; margin-bottom: 8px; font-size: 13px;">Calibration Successful!</div>
                        <div style="color: #cbd5e1; display: flex; flex-direction: column; gap: 4px;">
                            <div>• Wire R_offset: <strong style="color: #38bdf8;">${(wireR/100).toFixed(2)} Ω</strong></div>
                            <div>• ESR 1kHz Offset: <strong style="color: #38bdf8;">${(esrZero/100).toFixed(2)} Ω</strong></div>
                            <div>• Probe Asymmetry (RL 680Ω): <strong style="color: #f8fafc;">[${RL[0].toFixed(1)}, ${RL[1].toFixed(1)}, ${RL[2].toFixed(1)}] Ω</strong></div>
                            <div>• Probe Asymmetry (RH 470kΩ): <strong style="color: #f8fafc;">[${(RH[0]/1000).toFixed(1)}, ${(RH[1]/1000).toFixed(1)}, ${(RH[2]/1000).toFixed(1)}] kΩ</strong></div>
                        </div>
                    `;
                } else {
                    resultsEl.innerHTML = `
                        <div style="color: #f59e0b; font-weight: bold; margin-bottom: 8px; font-size: 13px;">2-Way Short Calibrated</div>
                        <div style="color: #cbd5e1; display: flex; flex-direction: column; gap: 4px;">
                            <div>• Wire R_offset: <strong style="color: #38bdf8;">${(wireR/100).toFixed(2)} Ω</strong></div>
                            <div style="color: #94a3b8; font-size: 11px; margin-top: 4px;">Short ALL 3 probes (TP1, TP2, TP3) for complete divider calibration!</div>
                        </div>
                    `;
                }
                resultsEl.style.display = 'block';
            }
            if (btnStart) {
                btnStart.innerText = 'Done';
                btnStart.disabled = false;
                btnStart.onclick = () => {
                    const modal = document.getElementById('modalCompCalib');
                    if (modal) modal.classList.remove('active');
                    this._calibrationBusy = false;
                };
            }
            if (btnCancel) btnCancel.disabled = false;
            this._calibrationBusy = false;
        }, 50);
    },

    _failCompWizard: function(errMsg) {
        const progContainer = document.getElementById('compModalProgressContainer');
        const resultsEl = document.getElementById('compModalResults');
        const btnStart = document.getElementById('btnCompModalNext');
        const btnCancel = document.getElementById('btnCompModalCancel');

        if (progContainer) progContainer.style.display = 'none';
        if (resultsEl) {
            resultsEl.innerHTML = `
                <div style="color: #ef4444; font-weight: bold; margin-bottom: 4px; font-size: 13px;">Calibration Failed</div>
                <div style="color: #cbd5e1; font-size: 12px;">${errMsg || 'Please make sure all 3 probes are firmly shorted together!'}</div>
            `;
            resultsEl.style.display = 'block';
        }
        if (btnStart) {
            btnStart.innerText = 'Retry';
            btnStart.disabled = false;
        }
        if (btnCancel) btnCancel.disabled = false;
        this._calibrationBusy = false;
    }
};

window.addEventListener('DOMContentLoaded', () => {
    window.Calibration.init();
    
    // VDDA Updates
    window.addEventListener('calibration-vdda-updated', (e) => {
        // Settings Tab VDDA Badge
        const vddaValTab = document.getElementById('vddaValTab');
        if (vddaValTab) {
            vddaValTab.innerText = `${e.detail.toFixed(3)} V`;
        }
    });

    // Initialize UI badge with saved/current VDDA value
    window.dispatchEvent(new CustomEvent('calibration-vdda-updated', { detail: window.Calibration.vDda }));

    // Settings Tab: Request VREF
    const btnReqVrefTab = document.getElementById('btnReqVrefTab');
    if (btnReqVrefTab) {
        btnReqVrefTab.addEventListener('click', () => {
            window.Calibration.requestVref();
        });
    }

    // Settings Tab: Reset VDDA
    const btnResetVddaTab = document.getElementById('btnResetVddaTab');
    if (btnResetVddaTab) {
        btnResetVddaTab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.Calibration.resetVdda();
        });
    }

    const btnCalibUnified = document.getElementById('btnCalibUnified');

    function updateCalibBadges() {
        const channelSelect = document.getElementById('calibChannelSelect');
        const badgeZero = document.getElementById('calibZeroValTab');
        const badgeBias = document.getElementById('calibBiasValTab');
        const badgeDivOff = document.getElementById('calibDivOffTab');
        const badgeDivOn = document.getElementById('calibDivOnTab');

        if (channelSelect) {
            const ch = parseInt(channelSelect.value || '0');
            
            let vzZero = window.Calibration.zeroOffsets[ch] || 0.0;
            let vzBias = window.Calibration.biasOffsets[ch] || 0.0;
            let divOff = window.Calibration.dividerOff[ch] || 11.0;
            let divOn = window.Calibration.dividerOn[ch] || 21.0;
            
            let zOff = vzZero * divOff;
            let bOff = (vzBias === 0.0) ? 0.0 : (vzBias * divOn - window.Calibration.vDda * 10.0);
            
            if (badgeZero) badgeZero.innerText = (zOff >= 0 ? '+' : '') + zOff.toFixed(3) + ' V';
            if (badgeBias) badgeBias.innerText = (bOff >= 0 ? '+' : '') + bOff.toFixed(3) + ' V';
            if (badgeDivOff) badgeDivOff.innerText = divOff.toFixed(2) + 'x';
            if (badgeDivOn) badgeDivOn.innerText = divOn.toFixed(2) + 'x';
        }
    }
    window.updateCalibBadgesGlobal = updateCalibBadges;

    if (calibChannelSelect) calibChannelSelect.addEventListener('change', updateCalibBadges);
    if (btnCalibZero) btnCalibZero.addEventListener('click', () => {
        const channel = parseInt(calibChannelSelect.value) || 0;
        window.Calibration.startActiveCalibration(false, channel, btnCalibZero, updateCalibBadges);
    });
    if (btnCalibBias) btnCalibBias.addEventListener('click', () => {
        const channel = parseInt(calibChannelSelect.value) || 0;
        window.Calibration.startActiveCalibration(true, channel, btnCalibBias, updateCalibBadges);
    });
    if (btnCalibUnified) btnCalibUnified.addEventListener('click', () => {
        const channel = parseInt(calibChannelSelect.value) || 0;
        window.Calibration.startUnifiedWizard(channel);
    });
    if (btnCalibResetTab) btnCalibResetTab.addEventListener('click', () => {
        const channel = parseInt(calibChannelSelect.value) || 0;
        window.Calibration.resetZero(false, channel);
        window.Calibration.resetZero(true, channel);
        updateCalibBadges();
    });

    // Initial Badge Updates
    setTimeout(() => {
        updateCalibBadges();
    }, 200);

    // Component Tester Calibration UI
    const btnCompCalibTab = document.getElementById('btnCompCalibTab');
    const compCalibBadge = document.getElementById('compCalibBadge');
    const compCalibVal = document.getElementById('compCalibVal');
    const compCalibESR = document.getElementById('compCalibESR');
    const compCalibRL = document.getElementById('compCalibRL');
    const compCalibRH = document.getElementById('compCalibRH');
    const btnCompCalibReset = document.getElementById('btnCompCalibReset');

    function updateCompBadge() {
        if (!compCalibBadge || !compCalibVal) return;
        
        let show = false;
        const offset = window.Calibration.compOffsetR || 0;
        const esrOffset = window.Calibration.compOffsetESR || 0;
        if (offset > 0 || esrOffset > 0) show = true;
        
        const RL = window.Calibration.compRL || [680, 680, 680];
        if (RL[0] !== 680 || RL[1] !== 680 || RL[2] !== 680) show = true;
        
        const RH = window.Calibration.compRH || [470000, 470000, 470000];
        
        if (show) {
            compCalibVal.innerText = (offset / 100).toFixed(2) + ' Ω';
            if (compCalibESR) compCalibESR.innerText = (esrOffset / 100).toFixed(2) + ' Ω';
            if (compCalibRL) compCalibRL.innerText = `[${RL[0].toFixed(1)}, ${RL[1].toFixed(1)}, ${RL[2].toFixed(1)}]`;
            if (compCalibRH) compCalibRH.innerText = `[${(RH[0]/1000).toFixed(1)}, ${(RH[1]/1000).toFixed(1)}, ${(RH[2]/1000).toFixed(1)}]`;
            compCalibBadge.style.display = 'inline-flex';
        } else {
            compCalibBadge.style.display = 'none';
        }
    }

    if (btnCompCalibTab) {
        btnCompCalibTab.addEventListener('click', () => {
            window.Calibration.startCompWizard();
        });
    }

    if (btnCompCalibReset) {
        btnCompCalibReset.addEventListener('click', () => {
            window.Calibration.compOffsetR = 0;
            window.Calibration.compOffsetESR = 0;
            window.Calibration.compRL = [680, 680, 680];
            window.Calibration.compRH = [470000, 470000, 470000];
            localStorage.setItem('microtester_comp_offset_r', '0');
            localStorage.setItem('microtester_comp_offset_esr', '0');
            localStorage.setItem('microtester_comp_RL', JSON.stringify(window.Calibration.compRL));
            localStorage.setItem('microtester_comp_RH', JSON.stringify(window.Calibration.compRH));
            updateCompBadge();
        });
    }

    const btnEsrTrimMinus = document.getElementById('btnEsrTrimMinus');
    const btnEsrTrimPlus = document.getElementById('btnEsrTrimPlus');
    const inpEsrTrim = document.getElementById('inpEsrTrim');

    function syncEsrTrimInput() {
        if (!inpEsrTrim) return;
        if (document.activeElement !== inpEsrTrim) {
            inpEsrTrim.value = ((window.Calibration.compESRManualTrim || 0) / 100).toFixed(2);
        }
    }

    if (btnEsrTrimMinus) {
        btnEsrTrimMinus.addEventListener('click', () => {
            window.Calibration.adjustCompESRManual(-1);
        });
    }
    if (btnEsrTrimPlus) {
        btnEsrTrimPlus.addEventListener('click', () => {
            window.Calibration.adjustCompESRManual(1);
        });
    }
    if (inpEsrTrim) {
        const applyTrimInput = () => {
            let v = parseFloat(inpEsrTrim.value);
            if (isNaN(v)) v = 0;
            if (v < -5) v = -5;
            if (v > 5) v = 5;
            window.Calibration.setCompESRManual(Math.round(v * 100));
        };
        inpEsrTrim.addEventListener('change', applyTrimInput);
        inpEsrTrim.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') applyTrimInput();
        });
    }
    window.addEventListener('comp-esr-trim-updated', syncEsrTrimInput);
    syncEsrTrimInput();
    
    window.addEventListener('comp-calib-updated', () => {
        updateCompBadge();
        window.Calibration.sendCompCalToFirmware();
    });
    window.addEventListener('calibration-vdda-updated', () => {
        window.Calibration.sendCompCalToFirmware();
    });
    if (typeof microTester !== 'undefined') {
        const origOnConnect = microTester.onConnect;
        microTester.onConnect = function() {
            if (origOnConnect) origOnConnect.apply(this, arguments);
            setTimeout(() => {
                window.Calibration.sendCompCalToFirmware();
            }, 500);
        };
    }
    updateCompBadge();

    // UI badges updater removed
});
