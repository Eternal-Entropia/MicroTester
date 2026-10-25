#include "modulator.h"
#include <Arduino.h>
#include <string.h>
#include <math.h>
#include "adc_sampler.h"

#if defined(ARDUINO_ARCH_STM32)
#include "HardwareTimer.h"
#include "pins_arduino.h"
#endif

// ======================= Constants =======================

#define MOD_SWING_Q15      24576   // 0.75 * 32768 — sigma-delta full-scale headroom
#define MOD_TONE_AMPL_Q15  22937   // internal tone amplitude (0.7 FS)
#define MOD_AM_SCALE_Q15   12288   // AM carrier scale = 3/8 (peak of 100 % AM = 0.75)
#define MOD_SINE_N         256u

#define MOD_PI             3.14159265f

// Sigma-delta bitstream ring lives in the shared pool "dual dac" slot —
// the standalone sigma_delta_dac buffer is owned by its own module, the
// modulator always keeps sigma_delta_dac stopped while it runs.
#define MOD_RING_BASE      (g_sharedMem.dual.dac_buf)
#define MOD_RING_HQ        8192u   // prescalerExp 5  -> 1.3125 Mbps, 25.0 ms half
#define MOD_RING_STD       4096u   // prescalerExp 6  ->  656 kbps,  24.9 ms half

// Local ADC sample prefetch (uint16 samples). One burst consumes ~804
// samples at HQ / ~400 at half-filled STD, so 1024 is a safe ceiling.
#define ADC_PREF_MAX       1024u

// 15-tap Hilbert transformer FIR coefficients (Q15, antisymmetric):
// h[±n] = 2/(n*pi), n = 1,3,5,7. Usable modulation band ~300 Hz .. 8 kHz.
static const int16_t MOD_HILBERT_Q15[15] = {
    -2981, 0, -4173, 0, -6955, 0, -20861, 0, 20861, 0, 6955, 0, 4173, 0, 2981
};

// Class-D capable PWM pins (same numbering as pwm_gen's PIN_MAP, minus the
// TIM2 aliases PA0/PB3 which are reserved as the ADC trigger).
#if defined(ARDUINO_ARCH_STM32)
static const uint32_t MOD_PWM_PINS[9] = { PA8, PA9, PA10, PB0, PB1, PB6, PB7, PB8, PB9 };
#else
static const uint32_t MOD_PWM_PINS[9] = { 0, 1, 2, 3, 4, 5, 6, 7, 8 };
#endif
static const uint8_t  MOD_PWM_IN[9]   = { 0, 1, 2, 3, 4, 5, 6, 7, 10 };

// ======================= State =======================

static volatile ModConfig s_cfg;
static volatile bool s_running = false;
static bool s_adcOwned = false;

// Hardware (STM32 only)
#if defined(ARDUINO_ARCH_STM32)
static HardwareTimer *s_tick = NULL;     // TIM5: refill tick / class-D envelope tick
static HardwareTimer *s_pwm = NULL;      // Class-D PWM timer
static uint32_t s_pwmChannel = 0;
static uint32_t s_pwmArr = 0;
static uint32_t s_pwmPin = 0;
#endif

// Sigma-delta stream state
static volatile uint16_t s_spiExp = 6;
static volatile uint32_t s_bitrate = 656250;
static volatile uint16_t s_ringSize = MOD_RING_STD;
static volatile uint16_t s_chunk = MOD_RING_STD / 2;
static float s_sdI1 = 0.0f, s_sdI2 = 0.0f, s_sdYp = 0.0f;
static float s_sampleF = 0.0f;           // current sample in ±0.75 float domain
static uint32_t s_osrAcc = 0;            // fractional sample-advance accumulator

// Modulation state
static int16_t s_sinLut[MOD_SINE_N];
static uint32_t s_cPhase = 0;            // carrier phase (32-bit)
static uint32_t s_mPhase = 0;            // internal tone phase (32-bit)

// SSB state
static int16_t s_hbuf[15];
static uint8_t s_hPos = 0;
static int16_t s_mDelay[8];
static uint8_t s_mDPos = 0;

