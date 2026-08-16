#ifndef ADC_SAMPLER_H
#define ADC_SAMPLER_H

#include <Arduino.h>

typedef struct {
    uint8_t pin;          // Single channel index OR trigger channel in multi-mode
    uint8_t pinMask;      // Multi-channel bitmask (bit0=CH0, bit1=CH1, ...). Set by host.
    uint8_t oversample;
    bool isOscilloscope;
    bool enableBias;
    bool bitness12;
    uint32_t rateKHz;
    uint8_t trigEdge;
    uint16_t trigLevel;
    uint8_t trigMode;
    uint16_t reqSamples;
    uint8_t sessionId;
} AdcConfig;

void adc_sampler_init();
void adc_sampler_start(AdcConfig config);
void adc_sampler_stop();
void adc_sampler_loop();
void adc_sampler_set_bias(bool enable);
uint8_t adc_sampler_get_session_id();
uint8_t adc_sampler_get_channel_mask();
uint16_t adc_sampler_measure_vrefint();
uint32_t adc_sampler_measure_vrefint_sum4096();

// Frame-based API
// Returns true if a frame is ready to transmit
bool adc_osc_process_frame(uint8_t** outPtr, uint16_t* outLen);

// Voltmeter legacy polling
int adc_sampler_get_available(uint8_t** outPtr);
void adc_sampler_consume(int count);

// Burst hardware DMA sampling for Component Tester RL/RC analysis
void adc_sampler_capture_burst(uint8_t pinIndex, uint16_t* outBuf, uint16_t count, uint32_t rateKHz);

#endif // ADC_SAMPLER_H
