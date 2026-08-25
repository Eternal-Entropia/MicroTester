#include "freq_resp.h"
#include "adc_sampler.h"
#include "pwm_gen.h"
#include "sigma_delta_dac.h"

#include <math.h>

#define FR_BUF_SIZE 1024
static uint16_t fr_buf[FR_BUF_SIZE];

#define FR_PI 3.14159265f

static bool fr_active = false;
static uint8_t fr_out_pin = 0;
static uint8_t fr_in_pin  = 7;
static uint32_t fr_direct_limit = FR_DIRECT_LIMIT_HZ;
static uint8_t fr_oversampling = FR_OVERSAMPLING;

volatile uint16_t fr_last_n = 0;
volatile uint16_t fr_last_rate_khz = 0;

void fr_init() {
    fr_active = false;
    fr_oversampling = FR_OVERSAMPLING;
}

void fr_start(uint8_t outPinIdx, uint8_t inPinIdx, uint32_t directLimitHz, uint8_t oversampling) {
    fr_out_pin = outPinIdx;
    fr_in_pin  = inPinIdx;
    fr_direct_limit = (directLimitHz > 0) ? directLimitHz : FR_DIRECT_LIMIT_HZ;
    fr_oversampling = (oversampling == 0) ? 1 : ((oversampling > 128) ? 128 : oversampling);
    fr_active  = true;
    pwm_gen_stop();
    adc_sampler_stop();
}

void fr_stop() {
    pwm_gen_stop();
    fr_active = false;
}

static bool fr_measure_dc(uint32_t* out) {
    const uint32_t rateKHz = 40;
    uint8_t overCount = (fr_oversampling == 0) ? 1 : fr_oversampling;
    uint64_t totalSum = 0;
    for (uint32_t k = 0; k < overCount; k++) {
        adc_sampler_capture_burst(fr_in_pin, fr_buf, FR_BUF_SIZE, rateKHz, 0);
        uint64_t sum = 0;
        for (uint32_t i = 0; i < FR_BUF_SIZE; i++) sum += fr_buf[i];
        totalSum += (sum / FR_BUF_SIZE);
    }
    *out = (uint32_t)(totalSum / overCount);
    fr_last_n = FR_BUF_SIZE;
    fr_last_rate_khz = rateKHz;
    return true;
}

static uint32_t fr_goertzel_power(const uint16_t* buf, uint32_t n, float omega) {
    float c = 2.0f * cosf(omega);

    // Remove DC: the Σ-Δ bias sits at ~1.65 V (ADC ~2048). If left in, it leaks into
    // the bin at low frequencies and corrupts the ratio (ref vs DUT have different DC).
    float mean = 0.0f;
    for (uint32_t i = 0; i < n; i++) mean += (float)buf[i];
    mean /= (float)n;

    // Hann window: the capture rate is an integer kHz (rateKHz = 16*f/1000), so for
    // most frequencies 16*f is not kHz-aligned and the window holds a fractional
    // number of periods (e.g. 15163 Hz -> rate 242 kHz, 384 samples = 24.06 periods).
    // A boxcar then ripples ~+-1% as the fractional part varies across the sweep.
    // Pre-windowing with Hann makes the amplitude estimate nearly immune to that
    // boundary error. Coherent gain of Hann = 0.5, hence amplitude A = 4*sqrt(P)/N
    // (boxcar used A = 2*sqrt(P)/N).
    const float invN = 1.0f / (float)n;
    float s1 = 0.0f, s2 = 0.0f, s0 = 0.0f;
    for (uint32_t i = 0; i < n; i++) {
        const float w = 0.5f * (1.0f - cosf(2.0f * FR_PI * (float)i * invN));
        const float xw = ((float)buf[i] - mean) * w;
        s0 = xw + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }

    float power = s2 * s2 + s1 * s1 - c * s1 * s2;
    if (power < 0.0f) power = 0.0f;

    // Return the sine peak amplitude in ADC counts: A = 4*sqrt(power)/N (Hann).
    // This makes the value frequency-independent (a proper lock-in amplitude),
    // instead of the raw DFT magnitude which scales with the window length N.
    return (uint32_t)(4.0f * sqrtf(power) / (float)n);
}

