// SDR Receiver (Phase 0) for MicroTester / STM32F401.
// See sdr_rx.h for the architecture description.
#include "sdr_rx.h"
#include "protocol.h"
#include "shared_mem.h"
#include "adc_sampler.h"
#include "pwm_gen.h"
#include "sigma_delta_dac.h"
#include "comp_tester.h"
#include "freq_resp.h"
#include "Adafruit_TinyUSB.h"
#include <math.h>
#include <string.h>

#if defined(ARDUINO_ARCH_STM32)

// ------------------------------------------------------------------ memory
// SDR is exclusive with the oscilloscope/DAC modes, so it overlays the shared
// 48 KB pool (same union trick adc_sampler / sigma_delta_dac use).
#define SDR_FFT_N        1024
#define SDR_WF_BINS      (SDR_FFT_N / 2)
#define SDR_CAP_BYTES    24576
#define SDR_CAP_MASK     (SDR_CAP_BYTES - 1)
#define SDR_AUD_RING     2048
#define SDR_AUD_MASK     (SDR_AUD_RING - 1)
#define SDR_AUD_CHUNK    240
#define SDR_LUT_N        1024

// adcBits=8: DMA bytes; adcBits=12: DMA halfwords over the same pool ->
// half the sample depth (12 ms @ 1 Msps, plenty for FFT + DDC chunks).
// Audio samples are ALWAYS 240 per packet; payload bytes double in 12-bit.
// Note: s_aud_wr/s_aud_rd positions count SAMPLES, byte offset = pos << shift.

typedef struct {
    uint8_t  cap[SDR_CAP_BYTES];            // DMA circular capture (8-bit bytes or 16-bit halfwords)
    float    fft_re[SDR_FFT_N];             // FFT work + input windowing
    float    fft_im[SDR_FFT_N];
    float    win[SDR_FFT_N];                // Hann window
    float    tw_c[SDR_FFT_N / 2];           // twiddle cos
    float    tw_s[SDR_FFT_N / 2];           // twiddle sin
    int8_t   nco_lut[SDR_LUT_N];            // cosine LO table (q8)
    uint8_t  aud_ring[SDR_AUD_RING];        // decimated audio output ring (int8 or int16 LE)
    uint8_t  wf_buf[2 + SDR_WF_BINS];       // [seq][meta][bins]
    uint8_t  aud_pkt[2 + SDR_AUD_CHUNK * 2]; // [seq][meta][samples] (room for int16 mode)
} SdrMem;

typedef char sdr_size_check[(sizeof(SdrMem) <= SHARED_MEM_POOL_SIZE) ? 1 : -1];
#define SDR ((SdrMem*)g_sharedMem.raw)

// ------------------------------------------------------------------ state
static bool     s_running = false;
static uint32_t s_fs_hz = 1000000;    // effective ADC fs
static uint32_t s_tim_period = 84;    // TIM2 ticks per sample
static uint16_t s_wf_fps = 10;
static uint8_t  s_pin_idx = 0;

static uint32_t s_listen_hz = 0;
static uint16_t s_if0_hz = SDR_IF0_DEFAULT_HZ;
static uint8_t  s_parity = 0;         // 0 = direct fold, 1 = mirrored

static uint8_t  s_adc_bits = 8;       // 8 or 12: ADC resolution + DMA width + audio format
static uint32_t s_cap_samp = SDR_CAP_BYTES;   // capture ring depth in SAMPLES
static uint32_t s_samp_shift = 0;     // 0 (8-bit) or 1 (12-bit); byte-pos = sample << shift

static volatile uint32_t s_nco_phase = 0;
static volatile int32_t  s_nco_inc = 0;

static int32_t s_cic_i0, s_cic_i1, s_cic_i2;
static int32_t s_cic_d1, s_cic_d2, s_cic_d3;
static uint8_t s_cic_cnt = 0;
static int32_t s_dclp = 0;   // slow-tracking input DC estimate (kills ADC off x LO tone)

