#include "adc_sampler.h"

// 20000 bytes shared buffer. 
// For Voltmeter: 10000 uint16_t. For Oscilloscope: 20000 uint8_t.
#define DMA_BUF_BYTES 20000
static uint16_t adcDmaBuf16[DMA_BUF_BYTES / 2];
#define adcDmaBuf8 ((uint8_t*)adcDmaBuf16)

#define PACK_BUF_SIZE 4096
static uint8_t adcPackedBuf[PACK_BUF_SIZE];

#define MAX_FRAME_SIZE 3200
static uint8_t oscFrameBuf[MAX_FRAME_SIZE];

static volatile bool isRunning = false;
static AdcConfig currentConfig;
static uint32_t lastDmaIndex = 0;

// Osc State
static enum {
    STATE_ARMED,
    STATE_WAIT_POST_TRIGGER,
    STATE_READY
} oscState = STATE_ARMED;

static uint32_t oscTriggerIndex = 0;
static uint32_t oscSearchIndex = 0;
static uint32_t oscLastSearchTime = 0;

// ETS State
static bool isEtsMode = false;
static uint16_t etsSampleIndex = 0;
static uint32_t etsNopsPerSample = 1;

static int mapPin(uint8_t configPin) {
    switch(configPin) {
        case 0: return PA1;
        case 1: return PA2;
        case 2: return PA3;
        case 3: return PA4;
        default: return PA1;
    }
}

static uint8_t getAdcChannel(int pin) {
    switch(pin) {
        case PA0: return 0;
        case PA1: return 1;
        case PA2: return 2;
        case PA3: return 3;
        case PA4: return 4;
        case PA5: return 5;
        case PA6: return 6;
        case PA7: return 7;
        default: return 4;
    }
}

void adc_sampler_init() {
    #if defined(ARDUINO_ARCH_STM32)
    analogReadResolution(12);
    #endif
}

#if defined(ARDUINO_ARCH_STM32)
static inline void clear_all_biases() {
    // Set PB6, PB7, PB8, PB9 to Input (Hi-Z)
    GPIOB->MODER &= ~((3UL << (6 * 2)) | (3UL << (7 * 2)) | (3UL << (8 * 2)) | (3UL << (9 * 2)));
    // Clear Pull-Ups/Pull-Downs on PA1, PA2, PA3, PA4 (00 = No Pull)
    GPIOA->PUPDR &= ~((3UL << (1 * 2)) | (3UL << (2 * 2)) | (3UL << (3 * 2)) | (3UL << (4 * 2)));
}

static inline void set_channel_bias(uint8_t pinIndex, bool enable) {
    if (pinIndex > 3) return;
    uint8_t pbPin = 9 - pinIndex; // 0->9, 1->8, 2->7, 3->6
    if (enable) {
        GPIOB->MODER &= ~(3UL << (pbPin * 2));
        GPIOB->MODER |=  (1UL << (pbPin * 2)); // 01 = Output
        GPIOB->BSRR   =  (1UL << pbPin);       // Set HIGH (+3.3V)
    } else {
        GPIOB->MODER &= ~(3UL << (pbPin * 2)); // 00 = Input (Hi-Z)
    }
}
#endif