// External-source conditioning state
static uint16_t s_adcPref[ADC_PREF_MAX];
static volatile uint16_t s_adcLen = 0, s_adcPos = 0;
static uint16_t s_lastRaw = 2048;
static int32_t s_dcState = 2048;         // DC blocker state (raw ADC units)
static int32_t s_envPeak = 1024;         // pre-AGC envelope peak (Q15)
static int32_t s_agcQ15 = 32768;         // AGC gain (Q15, 32768 = unity)

static int32_t clamp32(int32_t v, int32_t lo, int32_t hi) {
    return (v < lo) ? lo : ((v > hi) ? hi : v);
}

// ======================= Init / config =======================

static void mod_load_defaults() {
    s_cfg.mode = MOD_MODE_AM;
    s_cfg.sideband = MOD_SB_USB;
    s_cfg.source = MOD_SRC_TONE;
    s_cfg.outPin = 0;
    s_cfg.adcPin = 0;
    s_cfg.prescalerExp = 6;
    s_cfg.normalizeOn = 0;
    s_cfg.biasOn = 0;
    s_cfg.carrierInc = 134217728u;       // 2^32 * 1000 / 32000
    s_cfg.modInc = 134217728u;
    s_cfg.depthQ15 = 16384;              // 50 %
    s_cfg.devInc = 134217728u;           // 1000 Hz peak deviation
    s_cfg.ssbLevelQ15 = 22937;           // 0.70
    s_cfg.gainQ8 = 256;                  // x1.00
    s_cfg.offsetQ7 = 0;
    s_cfg.normTargetPct = 80;
    s_cfg.classDCarrierHz = 62500;
}

void modulator_init() {
    for (uint32_t i = 0; i < MOD_SINE_N; i++) {
        s_sinLut[i] = (int16_t)lrintf(32767.0f * sinf(2.0f * MOD_PI * (float)i / (float)MOD_SINE_N));
    }
    memset(s_hbuf, 0, sizeof(s_hbuf));
    memset(s_mDelay, 0, sizeof(s_mDelay));
    memset(s_adcPref, 0, sizeof(s_adcPref));
    mod_load_defaults();
    s_running = false;
    s_adcOwned = false;
}

static bool structural_change(const ModConfig* cfg, const volatile ModConfig* cur) {
    if (cfg->mode != cur->mode || cfg->source != cur->source) return true;
    if (cfg->outPin != cur->outPin || cfg->adcPin != cur->adcPin) return true;
    if (cfg->prescalerExp != cur->prescalerExp) return true;
    if (cfg->sideband != cur->sideband) return true;
    if (cfg->mode == MOD_MODE_CLASSD && cfg->classDCarrierHz != cur->classDCarrierHz) return true;
    return false;
}

// Live-safe per-field copy into the volatile config (single-word writes only)
static void mod_copy_cfg(const ModConfig* c) {
    s_cfg.mode = c->mode;
    s_cfg.sideband = c->sideband;
    s_cfg.source = c->source;
    s_cfg.outPin = c->outPin;
    s_cfg.adcPin = c->adcPin;
    s_cfg.prescalerExp = c->prescalerExp;
    s_cfg.normalizeOn = c->normalizeOn;
    s_cfg.biasOn = c->biasOn;
    s_cfg.carrierInc = c->carrierInc;
    s_cfg.modInc = c->modInc;
    s_cfg.depthQ15 = c->depthQ15;
    s_cfg.devInc = c->devInc;
    s_cfg.ssbLevelQ15 = c->ssbLevelQ15;
    s_cfg.gainQ8 = c->gainQ8;
    s_cfg.offsetQ7 = c->offsetQ7;
    s_cfg.normTargetPct = c->normTargetPct;
    s_cfg.classDCarrierHz = c->classDCarrierHz;
}

void modulator_apply(const ModConfig* cfg) {
    if (!cfg) return;
    if (s_running && structural_change(cfg, &s_cfg)) {
        modulator_stop();
        mod_copy_cfg(cfg);   // stopped: plain per-field copy is safe
        modulator_start();
        return;
    }
    mod_copy_cfg(cfg);
}

bool modulator_is_running()     { return s_running; }
bool modulator_source_is_adc()  { return s_cfg.source == MOD_SRC_ADC; }
bool modulator_mode_is_classd() { return s_cfg.mode == MOD_MODE_CLASSD; }

// ======================= External envelope pipeline =======================

