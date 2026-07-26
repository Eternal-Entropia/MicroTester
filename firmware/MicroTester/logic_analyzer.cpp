#include "logic_analyzer.h"

static uint8_t logicBuffer[LOGIC_BUFFER_SIZE];
static uint16_t bufferIndex = 0;
static bool bufferReady = false;
static bool isRunning = false;
static LogicConfig currentConfig;
static uint32_t lastSampleMicros = 0;
static uint32_t sampleIntervalMicros = 10; // 100kHz default
static uint8_t lastPortVal = 0;
static bool triggered = false;

// Channel pin mapping
// D0..D7 => PB0..PB7 (STM32) or D0..D7 (Arduino)
#if defined(ARDUINO_ARCH_STM32)
static const uint32_t LOGIC_PINS[8] = { PB0, PB1, PB2, PB3, PB4, PB5, PB6, PB7 };
#else
static const uint8_t LOGIC_PINS[8] = { 2, 3, 4, 5, 6, 7, 8, 9 };
#endif

void logic_analyzer_init() {
    for (int i = 0; i < 8; i++) {
        pinMode(LOGIC_PINS[i], INPUT_PULLDOWN);
    }
    bufferIndex = 0;
    bufferReady = false;
    isRunning = false;
}

// Read all 8 channels into an 8-bit byte
static inline uint8_t read8Channels() {
#if defined(ARDUINO_ARCH_STM32)
    // Direct GPIO read for maximum speed on STM32 GPIOB (pins PB0..PB7)
    return (uint8_t)(GPIOB->IDR & 0xFF);
#else
    uint8_t val = 0;
    for (int i = 0; i < 8; i++) {
        if (digitalRead(LOGIC_PINS[i])) {
            val |= (1 << i);
        }
    }
    return val;
#endif
}

void logic_analyzer_start(LogicConfig cfg) {
    logic_analyzer_stop();

    if (cfg.sampleRateHz == 0) cfg.sampleRateHz = 100000; // default 100kHz
    if (cfg.sampleCount == 0 || cfg.sampleCount > LOGIC_BUFFER_SIZE) {
        cfg.sampleCount = LOGIC_BUFFER_SIZE;
    }

    currentConfig = cfg;
    sampleIntervalMicros = 1000000UL / cfg.sampleRateHz;
    if (sampleIntervalMicros == 0) sampleIntervalMicros = 1;

    bufferIndex = 0;
    bufferReady = false;
    lastPortVal = read8Channels();
    triggered = (cfg.trigEdge >= 3 || cfg.trigChannel >= 8); // Immediate trigger if edge >= 3
    lastSampleMicros = micros();
    isRunning = true;
}

void logic_analyzer_stop() {
    isRunning = false;
    bufferReady = false;
    bufferIndex = 0;
}

void logic_analyzer_loop() {
    if (!isRunning || bufferReady) return;

    uint32_t now = micros();
    if (now - lastSampleMicros < sampleIntervalMicros) return;
    lastSampleMicros = now;

    uint8_t currentVal = read8Channels();

    // Check Trigger if not yet triggered
    if (!triggered) {
        uint8_t chBit = 1 << currentConfig.trigChannel;
        bool prevBit = (lastPortVal & chBit) != 0;
        bool currBit = (currentVal & chBit) != 0;

        if (currentConfig.trigEdge == 0 && !prevBit && currBit) {
            triggered = true; // Rising
        } else if (currentConfig.trigEdge == 1 && prevBit && !currBit) {
            triggered = true; // Falling
        } else if (currentConfig.trigEdge == 2 && (prevBit != currBit)) {
            triggered = true; // Any change
        }
        lastPortVal = currentVal;

        if (!triggered) return; // Wait for trigger condition before storing
    }

    // Store sample in buffer
    logicBuffer[bufferIndex++] = currentVal;

    if (bufferIndex >= currentConfig.sampleCount) {
        bufferReady = true;
        bufferIndex = 0;
        triggered = (currentConfig.trigEdge >= 3 || currentConfig.trigChannel >= 8);
    }
}

bool logic_analyzer_is_buffer_ready() {
    return bufferReady;
}

uint8_t* logic_analyzer_get_buffer() {
    return logicBuffer;
}

uint16_t logic_analyzer_get_buffer_size() {
    return currentConfig.sampleCount;
}

void logic_analyzer_clear_flag() {
    bufferReady = false;
}

bool logic_analyzer_is_running() {
    return isRunning;
}