void adc_sampler_start(AdcConfig config) {
    currentConfig = config;
    int pin = mapPin(currentConfig.pin);
    pinMode(pin, INPUT_ANALOG);
    analogRead(pin); // Wake up ADC and GPIO via HAL
    
    #if defined(ARDUINO_ARCH_STM32)
    clear_all_biases();
    if (currentConfig.pin <= 3) {
        set_channel_bias(currentConfig.pin, currentConfig.enableBias);
    }
    #endif
    
    #if defined(ARDUINO_ARCH_STM32)
    // 1. Enable Clocks
    RCC->APB2ENR |= RCC_APB2ENR_ADC1EN;
    RCC->AHB1ENR |= RCC_AHB1ENR_DMA2EN;

    // 2. Configure DMA2 Stream 0 Channel 0 for ADC1
    DMA2_Stream0->CR = 0; 
    while(DMA2_Stream0->CR & DMA_SxCR_EN);
    
    DMA2->LIFCR = 0x3F; 

    DMA2_Stream0->PAR = (uint32_t)&ADC1->DR;
    DMA2_Stream0->M0AR = (uint32_t)adcDmaBuf16;
    
    if (currentConfig.isOscilloscope) {
        if (currentConfig.bitness12) {
            DMA2_Stream0->NDTR = DMA_BUF_BYTES / 2;
            DMA2_Stream0->CR = (0 << 25) |       
                               (1 << 13) | // MSIZE=16bit      
                               (1 << 11) | // PSIZE=16bit      
                               DMA_SxCR_MINC |   
                               DMA_SxCR_CIRC |   
                               (0 << 6); 
        } else {
            DMA2_Stream0->NDTR = DMA_BUF_BYTES;
            DMA2_Stream0->CR = (0 << 25) |       
                               (0 << 13) | // MSIZE=8bit      
                               (0 << 11) | // PSIZE=8bit      
                               DMA_SxCR_MINC |   
                               DMA_SxCR_CIRC |   
                               (0 << 6); 
        }
    } else {
        DMA2_Stream0->NDTR = DMA_BUF_BYTES / 2;
        DMA2_Stream0->CR = (0 << 25) |       
                           (1 << 13) | // MSIZE=16bit      
                           (1 << 11) | // PSIZE=16bit      
                           DMA_SxCR_MINC |   
                           DMA_SxCR_CIRC |   
                           (0 << 6); 
    }
                       
    DMA2_Stream0->CR |= DMA_SxCR_EN;

    // 3. Set ADC Clock Prescaler to DIV2 (42 MHz ADCCLK) for max performance
    ADC->CCR &= ~(3 << 16); 

    // 4. Configure Timer 2 for precise hardware triggering
    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;
    TIM2->CR1 = 0;
    
    uint32_t timerClock = 84000000;
    uint32_t rateHz = currentConfig.isOscilloscope ? (currentConfig.rateKHz * 1000) : 10000;
    
    uint32_t maxRate = currentConfig.bitness12 ? 2800000 : 3818000; // Physical hardware limits
    if (rateHz > maxRate) rateHz = maxRate;
    
    uint32_t period = timerClock / rateHz;
    if (period < 2) period = 2; // Min limit
    
    TIM2->PSC = 0;
    TIM2->ARR = period - 1;
    TIM2->CNT = 0;             // Reset counter to 0 to prevent 32-bit overflow delay when ARR decreases
    TIM2->EGR = TIM_EGR_UG;    // Force update event to reload registers
    TIM2->CR2 = TIM_CR2_MMS_1; // Update event as TRGO
    
    // 5. Configure ADC1
    ADC1->CR2 = 0; 
    uint8_t channel = getAdcChannel(pin);
    ADC1->SQR3 = channel;

    if (currentConfig.isOscilloscope) {
        if (currentConfig.bitness12) {
            ADC1->CR1 = ADC_CR1_SCAN; // 12-bit resolution
        } else {
            ADC1->CR1 = ADC_CR1_SCAN | (2 << 24); // 8-bit resolution
        }
        ADC1->SMPR2 &= ~(7 << (3 * channel)); 
        if (currentConfig.rateKHz <= 1000) {
            ADC1->SMPR2 |= (1 << (3 * channel)); // 15 cycles sampling time for less voltage sag
        }
        ADC1->CR2 = (1 << 28) | (0x06 << 24) | ADC_CR2_DMA | ADC_CR2_DDS; // Ext trigger TIM2
    } else {
        ADC1->CR1 = ADC_CR1_SCAN; // 12-bit
        ADC1->SMPR2 &= ~(7 << (3 * channel)); 
        ADC1->SMPR2 |= (1 << (3 * channel)); // 15 cycles
        ADC1->CR2 = (1 << 28) | (0x06 << 24) | ADC_CR2_DMA | ADC_CR2_DDS; // Ext trigger TIM2
    }
    
    ADC1->CR2 |= ADC_CR2_ADON; 
    TIM2->CR1 |= TIM_CR1_CEN;
    #endif

    isRunning = true;
    lastDmaIndex = 0;
    
    if (currentConfig.isOscilloscope) {
        oscState = STATE_ARMED;
        oscSearchIndex = 0;
        oscLastSearchTime = millis();
    }
}

void adc_sampler_set_bias(bool enable) {
    currentConfig.enableBias = enable;
    if (currentConfig.pin <= 3 && !currentConfig.isOscilloscope) {
        #if defined(ARDUINO_ARCH_STM32)
        set_channel_bias(currentConfig.pin, enable);
        #endif
    }
}

void adc_sampler_stop() {
    isRunning = false;
    #if defined(ARDUINO_ARCH_STM32)
    clear_all_biases();

    TIM2->CR1 &= ~TIM_CR1_CEN;
    ADC1->CR2 = 0;
    DMA2_Stream0->CR &= ~DMA_SxCR_EN;
    uint32_t timeout = 10000;
    while ((DMA2_Stream0->CR & DMA_SxCR_EN) && --timeout);
    #endif
}