// Pull raw ADC samples from the local prefetch buffer holding the last value
// while underrunning (envelope keeps its previous level instead of slamming
// to zero on every jitter).
static inline int32_t adc_pull_raw() {
    if (s_adcPos < s_adcLen) {
        const uint16_t v = s_adcPref[s_adcPos++];
        s_lastRaw = v;
        return v;
    }
    return s_lastRaw;
}

// Refill the local linear prefetch from adc_sampler (voltmeter continuous).
//adc_sampler_get_available batches up to voltChunk samples (>= chunk/2 pending),
// so consume() the whole chunk each call: this module is the sole consumer.
static void adc_prefetch(uint16_t want) {
    // Compact consumed prefix away (cheap: <= 2 KB move)
    if (s_adcPos > 0) {
        if (s_adcPos >= s_adcLen) {
            s_adcLen = 0; s_adcPos = 0;
        } else {
            memmove(s_adcPref, s_adcPref + s_adcPos, (uint32_t)(s_adcLen - s_adcPos) * sizeof(uint16_t));
            s_adcLen -= s_adcPos; s_adcPos = 0;
        }
    }
    while (s_adcLen < want) {
        uint8_t* p = NULL;
        int n = adc_sampler_get_available(&p);
        if (n < 2) break;
        n >>= 1; // samples
        int room = (int)ADC_PREF_MAX - (int)s_adcLen;
        if (n > room) n = room;
        if (n <= 0) break;
        const uint8_t* q = p;
        uint16_t* d = &s_adcPref[s_adcLen];
        for (int i = 0; i < n; i++) {
            d[i] = (uint16_t)(q[0] | ((uint16_t)q[1] << 8));
            q += 2;
        }
        s_adcLen = (uint16_t)(s_adcLen + n);
        adc_sampler_consume(n * 2);
    }
}

// Update the AGC gain (call at burst rate while an external source runs)
static void agc_update() {
    if (s_cfg.source != MOD_SRC_ADC || !s_cfg.normalizeOn || s_cfg.normTargetPct == 0) {
        s_agcQ15 = 32768;
        return;
    }
    int32_t tgt = ((int32_t)s_cfg.normTargetPct * (int32_t)MOD_SWING_Q15) / 100;
    if (tgt < 256) tgt = 256;
    int32_t pk = s_envPeak > 64 ? s_envPeak : 64;
    int32_t want = (int32_t)(((int64_t)tgt << 15) / pk);
    if (want > 262144) want = 262144;   // max 8x
    if (want < 256) want = 256;         // min 1/128
    s_agcQ15 += (want - s_agcQ15) >> 4; // slew ~25 % per burst/tick (~0.5 s settle)
}

// One envelope sample (tone or conditioned ADC). Returns env01 Q15 clamped
// to ±MOD_SWING_Q15; advances the source.
static int32_t env_source_sample() {
    int32_t env01 = 0;
    if (s_cfg.source == MOD_SRC_ADC) {
        const int32_t v = adc_pull_raw();
        // DC blocker: state += (v - state)/128  ->  ~250 Hz HPF @ 32 kHz
        s_dcState += (v - s_dcState) >> 7;
        // Gain (Q8) then DC-offset trim
        int32_t e = ((v - s_dcState) * (int32_t)s_cfg.gainQ8) >> 8;
        e += ((int32_t)s_cfg.offsetQ7 * (int32_t)MOD_SWING_Q15) >> 7;
        // Peak follower: fast attack (~1 ms), slow release (~0.25 s)
        int32_t a = (e >= 0) ? e : -e;
        if (a > s_envPeak) s_envPeak += (a - s_envPeak) >> 3;
        else if (s_envPeak > 16) s_envPeak -= s_envPeak >> 13;
        // 12-bit -> Q15 then AGC
        int32_t envQ15 = (int32_t)e * 16;
        if (envQ15 > 32767) envQ15 = 32767; else if (envQ15 < -32768) envQ15 = -32768;
        env01 = (envQ15 * s_agcQ15) >> 15;
    } else {
        s_mPhase += s_cfg.modInc;
        env01 = ((int32_t)s_sinLut[(s_mPhase >> 24) & (MOD_SINE_N - 1)] * (int32_t)MOD_TONE_AMPL_Q15) >> 15;
    }
    return clamp32(env01, -(int32_t)MOD_SWING_Q15, (int32_t)MOD_SWING_Q15);
}

