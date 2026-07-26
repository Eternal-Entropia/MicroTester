#include "adc_sampler.h"

// 20000 bytes shared buffer. 
// For Voltmeter: 10000 uint16_t. For Oscilloscope: 20000 uint8_t.
#define DMA_BUF_BYTES 20000
static uint16_t adcDmaBuf16[DMA_BUF_BYTES / 2];
#define adcDmaBuf8 ((uint8_t*)adcDmaBuf16)

#define PACK_BUF_SIZE 4096
static uint8_t adcPackedBuf[PACK_BUF_SIZE];

#define MAX_FRAME_SIZE 1600
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
        case 0: return PA0;
        case 1: return PA1;
        case 2: return PA2;
        case 3: return PA3;
        case 4: return PA4;
        default: return PA4;
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

void adc_sampler_start(AdcConfig config) {
    currentConfig = config;
    int pin = mapPin(currentConfig.pin);
    pinMode(pin, INPUT_ANALOG);
    analogRead(pin); // Wake up ADC and GPIO via HAL
    
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
        DMA2_Stream0->NDTR = DMA_BUF_BYTES;
        DMA2_Stream0->CR = (0 << 25) |       
                           (0 << 13) | // MSIZE=8bit      
                           (0 << 11) | // PSIZE=8bit      
                           DMA_SxCR_MINC |   
                           DMA_SxCR_CIRC |   
                           (0 << 6); 
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

    // 4. Configure Timer 2 for precise hardware triggering (cap hardware rate at 2.0 MSPS)
    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;
    TIM2->CR1 = 0;
    
    uint32_t timerClock = 84000000;
    uint32_t rateHz = currentConfig.isOscilloscope ? (currentConfig.rateKHz * 1000) : 10000;
    if (rateHz > 2000000) rateHz = 2000000; // Hardware limit 2.0 MSPS
    
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
        ADC1->CR1 = ADC_CR1_SCAN | (2 << 24); // 8-bit resolution
        ADC1->SMPR2 &= ~(7 << (3 * channel)); // 3 cycles sampling time (0.28us conversion)
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

void adc_sampler_stop() {
    isRunning = false;
    #if defined(ARDUINO_ARCH_STM32)
    TIM2->CR1 &= ~TIM_CR1_CEN;
    ADC1->CR2 = 0;
    DMA2_Stream0->CR &= ~DMA_SxCR_EN;
    while (DMA2_Stream0->CR & DMA_SxCR_EN); // Wait for DMA stream to fully disable
    #endif
}

bool adc_osc_process_frame(uint8_t** outPtr, uint16_t* outLen) {
    if (!isRunning || !currentConfig.isOscilloscope) return false;
    
    #if defined(ARDUINO_ARCH_STM32)
    uint32_t currentDmaIndex = DMA_BUF_BYTES - DMA2_Stream0->NDTR;
    if (currentDmaIndex >= DMA_BUF_BYTES) currentDmaIndex = 0;
    
    if (oscState == STATE_ARMED) {
        // Prevent backlog loop starvation: if search is too far behind current DMA, jump ahead
        uint32_t backlog = (currentDmaIndex >= oscSearchIndex) ? 
                           (currentDmaIndex - oscSearchIndex) : 
                           (DMA_BUF_BYTES - oscSearchIndex + currentDmaIndex);
        if (backlog > 512) {
            oscSearchIndex = (currentDmaIndex >= 256) ? (currentDmaIndex - 256) : (DMA_BUF_BYTES - 256 + currentDmaIndex);
        }

        // Search for trigger
        bool triggered = false;
        
        while (oscSearchIndex != currentDmaIndex) {
            uint32_t prevIndex = (oscSearchIndex == 0) ? (DMA_BUF_BYTES - 1) : (oscSearchIndex - 1);
            uint8_t val = adcDmaBuf8[oscSearchIndex];
            uint8_t prevVal = adcDmaBuf8[prevIndex];
            
            uint8_t lvl = currentConfig.trigLevel & 0xFF;
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
            oscSearchIndex = (oscSearchIndex + 1) % DMA_BUF_BYTES;
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
                        (DMA_BUF_BYTES - oscTriggerIndex + currentDmaIndex);
                        
        if (dist >= currentConfig.reqSamples / 2) {
            // Frame is ready
            uint32_t startIdx = (oscTriggerIndex >= (currentConfig.reqSamples / 2)) ? 
                                (oscTriggerIndex - currentConfig.reqSamples / 2) : 
                                (DMA_BUF_BYTES - (currentConfig.reqSamples / 2 - oscTriggerIndex));
            
            uint16_t req = currentConfig.reqSamples;
            uint8_t over = currentConfig.oversample;

            if (req > 800) {
                uint32_t step = req / 800;
                if (step < 1) step = 1;

                if (over > 0) {
                    // Oversampling Mode: Average all samples in each bucket for high vertical resolution & noise reduction
                    for (int i = 0; i < 800; i++) {
                        uint32_t baseIdx = (startIdx + i * step) % DMA_BUF_BYTES;
                        uint32_t sum = 0;
                        uint32_t count = (step > 64) ? 64 : step; // Cap max sum iterations per bucket
                        for (uint32_t k = 0; k < count; k++) {
                            sum += adcDmaBuf8[(baseIdx + k) % DMA_BUF_BYTES];
                        }
                        uint8_t avgV = (uint8_t)(sum / count);
                        oscFrameBuf[i * 2] = avgV;
                        oscFrameBuf[i * 2 + 1] = avgV;
                    }
                } else {
                    // Peak-Detect Mode (Min/Max)
                    for (int i = 0; i < 800; i++) {
                        uint32_t baseIdx = (startIdx + i * step) % DMA_BUF_BYTES;
                        uint8_t minV = adcDmaBuf8[baseIdx];
                        uint8_t maxV = minV;
                        
                        uint32_t checkCount = (step > 4) ? 4 : step;
                        uint32_t subStep = step / checkCount;
                        if (subStep < 1) subStep = 1;
                        
                        for (uint32_t k = 1; k < checkCount; k++) {
                            uint8_t v = adcDmaBuf8[(baseIdx + k * subStep) % DMA_BUF_BYTES];
                            if (v < minV) minV = v;
                            if (v > maxV) maxV = v;
                        }
                        oscFrameBuf[i * 2] = minV;
                        oscFrameBuf[i * 2 + 1] = maxV;
                    }
                }
                *outPtr = oscFrameBuf;
                *outLen = 1600;
            } else {
                if (over > 0) {
                    // Oversampling boxcar filter: average 4^over samples
                    uint32_t winSize = 1 << (over * 2); // over=1 -> 4, over=2 -> 16, over=3 -> 64
                    for (int i = 0; i < req; i++) {
                        uint32_t sum = 0;
                        for (uint32_t k = 0; k < winSize; k++) {
                            uint32_t idx = (startIdx + i + k) % DMA_BUF_BYTES;
                            sum += adcDmaBuf8[idx];
                        }
                        oscFrameBuf[i] = (uint8_t)(sum / winSize);
                    }
                    *outPtr = oscFrameBuf;
                    *outLen = req;
                } else {
                    // Raw Copy -> up to 800 bytes
                    for (int i = 0; i < req; i++) {
                        oscFrameBuf[i] = adcDmaBuf8[(startIdx + i) % DMA_BUF_BYTES];
                    }
                    *outPtr = oscFrameBuf;
                    *outLen = req;
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
