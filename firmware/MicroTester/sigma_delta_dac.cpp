#include "sigma_delta_dac.h"
#include <Arduino.h>

#if defined(ARDUINO_ARCH_STM32)
// Pure CMSIS is used, no LL headers needed
#endif

#define SD_DAC_MAX_BUF_SIZE 16000
static uint8_t sd_dac_buffer[SD_DAC_MAX_BUF_SIZE] __attribute__((aligned(4)));
static uint16_t sd_dac_buf_len = 0;
static bool sd_dac_running = false;
static uint8_t sd_dac_pin = 0; // 0 = PB5 (SPI1_MOSI), 1 = PA7 (SPI1_MOSI alt)

uint16_t sigma_delta_dac_get_buf_len() {
    return sd_dac_buf_len;
}

void sigma_delta_dac_prepare(uint8_t pin, uint16_t length) {
    sigma_delta_dac_stop();
    if (length == 0 || length > SD_DAC_MAX_BUF_SIZE) return;
    
    // Clear buffer to 0 (0V) instead of 0xAA (1.65V) to avoid DC offset before start
    memset(sd_dac_buffer, 0x00, SD_DAC_MAX_BUF_SIZE);
    
    sd_dac_buf_len = length;
    sd_dac_pin = pin;
}

void sigma_delta_dac_init() {
    sd_dac_running = false;
    sd_dac_buf_len = 0;
    memset(sd_dac_buffer, 0xAA, sizeof(sd_dac_buffer));
}

void sigma_delta_dac_write_chunk(uint16_t offset, const uint8_t* data, uint16_t len) {
    if (!data || len == 0) return;
    if (offset + len > SD_DAC_MAX_BUF_SIZE) {
        len = (offset < SD_DAC_MAX_BUF_SIZE) ? (SD_DAC_MAX_BUF_SIZE - offset) : 0;
    }
    if (len > 0) {
        memcpy(&sd_dac_buffer[offset], data, len);
    }
}