// One MODULATED output sample. Advances carrier phase and the source.
static int32_t modulator_next() {
    const int32_t env01 = env_source_sample();
    const int32_t swing = (int32_t)MOD_SWING_Q15;
    int32_t out = 0;

    switch (s_cfg.mode) {
    case MOD_MODE_AM: {
        s_cPhase += s_cfg.carrierInc;
        const int32_t amp = 32768 + (((int32_t)s_cfg.depthQ15 * env01) >> 15);
        const int32_t sinv = s_sinLut[(s_cPhase >> 24) & (MOD_SINE_N - 1)];
        // (1 + m*env)*sin ∈ ±2 FS at 100 % depth — scale the carrier by 3/8 so
        // the peak never exceeds the sigma-delta range (2*0.375 = 0.75).
        out = (int32_t)(((int64_t)((int64_t)amp * (int64_t)sinv >> 15) * MOD_AM_SCALE_Q15) >> 15);
        break;
    }

    case MOD_MODE_FM: {
        const int32_t dev = (int32_t)(((int64_t)s_cfg.devInc * env01) >> 15);
        s_cPhase += s_cfg.carrierInc + dev;
        out = ((int32_t)s_sinLut[(s_cPhase >> 24) & (MOD_SINE_N - 1)] * swing) >> 15;
        break;
    }

    case MOD_MODE_SSB: {
        const int32_t m = ((int32_t)env01 * (int32_t)s_cfg.ssbLevelQ15) >> 15;
        // Delay the modulation by the FIR group delay (7 samples)
        s_mDelay[s_mDPos] = (int16_t)m;
        const int32_t mAligned = s_mDelay[(s_mDPos + 1) & 7];  // m(n-7): -7 == +1 (mod 8)
        s_mDPos = (s_mDPos + 1) & 7;
        // Hilbert FIR on the 15-sample history
        s_hbuf[s_hPos] = (int16_t)m;
        int64_t acc = 0;
        for (uint8_t j = 0; j < 15; j++) {
            const int32_t h = MOD_HILBERT_Q15[j];
            if (h == 0) continue;
            acc += (int64_t)h * (int32_t)s_hbuf[(uint8_t)(s_hPos - j) & 15];
        }
        s_hPos = (s_hPos + 1) & 15;
        const int32_t mh = (int32_t)(acc >> 15);  // m-hat(n), aligned with m(n)
        s_cPhase += s_cfg.carrierInc;
        const uint8_t idx = (s_cPhase >> 24) & (MOD_SINE_N - 1);
        const int32_t sinv = s_sinLut[idx];
        const int32_t cosv = s_sinLut[(idx + 64) & (MOD_SINE_N - 1)];
        // Verified for a tone m = A*sin(wm*t) -> m-hat = A*cos(wm*t):
        //   m*cos + m-hat*sin = A*sin(wm + wc)  -> UPPER sideband (USB)
        //   m*cos - m-hat*sin = A*sin(wm - wc)  -> LOWER sideband (LSB)
        const int64_t mhSigned = (s_cfg.sideband == MOD_SB_USB) ? (int64_t)mh : -(int64_t)mh;
        const int64_t sum64 = (int64_t)mAligned * (int64_t)cosv + mhSigned * (int64_t)sinv;
        out = (int32_t)(sum64 >> 15);
        break;
    }

    default: // never fills the bitstream (class-D handled separately)
        out = 0;
        break;
    }

    return clamp32(out, -swing, swing);
}

// ======================= Sigma-delta bitstream engine =======================

// Generate one half of the circular DMA ring with 2nd-order sigma-delta bits
// of the live-modulated waveform (same step model as sigma_delta_dac).
static void fill_half(uint16_t byteStart, uint16_t byteCount) {
    volatile uint8_t* ring = (volatile uint8_t*)MOD_RING_BASE;
    const uint32_t bits = (uint32_t)byteCount * 8u;
    const uint32_t firstBit = (uint32_t)byteStart * 8u;

    memset((void*)&ring[byteStart], 0, byteCount);

    // Prefetch the ADC window this burst will consume (~bits * MOD_FS / bitrate)
    if (s_cfg.source == MOD_SRC_ADC) {
        uint16_t want = (uint16_t)(((uint64_t)bits * MOD_FS) / s_bitrate) + 4;
        if (want > ADC_PREF_MAX) want = ADC_PREF_MAX;
        adc_prefetch(want);
    }

    for (uint32_t b = 0; b < bits; b++) {
        if (s_osrAcc >= s_bitrate) {
            s_osrAcc -= s_bitrate;
            s_sampleF = (float)modulator_next() * (1.0f / 32768.0f);
        }
        s_sdI1 += s_sampleF - s_sdYp;
        s_sdI2 += s_sdI1 - s_sdYp;
        const uint8_t bit = (s_sdI2 >= 0.0f) ? 1u : 0u;
        s_sdYp = bit ? 1.0f : -1.0f;
        if (bit) {
            const uint32_t bi = firstBit + b;
            ring[bi >> 3] |= (uint8_t)(1u << (7u - (bi & 7u)));
        }
        s_osrAcc += MOD_FS;
    }
}

