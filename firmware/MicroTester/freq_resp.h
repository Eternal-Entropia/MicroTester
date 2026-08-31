#ifndef FREQ_RESP_H
#define FREQ_RESP_H

#include <Arduino.h>

#define FR_MODE_DIRECT 0
#define FR_MODE_DIODE  1
#define FR_MODE_SINE   2

#define FR_DIRECT_LIMIT_HZ 1000000UL
#define FR_SINE_MAX_HZ     1000000UL
#define FR_OVERSAMPLING    16   // Default 16x captures averaged

void fr_init();
void fr_start(uint8_t outPinIdx, uint8_t inPinIdx, uint32_t directLimitHz = 1000000UL, uint8_t oversampling = 16);
void fr_stop();
bool fr_measure_point(uint32_t freqHz, uint8_t mode, uint32_t* out_mag, int16_t* out_phase_cdeg = NULL);

// Diagnostics: window length (samples) and sample rate (kHz) of the last direct
// measurement, reported to the host so the coherence of the capture can be verified.
extern volatile uint16_t fr_last_n;
extern volatile uint16_t fr_last_rate_khz;

#endif // FREQ_RESP_H