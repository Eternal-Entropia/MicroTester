#ifndef ADC_SAMPLER_H
#define ADC_SAMPLER_H

#include <Arduino.h>

typedef struct {
    uint8_t pin;
    uint8_t oversample;
    bool isOscilloscope;
    uint32_t rateKHz;
    uint8_t trigEdge;
    uint16_t trigLevel;
    uint8_t trigMode;
    uint16_t reqSamples;
} AdcConfig;

void adc_sampler_init();
void adc_sampler_start(AdcConfig config);
void adc_sampler_stop();

// Frame-based API
// Returns true if a frame is ready to transmit
bool adc_osc_process_frame(uint8_t** outPtr, uint16_t* outLen);

// Voltmeter legacy polling
int adc_sampler_get_available(uint8_t** outPtr);
void adc_sampler_consume(int count);

#endif // ADC_SAMPLER_H