#if defined(ARDUINO_ARCH_STM32)
// Timer tick: refill the half of the ring the DMA is NOT currently draining,
// selected by live NDTR so refills can lag safely.
static void sigma_refill_isr() {
    if (!s_running) return;
    uint32_t remaining = DMA2_Stream3->NDTR;
    if (remaining > s_ringSize) remaining = s_ringSize;
    agc_update();
    if (remaining > s_chunk) fill_half(s_chunk, s_chunk);  // DMA consumes first half
    else                     fill_half(0, s_chunk);        // DMA consumes second half
}

// Class-D tick: one envelope sample per MOD_FS period -> duty cycle update
static void classd_tick_isr() {
    if (!s_running || s_pwm == NULL) return;
    // Refill the local window when dry. adc_sampler batches >= voltChunk/2
    // (256) samples per call, so grab a ~10 ms window each time it empties.
    if (s_cfg.source == MOD_SRC_ADC && s_adcPos >= s_adcLen) adc_prefetch(320);
    agc_update();
    const int32_t env01 = env_source_sample();
    const int32_t swingPct = (((int32_t)s_cfg.depthQ15 * 5000) >> 15); // 0 .. 50.00 %
    int32_t duty = 5000 + (((int32_t)env01 * swingPct) >> 15);         // duty% * 100
    if (duty < 200) duty = 200;        // keep pin toggling (2 % .. 98 %)
    if (duty > 9800) duty = 9800;
    const uint32_t ccr = (uint32_t)(((uint64_t)(s_pwmArr + 1) * (uint32_t)duty) / 10000u);
    s_pwm->setCaptureCompare(s_pwmChannel, ccr, TICK_COMPARE_FORMAT);
}

static void tick_isr() {
    if (s_cfg.mode == MOD_MODE_CLASSD) classd_tick_isr();
    else sigma_refill_isr();
}
#endif

// ======================= Hardware setup (SPI sigma-delta path) =======================

#if defined(ARDUINO_ARCH_STM32)
// Same SPI1/DMA2-Stream3 configuration as sigma_delta_dac, but with the
// modulator ring and host-chosen bitrate exponent (5 = HQ, 6 = STD).
static void sigma_hw_prepare() {
    RCC->APB2ENR |= RCC_APB2ENR_SPI1EN;
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN | RCC_AHB1ENR_GPIOBEN | RCC_AHB1ENR_DMA2EN;

    // PB5 = SPI1_MOSI (AF5), very high speed
    GPIOB->MODER   = (GPIOB->MODER   & ~(3U << (5 * 2))) | (2U << (5 * 2));
    GPIOB->OSPEEDR = (GPIOB->OSPEEDR & ~(3U << (5 * 2))) | (3U << (5 * 2));
    GPIOB->AFR[0]  = (GPIOB->AFR[0]  & ~(15U << (5 * 4))) | (5U << (5 * 4));

    // PA5 = SPI1_SCK (AF5) — keeps the internal bit engine running
    GPIOA->MODER   = (GPIOA->MODER   & ~(3U << (5 * 2))) | (2U << (5 * 2));
    GPIOA->OSPEEDR = (GPIOA->OSPEEDR & ~(3U << (5 * 2))) | (3U << (5 * 2));
    GPIOA->AFR[0]  = (GPIOA->AFR[0]  & ~(15U << (5 * 4))) | (5U << (5 * 4));

    // Stop pipeline before reconfiguring
    DMA2_Stream3->CR &= ~DMA_SxCR_EN;
    while (DMA2_Stream3->CR & DMA_SxCR_EN) {}
    SPI1->CR1 &= ~SPI_CR1_SPE;

    // Master 8-bit MSB-first, half-duplex TX-only (never sets OVR)
    SPI1->CR1 = SPI_CR1_MSTR | SPI_CR1_SSI | SPI_CR1_SSM |
                ((uint32_t)(s_spiExp & 7) << SPI_CR1_BR_Pos) |
                SPI_CR1_BIDIMODE | SPI_CR1_BIDIOE;
    SPI1->CR2 = SPI_CR2_TXDMAEN;

    // Circular DMA: ring -> SPI DR
    DMA2_Stream3->PAR  = (uint32_t)&(SPI1->DR);
    DMA2_Stream3->M0AR = (uint32_t)MOD_RING_BASE;
    DMA2_Stream3->NDTR = s_ringSize;
    DMA2_Stream3->CR = (3U << DMA_SxCR_CHSEL_Pos) |
                       (3U << DMA_SxCR_PL_Pos) |
                       DMA_SxCR_MINC | DMA_SxCR_CIRC |
                       (1U << DMA_SxCR_DIR_Pos);

    DMA2->LIFCR = DMA_LIFCR_CTCIF3 | DMA_LIFCR_CHTIF3 | DMA_LIFCR_CTEIF3 |
                  DMA_LIFCR_CDMEIF3 | DMA_LIFCR_CFEIF3;
    (void)SPI1->SR;
    (void)SPI1->DR;
}
#endif