void sigma_delta_dac_play() {
    if (sd_dac_buf_len == 0 || sd_dac_buf_len > SD_DAC_MAX_BUF_SIZE) return;

#if defined(ARDUINO_ARCH_STM32) && defined(SPI1)
    // 1. Enable Clocks
    RCC->APB2ENR |= RCC_APB2ENR_SPI1EN;
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN | RCC_AHB1ENR_GPIOBEN | RCC_AHB1ENR_GPIOCEN | RCC_AHB1ENR_DMA2EN;

    // Turn on PC13 LED (Active Low) to indicate playback started
    GPIOC->MODER = (GPIOC->MODER & ~(3U << (13 * 2))) | (1U << (13 * 2)); // Output mode
    GPIOC->BSRR = (1U << (13 + 16)); // Set pin low (on)

    // 2. Configure PB5 Pin (AF5 - SPI1_MOSI @ 42 MHz)
    GPIOB->MODER   = (GPIOB->MODER   & ~(3U << (5 * 2))) | (2U << (5 * 2)); // AF Mode
    GPIOB->OSPEEDR = (GPIOB->OSPEEDR & ~(3U << (5 * 2))) | (3U << (5 * 2)); // Very High Speed
    GPIOB->AFR[0]  = (GPIOB->AFR[0]  & ~(15U << (5 * 4))) | (5U << (5 * 4)); // AF5 (SPI1_MOSI)
    
    // Always configure PA5 as SPI1_SCK (AF5) to keep the internal state machine happy
    GPIOA->MODER   = (GPIOA->MODER   & ~(3U << (5 * 2))) | (2U << (5 * 2)); // AF Mode
    GPIOA->OSPEEDR = (GPIOA->OSPEEDR & ~(3U << (5 * 2))) | (3U << (5 * 2)); // Very High Speed
    GPIOA->AFR[0]  = (GPIOA->AFR[0]  & ~(15U << (5 * 4))) | (5U << (5 * 4)); // AF5 (SPI1_SCK)

    // 3. Disable DMA & SPI before configuring to prevent hangs
    DMA2_Stream3->CR &= ~DMA_SxCR_EN;
    while (DMA2_Stream3->CR & DMA_SxCR_EN) {}
    SPI1->CR1 &= ~SPI_CR1_SPE;

    // 4. Configure SPI1 (Master, 8-bit, MSB first, Prescaler 2 = 42 MHz)
    // CPOL=0, CPHA=0, DFF=0 (8-bit)
    SPI1->CR1 = SPI_CR1_MSTR | SPI_CR1_SSI | SPI_CR1_SSM | (0 << SPI_CR1_BR_Pos); 
    
    // CRITICAL: Configure SPI1 for Half-Duplex Transmit Only (1-line bidirectional, output enabled).
    // This physically disables the receiver, meaning the OVR flag will NEVER occur.
    SPI1->CR1 |= SPI_CR1_BIDIMODE | SPI_CR1_BIDIOE;
    
    // Enable SPI TX DMA request
    SPI1->CR2 = SPI_CR2_TXDMAEN;

    // 5. Configure DMA2 Stream 3 Channel 3 for SPI1 TX Circular DMA
    DMA2_Stream3->PAR  = (uint32_t)&(SPI1->DR);
    DMA2_Stream3->M0AR = (uint32_t)sd_dac_buffer;
    DMA2_Stream3->NDTR = sd_dac_buf_len;
    
    // DMA Configuration:
    // CHSEL = 3 (Channel 3 for SPI1_TX)
    // PL = 3 (Very High Priority)
    // MSIZE = 0 (8-bit), PSIZE = 0 (8-bit)
    // MINC = 1 (Memory Increment), PINC = 0 (Periph No Increment)
    // CIRC = 1 (Circular mode)
    // DIR = 1 (Memory-to-Peripheral)
    DMA2_Stream3->CR = (3U << DMA_SxCR_CHSEL_Pos) | 
                       (3U << DMA_SxCR_PL_Pos) | 
                       DMA_SxCR_MINC | 
                       DMA_SxCR_CIRC | 
                       (1U << DMA_SxCR_DIR_Pos);

    // CRITICAL: Clear all status flags for DMA2 Stream 3 before enabling!
    DMA2->LIFCR = DMA_LIFCR_CTCIF3 | DMA_LIFCR_CHTIF3 | DMA_LIFCR_CTEIF3 | DMA_LIFCR_CDMEIF3 | DMA_LIFCR_CFEIF3;
    
    // Clear any pending SPI errors by reading SR and DR
    (void)SPI1->SR;
    (void)SPI1->DR;

    // 6. Enable DMA Stream & SPI Peripheral
    DMA2_Stream3->CR |= DMA_SxCR_EN;
    SPI1->CR1 |= SPI_CR1_SPE;
#endif

    sd_dac_running = true;
}

void sigma_delta_dac_stop() {
    if (!sd_dac_running) return;

#if defined(ARDUINO_ARCH_STM32) && defined(SPI1)
    if (DMA2_Stream3->CR & DMA_SxCR_EN) {
        DMA2_Stream3->CR &= ~DMA_SxCR_EN;
        // Must wait for DMA to finish before disabling SPI, otherwise DMA hangs!
        while (DMA2_Stream3->CR & DMA_SxCR_EN) {}
    }
    
    // Disable SPI and its DMA requests
    SPI1->CR2 &= ~SPI_CR2_TXDMAEN;
    SPI1->CR1 &= ~SPI_CR1_SPE;
    // Turn off PC13 LED (Active Low)
    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOCEN;
    GPIOC->MODER = (GPIOC->MODER & ~(3U << (13 * 2))) | (1U << (13 * 2)); // Output mode
    GPIOC->BSRR = (1U << 13); // Set pin high (off)
#endif
    sd_dac_running = false;
}

