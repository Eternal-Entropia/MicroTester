#include "adc_ets.h"
static inline uint16_t fast_analogRead(int pin) {
#if defined(ARDUINO_ARCH_STM32)
    uint32_t channel = 0;
    switch(pin) {
        case PA0: channel = 0; break;
        case PA1: channel = 1; break;
        case PA2: channel = 2; break;
        case PA3: channel = 3; break;
        case PA4: channel = 4; break;
        case PA5: channel = 5; break;
        case PA6: channel = 6; break;
        case PA7: channel = 7; break;
        default: return analogRead(pin);
    }
    
    if ((RCC->APB2ENR & RCC_APB2ENR_ADC1EN) == 0) {
        RCC->APB2ENR |= RCC_APB2ENR_ADC1EN;
    }
    if ((ADC1->CR2 & ADC_CR2_ADON) == 0) {
        ADC1->CR2 |= ADC_CR2_ADON;
        for(volatile int i=0; i<100; i++); // Wait to power up
    }
    
    ADC1->SQR3 = channel;
    ADC1->CR2 |= ADC_CR2_SWSTART;
    
    uint32_t timeout = 10000;
    while (!(ADC1->SR & ADC_SR_EOC) && timeout > 0) timeout--;
    
    if (timeout == 0) return analogRead(pin);
    
    return (uint16_t)ADC1->DR;
#else
    return analogRead(pin);
#endif
}
static uint16_t etsBuffer[ADC_ETS_BUFFER_SIZE];
static uint16_t etsBufferIndex = 0;
static volatile bool etsBufferReady = false;
static volatile bool etsIsRunning = false;

static AdcEtsConfig etsConfig;

// Simple inline delay for nanosecond-level wait on ~84MHz STM32
// Each iteration is roughly 3-4 clock cycles (~36ns - 48ns)
static inline void delay_nops(uint32_t nops) {
    while (nops--) {
        __asm__ __volatile__("nop");
    }
}

// Map Arduino Pins based on settings (Assuming STM32F401 BlackPill defaults)
static int etsMapPin(uint8_t configPin) {
    switch(configPin) {
        case 0: return PA1;
        case 1: return PA2;
        case 2: return PA3;
        case 3: return PA4;
        default: return PA1;
    }
}

void adc_ets_start(AdcEtsConfig config) {
    etsConfig = config;
    pinMode(etsMapPin(etsConfig.pin), INPUT_ANALOG);
    analogRead(etsMapPin(etsConfig.pin)); // Warm up ADC and configure it via HAL
    etsBufferIndex = 0;
    etsBufferReady = false;
    etsIsRunning = true;
}

void adc_ets_stop() {
    etsIsRunning = false;
}

bool adc_ets_is_buffer_ready() {
    return etsBufferReady;
}

uint16_t* adc_ets_get_buffer() {
    return etsBuffer;
}

void adc_ets_clear_flag() {
    etsBufferReady = false;
    etsBufferIndex = 0;
}

void adc_ets_loop() {
    if (!etsIsRunning || etsBufferReady) return;

    int pin = etsMapPin(etsConfig.pin);
    uint16_t trig_level = etsConfig.trigLevel;
    bool rising = (etsConfig.trigEdge == 1);
    
    // We collect ONE sample per call, yielding to the main loop!
    uint32_t period_ns = 1000000000 / etsConfig.sampleRateHz;
    uint32_t nops_per_sample = period_ns / 40;
    if (nops_per_sample == 0) nops_per_sample = 1;

    uint32_t timeout = micros();
    uint16_t prev = fast_analogRead(pin);
    bool triggered = false;
    
    // Wait for trigger (timeout 2ms to prevent blocking USB task forever)
    while(micros() - timeout < 2000) {
        uint16_t curr = fast_analogRead(pin);
        if (rising) {
            if (prev < trig_level && curr >= trig_level) { triggered = true; break; }
        } else {
            if (prev > trig_level && curr <= trig_level) { triggered = true; break; }
        }
        prev = curr;
    }
    
    // If triggered, wait the precise ETS delay for this sample index
    if (triggered) {
        delay_nops(etsBufferIndex * nops_per_sample);
    }
    
    // Take the sample
    etsBuffer[etsBufferIndex++] = fast_analogRead(pin);
    
    if (etsBufferIndex >= ADC_ETS_BUFFER_SIZE) {
        etsBufferReady = true;
    }
}
