#include "adc_sampler.h"

// 20000 bytes shared buffer. 
// For Voltmeter: 10000 uint16_t. For Oscilloscope: 20000 uint8_t.
#define DMA_BUF_BYTES 20000
static uint16_t adcDmaBuf16[DMA_BUF_BYTES / 2];
#define adcDmaBuf8 ((uint8_t*)adcDmaBuf16)

#define PACK_BUF_SIZE 4096
static uint8_t adcPackedBuf[PACK_BUF_SIZE];

#define MAX_FRAME_SIZE 15000
static uint8_t oscFrameBuf[MAX_FRAME_SIZE];

// Multi-channel scan state
static uint8_t multiChList[4];   // Ordered list of active channels (0..3)
static uint8_t multiChCount = 0;
static bool    isMultiCh  = false;

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
static uint32_t etsCyclesPerStep = 1;

#if defined(ARDUINO_ARCH_STM32)
static inline void ets_dwt_init() {
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
}

static inline uint16_t ets_fast_analogRead_raw() {
    ADC1->CR2 |= ADC_CR2_SWSTART;
    uint32_t timeout = 10000;
    while (!(ADC1->SR & ADC_SR_EOC) && --timeout);
    return (uint16_t)ADC1->DR;
}
#endif

static int mapPin(uint8_t configPin) {
    switch(configPin) {
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

    // Build multi-channel list from pinMask. If pinMask is 0, fall back to single pin in config.pin
    multiChCount = 0;
    isMultiCh = false;
    if (config.isOscilloscope) {
        uint8_t mask = config.pinMask;
        if (mask == 0) mask = 1 << config.pin; // Single-channel fallback
        for (uint8_t i = 0; i < 4; i++) {
            if (mask & (1 << i)) {
                multiChList[multiChCount++] = i;
            }
        }
        if (multiChCount > 1) isMultiCh = true;
    }

    int pin = mapPin(currentConfig.pin);
    pinMode(pin, INPUT_ANALOG);
    analogRead(pin); // Wake up ADC and GPIO via HAL

    #if defined(ARDUINO_ARCH_STM32)
    clear_all_biases();
    // Apply bias to ALL active channels in multi-mode, single channel otherwise
    if (isMultiCh) {
        for (uint8_t i = 0; i < multiChCount; i++) {
            set_channel_bias(multiChList[i], currentConfig.enableBias);
        }
    } else if (currentConfig.pin <= 3) {
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
        // In multi-channel mode DMA NDTR must be a multiple of channel count
        // so each scan cycle occupies a complete "frame" of samples and wrap-around
        // never splits a frame.
        uint32_t stride = (multiChCount > 0) ? multiChCount : 1;
        if (currentConfig.bitness12) {
            uint32_t n = (DMA_BUF_BYTES / 2) / stride * stride;
            DMA2_Stream0->NDTR = n;
            DMA2_Stream0->CR = (0 << 25) |
                               (1 << 13) | // MSIZE=16bit
                               (1 << 11) | // PSIZE=16bit
                               DMA_SxCR_MINC |
                               DMA_SxCR_CIRC |
                               (0 << 6);
        } else {
            uint32_t n = (DMA_BUF_BYTES / stride) * stride;
            DMA2_Stream0->NDTR = n;
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
    
    uint32_t period;
    if (currentConfig.isOscilloscope && isMultiCh) {
        period = (timerClock * multiChCount) / rateHz;
    } else {
        period = timerClock / rateHz;
    }
    if (period < 2) period = 2; // Min limit
    
    TIM2->PSC = 0;
    TIM2->ARR = period - 1;
    TIM2->CNT = 0;             // Reset counter to 0 to prevent 32-bit overflow delay when ARR decreases
    TIM2->EGR = TIM_EGR_UG;    // Force update event to reload registers
    TIM2->CR2 = TIM_CR2_MMS_1; // Update event as TRGO
    
    // 5. Configure ADC1
    ADC1->CR2 = 0;

    // ETS only supported for single channel (accurate timing control is impossible in scan mode)
    isEtsMode = (currentConfig.isOscilloscope && currentConfig.rateKHz >= 5000 && !currentConfig.bitness12 && !isMultiCh);

    if (isEtsMode) {
        uint8_t channel = getAdcChannel(pin);
        ets_dwt_init();
        DMA2_Stream0->CR &= ~DMA_SxCR_EN;
        TIM2->CR1 &= ~TIM_CR1_CEN;

        ADC1->CR1 = ADC_CR1_SCAN | (2 << 24); // 8-bit
        ADC1->SMPR2 &= ~(7 << (3 * channel)); // Fast 3-cycle sampling time
        ADC1->SQR3 = channel;                 // Set channel ONCE
        ADC1->CR2 = ADC_CR2_ADON;             // Software trigger only

        uint32_t cpuFreq = 84000000UL;
        #if defined(SystemCoreClock) && SystemCoreClock > 0
        cpuFreq = SystemCoreClock;
        #elif defined(F_CPU) && F_CPU > 0
        cpuFreq = F_CPU;
        #endif

        uint32_t periodNs = 1000000UL / currentConfig.rateKHz;
        if (periodNs < 1) periodNs = 1;

        etsCyclesPerStep = (uint32_t)(((double)periodNs * (double)cpuFreq) / 1000000000.0);
        if (etsCyclesPerStep == 0) etsCyclesPerStep = 1;
    } else if (isMultiCh) {
        // Apparatus-sync multi-channel scan mode
        // ADC SQR1: L = multiChCount-1 (bits[23:20])
        // Channels are ALL the same bitness as configured; scan in order of multiChList
        ADC1->CR1 = ADC_CR1_SCAN | (currentConfig.bitness12 ? 0 : (2 << 24));

        // Set sample time for each channel; use 3 cycles (fastest) or 15 for low rates
        uint32_t smpr2 = ADC1->SMPR2;
        for (uint8_t i = 0; i < multiChCount; i++) {
            uint8_t ch = getAdcChannel(mapPin(multiChList[i]));
            smpr2 &= ~(7UL << (3 * ch));
            if (currentConfig.rateKHz <= 1000) smpr2 |= (1UL << (3 * ch)); // 15 cycles
        }
        ADC1->SMPR2 = smpr2;

        // Regular channel sequence: SQR3 (1st..6th), SQR2 (7th..12th), SQR1 (13th..16th + L)
        uint32_t sqr1 = 0, sqr2 = 0, sqr3 = 0;
        for (uint8_t i = 0; i < multiChCount; i++) {
            uint8_t ch = getAdcChannel(mapPin(multiChList[i]));
            if (i < 6)       sqr3 |= (uint32_t)ch << (5 * i);
            else if (i < 12) sqr2 |= (uint32_t)ch << (5 * (i - 6));
            else             sqr1 |= (uint32_t)ch << (5 * (i - 12));
        }
        sqr1 |= ((uint32_t)(multiChCount - 1)) << 20; // L[3:0] = number of conversions - 1

        ADC1->SQR1 = sqr1;
        ADC1->SQR2 = sqr2;
        ADC1->SQR3 = sqr3;

        ADC1->CR2 = (1 << 28) | (0x06 << 24) | ADC_CR2_DMA | ADC_CR2_DDS | ADC_CR2_ADON; // Ext trigger TIM2
        TIM2->CR1 |= TIM_CR1_CEN;
    } else {
        uint8_t channel = getAdcChannel(pin);
        ADC1->SQR1 = 0; // CRITICAL: reset scan length L=0 (1 conversion) after multi-mode
        ADC1->SQR2 = 0;
        ADC1->SQR3 = channel;
        if (currentConfig.isOscilloscope) {
            if (currentConfig.bitness12) {
                ADC1->CR1 = ADC_CR1_SCAN;
            } else {
                ADC1->CR1 = ADC_CR1_SCAN | (2 << 24);
            }
            ADC1->SMPR2 &= ~(7 << (3 * channel));
            if (currentConfig.rateKHz <= 1000) {
                ADC1->SMPR2 |= (1 << (3 * channel)); // 15 cycles
            }
            ADC1->CR2 = (1 << 28) | (0x06 << 24) | ADC_CR2_DMA | ADC_CR2_DDS | ADC_CR2_ADON; // Ext trigger TIM2
        } else {
            ADC1->CR1 = ADC_CR1_SCAN; // 12-bit
            ADC1->SMPR2 &= ~(7 << (3 * channel));
            ADC1->SMPR2 |= (1 << (3 * channel)); // 15 cycles
            ADC1->CR2 = (1 << 28) | (0x06 << 24) | ADC_CR2_DMA | ADC_CR2_DDS | ADC_CR2_ADON; // Ext trigger TIM2
        }
        TIM2->CR1 |= TIM_CR1_CEN;
    }
    #endif

    isRunning = true;
    lastDmaIndex = 0;
    
    if (currentConfig.isOscilloscope) {
        oscState = STATE_ARMED;
        oscSearchIndex = 0;
        oscLastSearchTime = millis();
    } else {
        isEtsMode = false;
    }
}

uint8_t adc_sampler_get_session_id() {
    return currentConfig.sessionId;
}

uint8_t adc_sampler_get_channel_mask() {
    if (!isMultiCh) return 0;  // Single-channel (and ETS) frames don't carry mask
    uint8_t m = 0;
    for (uint8_t i = 0; i < multiChCount; i++) m |= (1 << multiChList[i]);
    return m;
}

#if defined(ARDUINO_ARCH_STM32)
static inline uint16_t ets_fast_analogRead(uint8_t channel) {
    if ((RCC->APB2ENR & RCC_APB2ENR_ADC1EN) == 0) {
        RCC->APB2ENR |= RCC_APB2ENR_ADC1EN;
    }
    if ((ADC1->CR2 & ADC_CR2_ADON) == 0) {
        ADC1->CR2 |= ADC_CR2_ADON;
        for(volatile int i=0; i<100; i++);
    }
    ADC1->SQR3 = channel;
    ADC1->CR2 |= ADC_CR2_SWSTART;
    uint32_t timeout = 10000;
    while (!(ADC1->SR & ADC_SR_EOC) && --timeout);
    return (uint16_t)ADC1->DR;
}
#endif

void adc_sampler_set_bias(bool enable) {
    currentConfig.enableBias = enable;
    if (currentConfig.pin <= 3) {
        #if defined(ARDUINO_ARCH_STM32)
        set_channel_bias(currentConfig.pin, enable);
        #endif
    }
}

void adc_sampler_stop() {
    isRunning = false;
    isEtsMode = false;
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
    if (isEtsMode) {
        int pin = mapPin(currentConfig.pin);
        uint8_t channel = getAdcChannel(pin);
        uint16_t req = currentConfig.reqSamples;
        if (req > 1600) req = 1600;

        ADC1->SQR3 = channel;
        uint16_t trigLevel = currentConfig.trigLevel;
        bool rising = (currentConfig.trigEdge == 1);
        bool autoTrig = (currentConfig.trigMode == 0);

        // FIX: Find ONE stable trigger point for the entire frame
        uint32_t startWait = micros();
        uint16_t prevVal = ets_fast_analogRead_raw();
        bool triggered = false;
        uint32_t baseTrigCycles = 0;

        while (micros() - startWait < 500) {
            uint16_t currVal = ets_fast_analogRead_raw();
            if (rising) {
                if (prevVal < trigLevel && currVal >= trigLevel) {
                    baseTrigCycles = DWT->CYCCNT;
                    triggered = true;
                    break;
                }
            } else {
                if (prevVal > trigLevel && currVal <= trigLevel) {
                    baseTrigCycles = DWT->CYCCNT;
                    triggered = true;
                    break;
                }
            }
            prevVal = currVal;
        }

        if (!triggered) {
            if (autoTrig) {
                baseTrigCycles = DWT->CYCCNT;
            } else {
                if (currentConfig.trigMode == 2) oscState = STATE_READY;
                return false;
            }
        }

        // FIX: Sample relative to the SINGLE trigger point
        // This creates correct sequential ETS: sample i is taken at time i*dt after trigger
        for (uint16_t i = 0; i < req; i++) {
            uint32_t target = baseTrigCycles + i * etsCyclesPerStep;
            // Handle 32-bit wrap-around correctly
            while ((int32_t)(DWT->CYCCNT - target) < 0);
            
            // Read sample immediately at precise time
            uint16_t val = ets_fast_analogRead_raw();
            oscFrameBuf[i] = (uint8_t)val;
        }

        *outPtr = oscFrameBuf;
        *outLen = req;

        if (currentConfig.trigMode == 2) {
            oscState = STATE_READY;
        } else {
            oscState = STATE_ARMED;
        }
        return true;
    }
    uint32_t bufElemsPerFrame = isMultiCh ? multiChCount : 1;
    if (bufElemsPerFrame < 1) bufElemsPerFrame = 1;
    uint32_t bufSize = (currentConfig.bitness12 ? (DMA_BUF_BYTES / 2) : DMA_BUF_BYTES);
    // Round bufSize down to a multiple of frame size so each scan frame is atomic
    bufSize -= bufSize % bufElemsPerFrame;

    uint32_t currentDmaIndex = bufSize - DMA2_Stream0->NDTR;
    if (currentDmaIndex >= bufSize) currentDmaIndex = 0;
    // Align read pointer to frame boundary in multi mode (DMA can stop mid-frame)
    if (isMultiCh) currentDmaIndex = (currentDmaIndex / bufElemsPerFrame) * bufElemsPerFrame;

    if (oscState == STATE_ARMED) {
        // Align search index to frame boundary (multi-mode) — otherwise it never equals currentDmaIndex
        if (isMultiCh) oscSearchIndex = (oscSearchIndex / bufElemsPerFrame) * bufElemsPerFrame;

        // Prevent backlog loop starvation: jump ahead if too far behind
        uint32_t backlog = (currentDmaIndex >= oscSearchIndex) ?
                           (currentDmaIndex - oscSearchIndex) :
                           (bufSize - oscSearchIndex + currentDmaIndex);
        uint32_t jumpBacklog = 512 * bufElemsPerFrame;
        if (backlog > jumpBacklog) {
            oscSearchIndex = (currentDmaIndex >= jumpBacklog / 2) ? (currentDmaIndex - jumpBacklog / 2) : (bufSize - jumpBacklog / 2 + currentDmaIndex);
            if (isMultiCh) oscSearchIndex = (oscSearchIndex / bufElemsPerFrame) * bufElemsPerFrame;
        }

        // Trigger search: in multi-mode, search ONLY on first channel of list (index stride = multiChCount)
        bool triggered = false;
        uint16_t lvl = currentConfig.trigLevel;
        uint8_t trigChannelSubIdx = 0;  // trigger on first channel of multiChList

        while (oscSearchIndex != currentDmaIndex) {
            uint32_t prevIndex;
            if (isMultiCh) {
                // Multi: each "sample" is multiChCount elements; search with stride
                uint32_t aligned = (oscSearchIndex / bufElemsPerFrame) * bufElemsPerFrame;
                uint32_t sampleIdx = aligned + trigChannelSubIdx;
                prevIndex = (aligned == 0) ? (bufSize - bufElemsPerFrame + trigChannelSubIdx) : (aligned - bufElemsPerFrame + trigChannelSubIdx);
                uint16_t val, prevVal;
                if (currentConfig.bitness12) {
                    val     = adcDmaBuf16[sampleIdx];
                    prevVal = adcDmaBuf16[prevIndex];
                } else {
                    val     = adcDmaBuf8[sampleIdx];
                    prevVal = adcDmaBuf8[prevIndex];
                }
                if (currentConfig.trigEdge == 1) {
                    if (prevVal < lvl && val >= lvl) triggered = true;
                } else {
                    if (prevVal > lvl && val <= lvl) triggered = true;
                }
                if (triggered) {
                    oscTriggerIndex = aligned;
                    oscState = STATE_WAIT_POST_TRIGGER;
                    break;
                }
                oscSearchIndex = (aligned + bufElemsPerFrame) % bufSize;
            } else {
                prevIndex = (oscSearchIndex == 0) ? (bufSize - 1) : (oscSearchIndex - 1);
                uint16_t val, prevVal;
                if (currentConfig.bitness12) {
                    val     = adcDmaBuf16[oscSearchIndex];
                    prevVal = adcDmaBuf16[prevIndex];
                } else {
                    val     = adcDmaBuf8[oscSearchIndex];
                    prevVal = adcDmaBuf8[prevIndex];
                }
                if (currentConfig.trigEdge == 1) {
                    if (prevVal < lvl && val >= lvl) triggered = true;
                } else {
                    if (prevVal > lvl && val <= lvl) triggered = true;
                }
                if (triggered) {
                    oscTriggerIndex = oscSearchIndex;
                    oscState = STATE_WAIT_POST_TRIGGER;
                    break;
                }
                oscSearchIndex = (oscSearchIndex + 1) % bufSize;
            }
        }

        // Auto trigger timeout (50ms)
        if (currentConfig.trigMode == 0 && !triggered && (millis() - oscLastSearchTime > 50)) {
            oscTriggerIndex = currentDmaIndex;
            // Align to frame boundary in multi mode
            if (isMultiCh) oscTriggerIndex = (oscTriggerIndex / bufElemsPerFrame) * bufElemsPerFrame;
            oscState = STATE_WAIT_POST_TRIGGER;
        }
    }

    if (oscState == STATE_WAIT_POST_TRIGGER) {
        uint32_t req = currentConfig.reqSamples;
        // Safety clamp: total output must fit oscFrameBuf (MAX_FRAME_SIZE bytes).
        // Frame units = uint16 in 12-bit, uint8 in 8-bit. Decimated path writes 1600 units per channel.
        {
            uint32_t bytesPerUnit = currentConfig.bitness12 ? 2 : 1;
            uint32_t decimatedUnitsPerCh = 1600;
            uint32_t maxDecimatedUnits = (MAX_FRAME_SIZE / bytesPerUnit) / bufElemsPerFrame;
            if (req > 800 && decimatedUnitsPerCh > maxDecimatedUnits) {
                req = 800; // fall into non-decimated path, clamp next
            }
            uint32_t maxReq = (MAX_FRAME_SIZE / bytesPerUnit) / bufElemsPerFrame;
            if (req > maxReq) req = maxReq;
        }
        // In multi mode req = samples PER CHANNEL; total raw elements needed = req * multiChCount
        uint32_t reqRawElems = req * bufElemsPerFrame;

        // Wait until enough samples post-trigger
        uint32_t dist = (currentDmaIndex >= oscTriggerIndex) ?
                        (currentDmaIndex - oscTriggerIndex) :
                        (bufSize - oscTriggerIndex + currentDmaIndex);

        if (dist >= reqRawElems / 2) {
            uint32_t startIdx = (oscTriggerIndex >= (reqRawElems / 2)) ?
                                (oscTriggerIndex - reqRawElems / 2) :
                                (bufSize - (reqRawElems / 2 - oscTriggerIndex));
            // Align startIdx to frame boundary
            startIdx = (startIdx / bufElemsPerFrame) * bufElemsPerFrame;

            uint8_t over = currentConfig.oversample;
            uint16_t outOffset = 0;

            // Demultiplex: for each channel, extract stride-subsequence and process.
            // Writes per-channel data in UNITS (uint16 if 12-bit, uint8 if 8-bit) starting at outUnits.
            uint32_t outUnits = 0;  // offset in units (not bytes)
            uint16_t* outBuf16 = (uint16_t*)oscFrameBuf;
            uint8_t*  outBuf8  = oscFrameBuf;

            for (uint8_t ci = 0; ci < bufElemsPerFrame; ci++) {
                uint32_t chUnits = 0;  // units written for this channel
                if (req > 800) {
                    uint32_t step = req / 800;
                    if (step < 1) step = 1;
                    if (over > 0) {
                        for (int i = 0; i < 800; i++) {
                            uint32_t baseRaw = (startIdx + (uint32_t)(i * step) * bufElemsPerFrame + ci) % bufSize;
                            uint32_t sum = 0;
                            uint32_t count = (step > 64) ? 64 : step;
                            for (uint32_t k = 0; k < count; k++) {
                                uint32_t e = (baseRaw + k * bufElemsPerFrame) % bufSize;
                                sum += currentConfig.bitness12 ? adcDmaBuf16[e] : adcDmaBuf8[e];
                            }
                            uint16_t avgV = (uint16_t)(sum / count);
                            if (currentConfig.bitness12) { outBuf16[outUnits + i * 2] = avgV; outBuf16[outUnits + i * 2 + 1] = avgV; }
                            else { outBuf8[outUnits + i * 2] = (uint8_t)avgV; outBuf8[outUnits + i * 2 + 1] = (uint8_t)avgV; }
                        }
                    } else {
                        for (int i = 0; i < 800; i++) {
                            uint32_t baseRaw = (startIdx + (uint32_t)(i * step) * bufElemsPerFrame + ci) % bufSize;
                            uint16_t minV = currentConfig.bitness12 ? adcDmaBuf16[baseRaw] : adcDmaBuf8[baseRaw];
                            uint16_t maxV = minV;
                            uint32_t checkCount = (step > 4) ? 4 : step;
                            uint32_t subStep = step / checkCount;
                            if (subStep < 1) subStep = 1;
                            for (uint32_t k = 1; k < checkCount; k++) {
                                uint32_t e = (baseRaw + k * subStep * bufElemsPerFrame) % bufSize;
                                uint16_t v = currentConfig.bitness12 ? adcDmaBuf16[e] : adcDmaBuf8[e];
                                if (v < minV) minV = v;
                                if (v > maxV) maxV = v;
                            }
                            if (currentConfig.bitness12) { outBuf16[outUnits + i * 2] = minV; outBuf16[outUnits + i * 2 + 1] = maxV; }
                            else { outBuf8[outUnits + i * 2] = (uint8_t)minV; outBuf8[outUnits + i * 2 + 1] = (uint8_t)maxV; }
                        }
                    }
                    chUnits = 1600; // 800 pairs min/max
                } else {
                    if (over > 0) {
                        uint32_t winSize = 1 << (over * 2);
                        for (uint32_t i = 0; i < req; i++) {
                            uint32_t sum = 0;
                            for (uint32_t k = 0; k < winSize; k++) {
                                uint32_t e = (startIdx + (i + k) * bufElemsPerFrame + ci) % bufSize;
                                sum += currentConfig.bitness12 ? adcDmaBuf16[e] : adcDmaBuf8[e];
                            }
                            if (currentConfig.bitness12) outBuf16[outUnits + i] = (uint16_t)(sum / winSize);
                            else                          outBuf8[outUnits + i] = (uint8_t)(sum / winSize);
                        }
                    } else {
                        for (uint32_t i = 0; i < req; i++) {
                            uint32_t e = (startIdx + i * bufElemsPerFrame + ci) % bufSize;
                            if (currentConfig.bitness12) outBuf16[outUnits + i] = adcDmaBuf16[e];
                            else                          outBuf8[outUnits + i] = adcDmaBuf8[e];
                        }
                    }
                    chUnits = req;
                }
                outUnits += chUnits;
            }

            *outPtr = oscFrameBuf;
            uint32_t bytesPerUnit = currentConfig.bitness12 ? 2 : 1;
            *outLen = (uint16_t)(outUnits * bytesPerUnit);

            // Re-arm logic
            if (currentConfig.trigMode == 2) {
                oscState = STATE_READY;
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

uint32_t adc_sampler_measure_vrefint_sum4096() {
#if defined(ARDUINO_ARCH_STM32)
    if ((RCC->APB2ENR & RCC_APB2ENR_ADC1EN) == 0) RCC->APB2ENR |= RCC_APB2ENR_ADC1EN;
    ADC1->CR2 = 0; // Stop ADC before modifying CR1
    ADC1->SR = 0;  // Clear OVR and EOC flags to unfreeze DR
    ADC1->CR1 = 0; // Set 12-bit mode
    
    ADC->CCR |= (1 << 23); // TSVREFE
    ADC1->SQR3 = 17; // VREFINT channel
    ADC1->SMPR1 |= (7 << 21); // Max sample time (480 cycles)
    ADC1->CR2 |= ADC_CR2_ADON;
    delay(2);
    
    // First conversion is dummy
    ADC1->CR2 |= ADC_CR2_SWSTART;
    uint32_t timeout = 10000;
    while (!(ADC1->SR & ADC_SR_EOC) && --timeout);
    uint16_t dump = ADC1->DR;
    
    uint32_t sum = 0;
    for (int i = 0; i < 4096; i++) {
        ADC1->CR2 |= ADC_CR2_SWSTART;
        timeout = 10000;
        while (!(ADC1->SR & ADC_SR_EOC) && --timeout);
        sum += ADC1->DR;
    }
    ADC1->CR2 = 0;
    ADC->CCR &= ~(1 << 23);
    return sum;
#else
    return 1500 * 4096;
#endif
}

uint16_t adc_sampler_measure_vrefint() {
    return adc_sampler_measure_vrefint_sum4096() / 4096;
}