static bool fr_measure_direct(uint32_t freqHz, uint32_t* out) {
    uint32_t rateKHz = (freqHz * 16UL) / 1000UL;
    if (rateKHz < 1) rateKHz = 1;
    if (rateKHz > 2800) rateKHz = 2800;
    uint32_t actualRateHz = rateKHz * 1000UL;

    // Coherent window: always a whole number of sine periods. At low frequencies the
    // ~20 ms budget would collapse the window below one full period (breaking Goertzel),
    // so enforce a minimum of 4 full periods; never fall back to a partial-cycle window.
    uint32_t perCycle = (actualRateHz + freqHz / 2) / freqHz;
    if (perCycle < 2) perCycle = 2;
    if (perCycle > FR_BUF_SIZE) perCycle = FR_BUF_SIZE;

    uint32_t cycles = (actualRateHz / 50) / perCycle; // ~20 ms budget in periods
    if (cycles < 4) cycles = 4;
    if (cycles > 24) cycles = 24;

    uint32_t n = perCycle * cycles;
    if (n > FR_BUF_SIZE) {
        n = (FR_BUF_SIZE / perCycle) * perCycle; // keep whole periods within the buffer
        if (n < perCycle) n = perCycle;
    }

    float omega = 2.0f * FR_PI * (float)freqHz / (float)actualRateHz;

    // Phase-diverse averaging: each of the FR_OVERSAMPLING captures starts its
    // sampling grid at another point of the sine period (shift = perCycle/16),
    // so the fractional-period boundary error (rate is an integer kHz, the window
    // is not always an exact whole number of periods) cancels across captures
    // instead of being repeated identically 16 times. Random noise also drops.
    uint8_t overCount = (fr_oversampling == 0) ? 1 : fr_oversampling;
    const uint32_t phaseShift = (perCycle >= overCount) ? (perCycle / overCount) : 1;
    uint64_t acc = 0;
    for (uint32_t k = 0; k < overCount; k++) {
        adc_sampler_capture_burst(fr_in_pin, fr_buf, (uint16_t)n, rateKHz, phaseShift * k);
        acc += fr_goertzel_power(fr_buf, n, omega);
    }
    *out = (uint32_t)(acc / overCount);

    fr_last_n = (uint16_t)n;
    fr_last_rate_khz = (uint16_t)rateKHz;
    return true;
}

bool fr_measure_point(uint32_t freqHz, uint8_t mode, uint32_t* out) {
    if (!fr_active) return false;

    if (freqHz == 0) {
        pwm_gen_stop();
        delay(2);
        return fr_measure_dc(out);
    }
    if (freqHz < 1) freqHz = 1;
    if (freqHz > 42000000UL) freqHz = 42000000UL;

    // Sine mode: sigma-delta DAC on PB5 (pin idx 0) / PA7 (idx 1), Goertzel on ADC
    if (mode == FR_MODE_SINE) {
        if (freqHz > FR_SINE_MAX_HZ) freqHz = FR_SINE_MAX_HZ;
        sigma_delta_dac_play_sine(fr_out_pin, freqHz);
        delay(3);
        bool ok = fr_measure_direct(freqHz, out);
        sigma_delta_dac_stop();
        return ok;
    }

    PwmConfig cfg;
    cfg.pinIndex = fr_out_pin;
    cfg.waveform = 0;
    cfg.frequency = freqHz;
    cfg.dutyCycle = 50;
    pwm_gen_start(cfg);

    if (mode == FR_MODE_DIRECT && freqHz <= fr_direct_limit) {
        delay(2);
        return fr_measure_direct(freqHz, out);
    }

    delay(3);
    return fr_measure_dc(out);
}