// ======================= Public control =======================

static bool start_adc_source(uint32_t rateHz) {
    if (s_cfg.source != MOD_SRC_ADC) return false;
    AdcConfig ac;
    memset(&ac, 0, sizeof(ac));
    ac.pin = (s_cfg.adcPin <= 3) ? s_cfg.adcPin : 0;
    ac.oversample = 0;
    ac.isOscilloscope = false;
    ac.enableBias = (s_cfg.biasOn != 0);
    ac.voltRateHz = rateHz;
    ac.voltChunk = 512;
    adc_sampler_start(ac);
    s_adcOwned = true;
    s_adcLen = 0; s_adcPos = 0;
    s_lastRaw = 2048;
    s_dcState = 2048;
    s_envPeak = 1024;
    s_agcQ15 = 32768;
    return true;
}

void modulator_start() {
    modulator_stop();

#if !defined(ARDUINO_ARCH_STM32)
    s_running = true;
    return;
#else
    const uint8_t mode = s_cfg.mode;

    uint32_t tickUs;
    if (mode == MOD_MODE_CLASSD) {
        // ---- Hardware PWM carrier + 32 kHz envelope tick ----
        uint8_t sel = 0;
        for (uint8_t i = 0; i < 9; i++) if (MOD_PWM_IN[i] == s_cfg.outPin) { sel = i; break; }
        const uint32_t pin = MOD_PWM_PINS[sel];
        s_pwmPin = pin;
        const uint32_t hz = (s_cfg.classDCarrierHz > 300000) ? 300000 :
                            ((s_cfg.classDCarrierHz < 500) ? 500 : s_cfg.classDCarrierHz);
        pinMode(pin, OUTPUT);
        TIM_TypeDef *instance = (TIM_TypeDef *)pinmap_peripheral(digitalPinToPinName(pin), PinMap_PWM);
        if (instance != NULL) {
            const uint32_t channel = STM_PIN_CHANNEL(pinmap_function(digitalPinToPinName(pin), PinMap_PWM));
            GPIO_TypeDef *port = get_GPIO_Port(STM_PORT(digitalPinToPinName(pin)));
            const uint32_t pinNum = STM_PIN(digitalPinToPinName(pin));
            if (port) port->OSPEEDR |= (3UL << (pinNum * 2));
            s_pwm = new HardwareTimer(instance);
            s_pwm->setMode(channel, TIMER_OUTPUT_COMPARE_PWM1, pin);
            s_pwm->setOverflow(hz, HERTZ_FORMAT);
            s_pwmArr = s_pwm->getOverflow();
            s_pwmChannel = channel;
            s_pwm->setCaptureCompare(channel, (s_pwmArr + 1) / 2, TICK_COMPARE_FORMAT); // 50 %
            s_pwm->resume();
        }
        tickUs = 1000000UL / MOD_FS;   // 31.25 us -> ~32.2 kHz envelope tick
    } else {
        // ---- Live sigma-delta bitstream path ----
        s_spiExp = (s_cfg.prescalerExp <= 5) ? 5 : 6;
        s_bitrate = 84000000UL >> (s_spiExp + 1);
        s_ringSize = (s_spiExp <= 5) ? MOD_RING_HQ : MOD_RING_STD;
        s_chunk = s_ringSize / 2;

        // Reset modulation/sigma state for a clean start
        s_sdI1 = s_sdI2 = s_sdYp = 0.0f;
        s_sampleF = 0.0f;
        s_osrAcc = 0;
        s_cPhase = 0;
        s_mPhase = 0;
        s_hPos = 0; s_mDPos = 0;
        memset(s_hbuf, 0, sizeof(s_hbuf));
        memset(s_mDelay, 0, sizeof(s_mDelay));

        sigma_hw_prepare();
        // Prime the full ring with the silence (x=0) bitstream so the stream
        // starts seamless; halves are then refilled live.
        fill_half(0, s_ringSize);
        DMA2_Stream3->CR |= DMA_SxCR_EN;
        SPI1->CR1 |= SPI_CR1_SPE;

        // Ceiling-rounded refill period: tread slightly LATE so a refill can
        // never overtake the consumption pointer (NDTR targeting makes late
        // refills strictly safe).
        tickUs = (uint32_t)(((uint64_t)s_chunk * 8u * 1000000u + s_bitrate - 1u) / s_bitrate);
    }

    // Envelope source wiring: sigma modes sample the env at MOD_FS; class-D's
    // actual tick (1e6/tickUs) defines the envelope rate.
    const uint32_t adcRate = (mode == MOD_MODE_CLASSD) ? (1000000UL / tickUs) : (uint32_t)MOD_FS;
    start_adc_source(adcRate);

    // TIM5 tick
    s_tick = new HardwareTimer(TIM5);
    s_tick->setOverflow(tickUs, MICROSEC_FORMAT);
    s_tick->attachInterrupt(tick_isr);
    s_tick->resume();

    s_running = true;
#endif
}

