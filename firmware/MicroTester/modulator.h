#ifndef MODULATOR_H
#define MODULATOR_H

#include <stdint.h>
#include "shared_mem.h"

// ============================ Modulator ============================
// Live-modulated generator on top of the two existing "DAC" paths:
//
//   AM / FM / SSB  -> analog output on the sigma-delta bitstream pin (PB5,
//                     SPI1_MOSI). Same SPI/DMA hardware as sigma_delta_dac,
//                     but the bitstream is generated LIVE: a slow timer tick
//                     refills a half of a circular DMA ring (placed in the
//                     shared pool, same slot as the standalone sigma-delta
//                     buffer) with 2nd-order sigma-delta bits produced from
//                     the current modulated sample.
//   Class-D (PWM)  -> hardware PWM output whose duty cycle follows the
//                     modulating envelope at the modulation sample rate
//                     (like a class-D output stage before the LC filter).
//
// Envelope source: internal tone (frequency set by the host) or the real
// ADC stream (continuous voltmeter-style capture on-device), with gain /
// DC offset / auto-fit normalize applied on-device.
//
// Modulation sample rate is fixed at MOD_FS. The host sends PRECOMPUTED
// phase increments (2^32 * freq / MOD_FS), so the firmware runs pure
// integer math (no libm) inside the tick routines.

#define MOD_FS          32000u

// Modes
#define MOD_MODE_AM     1
#define MOD_MODE_FM     2
#define MOD_MODE_SSB    3
#define MOD_MODE_CLASSD 4

// Sources
#define MOD_SRC_TONE    0
#define MOD_SRC_ADC     1

// Sideband selector (SSB only)
#define MOD_SB_USB      0
#define MOD_SB_LSB      1

struct ModConfig {
    uint8_t  mode;            // MOD_MODE_*
    uint8_t  sideband;        // MOD_SB_* (SSB only)
    uint8_t  source;          // MOD_SRC_*
    uint8_t  outPin;          // PWM pin index for Class-D (pwm_gen numbering, no PA0/PB3)
    uint8_t  adcPin;          // ADC channel 0..3 (PA1..PA4) for external source
    uint8_t  prescalerExp;    // sigma-delta bitrate exp: 5 = 1.3125 Mbps (HQ), 6 = 656 kbps
    uint8_t  normalizeOn;     // auto-fit AGC for the external source (0/1)
    uint8_t  biasOn;          // enable the ADC channel bias offset (0/1)
    uint32_t carrierInc;      // carrier phase increment per sample (2^32*Fc/MOD_FS)
    uint32_t modInc;          // tone phase increment per sample   (2^32*Fm/MOD_FS)
    uint16_t depthQ15;        // AM depth / Class-D swing, Q15 (32767 = 100 %)
    uint32_t devInc;          // FM peak deviation phase increment per sample
    uint16_t ssbLevelQ15;     // SSB modulation level (Q15)
    uint16_t gainQ8;          // external gain, Q8 (256 = x1.00, 64..4096)
    int8_t   offsetQ7;        // external DC offset, Q7 (-127..127)
    uint8_t  normTargetPct;   // AGC target peak in % of full swing (0 = off)
    uint32_t classDCarrierHz; // hardware PWM carrier for Class-D mode (Hz)
};

void modulator_init();
void modulator_apply(const ModConfig* cfg); // live parameter update (restarts on structural change)
void modulator_start();
void modulator_stop();
bool modulator_is_running();
bool modulator_source_is_adc();
bool modulator_mode_is_classd();

// Hooks for the command dispatcher: modes that own the ADC or PWM timers
// cannot coexist with the modulator running in the same role.
void modulator_stop_if_adc_source();
void modulator_stop_if_classd();

#endif // MODULATOR_H
