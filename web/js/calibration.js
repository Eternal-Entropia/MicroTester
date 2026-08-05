window.Calibration = {
    vDda: 3.30, // Default fallback
    zeroOffsets: [0, 0, 0, 0, 0], // Store zero offsets for CH0..CH4

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

        // Load saved offsets from localStorage
        try {
            const saved = localStorage.getItem('microtester_zero_offsets');
            if (saved) {
                const arr = JSON.parse(saved);
                if (Array.isArray(arr) && arr.length >= 5) {
                    this.zeroOffsets = arr;
                }
            }
        } catch (e) {
            console.error("Error loading zero offsets", e);
        }

        // Listen for VREF data packet
        if (typeof microTester !== 'undefined') {
            microTester.addDataListener((data) => {
                if (!data || data.length < 5) return;
                const type = data[0];
                const len = data[1] | (data[2] << 8);
                if (type === 0x20 /* PKT_VREF_DATA */) {
                    const payload = data.slice(3, 3 + len);
                    const vref_raw = payload[0] | (payload[1] << 8);
                    if (vref_raw > 0) {
                        // V_DDA = 1.21V * 4095 / VREFINT_ADC
                        this.vDda = (1.21 * 4095) / vref_raw;
                        try {
                            localStorage.setItem('microtester_vdda', this.vDda.toString());
                        } catch (err) {}
                        console.log(`Measured VREF: ${vref_raw}, VDDA: ${this.vDda.toFixed(3)} V (Saved to localStorage)`);
                        
                        // Trigger UI update
                        window.dispatchEvent(new CustomEvent('calibration-vdda-updated', { detail: this.vDda }));
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

    calibrateZero: function(channel, currentDisplayedVoltage) {
        if (channel >= 0 && channel <= 4) {
            this.zeroOffsets[channel] += currentDisplayedVoltage;
            localStorage.setItem('microtester_zero_offsets', JSON.stringify(this.zeroOffsets));
            console.log(`Calibrated CH${channel} zero offset to ${this.zeroOffsets[channel].toFixed(3)} V`);
        }
    },
    
    resetZero: function(channel) {
        if (channel >= 0 && channel <= 4) {
            this.zeroOffsets[channel] = 0;
            localStorage.setItem('microtester_zero_offsets', JSON.stringify(this.zeroOffsets));
        }
    },

    calculateVolts: function(channel, rawAdc, resolution, divider, baseOffset, freqComp = 0) {
        const adcMax = (resolution === 12) ? 4095 : 255;
        
        let pinVolts = (rawAdc / adcMax) * this.vDda;
        let probeVolts = pinVolts * divider - (baseOffset || 0);
        
        // Add frequency compensation (from oscilloscope high freq droop)
        probeVolts += freqComp;
        
        // Subtract zero offset for this specific pin
        if (channel >= 0 && channel <= 4) {
            probeVolts -= this.zeroOffsets[channel];
        }
        
        return probeVolts;
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

    // Settings Tab: Unified Zero Calibration
    const calibChannelSelect = document.getElementById('calibChannelSelect');
    const btnUnifiedCalibTab = document.getElementById('btnUnifiedCalibTab');
    const btnUnifiedResetTab = document.getElementById('btnUnifiedResetTab');
    const unifiedZeroBadgeTab = document.getElementById('unifiedZeroBadgeTab');
    const unifiedZeroValTab = document.getElementById('unifiedZeroValTab');

    function updateUnifiedZeroBadge() {
        if (!calibChannelSelect || !unifiedZeroBadgeTab || !unifiedZeroValTab) return;
        const channel = parseInt(calibChannelSelect.value) || 0;
        const offset = window.Calibration.zeroOffsets[channel] || 0.0;
        const hasOffset = Math.abs(offset) > 0.0001;
        
        if (hasOffset) {
            const txt = (offset >= 0 ? '+' : '') + offset.toFixed(3) + ' V';
            unifiedZeroValTab.innerText = txt;
            unifiedZeroBadgeTab.style.display = 'inline-flex';
        } else {
            unifiedZeroBadgeTab.style.display = 'none';
        }
    }

    if (calibChannelSelect) {
        calibChannelSelect.addEventListener('change', updateUnifiedZeroBadge);
    }

    if (btnUnifiedCalibTab) {
        btnUnifiedCalibTab.addEventListener('click', () => {
            if (!calibChannelSelect) return;
            const channel = parseInt(calibChannelSelect.value) || 0;
            
            // To calibrate, we need the CURRENT UNCALIBRATED voltage for this channel.
            // But wait, the settings page doesn't run the voltmeter itself!
            // We can just ask the voltmeter or oscilloscope state for the last raw reading.
            // BUT, the reading might be stale if it's not currently running.
            // Let's check if voltConfig or oscState are active on this channel.
            let lastRaw = 0;
            if (typeof voltConfig !== 'undefined' && voltConfig.running && voltConfig.channel === channel) {
                lastRaw = voltConfig.lastRawVin;
            } else if (typeof oscState !== 'undefined' && oscState.running && oscState.channel === channel) {
                // If osc is running on this channel, average the current frame.
                if (oscState.currentFrame && oscState.currentFrame.length > 0) {
                    let sum = 0;
                    for (let i = 0; i < oscState.currentFrame.length; i++) sum += oscState.currentFrame[i];
                    lastRaw = sum / oscState.currentFrame.length;
                }
            } else {
                alert(`Please start the Voltmeter or Oscilloscope on CH${channel} first to capture the zero baseline!`);
                return;
            }
            
            window.Calibration.calibrateZero(channel, lastRaw);
            updateUnifiedZeroBadge();
        });
    }

    if (btnUnifiedResetTab) {
        btnUnifiedResetTab.addEventListener('click', () => {
            if (!calibChannelSelect) return;
            const channel = parseInt(calibChannelSelect.value) || 0;
            window.Calibration.resetZero(channel);
            updateUnifiedZeroBadge();
        });
    }

    // Periodically update the badge in case it was changed from the Voltmeter or Oscilloscope tabs
    setInterval(updateUnifiedZeroBadge, 1000);
    setTimeout(updateUnifiedZeroBadge, 100);
});
