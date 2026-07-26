#ifndef ADC_ETS_H
#define ADC_ETS_H

#include <Arduino.h>
#include "adc_sampler.h" // For ADC_BUFFER_SIZE

#define ADC_ETS_BUFFER_SIZE 500 // Larger buffer for ETS mode

typedef struct {
    uint8_t pin;
    uint32_t sampleRateHz; // Effective sample rate (e.g. 1000000 for 1Msps)
    uint8_t trigEdge;      // 0 = falling, 1 = rising
    uint16_t trigLevel;    // 0-4095
} AdcEtsConfig;

void adc_ets_start(AdcEtsConfig config);
void adc_ets_stop();
bool adc_ets_is_buffer_ready();
uint16_t* adc_ets_get_buffer();
void adc_ets_clear_flag();
void adc_ets_loop(); // Call this in main loop

#endif // ADC_ETS_H
