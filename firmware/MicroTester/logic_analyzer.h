#ifndef LOGIC_ANALYZER_H
#define LOGIC_ANALYZER_H

#include <Arduino.h>

#define LOGIC_BUFFER_SIZE 1024 // 1024 samples x 8 channels (1 byte per sample, 1 bit per channel)

struct LogicConfig {
    uint32_t sampleRateHz; // 10000 to 10000000 Hz
    uint8_t trigChannel;   // 0..7 or 0xFF for none
    uint8_t trigEdge;      // 0: Rising, 1: Falling, 2: Any Change, 3: Immediate/None
    uint16_t sampleCount;  // 64..1024
};

void logic_analyzer_init();
void logic_analyzer_start(LogicConfig cfg);
void logic_analyzer_stop();
void logic_analyzer_loop();
bool logic_analyzer_is_buffer_ready();
uint8_t* logic_analyzer_get_buffer();
uint16_t logic_analyzer_get_buffer_size();
void logic_analyzer_clear_flag();
bool logic_analyzer_is_running();

#endif // LOGIC_ANALYZER_H