bool adc_osc_process_frame(uint8_t** outPtr, uint16_t* outLen) {
    if (!isRunning || !currentConfig.isOscilloscope) return false;
    
    #if defined(ARDUINO_ARCH_STM32)
    uint32_t bufSize = currentConfig.bitness12 ? (DMA_BUF_BYTES / 2) : DMA_BUF_BYTES;
    uint32_t currentDmaIndex = bufSize - DMA2_Stream0->NDTR;
    if (currentDmaIndex >= bufSize) currentDmaIndex = 0;
    
    if (oscState == STATE_ARMED) {
        // Prevent backlog loop starvation: if search is too far behind current DMA, jump ahead
        uint32_t backlog = (currentDmaIndex >= oscSearchIndex) ? 
                           (currentDmaIndex - oscSearchIndex) : 
                           (bufSize - oscSearchIndex + currentDmaIndex);
        if (backlog > 512) {
            oscSearchIndex = (currentDmaIndex >= 256) ? (currentDmaIndex - 256) : (bufSize - 256 + currentDmaIndex);
        }

        // Search for trigger
        bool triggered = false;
        
        while (oscSearchIndex != currentDmaIndex) {
            uint32_t prevIndex = (oscSearchIndex == 0) ? (bufSize - 1) : (oscSearchIndex - 1);
            uint16_t val, prevVal;
            if (currentConfig.bitness12) {
                val = adcDmaBuf16[oscSearchIndex];
                prevVal = adcDmaBuf16[prevIndex];
            } else {
                val = adcDmaBuf8[oscSearchIndex];
                prevVal = adcDmaBuf8[prevIndex];
            }
            
            uint16_t lvl = currentConfig.trigLevel;
            if (currentConfig.trigEdge == 1) { // Rising
                if (prevVal < lvl && val >= lvl) triggered = true;
            } else { // Falling
                if (prevVal > lvl && val <= lvl) triggered = true;
            }

            if (triggered) {
                oscTriggerIndex = oscSearchIndex;
                oscState = STATE_WAIT_POST_TRIGGER;
                break;
            }
            oscSearchIndex = (oscSearchIndex + 1) % bufSize;
        }
        
        // Auto trigger timeout (50ms)
        if (currentConfig.trigMode == 0 && !triggered && (millis() - oscLastSearchTime > 50)) {
            oscTriggerIndex = currentDmaIndex;
            oscState = STATE_WAIT_POST_TRIGGER;
        }
    }
    
    if (oscState == STATE_WAIT_POST_TRIGGER) {
        // Wait until we have enough samples post-trigger (reqSamples / 2)
        uint32_t dist = (currentDmaIndex >= oscTriggerIndex) ? 
                        (currentDmaIndex - oscTriggerIndex) : 
                        (bufSize - oscTriggerIndex + currentDmaIndex);
                        
        if (dist >= currentConfig.reqSamples / 2) {
            // Frame is ready
            uint32_t startIdx = (oscTriggerIndex >= (currentConfig.reqSamples / 2)) ? 
                                (oscTriggerIndex - currentConfig.reqSamples / 2) : 
                                (bufSize - (currentConfig.reqSamples / 2 - oscTriggerIndex));
            
            uint16_t req = currentConfig.reqSamples;
            uint8_t over = currentConfig.oversample;

            if (req > 800) {
                uint32_t step = req / 800;
                if (step < 1) step = 1;

                if (over > 0) {
                    for (int i = 0; i < 800; i++) {
                        uint32_t baseIdx = (startIdx + i * step) % bufSize;
                        uint32_t sum = 0;
                        uint32_t count = (step > 64) ? 64 : step; 
                        for (uint32_t k = 0; k < count; k++) {
                            sum += currentConfig.bitness12 ? adcDmaBuf16[(baseIdx + k) % bufSize] : adcDmaBuf8[(baseIdx + k) % bufSize];
                        }
                        uint16_t avgV = (uint16_t)(sum / count);
                        if (currentConfig.bitness12) {
                            ((uint16_t*)oscFrameBuf)[i * 2] = avgV;
                            ((uint16_t*)oscFrameBuf)[i * 2 + 1] = avgV;
                        } else {
                            oscFrameBuf[i * 2] = (uint8_t)avgV;
                            oscFrameBuf[i * 2 + 1] = (uint8_t)avgV;
                        }
                    }
                } else {
                    for (int i = 0; i < 800; i++) {
                        uint32_t baseIdx = (startIdx + i * step) % bufSize;
                        uint16_t minV = currentConfig.bitness12 ? adcDmaBuf16[baseIdx] : adcDmaBuf8[baseIdx];
                        uint16_t maxV = minV;
                        
                        uint32_t checkCount = (step > 4) ? 4 : step;
                        uint32_t subStep = step / checkCount;
                        if (subStep < 1) subStep = 1;
                        
                        for (uint32_t k = 1; k < checkCount; k++) {
                            uint16_t v = currentConfig.bitness12 ? adcDmaBuf16[(baseIdx + k * subStep) % bufSize] : adcDmaBuf8[(baseIdx + k * subStep) % bufSize];
                            if (v < minV) minV = v;
                            if (v > maxV) maxV = v;
                        }
                        if (currentConfig.bitness12) {
                            ((uint16_t*)oscFrameBuf)[i * 2] = minV;
                            ((uint16_t*)oscFrameBuf)[i * 2 + 1] = maxV;
                        } else {
                            oscFrameBuf[i * 2] = (uint8_t)minV;
                            oscFrameBuf[i * 2 + 1] = (uint8_t)maxV;
                        }
                    }
                }
                *outPtr = oscFrameBuf;
                *outLen = currentConfig.bitness12 ? 3200 : 1600;
            } else {
                if (over > 0) {
                    uint32_t winSize = 1 << (over * 2); 
                    for (int i = 0; i < req; i++) {
                        uint32_t sum = 0;
                        for (uint32_t k = 0; k < winSize; k++) {
                            uint32_t idx = (startIdx + i + k) % bufSize;
                            sum += currentConfig.bitness12 ? adcDmaBuf16[idx] : adcDmaBuf8[idx];
                        }
                        if (currentConfig.bitness12) {
                            ((uint16_t*)oscFrameBuf)[i] = (uint16_t)(sum / winSize);
                        } else {
                            oscFrameBuf[i] = (uint8_t)(sum / winSize);
                        }
                    }
                    *outPtr = oscFrameBuf;
                    *outLen = currentConfig.bitness12 ? (req * 2) : req;
                } else {
                    for (int i = 0; i < req; i++) {
                        if (currentConfig.bitness12) {
                            ((uint16_t*)oscFrameBuf)[i] = adcDmaBuf16[(startIdx + i) % bufSize];
                        } else {
                            oscFrameBuf[i] = adcDmaBuf8[(startIdx + i) % bufSize];
                        }
                    }
                    *outPtr = oscFrameBuf;
                    *outLen = currentConfig.bitness12 ? (req * 2) : req;
                }
            }
            
            // Re-arm logic
            if (currentConfig.trigMode == 2) {
                oscState = STATE_READY; // SINGLE mode: stop capturing
            } else {
                oscState = STATE_ARMED;
                oscSearchIndex = currentDmaIndex;
                oscLastSearchTime = millis();
            }
            return true;
        }
    }
    #endif
    return false;
}

