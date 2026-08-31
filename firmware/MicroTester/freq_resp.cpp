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

static uint32_t fr_goertzel_calc(const uint16_t* buf, uint32_t n, float omega, uint32_t sample_offset, float* out_phase_rad = NULL) {
    float c = 2.0f * cosf(omega);

    // Remove DC: the Σ-Δ bias sits at ~1.65 V (ADC ~2048). If left in, it leaks into
    // the bin at low frequencies and corrupts the ratio (ref vs DUT have different DC).
    float mean = 0.0f;
    for (uint32_t i = 0; i < n; i++) mean += (float)buf[i];
    mean /= (float)n;

    // Hann window: immune to fractional-period boundary error.
    const float invN = 1.0f / (float)n;
    float s1 = 0.0f, s2 = 0.0f, s0 = 0.0f;
    for (uint32_t i = 0; i < n; i++) {
        const float w = 0.5f * (1.0f - cosf(2.0f * FR_PI * (float)i * invN));
        const float xw = ((float)buf[i] - mean) * w;
        s0 = xw + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }

    // Complex DFT component for sine wave: x(t) = A * sin(omega*t + phi)
    // At phi = 0: Re > 0, Im = 0. At phi = +90 deg: Re = 0, Im > 0.
    float re = -s1 * sinf(omega);
    float im = s1 * cosf(omega) - s2;
    float power = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (power < 0.0f) power = 0.0f;

    if (out_phase_rad != NULL) {
        // Window-relative phase angle:
        float win_phase = atan2f(im, re);
        // Analytically rotate vector back to t=0 to compensate for settle_samples offset:
        float t0_phase = win_phase - ((float)sample_offset * omega);
        while (t0_phase > FR_PI) t0_phase -= 2.0f * FR_PI;
        while (t0_phase < -FR_PI) t0_phase += 2.0f * FR_PI;
        *out_phase_rad = t0_phase;
    }

    // Return the sine peak amplitude in ADC counts: A = 4*sqrt(power)/N (Hann).
    return (uint32_t)(4.0f * sqrtf(power) / (float)n);
}

static bool fr_measure_direct(uint32_t freqHz, uint32_t* out_mag, int16_t* out_phase_cdeg) {
    uint32_t rateKHz = (freqHz * 16UL) / 1000UL;
    if (rateKHz < 1) rateKHz = 1;
    if (rateKHz > 2800) rateKHz = 2800;

    // Exact TIM2 sampling rate Fs = 84 MHz / (ARR + 1)
    uint32_t arr = (84000000UL / (rateKHz * 1000UL)) - 1;
    float exactFs = 84000000.0f / (float)(arr + 1);

    // Coherent window: always a whole number of sine periods. At low frequencies the
    // ~20 ms budget would collapse the window below one full period (breaking Goertzel),
    // so enforce a minimum of 4 full periods; never fall back to a partial-cycle window.
    uint32_t perCycle = (uint32_t)((exactFs + (float)freqHz * 0.5f) / (float)freqHz);
    if (perCycle < 2) perCycle = 2;
    if (perCycle > FR_BUF_SIZE) perCycle = FR_BUF_SIZE;

    uint32_t cycles = (uint32_t)(exactFs / 50.0f) / perCycle; // ~20 ms budget in periods
    if (cycles < 6) cycles = 6;
    if (cycles > 24) cycles = 24;

    uint32_t n_total = perCycle * cycles;
    if (n_total > FR_BUF_SIZE) {
        cycles = FR_BUF_SIZE / perCycle;
        if (cycles < 4) cycles = 4;
        n_total = perCycle * cycles;
        if (n_total > FR_BUF_SIZE) n_total = FR_BUF_SIZE;
    }

    uint32_t settle_cycles = (cycles >= 6) ? 2 : 1;
    uint32_t settle_samples = settle_cycles * perCycle;
    uint32_t n_steady = (n_total > settle_samples) ? (n_total - settle_samples) : n_total;

    float omega = 2.0f * FR_PI * (float)freqHz / exactFs;

    // Single coherent, continuous hardware capture over full cycles
    adc_sampler_capture_burst(fr_in_pin, fr_buf, (uint16_t)n_total, rateKHz, 0);

    float p_rad = 0.0f;
    uint32_t mag = fr_goertzel_calc(&fr_buf[settle_samples], n_steady, omega, settle_samples, &p_rad);

    if (out_mag) *out_mag = mag;

    if (out_phase_cdeg) {
        if (mag <= 3) {
            // Below noise floor (no signal / short to GND): clamp to 0.00 deg
            *out_phase_cdeg = 0;
        } else {
            float deg = p_rad * (180.0f / FR_PI);
            int32_t cdeg = (int32_t)roundf(deg * 100.0f);
            if (cdeg > 18000) cdeg = 18000;
            if (cdeg < -18000) cdeg = -18000;
            *out_phase_cdeg = (int16_t)cdeg;
        }
    }

    fr_last_n = (uint16_t)n_steady;
    fr_last_rate_khz = (uint16_t)rateKHz;
    return true;
}

bool fr_measure_point(uint32_t freqHz, uint8_t mode, uint32_t* out_mag, int16_t* out_phase_cdeg) {
    if (!fr_active) return false;

    if (out_phase_cdeg) *out_phase_cdeg = 0;

    if (freqHz == 0) {
        pwm_gen_stop();
        delay(2);
        return fr_measure_dc(out_mag);
    }
    if (freqHz < 1) freqHz = 1;
    if (freqHz > 42000000UL) freqHz = 42000000UL;

    // Sine mode: sigma-delta DAC on PB5 (pin idx 0) / PA7 (idx 1), Goertzel on ADC
    if (mode == FR_MODE_SINE) {
        if (freqHz > FR_SINE_MAX_HZ) freqHz = FR_SINE_MAX_HZ;
        sigma_delta_dac_prepare_sine_sync(fr_out_pin, freqHz);
        uint32_t actualFreq = sigma_delta_dac_get_actual_freq();
        if (actualFreq < 1) actualFreq = freqHz;
        bool ok = fr_measure_direct(actualFreq, out_mag, out_phase_cdeg);
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
        return fr_measure_direct(freqHz, out_mag, out_phase_cdeg);
    }

    delay(3);
    return fr_measure_dc(out_mag);
}