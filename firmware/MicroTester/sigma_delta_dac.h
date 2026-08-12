#ifndef SIGMA_DELTA_DAC_H
#define SIGMA_DELTA_DAC_H

#include <stdint.h>
#include <stdbool.h>

#define SD_DAC_MAX_BUF_SIZE 4096

void sigma_delta_dac_init();
void sigma_delta_dac_prepare(uint8_t pin, uint16_t length);
void sigma_delta_dac_play();
uint16_t sigma_delta_dac_get_buf_len();
void sigma_delta_dac_write_chunk(uint16_t offset, const uint8_t* data, uint16_t len);
void sigma_delta_dac_stop();
#endif // SIGMA_DELTA_DAC_H
