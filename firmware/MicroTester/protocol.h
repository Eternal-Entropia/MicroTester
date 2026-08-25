#ifndef PROTOCOL_H
#define PROTOCOL_H

#include <stdint.h>

// Host to Device Commands
#define CMD_VOLT_START    0x10
#define CMD_VOLT_STOP     0x11
#define CMD_VOLT_SET_BIAS 0x14

#define CMD_GET_VREF      0x20  // Request VREFINT measurement
#define PKT_VREF_DATA     0x20  // Reply with VREFINT measurement (uint16_t)

#define CMD_OSC_START     0x12  // Payload: [pin(1)] [oversample(1)] [rateKHz_lo(1)] [rateKHz_hi(1)] [trigEdge(1)] [trigLevel_lo(1)] [trigLevel_hi(1)] [trigMode(1)] [reqSamples(2)] [bias(1)] [bitness12(1)] [sessionId(1)]
#define CMD_OSC_STOP      0x13
#define CMD_SIG_START          0x30  // Payload: [pin(1)] [waveform(1)] [freq_b0..3(4)] [duty(1)]
#define CMD_SIG_STOP           0x31
#define CMD_SIGMA_DELTA_START  0x32  // Payload: [pin(1)] [prescalerExp(1)] [bufSize_lo(1)] [bufSize_hi(1)] [data...]
#define CMD_SIGMA_DELTA_STOP   0x33  // Stop Sigma-Delta DAC output
#define CMD_SIGMA_DELTA_DATA   0x34  // Payload: [offset_lo(1)] [offset_hi(1)] [data...]
#define CMD_COMP_TEST     0x50  // Start component auto-test (no payload)
#define CMD_COMP_STOP     0x51  // Cancel test
#define CMD_COMP_SET_CAL  0x52  // Set hardware calibration: [vdda_mV(2)] [RL0..2(6)] [RH0..2(12)] [esrZero_x100(2, optional, backward compat)]

#define CMD_FR_START      0x60  // Frequency response analyzer: [outPin(1)] [inPin(1)] [directLimitHz_b0..3(4)]
#define CMD_FR_STEP       0x61  // Measure one point: [freq_b0..3(4)] [mode(1)]  mode: 0=Direct, 1=Diode, 2=Sine (Σ-Δ ≤ 1 MHz)
#define CMD_FR_STOP       0x62  // Stop FR analyzer (PWM off, pins Hi-Z)

// Device to Host Packets
#define PKT_VOLTMETER_DATA     0x10
#define PKT_OSCILLOSCOPE_DATA  0x12
#define PKT_COMP_RESULT        0x50  // Component test result
#define PKT_FR_DATA            0x60  // FR point reply: [freq_b0..3(4)] [mode(1)] [value_b0..3(4)]

// Command structure from Host (Variable length payload)
// [CMD (1 byte)] [PayloadLength (1 byte)] [Payload...]

#endif // PROTOCOL_H
