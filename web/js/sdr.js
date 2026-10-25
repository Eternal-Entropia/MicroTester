// MicroSDR receiver for MicroTester (Phase 0: under-sampled HF capture, MCU
// NCO+CIC DDC, browser analytic-signal (Hilbert) DSP). Requires firmware with
// CMD_SDR_* (0x70..0x72) support.
//
// Data flow:
//   MCU @ fs (default 1 MSps, 8-bit):
//     ├─ waterfall: Hann(1024) FFT on MCU -> 512 log-magnitude bins, ~10 fps
//     │   (PKT_SDR_WF, span = fs/2 = 500 kHz)
//     └─ NCO + CIC ÷32 -> real stream at fs/32 = 31.25 kS/s (PKT_SDR_AUDIO)
//   Browser (this file), overlap-save masked-FFT chain on the audio stream:
//     block A: analytic signal + bandpass around IF0
//              (one-sided spectrum = Hilbert transform, done in freq domain)
//     block B: complex rotate to 0 Hz (~IF0, with CW beat), FFT, keep ONE
//              sideband depending on mode & zone parity, IFFT, Re -> audio
//     AM: envelope of the analytic signal (no rotation needed)
//
// Zone parity (meta bit0 from MCU): 0 = direct fold, 1 = mirrored fold:
//   even zone: RF offset +Δ appears at audio +Δ   (USB content is positive)
//   odd  zone: RF offset +Δ appears at audio −Δ   (USB content is negative)

