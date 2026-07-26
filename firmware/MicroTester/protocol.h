#ifndef PROTOCOL_H
#define PROTOCOL_H

#include <stdint.h>

// Host to Device Commands
#define CMD_VOLT_START    0x10
#define CMD_VOLT_STOP     0x11
#define CMD_OSC_START     0x12  // Payload: [pin(1)] [oversample(1)] [rateKHz_lo(1)] [rateKHz_hi(1)] [trigEdge(1)] [trigLevel_lo(1)] [trigLevel_hi(1)]
#define CMD_OSC_STOP      0x13
#define CMD_SIG_START     0x30  // Payload: [pin(1)] [waveform(1)] [freq_b0..3(4)] [duty(1)]
#define CMD_SIG_STOP      0x31
#define CMD_LOGIC_START   0x40  // Payload: [rateKHz_lo(1)] [rateKHz_hi(1)] [trigChannel(1)] [trigEdge(1)] [samples_lo(1)] [samples_hi(1)]
#define CMD_LOGIC_STOP    0x41
#define CMD_COMP_TEST     0x50  // Start component auto-test (no payload)
#define CMD_COMP_STOP     0x51  // Cancel test

// Device to Host Packets
#define PKT_VOLTMETER_DATA     0x10
#define PKT_OSCILLOSCOPE_DATA  0x12
#define PKT_LOGIC_DATA         0x40
#define PKT_COMP_RESULT        0x50  // Component test result

// Standard packet payload size (in bytes)
#define MAX_PAYLOAD_SIZE 1024 

// Command structure from Host (Variable length payload)
// [CMD (1 byte)] [PayloadLength (1 byte)] [Payload...]

#endif // PROTOCOL_H