static uint16_t s_aud_wr = 0, s_aud_rd = 0;
static uint8_t  s_aud_seq = 0, s_wf_seq = 0;
static uint32_t s_last_pos = 0;
static uint32_t s_wf_due_ms = 0;

static bool     s_tables_ok = false;

// Exposed by MicroTester.ino
extern Adafruit_USBD_WebUSB usb_web;
bool robust_write(const uint8_t* data, uint16_t len);

// ------------------------------------------------------------------ pin map
static int sdr_map_pin(uint8_t configPin) {
    switch (configPin) {
        case 0: return PA1;
        case 1: return PA2;
        case 2: return PA3;
        case 3: return PA4;
        case 4: return PA5;
        case 5: return PA6;
        case 6: return PA7;
        case 7: return PB0;
        case 8: return PB1;
        default: return PA1;
    }
}

static uint8_t sdr_adc_ch(int pin) {
    switch (pin) {
        case PA0: return 0;
        case PA1: return 1;
        case PA2: return 2;
        case PA3: return 3;
        case PA4: return 4;
        case PA5: return 5;
        case PA6: return 6;
        case PA7: return 7;
        case PB0: return 8;
        case PB1: return 9;
        default: return 4;
    }
}

uint32_t sdr_rx_get_fs(void) { return s_fs_hz; }
bool sdr_rx_active(void)     { return s_running; }

// ------------------------------------------------------------------ setup
static void sdr_build_tables(void) {
    const float PI2 = 6.283185307179586f;
    for (uint16_t i = 0; i < SDR_FFT_N; i++) {
        SDR->win[i] = 0.5f - 0.5f * cosf(PI2 * (float)i / (float)(SDR_FFT_N - 1));
    }
    for (uint16_t k = 0; k < SDR_FFT_N / 2; k++) {
        SDR->tw_c[k] = cosf(PI2 * (float)k / (float)SDR_FFT_N);
        SDR->tw_s[k] = sinf(PI2 * (float)k / (float)SDR_FFT_N);
    }
    for (uint16_t i = 0; i < SDR_LUT_N; i++) {
        float v = 127.0f * cosf(PI2 * (float)i / (float)SDR_LUT_N);
        SDR->nco_lut[i] = (int8_t)((v >= 0.0f) ? (v + 0.5f) : (v - 0.5f));
    }
    s_tables_ok = true;
}

static inline uint32_t sdr_pos(void) {
    // NDTR counts DMA transfers: bytes (8-bit) or halfwords (12-bit)
    uint32_t p = s_cap_samp - DMA2_Stream0->NDTR;
    if (p >= s_cap_samp) p = 0;
    return p;
}