(function () {
    'use strict';

    // ------------------------------------------------------------ state
    const S = {
        running: false,
        fsKHz: 1000,
        wfFps: 10,
        listenHz: 7100000,
        if0Hz: 8000,
        parity: 0,
        pinIdx: 0,
        adcBits: 8,         // 8 or 12 (ADC resolution; 12 -> int16 audio, +24 dB DR)
        mode: 'usb',        // usb | lsb | cw | am | fm
        bwHz: 2800,         // total passband around demod carrier
        ssbBw: 2800,        // bandwidth memory for SSB/AM modes (swapped on refresh)
        fmBw: 10000,        // FM channel width (2.5k NBFM / 5k / 10k wide)
        beatHz: 700,        // CW beat note
        volume: 0.7,
        waterGainDb: 0,     // waterfall gain (contrast), dB
        effectiveBw: 2800,
    };

    // ---- Polyakov external-mixer mode ---------------------------------------
    // Hardware: the ADC input receives the IF of an external Polyakov mixer
    // (two anti-parallel Schottky diodes, second-harmonic conversion by the
    // "Radio" 1977 scheme). The mixer LO is the device's own PWM square wave.
    // Conversion: IF = RF - 2*LO  ->  LO = (RF - IF0)/2, so the whole
    // 3-30 MHz range is covered with LO <= 15 MHz (PWM easy territory).
    // The browser only remaps coordinates -- the firmware tune gets the
    // physical IF (listenHz - 2*LO) which always sits just above DC in zone 0
    // (direct orientation, parity 0): the wanted channel again appears at the
    // standard +8 kHz low IF. The waterfall labels RF = 2*LO + bin over the
    // window [2*LO, 2*LO + fs/2]; inside the window the LO rests and tuning is
    // a pure NCO retune, at the window edge the LO re-quantizes to the PWM
    // staircase (step ~ fLO^2/84e6, a few kHz at most).
    const MIX_PINS = ['PA8', 'PA9', 'PA10', 'PB0', 'PB1', 'PB6', 'PB7', 'PB8', 'PA0', 'PB3', 'PB9'];
    // Practical LOW-RF park floor (Hz): with the channel above 2*LO the mixer
    // side can never cross while wheeling, and the upper-side window stays
    // fully valid (no RF<0 ruler span). 2*20k = 40 kHz base of the window.
    const MIX_LO_FLOOR_HZ = 20000;
    const MIX = {
        on: false,          // mixer mode active
        side: 1,            // window side: +1 direct upper sideband; -1 mirrored image
                            // window (only the Aligned mode uses -1)
        if0Nom: 8000,       // nominal channel position (firmware low-IF offset)
        loPinIdx: 2,        // index into the firmware PWM PIN_MAP (0..10); default PA10 (TIM1_CH3)
        loMode: 'auto',     // 'auto': LO follows the tune; 'aligned': LO locked to the
                            // fs/2 grid (harmonic windows); 'manual': user-typed, the
                            // parking never overrides it (empty register parks once)
        hMax: 5,            // Aligned: max commutation harmonic (odd, 1..5)
        alignH: 0,          // Aligned: harmonic index of the parked window (0 = n/a)
        fb: false,          // Aligned fallback: the window is a plain ladder park
                            // (the aligned grid had nothing better than a deep
                            // h>=5 harmonic or no aligned window at all)
        loReal: 0,          // last LO really produced by the timer, Hz. 0 = not parked yet;
                            // deliberately NOT persisted: the LO is re-derived from the
                            // currently tuned frequency at every SDR start
        loSent: 0,          // exact Hz value sent to the firmware for that LO
        qfs: 0,             // RF anchor of the current window: direct windows span
                            // [qfs .. qfs+fs/2], mirrored ones [qfs-fs/2 .. qfs].
                            // Equals 2*LO on fundamental windows, h*2*LO on the
                            // Aligned commutation-harmonic windows (the anchor is
                            // what the IF is measured against -- NOT the raw LO!)
        loOwned: false,     // SDR started the LO -> SDR also stops it
        minRfHz: 60000,     // below this the LO-following math is pointless
    };

    try {
        const m = parseFloat(localStorage.getItem('sdr_listen_mhz'));
        if (m > 0) S.listenHz = Math.round(m * 1e6);
        const md = localStorage.getItem('sdr_mode');
        if (md === 'usb' || md === 'lsb' || md === 'cw' || md === 'am' || md === 'fm') S.mode = md;
        const fb = parseInt(localStorage.getItem('sdr_fm_bw'), 10);
        if (fb === 2500 || fb === 5000 || fb === 10000) { S.fmBw = fb; if (S.mode === 'fm') S.bwHz = fb; }
        const v = parseFloat(localStorage.getItem('sdr_volume'));
        if (!isNaN(v)) S.volume = v;
        const p = parseInt(localStorage.getItem('sdr_pin'), 10);
        if (!isNaN(p) && p >= 0 && p <= 8) S.pinIdx = p;
        const ab = parseInt(localStorage.getItem('sdr_adcbits'), 10);
        if (ab === 8 || ab === 12) S.adcBits = ab;
        MIX.on = localStorage.getItem('sdr_mix_on') === '1';
        const mlp = parseInt(localStorage.getItem('sdr_mix_lopin'), 10);
        // 0..3 only: TIM1/TIM3 pins; TIM2 (idx 8/9) fights the SDR capture timer
        if (!isNaN(mlp) && mlp >= 0 && mlp <= 3) MIX.loPinIdx = mlp;
        // LO mode (Auto / Aligned / Manual); the LO value itself is never
        // restored -- it is re-derived from the tuned frequency at SDR start
        // (Auto/Aligned) or typed by the user (Manual). Migrate the old
        // Auto/Manual flag of v21 sessions, also wipe stale keys.
        const lom = localStorage.getItem('sdr_mix_mode');
        if (lom === 'aligned' || lom === 'manual' || lom === 'auto') MIX.loMode = lom;
        else if (localStorage.getItem('sdr_mix_auto') === '0') MIX.loMode = 'manual';
        localStorage.removeItem('sdr_mix_auto');
        localStorage.removeItem('sdr_mix_lomhz');
        const hm = parseInt(localStorage.getItem('sdr_mix_hmax'), 10);
        if (hm === 1 || hm === 3 || hm === 5) MIX.hMax = hm;
        const fs = parseInt(localStorage.getItem('sdr_fs'), 10);
        if (fs === 1500 || fs === 1000 || fs === 800 || fs === 500 || fs === 250) S.fsKHz = fs;
    } catch (e) { }

    let persistTimer = null;
    function persist() {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            try {
                localStorage.setItem('sdr_listen_mhz', (S.listenHz / 1e6).toFixed(4));
                localStorage.setItem('sdr_mode', S.mode);
                localStorage.setItem('sdr_volume', String(S.volume));
                localStorage.setItem('sdr_pin', String(S.pinIdx));
                localStorage.setItem('sdr_adcbits', String(S.adcBits));
                localStorage.setItem('sdr_fm_bw', String(S.fmBw));
                localStorage.setItem('sdr_mix_on', MIX.on ? '1' : '0');
                localStorage.setItem('sdr_mix_lopin', String(MIX.loPinIdx));
                localStorage.setItem('sdr_mix_mode', MIX.loMode);
                localStorage.setItem('sdr_mix_hmax', String(MIX.hMax));
                localStorage.setItem('sdr_fs', String(S.fsKHz));
            } catch (e) { }
        }, 400);
    }

    // Packet payload lengths emitted by firmware
    const WF_PL = 2 + 512;     // seq + meta + 512 bins
    const AUD_PL8 = 2 + 240;   // seq + meta + 240 int8 samples  (8-bit ADC)
    const AUD_PL12 = 2 + 480;  // seq + meta + 240 int16 LE samples (12-bit ADC)

    // ---------------------------------------------------- stream framer
    class SdrFramer {
        constructor(fn) { this.fn = fn; this.buf = new Uint8Array(0); }
        push(u8) {
            if (!u8 || u8.length === 0) return;
            if (this.buf.length === 0) {
                this.buf = u8;
            } else {
                const n = new Uint8Array(this.buf.length + u8.length);
                n.set(this.buf); n.set(u8, this.buf.length);
                this.buf = n;
            }
            let pos = 0;
            for (;;) {
                const L = this.buf.length - pos;
                if (L < 3) break;
                const type = this.buf[pos];
                const plen = this.buf[pos + 1] | (this.buf[pos + 2] << 8);
                const ok = (type === PKT_SDR_WF && plen === WF_PL) ||
                           (type === PKT_SDR_AUDIO && (plen === AUD_PL8 || plen === AUD_PL12));
                if (!ok) { pos += 1; continue; }     // resync: drop byte
                if (L < 3 + plen) break;             // incomplete: wait
                const seq = this.buf[pos + 3];
                const meta = this.buf[pos + 4];
                const payload = this.buf.subarray(pos + 5, pos + 3 + plen);
                try { this.fn(type, seq, meta, payload); } catch (e) { console.error('[SDR] parser', e); }
                pos += 3 + plen;
            }
            this.buf = (pos > 0) ? this.buf.subarray(pos) : this.buf;
            if (this.buf.length > 65536) this.buf = new Uint8Array(0);
        }
    }

    const stats = { wf: 0, aud: 0, gaps: 0, wfSeq: null, audSeq: null };

    const framer = new SdrFramer((type, seq, meta, payload) => {
        if (type === PKT_SDR_WF) {
            stats.wf++;
            if (stats.wfSeq !== null && seq !== ((stats.wfSeq + 1) & 0xFF)) stats.gaps++;
            stats.wfSeq = seq;
            onWaterfall(payload, meta & 1);
        } else if (type === PKT_SDR_AUDIO) {
            stats.aud++;
            if (stats.audSeq !== null && seq !== ((stats.audSeq + 1) & 0xFF)) stats.gaps++;
            stats.audSeq = seq;
            onAudioSamples(payload, meta);   // full meta: bit0 parity, bit1 = 12-bit
        }
    });

    // ---------------------------------------------------- waterfall view
    const WF_BINS = 512;
    const WF_ROWS = 240;
    const wfRows = [];
    let wfDirty = false, wfAcc = 0;

    const WF_LUT = (() => {
        const stops = [
            [4, 6, 16, 0], [10, 14, 46, 0.14], [28, 16, 92, 0.3], [0, 110, 150, 0.44],
            [0, 170, 160, 0.56], [30, 210, 110, 0.68], [130, 230, 40, 0.8],
            [235, 215, 10, 0.9], [255, 120, 20, 0.96], [255, 250, 220, 1]
        ];
        const lut = new Uint8Array(256 * 3);
        for (let i = 0; i < 256; i++) {
            const t = (i / 255) * (stops.length - 1);
            const j = Math.min(stops.length - 2, Math.floor(t));
            const f = t - j;
            for (let c = 0; c < 3; c++) {
                lut[i * 3 + c] = Math.round(stops[j][c] + (stops[j + 1][c] - stops[j][c]) * f);
            }
        }
        return lut;
    })();

    function onWaterfall(payload, parity) {
        // mixer: the RF orientation lives browser-side (upper/lower mixer
        // sideband); firmware reports the pseudo-IF zone, which is always
        // direct (0) -- keep the browser-side value in that mode
        if (!MIX.on) S.parity = parity;
        const row = new Uint8Array(WF_BINS);
        row.set(payload.subarray(0, WF_BINS));
        wfRows.push(row);
        if (wfRows.length > WF_ROWS) wfRows.shift();
        // waterfall keeps its ~10 rows/s roll regardless of packet rate; the
        // spectrum consumes every packet (it has its own render loop)
        wfAcc += 10 / Math.max(1, S.wfFps);
        if (wfAcc >= 1) { wfAcc -= 1; wfDirty = true; }
    }

    let wfCtx = null, specCtx = null, wovCtx = null;
    let offRow = null, offRowCtx = null, rowImg = null;
    let dpr = 1, wfW = 0, wfH = 0, specW = 0, specH = 0, rowHpx = 1;
    let lastW = -1, lastH = -1, lastSH = -1, lastDpr = -1;

    function setupCanvases() {
        const wf = document.getElementById('sdrWf');
        const sp = document.getElementById('sdrSpectrum');
        if (!wf || !sp) return;
        const ndpr = Math.min(2, window.devicePixelRatio || 1);
        // Canvas CSS size comes from styles; internal size = device pixels.
        // Hidden panels report 0 -> skip until it becomes visible.
        const cssW = wf.clientWidth;
        const wfHcss = wf.clientHeight;
        const spHcss = sp.clientHeight;
        if (cssW < 50 || wfHcss < 50) return;
        const nw = Math.round(cssW * ndpr);
        const nh = Math.round(wfHcss * ndpr);
        const nsh = Math.round(spHcss * ndpr);
        if (nw === lastW && nh === lastH && nsh === lastSH && ndpr === lastDpr) return;
        lastW = nw; lastH = nh; lastSH = nsh; lastDpr = ndpr;
        dpr = ndpr;

        wfW = nw; wfH = nh; specW = nw; specH = nsh;
        wf.width = wfW; wf.height = wfH;
        sp.width = specW; sp.height = specH;
        wfCtx = wf.getContext('2d');
        specCtx = sp.getContext('2d');
        wfCtx.imageSmoothingEnabled = false;
        wfCtx.fillStyle = '#05070f';
        wfCtx.fillRect(0, 0, wfW, wfH);
        rowHpx = wfH / WF_ROWS;             // pixels per incoming data row

        // transparent overlay for the tune bracket (must NOT scroll into history)
        const ov = document.getElementById('sdrWfOverlay');
        if (ov) {
            ov.width = wfW; ov.height = wfH;
            wovCtx = ov.getContext('2d');
            wovCtx.clearRect(0, 0, wfW, wfH);
        }

        offRow = document.createElement('canvas');
        offRow.width = WF_BINS; offRow.height = 1;
        offRowCtx = offRow.getContext('2d');
        rowImg = offRowCtx.createImageData(WF_BINS, 1);
    }

    function wfByte(v) {
        let b = Math.round(v + S.waterGainDb * 2.8);
        return Math.max(0, Math.min(255, b));
    }

    // screen X (CSS px) of bin center, on both spectrum and waterfall
    function binXcss(b, Wcss) {
        return (b + 0.5) * Wcss / WF_BINS;
    }

    // Screen column <-> raw FFT bin.
    // In mirrored zones RF grows right-to-left while the raw IF spectrum always
    // grows left-to-right. Mirrored zones are therefore drawn reversed, so the
    // waterfall x-axis always means "increasing RF" and matches the ruler,
    // the passband bracket and clicks in every zone.
    function screenColOfBinF(bf) {
        return foldParity(S.listenHz) ? (WF_BINS - 1 - bf) : bf;
    }
    function rawBinOfScreenCol(c) {
        return foldParity(S.listenHz) ? (WF_BINS - 1 - c) : c;
    }

    function bracketEdgesCss(Wcss) {
        const b = tuneBinX();
        if (b < 0) return null;
        const bx = screenColOfBinF(b) + 0.5;
        let half = (S.effectiveBw / binHz() / 2) * Wcss / WF_BINS;
        const minHalf = 1.6;                 // keeps the two lines apart for narrow filters
        if (half < minHalf) half = minHalf;
        return { xc: binXcss(bx, Wcss), half: half };
    }

    // Tune bracket on the transparent overlay (never scrolls into waterfall history)
    function drawWfOverlay() {
        if (!wovCtx) return;
        wovCtx.setTransform(1, 0, 0, 1, 0, 0);
        wovCtx.clearRect(0, 0, wfW, wfH);
        const br = bracketEdgesCss(wfW / dpr);
        if (br) {
            const xcD = Math.round(br.xc * dpr);
            const halfD = Math.round(br.half * dpr);
            const lw = Math.max(1, Math.round(dpr));
            wovCtx.fillStyle = 'rgba(56,189,248,0.10)';
            wovCtx.fillRect(xcD - halfD, 0, halfD * 2, wfH);
            wovCtx.strokeStyle = 'rgba(56,189,248,0.95)';
            wovCtx.lineWidth = lw;
            wovCtx.beginPath();
            wovCtx.moveTo(xcD - halfD + 0.5, 0); wovCtx.lineTo(xcD - halfD + 0.5, wfH);
            wovCtx.moveTo(xcD + halfD - 0.5, 0); wovCtx.lineTo(xcD + halfD - 0.5, wfH);
            wovCtx.stroke();
        }
        // transient banner right after a Nyquist-zone crossing
        if (zoneFlashT && wfW > 0 && performance.now() - zoneFlashT < 1000) {
            const half = fsHz() / 2;
            const z0 = MIX.on ? mixWinBase() : Math.floor(S.listenHz / half) * half;
            const par = foldParity(S.listenHz);
            wovCtx.font = 'bold 13px JetBrains Mono, monospace';
            wovCtx.textAlign = 'center';
            wovCtx.fillStyle = 'rgba(125,211,252,0.95)';
            wovCtx.fillText(
                `T ${(S.listenHz / 1e6).toFixed(4)} MHz · WINDOW ${(z0 / 1e6).toFixed(1)}–${((z0 + half) / 1e6).toFixed(1)} MHz${par ? ' (MIRROR)' : ''}`,
                wfW / dpr / 2, 30);
        }
    }

    function drawWaterfall() {
        if (!wfDirty || !wfCtx) return;
        wfDirty = false;
        const shift = Math.max(1, Math.round(rowHpx));
        // shift previous content down by one row
        wfCtx.setTransform(1, 0, 0, 1, 0, 0);       // raw device pixels
        wfCtx.imageSmoothingEnabled = false;
        wfCtx.drawImage(wfCtx.canvas, 0, 0, wfW, wfH - shift, 0, shift, wfW, wfH - shift);
        // paint newest row (nearest-neighbor upscale -> crisp columns)
        const row = wfRows[wfRows.length - 1];
        if (row && offRow) {
            const d = rowImg.data;
            // paint along the RF axis: mirrored zones are drawn reversed so
            // that x always means "increasing RF" (matches ruler + clicks)
            const mir = foldParity(S.listenHz);
            for (let x = 0; x < WF_BINS; x++) {
                const raw = mir ? (WF_BINS - 1 - x) : x;
                const v = wfByte(row[raw]);
                d[x * 4 + 0] = WF_LUT[v * 3 + 0];
                d[x * 4 + 1] = WF_LUT[v * 3 + 1];
                d[x * 4 + 2] = WF_LUT[v * 3 + 2];
                d[x * 4 + 3] = 255;
            }
            offRowCtx.putImageData(rowImg, 0, 0);
            wfCtx.drawImage(offRow, 0, 0, WF_BINS, 1, 0, 0, wfW, shift);
        }
        // tune bracket lives on a non-scrolling overlay so it never leaves trails
        drawWfOverlay();
    }

    // --------------------------------- console-style spectrum
    // Look & feel after the SDR Console reference: frequency ruler strip on
    // top (red blocks over the non-tunable bin span), blue dB grid every
    // 10 dB, white noise trace, green max-hold fill, blue passband panel,
    // red tune line, peak readout top-right.
    const RULER_H = 18;                  // ruler strip height, css px
    const DB_HI = 0, DB_LO = -140;       // vertical display range, dB
    const DB_OFF = 135;                  // display dB = binByte/2.8 - DB_OFF
    let pkHold = null, pkT = 0;          // max-hold trace

    function specY(db, Hcss) {
        return RULER_H + (DB_HI - db) * (Hcss - RULER_H) / (DB_HI - DB_LO);
    }

    function pkReset() {
        if (!pkHold) pkHold = new Float32Array(WF_BINS);
        pkHold.fill(DB_LO - 20);
        pkT = 0;
    }

    function pkUpdate(row, now) {
        if (!pkHold) pkReset();
        const dt = pkT ? Math.min(60, now - pkT) : 16;   // ms since last row
        pkT = now;
        const decay = dt * 0.006;                        // ~6 dB/s fall
        for (let x = 0; x < WF_BINS; x++) {
            const db = row[x] / 2.8 - DB_OFF;
            pkHold[x] = db > pkHold[x] ? db : Math.max(db, pkHold[x] - decay);
        }
    }

    // real RF Hz -> fractional bin index (may be outside [0, WF_BINS)).
    // In mirrored zones RF grows right-to-left in the raw IF spectrum, so the
    // sign flips. This was previously always the direct formula -> the ruler
    // disagreed with clicks by almost a whole zone in mirrored zones.
    function binFOfRF(f) {
        const nu = foldParity(S.listenHz)
            ? foldAlias(S.listenHz) - (f - S.listenHz)
            : foldAlias(S.listenHz) + (f - S.listenHz);
        return nu / binHz();
    }

    // fractional bin -> x position (CSS px), honouring the zone mirror
    function xOfBinF(bf, Wcss) {
        return screenColOfBinF(bf) * Wcss / WF_BINS;
    }

    // bins actually showing RF of the tuned Nyquist zone (contiguous)
    function validBinRange() {
        let lo = 0, hi = WF_BINS - 1;
        while (lo < WF_BINS && rfFromBin(lo) === null) lo++;
        while (hi > lo && rfFromBin(hi) === null) hi--;
        return (lo > hi) ? null : { lo: lo, hi: hi };
    }

    function drawSpectrum() {
        if (!specCtx) return;
        const c = specCtx;
        const Wcss = specW / dpr, Hcss = specH / dpr;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);       // draw in CSS px
        const xAt = (bf) => xOfBinF(bf, Wcss);

        // background
        c.fillStyle = '#060a20';
        c.fillRect(0, 0, Wcss, Hcss);

        // frequency ruler strip + red "no direct RF" blocks at edges
        c.fillStyle = '#181c66';
        c.fillRect(0, 0, Wcss, RULER_H);
        const vr = validBinRange();
        if (vr) {
            // valid bins form a contiguous screen range thanks to the mirror
            const cLo = Math.min(screenColOfBinF(vr.lo), screenColOfBinF(vr.hi));
            const cHi = Math.max(screenColOfBinF(vr.lo), screenColOfBinF(vr.hi));
            c.fillStyle = '#a02222';
            if (cLo > 0) c.fillRect(0, 0, xAt(cLo), RULER_H);
            if (cHi < WF_BINS - 1) {
                const x0 = xAt(cHi + 1);
                c.fillRect(x0, 0, Wcss - x0, RULER_H);
            }
        }
        const half = fsHz() / 2;
        // ascending-RF base of the drawn window: the screen is mirrored for
        // the mixer's lower (image) sideband, same as odd Nyquist zones
        const zone0 = MIX.on ? mixWinBase() : Math.floor(S.listenHz / half) * half;
        c.font = '10px JetBrains Mono, monospace';
        c.textAlign = 'center';
        c.lineWidth = 1;
        for (let f = Math.ceil(zone0 / 10000) * 10000; f < zone0 + half; f += 10000) {
            if (f < 0) continue;                 // mixer image below DC: no negative-RF labels
            const bf = binFOfRF(f);
            if (bf < 0 || bf >= WF_BINS) continue;
            const x = xAt(bf);
            const major = (f % 50000 === 0);
            c.strokeStyle = 'rgba(150,170,255,0.8)';
            c.beginPath();
            c.moveTo(x, RULER_H); c.lineTo(x, RULER_H - (major ? 7 : 4));
            c.stroke();
            if (major) {
                c.fillStyle = '#dfe6ff';
                c.fillText(String(Math.round(f / 1000)), x, 11);
            }
        }
        // exact tuned RF, top-left of the ruler
        c.textAlign = 'left';
        c.fillStyle = 'rgba(6,10,32,0.85)';
        c.font = '10px JetBrains Mono, monospace';
        const tSig = (S.listenHz >= 1e6)
            ? 'T ' + (S.listenHz / 1e6).toFixed(4) + 'M'
            : 'T ' + Math.round(S.listenHz / 1e3) + 'k';
        const tW = c.measureText(tSig).width + 8;
        c.fillRect(0, 0, tW, RULER_H);
        c.fillStyle = '#67e8f9';
        c.fillText(tSig, 4, 12);
        c.strokeStyle = 'rgba(90,110,240,0.6)';
        c.beginPath(); c.moveTo(0, RULER_H + 0.5); c.lineTo(Wcss, RULER_H + 0.5); c.stroke();

        // dB grid every 10 dB, labels every 20 dB
        c.font = '9px JetBrains Mono, monospace';
        c.textAlign = 'left';
        for (let db = DB_HI; db > DB_LO; db -= 10) {
            const y = Math.round(specY(db, Hcss)) + 0.5;
            c.strokeStyle = 'rgba(46,88,220,0.35)';
            c.beginPath(); c.moveTo(0, y); c.lineTo(Wcss, y); c.stroke();
            if (db % 20 === 0) {
                c.fillStyle = '#7a9bff';
                c.fillText(String(db), 2, y - 2);
            }
        }

        // peak-hold update (max falls ~6 dB/s; also drives the PK readout)
        const row = wfRows[wfRows.length - 1];
        if (row) pkUpdate(row, performance.now());

        // translucent blue passband panel
        const br = bracketEdgesCss(Wcss);
        if (br) {
            c.fillStyle = 'rgba(30,90,230,0.22)';
            c.fillRect(br.xc - br.half, RULER_H, br.half * 2, Hcss - RULER_H);
            c.strokeStyle = 'rgba(90,150,255,0.55)';
            c.beginPath();
            c.moveTo(br.xc - br.half + 0.5, RULER_H); c.lineTo(br.xc - br.half + 0.5, Hcss);
            c.moveTo(br.xc + br.half - 0.5, RULER_H); c.lineTo(br.xc + br.half - 0.5, Hcss);
            c.stroke();
        }

        // white current trace (x = RF axis, mirrored zone already applied)
        if (row) {
            c.beginPath();
            for (let x = 0; x < WF_BINS; x++) {
                const py = specY(row[x] / 2.8 - DB_OFF, Hcss);
                const px = xAt(x + 0.5);
                if (x === 0) c.moveTo(px, py); else c.lineTo(px, py);
            }
            c.strokeStyle = '#eef3ff';
            c.lineWidth = 1;
            c.stroke();
        }

        // red tune line
        const bx = tuneBinX();
        if (bx >= 0) {
            const x = Math.round(xAt(bx + 0.5)) + 0.5;
            c.strokeStyle = '#ff2d2d';
            c.lineWidth = 1;
            c.beginPath(); c.moveTo(x, RULER_H); c.lineTo(x, Hcss); c.stroke();
        }

        // peak readout, top-right
        if (pkHold) {
            let mx = DB_LO;
            for (let x = 0; x < WF_BINS; x++) if (pkHold[x] > mx) mx = pkHold[x];
            c.fillStyle = '#3ee6a0';
            c.font = '10px JetBrains Mono, monospace';
            c.textAlign = 'right';
            c.fillText(`PK ${mx.toFixed(0)} dB`, Wcss - 4, RULER_H + 12);
        }
    }

    // spectrum has its own render loop (~30 fps): the trace gets every
    // incoming packet, the peak fall animates smoothly between packets,
    // and the passband/tune markers move without waiting for waterfall rows
    function specLoop() {
        requestAnimationFrame(specLoop);
        specTog = !specTog;
        if (specTog || !specCtx) return;    // ~30 fps is plenty for a spectrum
        drawSpectrum();
    }
    let specTog = false;
    requestAnimationFrame(specLoop);

    // ---- Mixer helpers -------------------------------------------------------
    // Firmware-exact PWM frequency math (same split as pwm_generator.js:
    // pc = floor(84e6/Hz), psc = floor(pc/65536)+1, ticks = floor(pc/psc),
    // real = 84e6/(psc*ticks)). The firmware re-decodes a sent Hz into the
    // same (pc, psc, ticks), so this predicts the LO the timer really makes.
    function mixPwmReal(f) {
        const CLK = 84000000;
        f = Math.round(Math.max(1, Math.min(42000000, f)) || 1);
        const pc = Math.max(1, Math.floor(CLK / f));
        const psc = Math.floor(pc / 65536) + 1;
        const ticks = Math.max(1, Math.floor(pc / psc));
        return CLK / (psc * ticks);
    }
    // physical IF the mixer puts on the ADC input for the wanted channel,
    // measured against the window anchor MIX.qfs (side +1: RF = qfs + IF;
    // side -1 Aligned image windows: RF = qfs - IF, so the delta is negative
    // there -- callers use its absolute value wherever the sign doesn't
    // matter). The anchor is the LO's commutation harmonic the window rides:
    // 2*LO on fundamental windows, h*2*LO on Aligned harmonic windows.
    function mixDelta(hz) { return hz - MIX.qfs; }
    // workable window for the physical IF |delta|: away from DC boundary
    // junk, below the spectrum top (the firmware NCO places the demod
    // carrier at +IF0 wherever the channel actually sits, so ANY position
    // inside the band is fine)
    function mixBounds() {
        const half = fsHz() / 2;
        return {
            // 4 kHz floor: the audio passband reaches down to (channel - IF0),
            // a parked channel below ~4k would pull ADC DC/1-f junk into the
            // demod band; 10 kHz margin under the spectrum top
            dLow: 4000,
            dHigh: half - Math.min(10000, half * 0.06),
        };
    }
    // Choose the PWM LO so the channel lands in the workable band: full
    // staircase scan (LO = CLK/n, realized via mixPwmReal). The Auto mode is
    // upper-sideband-only: RF = 2*LO + IF, IF inside [dLow..dHigh] -- the
    // picture is always a direct, non-mirrored view (the Aligned mode may
    // additionally use mirrored image windows, see below). Park near the
    // window middle -> ~fs/2 tuning headroom in both directions; when the
    // tune leaves the window, a new LO is derived from the new window
    // frequency -- nothing else is kept.
    // The PWM staircase is coarse (entry spacing 2*84e6/(n(n+1)) of RF, e.g.
    // ~700 kHz per entry at LO 5.6 MHz), so some RF bands have no window at
    // all; those are reported honestly as a coverage gap.
    // Returns 0 (no LO change), 1 (LO re-set), 2 (side flip -- image-window
    // entry/exit of the Aligned mode).
    function mixRetune(force) {
        if (MIX.loMode === 'aligned') return mixRetuneAligned(force);
        // Manual override: the LO belongs to the user and the parking never
        // touches it. The only exception -- a fresh session with nothing
        // parked yet (force start derives it from the tune once, so the
        // Manual field has a sane value to work from).
        if (MIX.loMode === 'manual' && !(force && MIX.loReal <= 0)) return 0;
        return mixAutoParkLadder(force, false);
    }
    // Plain Auto ladder park (upper sideband only), also reused by the
    // Aligned mode as a FALLBACK: when the fs/2 grid offers nothing better
    // than a deep commutation harmonic (h >= 5: conversion -14 dB and
    // worse) or no aligned window at all, a full-strength ladder window
    // wins over the comb-free screen in those narrow slots; the status
    // marks such windows "FB", so the returning harmonic comb is expected.
    function mixAutoParkLadder(force, fb) {
        if (S.listenHz < MIX.minRfHz) return 0;
        const { dLow, dHigh } = mixBounds();
        const park = (dLow + dHigh) / 2;
        if (!force) {
            // in-window cruising keeps the LO while RF stays inside
            // [2*LO + dLow .. 2*LO + dHigh]; below the window base it is
            // already another window -> the LO is recomputed from RF
            const d = mixDelta(S.listenHz);
            if (d >= dLow && d <= dHigh) return 0;
        }
        let best = null, bestErr = Infinity;
        // candidate for realizable period n: mid-band sent value
        // s = floor(84e6/(n+0.5)) -- the firmware decode pc = floor(84e6/s)
        // then always lands on n (the band edge value floor(84e6/n) can decode
        // to n-1!), so the realized LO is exactly CLK/n and the channel
        // offset is exact for every staircase entry
        // park target: mid-window while RF allows it; when RF is too low for
        // a mid-window park the target clamps down to the LO floor
        // (2*LO = 40 kHz stays under every tuned RF, so the low bands ride
        // one parking whose window is fully valid RF>0 from its left edge)
        const parkU = Math.min(park, S.listenHz - 2 * MIX_LO_FLOOR_HZ);
        for (let n = 2; n <= 42000; n++) {          // LO floor 2 kHz
            const s = Math.floor(84000000 / (n + 0.5));
            const lo = mixPwmReal(s);
            const d = S.listenHz - 2 * lo;
            if (d < dLow || d > dHigh) continue;    // upper sideband only
            const err = Math.abs(d - parkU) + (MIX.side > 0 ? 0 : 1e-3);
            if (err < bestErr) { bestErr = err; best = s; }
        }
        if (best === null) return 0;                // blind RF: keep last LO
        const rNew = mixPwmReal(best);
        if (!force && rNew === MIX.loReal) return 0;
        const flip = (MIX.side !== 1) ? 2 : 1;
        MIX.side = 1;
        MIX.alignH = 0;                             // not an aligned window
        MIX.fb = fb;                                // false: Auto; true: Aligned fallback
        MIX.loReal = rNew;                          // store the realized LO
        MIX.loSent = best;                          // ... and the exact send value
        MIX.qfs = 2 * rNew;                         // fundamental window anchor
        return flip;
    }
    // ---- Aligned mode: LO locked to the fs/2 grid ---------------------------
    // LO = j*fs/2 is an exact PWM node whenever j divides D = 2*CLK/fs
    // (168 @ fs 1000k, 112 @ fs 1500k, ...) because the timer period is then
    // n = 2*CLK/(j*fs) = D/j, an integer. On such a node EVERY odd
    // commutation harmonic h*2*LO = h*j*fs is an exact multiple of fs, so
    // the LO feedthrough and all spurious mixing products alias onto the
    // screen edges (0 / fs/2) instead of dumping a comb into the band, and
    // station ghosts fold onto the same columns as the direct alias lens.
    // The RX window then sits at RF = h*j*fs +- IF: the mixer hardware does
    // its own harmonic mixing, the firmware just sees a plain PWM frequency
    // and the ordinary IF tune -- nothing changes for it.
    // Window search for the tuned RF: q = h*j with h in {1, 3, .., hMax};
    // direct upper window (side +1, parity 0) or mirrored image window
    // (side -1, parity 1 -- same look as the odd Nyquist zones). Fewest
    // harmonics wins (conversion loss ~ 20*log10(h) dB), then the park
    // error, then the direct view beats the mirrored one.
    // If the best window still rides a deep harmonic (h >= 5: conversion
    // -14 dB) or the band has no aligned window at all, the parking falls
    // back to the plain Auto ladder (full conversion; the status marks
    // such windows "FB", so the harmonic comb is expected there).
    // Park target: window middle, clamped under the front-end LC low-pass
    // (fc ~340 kHz) so the channel never sits in the filter skirt at
    // fs 1500 kHz, whose windows reach 740 kHz.
    function mixAlignedDivisors() {
        const D = Math.round(168000000 / fsHz());
        const cap = Math.floor(84000000 / fsHz());  // LO <= 42 MHz PWM limit
        const divs = [];
        for (let j = 1; j <= cap; j++) if (D % j === 0) divs.push(j);
        return divs;
    }
    function mixRetuneAligned(force) {
        if (S.listenHz < MIX.minRfHz) return 0;
        const { dLow, dHigh } = mixBounds();
        const park = Math.min((dLow + dHigh) / 2, 330000);
        let best = null;
        const better = (a, b) => {
            if (a.h !== b.h) return a.h < b.h;
            const ea = Math.abs(a.ifv - park), eb = Math.abs(b.ifv - park);
            if (ea !== eb) return ea < eb;
            return a.side > b.side;
        };
        for (const j of mixAlignedDivisors()) {
            for (let h = 1; h <= MIX.hMax; h += 2) {
                const qf = j * h * fsHz();          // RF anchor of this window
                const up = S.listenHz - qf;         // direct window IF
                if (up >= dLow && up <= dHigh) {
                    const cand = { h: h, j: j, side: 1, ifv: up, qf: qf };
                    if (!best || better(cand, best)) best = cand;
                }
                const im = qf - S.listenHz;         // mirrored window IF
                if (im >= dLow && im <= dHigh) {
                    const cand = { h: h, j: j, side: -1, ifv: im, qf: qf };
                    if (!best || better(cand, best)) best = cand;
                }
            }
        }
        // the grid has nothing better than a deep harmonic (h >= 5, global
        // conversion loss >= 14 dB) or no aligned window at all -> a
        // full-strength Auto ladder window wins, the comb returns there
        if (best === null || best.h >= 5) return mixAutoParkLadder(force, true);
        const lo = best.j * fsHz() / 2;             // exact grid node
        const n = Math.round(84000000 / lo);        // = D/j, integer by design
        const s = Math.floor(84000000 / (n + 0.5)); // decode lands on n exactly
        // in-window (same anchor + same side) cruising keeps everything; a
        // move to ANOTHER window of the same LO (e.g. h=1 -> h=3) must still
        // re-label the screen, the RF meaning of every column changes
        if (!force && best.side === MIX.side && best.qf === MIX.qfs) return 0;
        const flip = (MIX.side !== best.side) ? 2 : 1;
        MIX.side = best.side;
        MIX.alignH = best.h;
        MIX.fb = false;                             // a true aligned window again
        MIX.loReal = lo;
        MIX.loSent = s;
        MIX.qfs = best.qf;                          // harmonic window anchor
        return flip;
    }
    // User-typed LO (Manual mode): quantize to the nearest realizable PWM
    // ladder node (LO = 84 MHz / integer period), store it exactly like the
    // auto park does (loReal + the mid-band integer to send). Returns true
    // when a valid LO ended up registered.
    function applyManualLo(txt) {
        if (!MIX.on) return false;
        const v = parseFloat(String(txt).replace(',', '.'));
        if (!(v > 0)) return false;
        const want = Math.min(42000000, Math.max(2000, Math.round(v * 1e6)));
        const n0 = Math.round(84000000 / want);
        let bestN = Math.max(2, Math.min(42000, n0)), bestErr = Infinity;
        for (let n = Math.max(2, n0 - 2); n <= Math.min(42000, n0 + 2); n++) {
            const lo = mixPwmReal(Math.floor(84000000 / (n + 0.5)));
            const err = Math.abs(lo - want);
            if (err < bestErr) { bestErr = err; bestN = n; }
        }
        const s = Math.floor(84000000 / (bestN + 0.5));
        const rNew = mixPwmReal(s);
        MIX.side = 1;
        MIX.alignH = 0;                     // a Manual LO is never an aligned window
        MIX.fb = false;                     // ... and never a fallback
        MIX.loReal = rNew;
        MIX.loSent = s;
        MIX.qfs = 2 * rNew;                 // fundamental window anchor
        updateMixLabels();
        return true;
    }
    // (re)start the PWM LO: firmware waveform 0 = square, fixed 50% duty.
    // MIX.loSent is the mid-band integer whose decode realizes MIX.loReal
    // exactly (rounding the realized value instead could cross into the
    // neighboring period band, e.g. 129429.9 -> 129430 decodes as pc 648!).
    function mixLoStart() {
        if (!(MIX.loSent > 0 || MIX.loReal > 0)) return;    // nothing parked yet
        const f = Math.round(Math.max(1, Math.min(42000000, MIX.loSent || MIX.loReal)));
        const payload = new Uint8Array(7);
        payload[0] = MIX.loPinIdx;
        payload[1] = 0;                        // square 50%
        payload[2] = f & 0xFF;
        payload[3] = (f >> 8) & 0xFF;
        payload[4] = (f >> 16) & 0xFF;
        payload[5] = (f >>> 24) & 0xFF;
        payload[6] = 50;
        microTester.sendCommand(CMD_SIG_START, payload);
        MIX.loOwned = true;
        updateMixLabels();
    }
    function mixLoStop() {
        microTester.sendCommand(CMD_SIG_STOP);
        MIX.loOwned = false;
    }
    // firmware-safe pseudo "listen" frequency: positive physical IF, clamped
    // below fs/2 (on blind RF the firmware then gets a sane value; the audio
    // is junk there anyway and the status shows the gap)
    function mixPseudo() {
        let d = Math.abs(mixDelta(S.listenHz));
        const lim = fsHz() / 2 - 1000;
        if (d > lim) d = lim;
        return d;
    }
    // RF of the left edge of the drawn (screen-ascending) window, measured
    // from the window anchor: direct windows span [qfs .. qfs+fs/2],
    // mirrored image windows span [qfs-fs/2 .. qfs]
    function mixWinBase() {
        return MIX.side > 0 ? MIX.qfs : MIX.qfs - fsHz() / 2;
    }
    function updateMixLabels() {
        const el = document.getElementById('sdrMixerLo');
        if (el) {
            const f = MIX.on ? MIX.loReal : 0;
            const tag = !MIX.on ? ''
                : (MIX.loMode === 'manual' ? ' · M' : (MIX.loMode === 'aligned' ? ' · A' : ''));
            el.textContent = (MIX.on && f > 0) ? (f >= 1e6 ? 'LO ' + (f / 1e6).toFixed(5) + 'M'
                : 'LO ' + Math.round(f / 1e3) + 'k') + tag : '';
        }
    }

    // alias-fold helpers
    function fsHz() { return S.fsKHz * 1000; }
    function binHz() { return fsHz() / 1024; }
    // mixer: every window is the upper (direct) sideband, so the parity is
    // fixed 0 -- no mirrored image view at all; the undersampling display
    // still alternates even/direct and odd/mirrored zones
    function foldParity(f) {
        return MIX.on ? (MIX.side < 0 ? 1 : 0) : Math.floor(f / (fsHz() / 2)) & 1;
    }
    function foldAlias(f) {
        if (MIX.on) return Math.abs(mixDelta(f));          // physical IF vs window anchor
        const half = fsHz() / 2;
        const z = Math.floor(f / half);
        return (z & 1) ? ((z + 1) * half - f) : (f - z * half);
    }
    // RF of waterfall bin b, null if outside the tuned half-zone
    function rfFromBin(b) {
        const half = fsHz() / 2;
        const nu = b * binHz();
        if (nu >= half) return null;
        const diff = nu - foldAlias(S.listenHz);
        const rf = S.listenHz + (foldParity(S.listenHz) ? -diff : diff);
        if (MIX.on) return rf < 0 ? null : rf;   // image bins below DC show no real RF
        if (Math.floor(rf / half) !== Math.floor(S.listenHz / half)) return null;
        return rf;
    }
    function tuneBinX() {
        const b = Math.round(foldAlias(S.listenHz) / binHz());
        return (b < 0 || b >= WF_BINS) ? -1 : b;
    }

    let drawPending = false;
    function scheduleDraw() {
        if (drawPending) return;
        drawPending = true;
        requestAnimationFrame(() => { drawPending = false; drawWaterfall(); });
    }

    // ---------------------------------------------------- DSP core
    const DSP = {
        fsAud: 31250,
        N: 1024,
        HOP: 512,
        ring: null, rd: 0, wr: 0,
        reA: null, imA: null,     // stage A spectrum / time workspace
        reB: null, imB: null,     // stage B
        tmRe: null, tmIm: null,   // stage B pristine copy for sideband mirror
        hRe: null, hIm: null,     // stage A -> rotated fresh (z_d)
        h2Re: null, h2Im: null,   // stage B history (previous z_d fresh)
        h2Valid: false,
        hARe: null, hAIm: null,   // stage B cache while switching modes
        fmOk: false,              // FM demod phase history valid
        fmPrevRe: 0, fmPrevIm: 0, // last rotated sample of the previous block
        fLpf: 0,                  // FM post-demod audio LPF state
        fmRms: 0,                 // smoothed CHANNEL carrier RMS (FM S-meter source)
        agcGain: 1,
        audAbs: 0,
    };
    const OUT = { buf: null, len: 0, rms: 0, peak: 0, prevIn: 0, prevOut: 0 };

    let fftTwC = null, fftTwS = null, fftRev = null;
    function buildFftTables(N) {
        const TWO_PI = Math.PI * 2;
        fftTwC = new Float32Array(N / 2);
        fftTwS = new Float32Array(N / 2);
        for (let k = 0; k < N / 2; k++) {
            fftTwC[k] = Math.cos(TWO_PI * k / N);
            fftTwS[k] = Math.sin(TWO_PI * k / N);
        }
        fftRev = new Uint16Array(N);
        for (let i = 0; i < N; i++) {
            let r = 0;
            for (let b = 1; b < N; b <<= 1) { r <<= 1; if (i & b) r |= 1; }
            fftRev[i] = r;
        }
    }

    function fftInPlace(re, im, N, inverse) {
        for (let i = 0; i < N; i++) {
            const j = fftRev[i];
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let len = 2; len <= N; len <<= 1) {
            const half = len >> 1, step = N / len;
            const sgn = inverse ? -1 : 1; // DFT convention: forward twiddle e^{-j}, inverse e^{+j}
            for (let i = 0; i < N; i += len) {
                for (let j = 0; j < half; j++) {
                    const wi = j * step;
                    const c = fftTwC[wi];
                    const s = fftTwS[wi] * sgn;
                    const a = i + j, b = a + half;
                    const xr = re[b], xi = im[b];
                    const tr = xr * c + xi * s;   // (x)·e^{-jθ}: Re
                    const ti = xi * c - xr * s;   // Im
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                }
            }
        }
        if (inverse) {
            const g = 1 / N;
            for (let i = 0; i < N; i++) { re[i] *= g; im[i] *= g; }
        }
    }

    function initDsp() {
        DSP.fsAud = fsHz() / 32;
        const N = DSP.N, HOP = DSP.HOP;
        DSP.reA = new Float32Array(N); DSP.imA = new Float32Array(N);
        DSP.reB = new Float32Array(N); DSP.imB = new Float32Array(N);
        DSP.tmRe = new Float32Array(N); DSP.tmIm = new Float32Array(N);
        DSP.hRe = new Float32Array(HOP); DSP.hIm = new Float32Array(HOP);
        DSP.h2Re = new Float32Array(HOP); DSP.h2Im = new Float32Array(HOP);
        DSP.hARe = new Float32Array(HOP); DSP.hAIm = new Float32Array(HOP);
        DSP.h2Valid = false;
        DSP.ring = new Float32Array(32768); DSP.rd = 0; DSP.wr = 0;
        DSP.agcGain = 1;
        DSP.audAbs = 0;
        DSP.fmOk = false; DSP.fLpf = 0;
        DSP.fmRms = 0;
        OUT.buf = new Float32Array(HOP); OUT.len = 0; OUT.rms = 0;
        OUT.peak = 0; OUT.prevIn = 0; OUT.prevOut = 0;
        buildFftTables(N);
        if (workletNode) workletNode.port.postMessage({ t: 'rate', v: DSP.fsAud });
        else if (sprocNode) { SP.base = DSP.fsAud / audioCtx.sampleRate; SP.step = SP.base; }
    }

    // raw payload -> input ring. Fixed-width float scale (~+-1) keeps AGC,
    // S-meter and worklet pacing identical in both ADC modes.
    function onAudioSamples(payload, meta) {
        if (!MIX.on) S.parity = meta & 1;   // mixer keeps its browser-side parity
        const twelve = !!(meta & 2);
        S.effectiveBw = S.bwHz;
        if (!DSP.reA) return;
        const m = DSP.ring.length - 1;
        if (twelve) {
            // firmware sends little-endian int16, +-2047 -> float/2048
            for (let i = 0; i + 1 < payload.length; i += 2) {
                let v = payload[i] | (payload[i + 1] << 8);
                v = (v << 16) >> 16;                 // sign-extend
                DSP.ring[DSP.wr & m] = v / 2048;
                DSP.wr++;
            }
        } else {
            // two's-complement int8 bytes -> sign-extend
            for (let i = 0; i < payload.length; i++) {
                const v = (payload[i] << 24) >> 24;  // -128..127
                DSP.ring[DSP.wr & m] = v / 128;
                DSP.wr++;
            }
        }
        dspProcess();
    }

    // Raised-cosine edge taper for frequency-domain masks (bin index k)
    function shapedW(k, lo, hi, tap) {
        if (k <= lo - tap || k >= hi + tap) return 0;
        let t = Math.min(1, (k - (lo - tap)) / tap, (hi + tap - k) / tap);
        if (t < 0) t = 0;
        return 0.5 - 0.5 * Math.cos(Math.PI * t);
    }

    function dspProcess() {
        if (!DSP.reA) return;
        const N = DSP.N, HOP = DSP.HOP, fsAud = DSP.fsAud, binH = fsAud / N;
        const m = DSP.ring.length - 1;
        const isAm = (S.mode === 'am');
        const TAP = 8;
        while (DSP.wr - DSP.rd >= HOP) {
            // ---- Overlap-save blocks: NO time window (a window is never undone
            // by frequency masking and would AM the output at 61 Hz).
            const aLo = Math.max(1, Math.floor((S.if0Hz - Math.max(S.bwHz, 1500) / 2) / binH));
            const aHi = Math.min(N / 2 - 1, Math.ceil((S.if0Hz + Math.max(S.bwHz, 1500) / 2) / binH));

            for (let i = 0; i < N; i++) {
                DSP.reA[i] = DSP.ring[(DSP.rd - HOP + i) & m];
                DSP.imA[i] = 0;
            }
            fftInPlace(DSP.reA, DSP.imA, N, false);
            // analytic + bandpass around IF0: positive bins only, smooth edges
            for (let k = 0; k < N; k++) {
                if (k >= 1 && k < N / 2) {
                    const w = shapedW(k, aLo, aHi, TAP) * 2;
                    DSP.reA[k] *= w; DSP.imA[k] *= w;
                } else { DSP.reA[k] = 0; DSP.imA[k] = 0; }
            }
            fftInPlace(DSP.reA, DSP.imA, N, true);

            if (isAm) {
                for (let i = HOP; i < N; i++) {
                    const r = DSP.reA[i], ii = DSP.imA[i];
                    emitAudio(Math.sqrt(r * r + ii * ii));
                }
            } else {
                for (let i = 0; i < HOP; i++) {
                    DSP.hRe[i] = DSP.reA[HOP + i];
                    DSP.hIm[i] = DSP.imA[HOP + i];
                }
                // ---- rotate z_an by e^{-j·2π fRot n/fs} -> carrier to 0 (+beat)
                const fRot = S.if0Hz + (S.mode === 'cw' ? -S.beatHz : 0);
                const th = 2 * Math.PI * fRot / fsAud;
                const ph0 = -(((DSP.audAbs % fsAud) * fRot % fsAud) / fsAud) * 2 * Math.PI;
                let c = Math.cos(ph0), s = Math.sin(ph0);
                const cr = Math.cos(th), sn = -Math.sin(th);
                let renorm = 0;
                for (let i = 0; i < HOP; i++) {
                    const r = DSP.hRe[i], ii = DSP.hIm[i];
                    const nr = r * c - ii * s;
                    const ni = r * s + ii * c;
                    DSP.hRe[i] = nr; DSP.hIm[i] = ni;
                    const tc = c * cr - s * sn, ts = c * sn + s * cr;
                    c = tc; s = ts;
                    if (++renorm >= 256) {
                        const nn = Math.hypot(c, s) || 1;
                        c /= nn; s /= nn; renorm = 0;
                    }
                }
                // ---- stage B: FFT of z_d block, one-sided sideband mask
                for (let i = 0; i < HOP; i++) {
                    DSP.reB[i] = DSP.h2Re[i]; DSP.imB[i] = DSP.h2Im[i];
                    DSP.reB[HOP + i] = DSP.hRe[i]; DSP.imB[HOP + i] = DSP.hIm[i];
                }
                if (S.mode === 'fm') {
                    // ---- FM: instantaneous-frequency demod on the rotated channel.
                    // w[n] = arg-derivative of the analytic channel at DC; freq
                    // = arg(w[n] * conj(w[n-1])) * fsAud/2pi. The carrier cluster
                    // is whole-band here in BOTH parities (mirrored zones only
                    // conjugate the phase -> negated audio amplitude), so like
                    // AM this path is parity-agnostic and skips the sideband FFT.
                    // Normalization: |dev| = bw/2 -> +-1.0 out (AGC handles the rest).
                    const rot = fsAud / (2 * Math.PI);
                    const sca = 2 / S.bwHz;
                    const lpfA = 1 - Math.exp(-2 * Math.PI * 3400 / fsAud); // ~3.4 kHz audio LPF (FM noise falls fast, voice <= 3k)
                    if (!DSP.fmOk) {                       // fresh tune/start: seed from itself
                        DSP.fmPrevRe = DSP.reB[HOP]; DSP.fmPrevIm = DSP.imB[HOP];
                        DSP.fmOk = true; DSP.fLpf = 0;
                    }
                    let pr = DSP.fmPrevRe, pi = DSP.fmPrevIm;
                    let chp = 0;                           // channel power for the S-meter
                    for (let i = HOP; i < N; i++) {
                        const vr = DSP.reB[i], vi = DSP.imB[i];
                        chp += vr * vr + vi * vi;
                        const dr = vr * pr + vi * pi;      // Re{ w[i] * conj(w[i-1]) }
                        const di = vr * pi - vi * pr;      // Im{ w[i] * conj(w[i-1]) }
                        pr = vr; pi = vi;
                        DSP.fLpf += lpfA * (Math.atan2(di, dr) - DSP.fLpf);
                        emitAudio(DSP.fLpf * rot * sca);
                    }
                    DSP.fmPrevRe = pr; DSP.fmPrevIm = pi;
                    {
                        // S-meter source: carrier amplitude of the analytic channel.
                        // Demod AUDIO RMS on FM tracks voice syllables and dominates
                        // on tuning noise (reads S9+20 while idle) — channel power is
                        // the real signal-strength measure and stays put during speech.
                        const r = Math.sqrt(chp / (N - HOP));
                        DSP.fmRms = DSP.fmRms ? DSP.fmRms * 0.95 + r * 0.05 : r;  // ~0.33 s
                    }
                } else {
                fftInPlace(DSP.reB, DSP.imB, N, false);
                const even = (S.parity === 0);
                let wantPos;
                if (S.mode === 'cw') wantPos = true;
                else wantPos = (S.mode === 'usb') ? even : !even;
                const bwHalf = S.bwHz / 2;
                const fCenter = (S.mode === 'cw') ? S.beatHz : 0;
                const bLo = Math.max(1, Math.floor((fCenter - bwHalf) / binH));
                const bHi = Math.min(N / 2 - 1, Math.ceil((fCenter + bwHalf) / binH));
                // pristine copy for mirror reads
                DSP.tmRe.set(DSP.reB); DSP.tmIm.set(DSP.imB);
                for (let k = 0; k < N; k++) {
                    let vr = 0, vi = 0;
                    if (k >= 1 && k < N / 2) {
                        const f = k * binH;
                        if (wantPos) {
                            if (f >= fCenter - bwHalf && f <= fCenter + bwHalf) {
                                const w = shapedW(k, bLo, bHi, TAP);
                                vr = DSP.tmRe[k] * w; vi = DSP.tmIm[k] * w;
                            }
                        } else {
                            // keep audio at -f: pull Z[N-k] (conjugated) into slot k
                            const j = N - k;
                            if (f >= fCenter - bwHalf && f <= fCenter + bwHalf) {
                                const w = shapedW(k, bLo, bHi, TAP);
                                vr = DSP.tmRe[j] * w; vi = -DSP.tmIm[j] * w;
                            }
                        }
                    }
                    DSP.reB[k] = vr; DSP.imB[k] = vi;
                }
                fftInPlace(DSP.reB, DSP.imB, N, true);
                for (let i = HOP; i < N; i++) emitAudio(DSP.reB[i]);
                }
            }

            // stage-B history = rotated fresh samples (SSB) or stage-A analytic (AM)
            if (isAm) {
                // on switch back to SSB, h2 is slight garbage for one block — ok
                for (let i = 0; i < HOP; i++) {
                    DSP.h2Re[i] = DSP.reA[HOP + i];
                    DSP.h2Im[i] = DSP.imA[HOP + i];
                }
            } else {
                for (let i = 0; i < HOP; i++) {
                    DSP.h2Re[i] = DSP.hRe[i];
                    DSP.h2Im[i] = DSP.hIm[i];
                }
            }
            DSP.h2Valid = true;
            DSP.audAbs += HOP;
            DSP.rd += HOP;
        }
    }

    // output: DC blocker + AGC + push to worklet
    function emitAudio(x) {
        const a = 0.992; // ~55 Hz HPF @31.25k
        const y = x - OUT.prevIn + a * OUT.prevOut;
        OUT.prevIn = x; OUT.prevOut = y;
        OUT.rms += y * y;
        const p = y < 0 ? -y : y;
        if (p > OUT.peak) OUT.peak = p;
        OUT.buf[OUT.len++] = y * DSP.agcGain;
        if (OUT.len >= OUT.buf.length) {
            const rms = Math.sqrt(OUT.rms / OUT.len) + 1e-7;
            // peak-aware target: never let gain*peak exceed ~0.8 (no clipping
            // on spiky content / pumped noise), rms target 0.45 for speech
            let gT = Math.min(0.45 / rms, 0.8 / (OUT.peak + 1e-6));
            if (gT > 24) gT = 24;
            if (gT < 0.02) gT = 0.02;
            DSP.agcGain += (gT - DSP.agcGain) * (gT < DSP.agcGain ? 0.9 : 0.08);
            OUT.rms = 0; OUT.len = 0; OUT.peak = 0;
            pushAudio(OUT.buf);
            OUT.buf = new Float32Array(DSP.HOP);
        }
    }

    // ---------------------------------------------------- audio output
    let audioCtx = null, workletNode = null, sprocNode = null;
    // ScriptProcessor fallback state (needed on file:// pages where Chrome
    // refuses to load blob-URL AudioWorklet module scripts)
    const SP = { ring: null, wr: 0, rd: 0, p: 0, step: 0, base: 0, vol: 0.7, prerolled: false, target: 4096, meter: 0, meterN: 0 };
    const WORKLET_SRC = `
    class SdrOutProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.ring = new Float32Array(32768);
        this.wr = 0; this.rd = 0;
        this.p = 0;
        this.base = 31250 / sampleRate;   // nominal read step
        this.step = this.base;
        this.vol = 0.7;
        // Pre-roll: accumulate a buffer before playback starts. Without it the
        // read pointer (rd) instantly catches the write pointer (wr) because
        // production and consumption rates are identical -> constant silence.
        this.prerolled = false;
        this.target = 2048;               // ~65 ms of headroom @31.25 kS/s
        this.meter = 0; this.meterN = 0;
        this.port.onmessage = (e) => {
          const d = e.data;
          if (d.t === 's') {
            const arr = d.d;
            for (let i = 0; i < arr.length; i++) this.ring[this.wr++ & 32767] = arr[i];
          } else if (d.t === 'v') { this.vol = d.v; }
          else if (d.t === 'rate') { this.base = d.v / sampleRate; this.step = this.base; }
        };
      }
      process(inputs, outputs) {
        const out = outputs[0][0];
        const lvl = this.wr - this.rd;
        if (!this.prerolled) {
          if (lvl < this.target) { out.fill(0); return true; }  // wait for buffer
          this.prerolled = true;
        }
        // Async pacing: nudge the read rate +-0.15% so the buffer settles
        // near the target and absorbs USB/DSP arrival jitter.
        const err = Math.max(-1, Math.min(1, (lvl - this.target) / this.target));
        this.step = this.base * (1 + 0.0015 * err);
        let rms = 0;
        let hardUnderrun = false;
        for (let i = 0; i < out.length; i++) {
          this.p += this.step;
          while (this.p >= 1) { this.p -= 1; this.rd++; }
          if (this.rd > this.wr) { this.rd = this.wr; hardUnderrun = true; } // hard underrun
          const i0 = this.rd & 32767, i1 = (this.rd + 1) & 32767;
          let v;
          if (this.rd >= this.wr) v = 0;
          else v = this.ring[i0] + (this.ring[i1] - this.ring[i0]) * this.p;
          out[i] = v * this.vol;
          rms += v * v;
        }
        if (hardUnderrun) this.prerolled = false; // re-buffer only after empty drain
        this.meter += rms; this.meterN += out.length;
        if (this.meterN > 2048) {
          this.port.postMessage({ t: 'm', v: Math.sqrt(this.meter / this.meterN + 1e-12) });
          this.meter = 0; this.meterN = 0;
        }
        return true;
      }
    }
    registerProcessor('sdr-out', SdrOutProcessor);
    `;

    function pushAudio(f32) {
        if (workletNode) {
            workletNode.port.postMessage({ t: 's', d: f32 });
            return;
        }
        if (sprocNode) sprocPush(f32);
    }

    function sprocPush(f32) {
        const r = SP.ring;
        for (let i = 0; i < f32.length; i++) r[SP.wr++ & 32767] = f32[i];
    }

    // Same pacing algorithm as the worklet: preroll, +-0.15% async read rate,
    // hard-underrun re-buffer. Runs in the main thread at 2048-sample chunks.
    function sprocFill(out) {
        if (!SP.ring) { out.fill(0); return; }
        const lvl = SP.wr - SP.rd;
        if (!SP.prerolled) {
            if (lvl < SP.target) { out.fill(0); return; }
            SP.prerolled = true;
        }
        const err = Math.max(-1, Math.min(1, (lvl - SP.target) / SP.target));
        SP.step = SP.base * (1 + 0.0015 * err);
        let rms = 0;
        let hard = false;
        for (let i = 0; i < out.length; i++) {
            SP.p += SP.step;
            while (SP.p >= 1) { SP.p -= 1; SP.rd++; }
            if (SP.rd > SP.wr) { SP.rd = SP.wr; hard = true; }
            let v = 0;
            if (SP.rd < SP.wr) {
                const i0 = SP.rd & 32767, i1 = (SP.rd + 1) & 32767;
                v = SP.ring[i0] + (SP.ring[i1] - SP.ring[i0]) * SP.p;
            }
            out[i] = v * SP.vol;
            rms += v * v;
        }
        if (hard) SP.prerolled = false;
        SP.meter += rms; SP.meterN += out.length;
        if (SP.meterN > 4096) {
            meterTick(Math.sqrt(SP.meter / SP.meterN + 1e-12));
            SP.meter = 0; SP.meterN = 0;
        }
    }

    async function ensureAudio() {
        if (audioCtx) return;
        audioCtx = new AudioContext({ latencyHint: 'interactive' });
        try {
            const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
            await audioCtx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            workletNode = new AudioWorkletNode(audioCtx, 'sdr-out', {
                numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]
            });
            workletNode.connect(audioCtx.destination);
            workletNode.port.postMessage({ t: 'v', v: S.volume });
            workletNode.port.postMessage({ t: 'rate', v: DSP.fsAud || (fsHz() / 32) });
            workletNode.port.onmessage = (e) => { if (e.data.t === 'm') meterTick(e.data.v); };
        } catch (e) {
            // Chrome blocks module loads from file:// -> degrade gracefully
            console.warn('[SDR] AudioWorklet unavailable, using ScriptProcessor fallback:', e && e.name);
            workletNode = null;
            sprocNode = audioCtx.createScriptProcessor(2048, 0, 1);
            sprocNode.onaudioprocess = (ev) => sprocFill(ev.outputBuffer.getChannelData(0));
            sprocNode.connect(audioCtx.destination);
            SP.ring = new Float32Array(32768);
            SP.wr = 0; SP.rd = 0; SP.p = 0;
            SP.base = DSP.fsAud / audioCtx.sampleRate;
            SP.step = SP.base;
            SP.vol = S.volume;
            SP.target = 4096;           // bigger headroom than the worklet (~131 ms)
            SP.prerolled = false;
        }
        await audioCtx.resume();
    }

    // ---------------------------------------------------- S-meter
    let smDb = -60;
    function updateSMeter(rms) {
        const db = 20 * Math.log10(rms * 2.5 + 1e-9);
        smDb = smDb * 0.7 + db * 0.3;
    }
    // FM: feed the meter from the channel carrier RMS, not the audio RMS —
    // audio RMS on FM swings with syllables and tuning noise, the carrier
    // level is what an S-meter should read.
    function updateSMeterFm() {
        const db = 20 * Math.log10(DSP.fmRms * 2.5 + 1e-9);
        smDb = smDb * 0.7 + db * 0.3;
    }
    const meterTick = (rms) => { if (S.mode === 'fm') updateSMeterFm(); else updateSMeter(rms); };
    setInterval(() => {
        const bar = document.getElementById('sdrSMeterBar');
        const txt = document.getElementById('sdrSMeterDb');
        if (!bar) return;
        const v = Math.max(0, Math.min(100, (smDb + 60) / 45 * 100));
        bar.style.width = v + '%';
        const s = smDb + 60;
        let word;
        if (s < 6) word = 'S1'; else if (s < 12) word = 'S2'; else if (s < 18) word = 'S3';
        else if (s < 24) word = 'S4'; else if (s < 30) word = 'S5'; else if (s < 36) word = 'S6';
        else if (s < 42) word = 'S7'; else if (s < 48) word = 'S8'; else word = 'S9' + (s < 54 ? '+' : '+20');
        if (txt) txt.textContent = word;
    }, 250);

    // ---------------------------------------------------- status
    setInterval(() => {
        const el = document.getElementById('sdrStatus');
        if (!el) return;
        if (!S.running) { el.textContent = 'Stop'; return; }
        const sink = workletNode ? 'AW' : (sprocNode ? 'SP' : '--');
        const half = fsHz() / 2;
        let win;
        if (MIX.on) {
            const b = mixBounds();
            const ad = Math.abs(mixDelta(S.listenHz));
            const gap = (ad < b.dLow || ad > b.dHigh) ? 'GAP·' : '';
            const base = mixWinBase();        // screen-ascending window left edge
            let head = 'MIX';
            if (MIX.loMode === 'aligned') {
                // FB: plain ladder fallback window (the aligned grid had
                // nothing better than a deep harmonic there); otherwise
                // show the commutation harmonic + its conversion loss
                // (the window itself sits at h*fs, mirrored view marked MIR)
                head = MIX.fb ? 'ALG FB'
                    : MIX.alignH > 1
                        ? `ALG h${MIX.alignH} -${(Math.round(200 * Math.log10(MIX.alignH)) / 10).toFixed(1)}dB ${MIX.side > 0 ? 'DIR' : 'MIR'}`
                        : `ALG ${MIX.side > 0 ? 'DIR' : 'MIR'}`;
            }
            win = `${gap}${head} ${(base / 1e6).toFixed(3)}–${((base + half) / 1e6).toFixed(3)}M · LO ${(MIX.loReal / 1e6).toFixed(4)}M ${MIX_PINS[MIX.loPinIdx]}`;
        } else {
            const z0 = Math.floor(S.listenHz / half) * half;
            win = `win ${(z0 / 1e6).toFixed(1)}–${((z0 + half) / 1e6).toFixed(1)}M ${S.parity ? 'MIR' : 'DIR'}`;
        }
        el.textContent =
            `fs ${S.fsKHz} kHz · ADC ${S.adcBits}b · water ${stats.wf} · audio pkt ${stats.aud} ${sink} · ${win} · gaps ${stats.gaps}`;
    }, 1000);

    // ---------------------------------------------------- WebUSB control
    function u32(x) {
        return new Uint8Array([x & 0xFF, (x >> 8) & 0xFF, (x >> 16) & 0xFF, (x >>> 24) & 0xFF]);
    }

    function startPayload() {
        return new Uint8Array([S.fsKHz & 0xFF, (S.fsKHz >> 8) & 0xFF, S.wfFps, S.pinIdx, S.adcBits]);
    }
    function tunePayload(hz) {
        const b = new Uint8Array(6);
        const f = Math.round(hz);
        b[0] = f & 0xFF; b[1] = (f >> 8) & 0xFF; b[2] = (f >> 16) & 0xFF; b[3] = (f >>> 24) & 0xFF;
        b[4] = S.if0Hz & 0xFF; b[5] = (S.if0Hz >> 8) & 0xFF;
        return b;
    }

    async function sdrStart() {
        if (!microTester.device) {
            const ok = await microTester.connect();
            if (!ok || !microTester.device) { alert('Connect device first!'); return; }
        }
        const fsSel = document.getElementById('cfgSdrFs');
        const fpsSel = document.getElementById('cfgSdrFps');
        const pinSel = document.getElementById('cfgSdrPin');
        const bitsSel = document.getElementById('cfgSdrBits');
        if (fsSel) S.fsKHz = parseInt(fsSel.value, 10) || 1000;
        if (fpsSel) S.wfFps = parseInt(fpsSel.value, 10) || 10;
        if (pinSel) S.pinIdx = parseInt(pinSel.value, 10) || 0;
        if (bitsSel) S.adcBits = parseInt(bitsSel.value, 10) === 12 ? 12 : 8;
        persist();
        stats.wf = 0; stats.aud = 0; stats.gaps = 0;
        stats.wfSeq = null; stats.audSeq = null;
        pkReset();
        if (MIX.on) {
            const r = mixRetune(true);         // park the channel mid-window
            S.parity = foldParity(S.listenHz); // the park may flip the side
            tuneZone = 0;
        } else {
            S.parity = foldParity(S.listenHz);
            tuneZone = Math.floor(S.listenHz / (fsHz() / 2));
        }
        resetWaterfall();
        initDsp();
        // NOTE: sdr_rx_start wipes the stored tune and stops pwm_gen (capture
        // mux discipline), so the sequence must be: SDR first, then the LO,
        // then the tune with the mixer pseudo frequency.
        await microTester.sendCommand(CMD_SDR_START, startPayload());
        S.running = true;
        if (MIX.on) mixLoStart();
        await microTester.sendCommand(CMD_SDR_TUNE, tunePayload(MIX.on ? mixPseudo() : S.listenHz));
        try { await ensureAudio(); } catch (e) { console.error('[SDR] audio init failed', e); }
        updateUi();
    }

    async function sdrStop() {
        await microTester.sendCommand(CMD_SDR_STOP);
        if (MIX.loOwned) mixLoStop();          // release the LO the mixer started
        S.running = false;
        tuneZone = -1;
        if (audioCtx) {
            try { await audioCtx.close(); } catch (e) { }
            audioCtx = null; workletNode = null; sprocNode = null;
        }
        updateUi();
    }

    let tuneTimer = null;
    let tuneZone = -1;              // Nyquist zone the waterfall history belongs to
    let zoneFlashT = 0;

    // fresh waterfall for a new RF window: the rows are the raw IF spectrum,
    // which is meaningless under the ruler of a different zone
    function resetWaterfall() {
        wfRows.length = 0;
        wfAcc = 0;
        pkReset();
        wfDirty = true;
        if (wfCtx && wfW > 0) {
            wfCtx.setTransform(1, 0, 0, 1, 0, 0);
            wfCtx.fillStyle = '#05070f';
            wfCtx.fillRect(0, 0, wfW, wfH);
        }
        zoneFlashT = performance.now();
        drawWfOverlay();
        setTimeout(drawWfOverlay, 1100);        // clear the flash banner
    }

    function setListen(hz) {
        S.listenHz = Math.max(500, Math.min(60000000, Math.round(hz)));
        // parity must be CURRENT immediately: it drives the demod side mask,
        // the ruler and the zone-cross reset — a 200 ms stale window is what
        // makes the picture look "off by half a zone" while wheeling fast
        S.parity = foldParity(S.listenHz);
        const inp = document.getElementById('sdrListenMHz');
        if (inp && document.activeElement !== inp) inp.value = (S.listenHz / 1e6).toFixed(4);
        persist();
        drawWfOverlay();                     // instant bracket move (no packet wait)
        if (S.running) {
            clearTimeout(tuneTimer);
            tuneTimer = setTimeout(() => {
                if (MIX.on) {
                    // window edge or hole? -> derive a new LO from the tuned
                    // frequency (the window then starts at the new 2*LO and
                    // the ruler/labels move with it); in-window retunes keep
                    // the waterfall history
                    const r = mixRetune(false);
                    if (r) {
                        mixLoStart();
                        S.parity = foldParity(S.listenHz);
                        // LO changed -> the whole RF window moved: rows of the
                        // old window mean other frequencies now, keep nothing
                        resetWaterfall();
                    }
                    // tune = pure NCO retune with the physical IF
                    microTester.sendCommand(CMD_SDR_TUNE, tunePayload(mixPseudo()));
                    updateMixLabels();
                    drawWfOverlay();
                    return;
                }
                // crossing a Nyquist zone re-labels every bin -> drop the
                // stale waterfall history, it belongs to the old RF window
                const z = Math.floor(S.listenHz / (fsHz() / 2));
                if (z !== tuneZone) {
                    tuneZone = z;
                    resetWaterfall();
                }
                microTester.sendCommand(CMD_SDR_TUNE, tunePayload(S.listenHz));
            }, 200);
        }
    }

    function updateUi() {
        const bStart = document.getElementById('btnSdrStart');
        const bStop = document.getElementById('btnSdrStop');
        if (bStart) bStart.disabled = S.running;
        if (bStop) bStop.disabled = !S.running;
        // sidebar green dot
        const dot = document.getElementById('sdrIndicator');
        if (dot) dot.classList.toggle('active', !!S.running);
    }

    // FM uses a different bandwidth set (whole RF channel width, not audio BW).
    // The two sets are disjoint (SSB max 6000, FM entries 2500/5000/10000).
    function syncBwOptions() {
        const sel = document.getElementById('cfgSdrBw');
        if (!sel) return;
        const isFm = (S.mode === 'fm');
        const list = isFm
            ? [[2500, '2.5 kHz (NBFM)'], [5000, '5 kHz'], [10000, '10 kHz (FM wide)']]
            : [[500, '500 Hz'], [1800, '1.8 kHz'], [2400, '2.4 kHz'], [2800, '2.8 kHz'], [3600, '3.6 kHz'], [6000, '6 kHz (AM)']];
        sel.innerHTML = '';
        for (const v of list) {
            const o = document.createElement('option');
            o.value = String(v[0]); o.textContent = v[1];
            if (v[0] === S.bwHz) o.selected = true;
            sel.appendChild(o);
        }
        if (sel.selectedIndex < 0) {         // current width not in this set
            S.bwHz = isFm ? S.fmBw : S.ssbBw;
            sel.value = String(S.bwHz);
        }
    }


    // ---------------------------------------------------- UI wiring
    document.addEventListener('DOMContentLoaded', () => {
        setupCanvases();
        updateUi();
        // Canvas internal size follows CSS layout (HiDPI-crisp). Hidden panels
        // report zero size, so re-init whenever the element gets resized/shown.
        const wfEl = document.getElementById('sdrWf');
        if (wfEl) {
            if ('ResizeObserver' in window) {
                try { new ResizeObserver(() => setupCanvases()).observe(wfEl); } catch (e) { }
            }
            window.addEventListener('resize', () => setupCanvases());
        }
        microTester.addDataListener((data) => framer.push(data));

        // USB unplug: stop the receiver, close audio, clear the green dot.
        // sendCommand is a no-op without the device, so sdrStop is safe here.
        if (microTester.addDisconnectListener) {
            microTester.addDisconnectListener(() => { if (S.running) sdrStop(); });
        }

        const bStart = document.getElementById('btnSdrStart');
        const bStop = document.getElementById('btnSdrStop');
        if (bStart) bStart.addEventListener('click', sdrStart);
        if (bStop) bStop.addEventListener('click', sdrStop);

        const listenInp = document.getElementById('sdrListenMHz');
        if (listenInp) {
            listenInp.value = (S.listenHz / 1e6).toFixed(4);
            listenInp.addEventListener('change', () => {
                const v = parseFloat(listenInp.value);
                if (!isNaN(v) && v > 0) setListen(v * 1e6);
            });
        }

        const bandSel = document.getElementById('cfgSdrBand');
        if (bandSel) {
            bandSel.addEventListener('change', () => {
                const v = parseFloat(bandSel.value);
                if (v > 0) { setListen(v * 1e6); bandSel.selectedIndex = 0; }
            });
        }

        const modeSel = document.getElementById('cfgSdrMode');
        if (modeSel) {
            modeSel.value = S.mode;
            modeSel.addEventListener('change', () => {
                S.mode = modeSel.value;
                // bandwidth option sets for SSB/AM (audio filters, up to 6 kHz)
                // and FM (whole-channel RF width, 2.5/5/10 kHz) are disjoint ->
                // the width tells which group the CURRENT S.bwHz belongs to;
                // each group keeps its own last choice across switches.
                const wasFm = (S.bwHz === 2500 || S.bwHz === 5000 || S.bwHz === 10000);
                if (S.mode === 'fm') {
                    if (!wasFm) S.ssbBw = S.bwHz;
                    S.bwHz = S.fmBw;
                } else {
                    if (wasFm) S.bwHz = S.ssbBw;
                }
                syncBwOptions();
                persist();
                drawWfOverlay();
            });
        }

        // sample-rate select: remember the choice, keep the RF span label
        // honest (span = fs/2); 1500 kHz also halves the mixer's blind gaps
        const fsSel = document.getElementById('cfgSdrFs');
        const spanLbl = document.getElementById('sdrSpanLbl');
        function applyFsUi() {
            if (fsSel) fsSel.value = String(S.fsKHz);
            if (spanLbl) spanLbl.textContent = String(S.fsKHz / 2);
        }
        if (fsSel) {
            fsSel.addEventListener('change', () => {
                S.fsKHz = parseInt(fsSel.value, 10) || 1000;
                applyFsUi();
                persist();
            });
        }
        applyFsUi();
        const bwSel = document.getElementById('cfgSdrBw');
        if (bwSel) {
            bwSel.addEventListener('change', () => {
                S.bwHz = parseInt(bwSel.value, 10) || S.bwHz;
                if (S.mode === 'fm') S.fmBw = S.bwHz;
                persist();
                drawWfOverlay();              // resize bracket instantly
            });
        }
        syncBwOptions();

        const pinSel = document.getElementById('cfgSdrPin');
        if (pinSel) pinSel.value = String(S.pinIdx);

        // ---- Polyakov external-mixer selector ------------------------------
        const mixSel = document.getElementById('sdrMixMode');
        const mixPinSel = document.getElementById('sdrMixLoPin');
        const mixField = document.getElementById('sdrMixLoField');
        const mixModeSel = document.getElementById('sdrMixLoMode');
        const mixLoInp = document.getElementById('sdrMixLoMhz');
        const mixModeField = document.getElementById('sdrMixModeField');
        const mixManualField = document.getElementById('sdrMixManualField');
        const mixHField = document.getElementById('sdrMixHField');
        const mixHMaxSel = document.getElementById('sdrMixHMax');
        // (re)drive the LO after a mode/harmonic change while the SDR runs:
        // park by the new rules, restart the PWM LO, retune the NCO to the
        // physical IF. Returns the mixRetune() flip code (0 = nothing moved).
        function mixRedrive() {
            mixLoStart();
            S.parity = foldParity(S.listenHz);
            microTester.sendCommand(CMD_SDR_TUNE, tunePayload(mixPseudo()));
        }
        function applyMixUi() {
            if (mixPinSel) mixPinSel.value = String(MIX.loPinIdx);
            if (mixField) mixField.style.display = MIX.on ? '' : 'none';
            if (mixModeField) mixModeField.style.display = MIX.on ? '' : 'none';
            if (mixHField) mixHField.style.display = (MIX.on && MIX.loMode === 'aligned') ? '' : 'none';
            if (mixManualField) mixManualField.style.display = (MIX.on && MIX.loMode === 'manual') ? '' : 'none';
            if (mixModeSel) mixModeSel.value = MIX.loMode;
            if (mixHMaxSel) mixHMaxSel.value = String(MIX.hMax);
            if (mixLoInp) mixLoInp.value = MIX.loReal > 0 ? (MIX.loReal / 1e6).toFixed(5) : '';
            updateMixLabels();
        }
        if (mixModeSel) {
            mixModeSel.addEventListener('change', () => {
                const prev = MIX.loMode;
                MIX.loMode = mixModeSel.value;
                persist();
                applyMixUi();
                if (S.running && MIX.on && MIX.loMode !== prev) {
                    // re-park by the new mode's rules (Manual keeps its LO)
                    const r = mixRetune(true);
                    if (r) mixRedrive(); else S.parity = foldParity(S.listenHz);
                    // window semantics changed with the mode -> the columns
                    // mean other RF now; keep the history only for the
                    // Manual switch that kept the same LO
                    if (r !== 0 || MIX.loMode !== 'manual') resetWaterfall();
                    drawWfOverlay();
                }
            });
        }
        if (mixHMaxSel) {
            mixHMaxSel.addEventListener('change', () => {
                MIX.hMax = parseInt(mixHMaxSel.value, 10) || 5;
                persist();
                if (S.running && MIX.on && MIX.loMode === 'aligned') {
                    // a wider harmonic range can cover a radio that was a gap
                    const r = mixRetune(true);
                    if (r) { mixRedrive(); resetWaterfall(); drawWfOverlay(); }
                }
            });
        }
        if (mixLoInp) {
            mixLoInp.addEventListener('change', () => {
                if (!MIX.on || MIX.loMode !== 'manual') { applyMixUi(); return; }
                const ok = applyManualLo(mixLoInp.value);
                applyMixUi();                           // shows the quantized node
                if (ok && S.running) {
                    mixLoStart();                       // PWM at the new LO
                    S.parity = foldParity(S.listenHz);
                    // the NCO now tunes the residual offset for the new LO
                    microTester.sendCommand(CMD_SDR_TUNE, tunePayload(mixPseudo()));
                    resetWaterfall();                   // the window just moved
                    drawWfOverlay();
                }
            });
        }
        if (mixSel) {
            mixSel.value = MIX.on ? '1' : '0';
            mixSel.addEventListener('change', () => {
                MIX.on = (mixSel.value === '1');
                persist();
                applyMixUi();
                if (S.running) {
                    if (MIX.on) {
                        mixRetune(true);           // re-center the window
                        mixLoStart();
                        microTester.sendCommand(CMD_SDR_TUNE, tunePayload(mixPseudo()));
                        tuneZone = 0;
                        resetWaterfall();          // new RF window (labels differ)
                    } else {
                        if (MIX.loOwned) mixLoStop();
                        microTester.sendCommand(CMD_SDR_TUNE, tunePayload(S.listenHz));
                        tuneZone = Math.floor(S.listenHz / (fsHz() / 2));
                    }
                    S.parity = foldParity(S.listenHz);
                    drawWfOverlay();               // passband + bracket relabel
                    scheduleDraw();                // ruler follows at ~30 fps
                }
            });
        }
        if (mixPinSel) {
            mixPinSel.addEventListener('change', () => {
                MIX.loPinIdx = parseInt(mixPinSel.value, 10) || 0;
                persist();
                if (S.running && MIX.on && MIX.loOwned) mixLoStart();
            });
        }
        applyMixUi();

        const volInp = document.getElementById('sdrVolume');
        if (volInp) {
            volInp.value = S.volume;
            volInp.addEventListener('input', () => {
                S.volume = parseFloat(volInp.value);
                if (workletNode) workletNode.port.postMessage({ t: 'v', v: S.volume });
                else if (sprocNode) SP.vol = S.volume;
                persist();
            });
        }

        const wfGainInp = document.getElementById('sdrWfGain');
        if (wfGainInp) {
            wfGainInp.addEventListener('input', () => {
                S.waterGainDb = parseFloat(wfGainInp.value);
                wfDirty = true;
            });
        }

        // click spectrum/waterfall to tune
        ['sdrSpectrum', 'sdrWf'].forEach(id => {
            const cv = document.getElementById(id);
            if (!cv) return;
            cv.addEventListener('click', (ev) => {
                if (!S.running) return;
                const r = cv.getBoundingClientRect();
                // screen column -> raw IF bin (undo the zone mirror)
                const sc = Math.round((ev.clientX - r.left) / r.width * (WF_BINS - 1));
                if (sc < 0 || sc >= WF_BINS) return;
                const rf = rfFromBin(rawBinOfScreenCol(sc));
                if (rf !== null) setListen(rf);
            });

            // mouse wheel over the graphs:
            //   plain wheel   -> tune +-10 kHz (clamped 0..30 MHz)
            //   Shift + wheel -> waterfall gain +-1 dB (picture up/down over noise)
            cv.addEventListener('wheel', (ev) => {
                ev.preventDefault();
                const dir = ev.deltaY < 0 ? 1 : -1;
                if (ev.shiftKey) {
                    S.waterGainDb = Math.max(-40, Math.min(30, S.waterGainDb + dir));
                    const s = document.getElementById('sdrWfGain');
                    if (s) s.value = S.waterGainDb;
                    wfDirty = true;
                } else {
                    const f = Math.max(0, Math.min(30e6, S.listenHz + dir * 10000));
                    setListen(Math.round(f / 5000) * 5000);
                }
            }, { passive: false });
        });

        // Start button stays clickable even without a device: the click opens
        // the USB picker and starts the mode right after (FR-sweep UX).
        setInterval(() => { if (S.running) scheduleDraw(); }, 110);
    });

    window.MicroSdr = { start: sdrStart, stop: sdrStop, setListen, state: S };
})();