void modulator_stop() {
#if defined(ARDUINO_ARCH_STM32)
    const bool wasSigma = s_running && (s_cfg.mode != MOD_MODE_CLASSD);

    if (s_tick != NULL) {
        s_tick->pause();
        delete s_tick;
        s_tick = NULL;
    }
    if (s_pwm != NULL) {
        s_pwm->pause();
        delete s_pwm;
        s_pwm = NULL;
        s_pwmChannel = 0;
        s_pwmArr = 0;
    }
    // Release the Class-D pin like pwm_gen_stop does
    if (s_pwmPin != 0) {
        pinMode(s_pwmPin, OUTPUT);
        digitalWrite(s_pwmPin, LOW);
        s_pwmPin = 0;
    }

    // Make sure the DMA/SPI registers are clocked before touching them
    RCC->APB2ENR |= RCC_APB2ENR_SPI1EN;
    RCC->AHB1ENR |= RCC_AHB1ENR_DMA2EN;

    if (wasSigma && (DMA2_Stream3->CR & DMA_SxCR_EN)) {
        DMA2_Stream3->CR &= ~DMA_SxCR_EN;
        while (DMA2_Stream3->CR & DMA_SxCR_EN) {}
    }
    SPI1->CR2 &= ~SPI_CR2_TXDMAEN;
    SPI1->CR1 &= ~SPI_CR1_SPE;
    // Quieten the bitstream pins only when the modulator owned the stream
    // (sigma_delta_dac is always stopped while the modulator runs; both
    // modules re-configure AF on their next start).
    if (wasSigma) {
        pinMode(PB5, INPUT);
        pinMode(PA5, INPUT);
    }

    if (s_adcOwned) {
        adc_sampler_stop();
        s_adcOwned = false;
    }
    memset(s_adcPref, 0, sizeof(s_adcPref));
    s_adcLen = 0; s_adcPos = 0;
#endif
    s_running = false;
}

void modulator_stop_if_adc_source() {
    if (s_running && s_cfg.source == MOD_SRC_ADC) modulator_stop();
}

void modulator_stop_if_classd() {
    if (s_running && s_cfg.mode == MOD_MODE_CLASSD) modulator_stop();
}