void sdr_rx_start(uint16_t fsKHz, uint8_t wfFps, uint8_t pinIdx, uint8_t adcBits) {
    if (!s_tables_ok) sdr_build_tables();
    if (fsKHz < 200) fsKHz = SDR_FS_DEFAULT_KHZ;
    if (fsKHz > 1500) fsKHz = 1500;
    if (wfFps < 2) wfFps = 2;
    if (wfFps > 30) wfFps = 30;
    if (pinIdx > 8) pinIdx = 0;
    if (adcBits != 12) adcBits = 8;

    s_pin_idx = pinIdx;
    s_wf_fps = wfFps;
    s_adc_bits = adcBits;
    s_samp_shift = (adcBits == 12) ? 1 : 0;
    s_cap_samp = SDR_CAP_BYTES >> s_samp_shift;          // same pool, half depth in 12-bit
    s_tim_period = 84000000UL / ((uint32_t)fsKHz * 1000UL);
    if (s_tim_period < 2) s_tim_period = 2;
    s_fs_hz = 84000000UL / s_tim_period;

    // Reset DSP state
    s_nco_phase = 0;
    s_nco_inc = 0;
    s_cic_i0 = s_cic_i1 = s_cic_i2 = 0;
    s_cic_d1 = s_cic_d2 = s_cic_d3 = 0;
    s_cic_cnt = 0;
    s_dclp = 0;
    s_aud_wr = 0; s_aud_rd = 0;
    s_aud_seq = 0; s_wf_seq = 0;
    s_parity = 0;
    s_listen_hz = 0;
    s_if0_hz = SDR_IF0_DEFAULT_HZ;

    // Make sure nothing else owns TIM2/DMA/pins
    adc_sampler_stop();
    pwm_gen_stop();
    sigma_delta_dac_stop();
    comp_tester_stop();
    fr_stop();

    int pin = sdr_map_pin(s_pin_idx);
    pinMode(pin, INPUT_ANALOG);
    analogRead(pin); // Wake up ADC and GPIO via HAL
    uint8_t ch = sdr_adc_ch(pin);

    // SDR is a passive RX: all bias lines Hi-Z, no pulls on ADC pins
    GPIOB->MODER &= ~((3UL << (6 * 2)) | (3UL << (7 * 2)) | (3UL << (8 * 2)) | (3UL << (9 * 2)));
    GPIOA->PUPDR &= ~((3UL << (1 * 2)) | (3UL << (2 * 2)) | (3UL << (3 * 2)) | (3UL << (4 * 2)));

    RCC->APB2ENR |= RCC_APB2ENR_ADC1EN;
    RCC->AHB1ENR |= RCC_AHB1ENR_DMA2EN;
    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;

    // DMA2 Stream0 Ch0 -> circular capture (bytes @8-bit, halfwords @12-bit)
    DMA2_Stream0->CR = 0;
    while (DMA2_Stream0->CR & DMA_SxCR_EN);
    DMA2->LIFCR = 0x3F;
    DMA2_Stream0->PAR = (uint32_t)&ADC1->DR;
    DMA2_Stream0->M0AR = (uint32_t)&SDR->cap[0];
    DMA2_Stream0->NDTR = s_cap_samp;             // transfers = samples
    {
        uint32_t sz = (s_adc_bits == 12) ? 1u : 0u;   // 0 = byte, 1 = halfword
        DMA2_Stream0->CR = (0 << 25) |
                           (sz << 13) |  // MSIZE
                           (sz << 11) |  // PSIZE
                           DMA_SxCR_MINC |
                           DMA_SxCR_CIRC |
                           (0 << 6);
    }
    DMA2_Stream0->CR |= DMA_SxCR_EN;

    // ADC1 resolution + single channel + TIM2-trigger
    ADC->CCR &= ~(3 << 16);          // ADCCLK = PCLK2/2 = 42 MHz
    ADC1->CR2 = 0;
    ADC1->CR1 = ADC_CR1_SCAN | ((s_adc_bits == 12) ? (0 << 24) : (2 << 24)); // RES: 12- or 8-bit
    ADC1->SQR1 = 0;
    ADC1->SQR2 = 0;
    ADC1->SQR3 = ch;
    ADC1->SMPR2 &= ~(7 << (3 * ch));
    // Sampling time must fit the TIM2 period (conversion = SMP + 12 cyc in
    // 12-bit mode / SMP + 7 in 8-bit @42 MHz). Worst case 12-bit:
    // SMP 15 -> 27 cyc = 643 ns (fits any fs <= 1.55 Msps).
    if (s_fs_hz > 1550000)      ADC1->SMPR2 |= (0 << (3 * ch)); // 3 cycles
    else if (s_fs_hz >= 400000) ADC1->SMPR2 |= (1 << (3 * ch)); // 15 cycles
    else                        ADC1->SMPR2 |= (4 << (3 * ch)); // 84 cycles
    ADC1->CR2 = (1 << 28) | (0x06 << 24) | ADC_CR2_DMA | ADC_CR2_DDS | ADC_CR2_ADON;

    // TIM2 update -> TRGO
    TIM2->CR1 = 0;
    TIM2->PSC = 0;
    TIM2->ARR = s_tim_period - 1;
    TIM2->CNT = 0;
    TIM2->EGR = TIM_EGR_UG;
    TIM2->CR2 = TIM_CR2_MMS_1;
    TIM2->CR1 |= TIM_CR1_CEN;

    s_last_pos = sdr_pos();
    s_wf_due_ms = millis() + 300;
    s_running = true;
}

