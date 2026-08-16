#ifndef COMP_TESTER_H
#define COMP_TESTER_H

#include <Arduino.h>

// Component types
#define COMP_NONE        0
#define COMP_RESISTOR    10
#define COMP_CAPACITOR   11
#define COMP_INDUCTOR    12
#define COMP_DIODE       20
#define COMP_BJT         21
#define COMP_MOSFET      22
#define COMP_SHORT       30
#define COMP_OPEN        31

// BJT/MOSFET subtypes (in flags)
#define FLAG_NPN         0x01
#define FLAG_PNP         0x02
#define FLAG_NCH         0x04
#define FLAG_PCH         0x08
#define FLAG_ENHANCEMENT 0x10
#define FLAG_DEPLETION   0x20

// Test result packet structure (binary, 16 bytes)
struct CompResult {
    uint8_t type;        // COMP_xxx
    uint8_t pinA;        // Probe assignment A (0-2)
    uint8_t pinB;        // Probe assignment B (0-2)
    uint8_t pinC;        // Probe assignment C (0-2)
    uint32_t value1;     // Primary value: R (ohm*100), C (pF), Vf (mV), hFE
    uint32_t value2;     // Secondary: ESR*100, Vbe(mV), Vth(mV)
    uint32_t value3;     // Tertiary / Calibration values
    uint16_t flags;      // Subtype flags
};

void comp_tester_init();
void comp_tester_start(uint8_t mode = 0);  // Start one test cycle
void comp_tester_stop();
void comp_tester_loop();   // Call in main loop
bool comp_tester_is_done();
CompResult comp_tester_get_result();
void comp_tester_set_cal(uint16_t vdda_mv, const uint16_t rl[3], const uint32_t rh[3]);



#endif
