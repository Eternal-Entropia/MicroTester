#ifndef SDR_RX_H
#define SDR_RX_H

#include <stdint.h>
#include <stdbool.h>

// SDR Receiver (Phase 0): under-sampled direct HF capture + on-MCU DDC.
//
// Architecture:
//  - ADC1 @ fs (default 1 Msps, 8-bit) streamed via TIM2-triggered DMA into a
//    24 KB circular buffer. Waterfall = on-MCU Hann(1024) + float32 FFT,
//    512 log-magnitude bins at wfFps (~5 kB/s). Span = fs/2 (500 kHz @ 1 Msps).
//  - Demod channel: digital NCO (cos LUT, 32-bit phase accumulator) + CIC
//    decimator R=32 N=3 -> real stream at fs/32 (31.25 kS/s @ 1 Msps),
//    240-sample packets (~28 kB/s). Listen RF -> alias fold -> NCO at
//    (alias - IF0) puts the channel on a low-IF; the browser builds the
//    analytic signal (Hilbert / one-sided spectrum) for USB/LSB/CW and AM.
//  - TUNE is glitch-free: NCO phase accumulator is never reset, only the
//    increment changes.
//  - Zone parity (mirror orientation of the alias fold) is reported in the
//    meta byte (bit0) of every WF/AUDIO packet: 0 = direct, 1 = mirrored.
//
// Packet formats (payload length after the 3-byte header):
//  PKT_SDR_WF    0x70: [seq][meta][512 log-mag bins], bin k = k*fs/1024 Hz
//                (bins are 8-bit-scale in both ADC modes -> display unchanged)
//  PKT_SDR_AUDIO 0x71: adcBits=8:  [seq][meta][240 int8 samples @ fs/32]
//                      adcBits=12: [seq][meta][480 bytes = 240 int16 LE samples
//                                  @ fs/32, +-2047 range]
//  meta bit0 = Nyquist zone parity; bit1 = 1 -> 12-bit ADC mode (int16 audio)

#define SDR_FS_DEFAULT_KHZ   1000
#define SDR_IF0_DEFAULT_HZ   8000

// Start: [fsKHz_lo(1)][fsKHz_hi(1)][wfFps(1)][pinIdx(1)][adcBits(1)]
//        (defaults 1000/10/0=PA1/8; adcBits 8 or 12)
void sdr_rx_start(uint16_t fsKHz, uint8_t wfFps, uint8_t pinIdx, uint8_t adcBits);
void sdr_rx_stop(void);
// Tune: [freqHz_b0..3] (RF listening frequency), if0Hz = low-IF offset (0 = zero-IF)
void sdr_rx_tune(uint32_t fListenHz, uint16_t if0Hz);
// Call from main loop; streams PKT_SDR_WF / PKT_SDR_AUDIO
void sdr_rx_loop(void);
bool sdr_rx_active(void);
uint32_t sdr_rx_get_fs(void);

#endif // SDR_RX_H