void sdr_rx_stop(void) {
    if (!s_running) return;
    s_running = false;
    TIM2->CR1 &= ~TIM_CR1_CEN;
    ADC1->CR2 = 0;
    ADC1->CR1 = 0;
    DMA2_Stream0->CR &= ~DMA_SxCR_EN;
    uint32_t timeout = 10000;
    while ((DMA2_Stream0->CR & DMA_SxCR_EN) && --timeout);
}

// --------------------------------------------------------------- tune
// Fold listen RF into [0, fs/2) and set the NCO so the channel appears at
// +IF0 (dc offset & 1/f noise stay away from the audio band). Parity of the
// half-zone (mirror orientation) is reported to the host in packet meta bit0.
void sdr_rx_tune(uint32_t fListenHz, uint16_t if0Hz) {
    if (!s_running) {
        s_listen_hz = fListenHz;
        s_if0_hz = if0Hz;
        return;
    }
    s_listen_hz = fListenHz;
    s_if0_hz = if0Hz;
    uint32_t half = s_fs_hz / 2;
    uint32_t z = fListenHz / half;
    s_parity = (uint8_t)(z & 1);
    int32_t nu;
    if (s_parity) nu = (int32_t)((z + 1) * half) - (int32_t)fListenHz; // mirrored
    else          nu = (int32_t)(fListenHz - z * half);                // direct
    int32_t f_nco = nu - (int32_t)if0Hz;
    s_nco_inc = (int32_t)(((int64_t)f_nco << 32) / (int64_t)s_fs_hz);
    // NOTE: s_nco_phase is intentionally NOT reset -> glitch-free retune.
}

