#ifndef SHARED_MEM_H
#define SHARED_MEM_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define SHARED_MEM_POOL_SIZE      48000

// Full DAC standalone mode (when Oscilloscope is NOT running)
#define SD_DAC_MAX_BUF_SIZE       48000

// Dual mode (when DAC and Oscilloscope are running simultaneously)
#define SD_DAC_DUAL_MAX_BUF_SIZE  12000
#define DMA_BUF_DUAL_BYTES        24000
#define MAX_FRAME_SIZE            12000
#define PACK_BUF_SIZE             4096

// Shared memory layout (aligned to 4 bytes)
union SharedMemoryPool {
    // 1. Standalone DAC mode (Full 48 KB)
    uint8_t dac_standalone[SD_DAC_MAX_BUF_SIZE];
    
    // 2. Dual mode (DAC 12 KB + Osc DMA 24 KB + Osc Frame 12 KB = 48 KB)
    struct {
        uint8_t  dac_buf[SD_DAC_DUAL_MAX_BUF_SIZE];                  // Offset 0 .. 11999 (12 KB)
        uint16_t adc_dma_buf16[DMA_BUF_DUAL_BYTES / sizeof(uint16_t)]; // Offset 12000 .. 35999 (24 KB)
        union {
            uint8_t osc_frame_buf[MAX_FRAME_SIZE];                    // Offset 36000 .. 47999 (12 KB)
            uint8_t adc_packed_buf[PACK_BUF_SIZE];
        } osc_usb;
    } dual;
    
    uint8_t raw[SHARED_MEM_POOL_SIZE];
};

extern union SharedMemoryPool g_sharedMem;

#endif // SHARED_MEM_H