void adc_sampler_loop() {
    // Left empty for stability. PB9 is now strictly controlled by initialization in adc_sampler_start.
}

int adc_sampler_get_available(uint8_t** outPtr) {
    if (!isRunning || currentConfig.isOscilloscope) return 0;
    
    #if defined(ARDUINO_ARCH_STM32)
    uint16_t currentDmaIndex = (DMA_BUF_BYTES / 2) - DMA2_Stream0->NDTR;
    if (currentDmaIndex == (DMA_BUF_BYTES / 2)) currentDmaIndex = 0;

    int available = currentDmaIndex - lastDmaIndex;
    if (available < 0) available += (DMA_BUF_BYTES / 2);
    
    int contiguous = (DMA_BUF_BYTES / 2) - lastDmaIndex;
    if (available > contiguous) {
        available = contiguous;
    }
    
    if (available > 64) {
        available = 64; // Max 128 bytes per chunk to prevent WebUSB TX buffer overflow
    }
    
    if (available >= 32 || (available > 0 && available == contiguous)) {
        available = available & ~1; // Must be even
        if (available == 0) return 0;
        for (int i = 0; i < available; i++) {
            uint16_t val = adcDmaBuf16[lastDmaIndex + i];
            adcPackedBuf[i*2] = val & 0xFF;
            adcPackedBuf[i*2 + 1] = (val >> 8) & 0xFF;
        }
        available *= 2; // Return byte count
        *outPtr = adcPackedBuf;
        return available;
    }
    #endif
    return 0;
}

void adc_sampler_consume(int count) {
    if (count > 0 && !currentConfig.isOscilloscope) {
        count /= 2;
        lastDmaIndex = (lastDmaIndex + count) % (DMA_BUF_BYTES / 2);
    }
}