// --------------------------------------------------------------- FFT
// In-place iterative radix-2 DIT with precomputed twiddles.
static void sdr_fft(void) {
    float* re = SDR->fft_re;
    float* im = SDR->fft_im;

    for (uint16_t i = 1, j = 0; i < SDR_FFT_N; i++) {
        uint16_t bit = SDR_FFT_N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            float t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }

    for (uint16_t len = 2; len <= SDR_FFT_N; len <<= 1) {
        uint16_t half = len >> 1;
        uint16_t step = SDR_FFT_N / len;
        for (uint16_t i = 0; i < SDR_FFT_N; i += len) {
            for (uint16_t j = 0; j < half; j++) {
                float C = SDR->tw_c[(uint32_t)j * step];
                float S = SDR->tw_s[(uint32_t)j * step];
                uint16_t a = i + j;
                uint16_t b = a + half;
                float xr = re[b], xi = im[b];
                float tr = xr * C + xi * S;
                float ti = xi * C - xr * S;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
    }
}

// --------------------------------------------------------------- waterfall
// Capture config (DMA width, ADC RES) lives in sdr_rx_start; WF bins are
// always 8-bit-scaled, so the browser grid needs no mode-dependent offsets.
static void sdr_send_wf(uint32_t pos) {
    uint32_t mask = s_cap_samp - 1;
    uint32_t start = (pos + s_cap_samp - SDR_FFT_N) & mask;
    const uint8_t* cap8 = SDR->cap;
    const uint16_t* cap16 = (const uint16_t*)SDR->cap;
    uint32_t shift = s_samp_shift;
    float* re = SDR->fft_re;
    float* im = SDR->fft_im;

    for (uint16_t i = 0; i < SDR_FFT_N; i++) {
        int32_t v;
        if (shift == 0) {
            v = (int16_t)cap8[(start + i) & mask] - 128;   // -128..127
        } else {
            v = (int16_t)cap16[(start + i) & mask] - 2048; // -2048..2047
            v >>= 4;               // 12-bit counts -> 8-bit scale (floor div)
        }
        re[i] = (float)v * SDR->win[i];
        im[i] = 0.0f;
    }
    sdr_fft();

    SDR->wf_buf[0] = s_wf_seq++;
    SDR->wf_buf[1] = s_parity | ((s_adc_bits == 12) ? 0x02 : 0x00);
    for (uint16_t k = 0; k < SDR_WF_BINS; k++) {
        float m2 = re[k] * re[k] + im[k] * im[k];
        float db = 10.0f * log10f(m2 + 1.0e-9f);
        // 12-bit: real noise floor sits ~24 dB lower than the 8-bit one and
        // would map to byte 0 (black waterfall) -> lift the display range so
        // the floor keeps its usual row; true weak signals then appear below it.
        float db_off = (s_adc_bits == 12) ? 24.0f : 0.0f;
        int v = (int)((db + db_off) * 2.8f);
        if (v < 0) v = 0;
        if (v > 255) v = 255;
        SDR->wf_buf[2 + k] = (uint8_t)v;
    }
    // Bins 0..2 carry the ADC DC offset (always hot, white column at x=0);
    // Hann spreads that energy over ~4 bins -> substitute a quiet neighbor.
    SDR->wf_buf[2] = SDR->wf_buf[6];
    SDR->wf_buf[3] = SDR->wf_buf[6];
    SDR->wf_buf[4] = SDR->wf_buf[6];

    uint8_t hdr[3];
    hdr[0] = PKT_SDR_WF;
    hdr[1] = (2 + SDR_WF_BINS) & 0xFF;
    hdr[2] = ((2 + SDR_WF_BINS) >> 8) & 0xFF;
    if (!usb_web.connected()) return;
    if (!robust_write(hdr, 3) || !robust_write(SDR->wf_buf, 2 + SDR_WF_BINS)) return;
    usb_web.flush();
}

// --------------------------------------------------------------- DDC + CIC
static inline void sdr_ddc_range(uint32_t start, uint32_t count) {
    const uint8_t* cap8 = SDR->cap;
    const uint16_t* cap16 = (const uint16_t*)SDR->cap;
    uint32_t cmask = s_cap_samp - 1;
    uint32_t shift = s_samp_shift;
    for (uint32_t i = 0; i < count; i++) {
        int16_t xc;
        if (shift == 0) xc = (int16_t)cap8[(start + i) & cmask] - 128;
        else            xc = (int16_t)cap16[(start + i) & cmask] - 2048;
        // 1-pole DC blocker, tau ~2k samples (fc ~75 Hz @ 1 MP): far below the
        // wanted alias band (>= IF0 - bw/2), removes the DC x NCO product.
        s_dclp += (xc - s_dclp) >> 11;
        int16_t xcd = (int16_t)(xc - s_dclp);
        int8_t c = SDR->nco_lut[(s_nco_phase >> 22) & (SDR_LUT_N - 1)];
        s_nco_phase += (uint32_t)s_nco_inc;

        int32_t mix = ((int32_t)xcd * (int32_t)c) >> 7;
        s_cic_i0 += mix;
        if (++s_cic_cnt >= 32) {
            s_cic_cnt = 0;
            s_cic_i1 += s_cic_i0;
            s_cic_i2 += s_cic_i1;
            int32_t c1 = s_cic_i2 - s_cic_d1; s_cic_d1 = s_cic_i2;
            int32_t c2 = c1 - s_cic_d2;       s_cic_d2 = c1;
            int32_t c3 = c2 - s_cic_d3;       s_cic_d3 = c2;
            int32_t v = c3 >> 15;             // CIC gain R^N = 32768
            if (shift == 0) {                 // out scale tracks input scale
                if (v > 127) v = 127;
                if (v < -128) v = -128;
            } else {
                if (v > 2047) v = 2047;
                if (v < -2048) v = -2048;
            }

            // Drop oldest audio if the ring is full (loop stalled)
            while ((uint16_t)(s_aud_wr - s_aud_rd) >= (SDR_AUD_RING >> shift)) s_aud_rd++;
            // Positions are sample counts; byte offset is even in 16-bit mode,
            // so a sample never straddles the ring wrap.
            uint32_t off = (s_aud_wr & ((SDR_AUD_RING >> shift) - 1)) << shift;
            if (shift == 0) {
                SDR->aud_ring[off] = (uint8_t)((int8_t)v);
            } else {
                uint16_t u = (uint16_t)v;               // int16 LE, -2048..2047
                SDR->aud_ring[off]     = (uint8_t)(u & 0xFF);
                SDR->aud_ring[off + 1] = (uint8_t)(u >> 8);
            }
            s_aud_wr++;
        }
    }
}

// --------------------------------------------------------------- audio TX
static void sdr_send_audio(void) {
    uint32_t shift = s_samp_shift;
    uint32_t ring_samp = SDR_AUD_RING >> shift;           // ring depth in samples
    uint32_t chunk_bytes = (uint32_t)SDR_AUD_CHUNK << shift;
    uint8_t* pkt = SDR->aud_pkt;
    const uint8_t* ring = SDR->aud_ring;
    for (uint8_t n = 0; n < 3; n++) {
        if (!usb_web.connected()) return;
        uint16_t avail = (uint16_t)(s_aud_wr - s_aud_rd);
        if (avail < SDR_AUD_CHUNK) return;

        pkt[0] = s_aud_seq++;
        pkt[1] = s_parity | ((s_adc_bits == 12) ? 0x02 : 0x00);
        // byte offset on the ring; always even in 16-bit mode -> no torn sample
        uint32_t rb = (uint32_t)(s_aud_rd & (ring_samp - 1)) << shift;
        if (rb + chunk_bytes <= SDR_AUD_RING) {
            memcpy(&pkt[2], &ring[rb], chunk_bytes);
        } else {
            uint32_t part = SDR_AUD_RING - rb;
            memcpy(&pkt[2], &ring[rb], part);
            memcpy(&pkt[2 + part], &ring[0], chunk_bytes - part);
        }
        s_aud_rd += SDR_AUD_CHUNK;

        uint8_t hdr[3];
        hdr[0] = PKT_SDR_AUDIO;
        hdr[1] = (2 + chunk_bytes) & 0xFF;
        hdr[2] = ((2 + chunk_bytes) >> 8) & 0xFF;
        if (!robust_write(hdr, 3) || !robust_write(pkt, 2 + chunk_bytes)) return;
        usb_web.flush();
    }
}

// --------------------------------------------------------------- main loop
void sdr_rx_loop(void) {
    if (!s_running) return;
    if (!usb_web.connected()) return;

    uint32_t pos = sdr_pos();
    uint32_t avail = (pos + s_cap_samp - s_last_pos) % s_cap_samp;

    // TX whatever audio is ready even between capture chunks
    if (avail < 1024) {
        sdr_send_audio();
        return;
    }
    // Starvation guard: if the loop fell way behind, skip the oldest region
    // (threshold in samples: 16384 @8-bit, 8192 @12-bit where the ring is 12288)
    const uint32_t starve = 16384 >> s_samp_shift;
    if (avail > starve) {
        s_last_pos = (pos + s_cap_samp - starve) % s_cap_samp;
        avail = starve;
    }

    if ((int32_t)(millis() - s_wf_due_ms) >= 0) {
        sdr_send_wf(pos);                      // newest 1024 samples -> 512 bins
        s_wf_due_ms = millis() + (1000UL / s_wf_fps);
    }

    sdr_ddc_range(s_last_pos, avail);          // NCO + CIC -> audio ring
    s_last_pos = pos;
    sdr_send_audio();
}

#endif // ARDUINO_ARCH_STM32
