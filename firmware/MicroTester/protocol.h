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
#define CMD_SIGMA_DELTA_START  0x32  // Payload: [pin(1)] [bufSize_lo(1)] [bufSize_hi(1)] [data...]
#define CMD_SIGMA_DELTA_STOP   0x33  // Stop Sigma-Delta DAC output
#define CMD_SIGMA_DELTA_DATA   0x34  // Payload: [offset_lo(1)] [offset_hi(1)] [data...]
#define CMD_COMP_TEST     0x50  // Start component auto-test (no payload)
#define CMD_COMP_STOP     0x51  // Cancel test
#define CMD_COMP_SET_CAL  0x52  // Set hardware calibration parameters: [vdda_mV(2)] [RL0..2(6)] [RH0..2(12)]

// Device to Host Packets
#define PKT_VOLTMETER_DATA     0x10
#define PKT_OSCILLOSCOPE_DATA  0x12
#define PKT_OSC_MULTICHANNEL   0x13  // Multi-channel frame: [sessId][chMask][ch0...][ch1...]
#define PKT_COMP_RESULT        0x50  // Component test result

// Standard packet payload size (in bytes)
#define MAX_PAYLOAD_SIZE 1024 

// Command structure from Host (Variable length payload)
// [CMD (1 byte)] [PayloadLength (1 byte)] [Payload...]

#endif // PROTOCOL_H
