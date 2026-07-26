#include "Adafruit_TinyUSB.h"
#include "protocol.h"
#include "adc_sampler.h"
#include "adc_ets.h"
#include "pwm_gen.h"
#include "logic_analyzer.h"
#include "comp_tester.h"

#define CMD_BENCHMARK_START 0x20
#define CMD_BENCHMARK_STOP  0x21

bool benchmarkMode = false;
bool oscMode = false; // true = oscilloscope, false = voltmeter

// Benchmark: 2KB buffer, write in big chunk then flush once
static uint8_t benchBuffer[2048];

// WebUSB object
Adafruit_USBD_WebUSB usb_web;

bool robust_write(const uint8_t* data, uint16_t len) {
    uint16_t written = 0;
    uint32_t start = millis();
    while (written < len && usb_web.connected()) {
        int res = usb_web.write(data + written, len - written);
        if (res > 0) {
            written += res;
            start = millis(); // Reset timeout on progress
        }
        if (written < len) {
            usb_web.flush();
            #if defined(ARDUINO_ARCH_STM32)
            TinyUSB_Device_Task();
            #endif
            if (millis() - start > 100) return false; // 100ms timeout to prevent hard freeze
        }
    }
    return written == len;
}

void setup() {
#if defined(ARDUINO_ARCH_STM32)
  TinyUSB_Device_Init(0);
#endif
  TinyUSBDevice.setID(0xCAFE, 0x4321);
  TinyUSBDevice.setManufacturerDescriptor("MicroTester Team");
  TinyUSBDevice.setProductDescriptor("MicroTester Board");

  SerialTinyUSB.begin(115200);

  // Fill benchmark buffer with pattern
  for (int i = 0; i < 2048; i++) {
    benchBuffer[i] = i & 0xFF;
  }

  // Configure WebUSB
  usb_web.setLineStateCallback(line_state_callback);
  usb_web.begin();

  adc_sampler_init();
  pwm_gen_init();
  logic_analyzer_init();
  comp_tester_init();
}

void loop() {
#if defined(ARDUINO_ARCH_STM32)
  TinyUSB_Device_Task();
  TinyUSB_Device_FlushCDC();
#endif

  // 1. Check for incoming WebUSB commands
  if (usb_web.available() >= 2) {
    uint8_t cmd = usb_web.read();
    uint8_t len = usb_web.read();

    uint8_t payload[64];
    uint8_t bytesRead = 0;

    while (bytesRead < len && usb_web.available()) {
      payload[bytesRead++] = usb_web.read();
    }

    if (cmd == CMD_VOLT_START && len >= 2) {
      AdcConfig cfg;
      cfg.pin = payload[0];
      cfg.oversample = payload[1];
      cfg.isOscilloscope = false;
      oscMode = false;
      adc_sampler_start(cfg);
    }
    else if (cmd == CMD_VOLT_STOP) {
      adc_sampler_stop();
      oscMode = false;
    }
    else if (cmd == CMD_OSC_START && len >= 10) {
      AdcConfig cfg;
      cfg.pin = payload[0];
      cfg.oversample = payload[1];
      cfg.rateKHz = (uint32_t)payload[2] | ((uint32_t)payload[3] << 8);
      cfg.trigEdge = payload[4];
      cfg.trigLevel = (uint16_t)payload[5] | ((uint16_t)payload[6] << 8);
      cfg.trigMode = payload[7];
      cfg.reqSamples = (uint16_t)payload[8] | ((uint16_t)payload[9] << 8);
      cfg.isOscilloscope = true;
      
      oscMode = true;
      adc_sampler_stop();
      adc_ets_stop();
      
      adc_sampler_start(cfg);
    }
    else if (cmd == CMD_OSC_STOP) {
      adc_sampler_stop();
      adc_ets_stop();
      oscMode = false;
    }
    else if (cmd == CMD_SIG_START && len >= 7) {
      PwmConfig cfg;
      cfg.pinIndex = payload[0];
      cfg.waveform = payload[1];
      cfg.frequency = (uint32_t)payload[2] | 
                      ((uint32_t)payload[3] << 8) | 
                      ((uint32_t)payload[4] << 16) | 
                      ((uint32_t)payload[5] << 24);
      cfg.dutyCycle = payload[6];
      pwm_gen_start(cfg);
    }
    else if (cmd == CMD_SIG_STOP) {
      pwm_gen_stop();
    }
    else if (cmd == CMD_LOGIC_START && len >= 4) {
      LogicConfig cfg;
      uint32_t rateKHz = payload[0] | ((uint32_t)payload[1] << 8);
      if (rateKHz == 0) rateKHz = 100;
      cfg.sampleRateHz = rateKHz * 1000;
      cfg.trigChannel  = payload[2];
      cfg.trigEdge     = payload[3];
      cfg.sampleCount  = (len >= 6) ? (payload[4] | ((uint16_t)payload[5] << 8)) : LOGIC_BUFFER_SIZE;
      logic_analyzer_start(cfg);
    }
    else if (cmd == CMD_LOGIC_STOP) {
      logic_analyzer_stop();
    }
    else if (cmd == CMD_BENCHMARK_START) {
      benchmarkMode = true;
      adc_sampler_stop();
    }
    else if (cmd == CMD_BENCHMARK_STOP) {
      benchmarkMode = false;
    }
    else if (cmd == CMD_COMP_TEST) {
      uint8_t mode = 0;
      if (len >= 1) mode = payload[0];
      comp_tester_start(mode);
    }
    else if (cmd == CMD_COMP_STOP) {
      comp_tester_stop();
    }
  }

  // Benchmark mode: write 2048 bytes then flush once
  if (benchmarkMode) {
    if (usb_web.connected()) {
      usb_web.write(benchBuffer, 2048);
      usb_web.flush();
    }
    return;
  }

  // 2. Run Sampler & Logic Loops
  adc_ets_loop();
  logic_analyzer_loop();
  comp_tester_loop();

  // 3. Check if ADC buffer is ready to transmit (ETS Mode)
  if (adc_ets_is_buffer_ready()) {
    if (usb_web.connected()) {
      uint16_t sampleCount = ADC_ETS_BUFFER_SIZE;
      uint16_t payloadSize = sampleCount * 2;
      uint8_t header[3];
      header[0] = PKT_OSCILLOSCOPE_DATA;
      header[1] = payloadSize & 0xFF;
      header[2] = (payloadSize >> 8) & 0xFF;

      uint16_t* buffer = adc_ets_get_buffer();

      if (robust_write(header, 3) && robust_write((uint8_t*)buffer, payloadSize)) {
        usb_web.flush();
      }
      adc_ets_clear_flag();
    } else {
      adc_ets_clear_flag();
    }
  }

  // 3.5 Check if ADC sampler has data available
  if (oscMode) {
    uint8_t* framePtr;
    uint16_t frameLen;
    if (adc_osc_process_frame(&framePtr, &frameLen)) {
      if (usb_web.connected()) {
        uint8_t header[3];
        header[0] = PKT_OSCILLOSCOPE_DATA;
        header[1] = frameLen & 0xFF;
        header[2] = (frameLen >> 8) & 0xFF;

        if (robust_write(header, 3) && robust_write(framePtr, frameLen)) {
          usb_web.flush();
        }
      }
    }
  } else {
    uint8_t* streamPtr;
    int streamCount = adc_sampler_get_available(&streamPtr);
    if (streamCount > 0) {
      if (usb_web.connected()) {
        uint16_t payloadSize = streamCount; 
        uint8_t header[3];
        header[0] = PKT_VOLTMETER_DATA;
        header[1] = payloadSize & 0xFF;
        header[2] = (payloadSize >> 8) & 0xFF;

        if (robust_write(header, 3) && robust_write(streamPtr, payloadSize)) {
          usb_web.flush();
        }
      }
      adc_sampler_consume(streamCount);
    }
  }

  // 4. Check if Logic Analyzer buffer is ready to transmit
  if (logic_analyzer_is_buffer_ready()) {
    if (usb_web.connected()) {
      uint16_t sampleCount = logic_analyzer_get_buffer_size();
      uint8_t packet[3 + LOGIC_BUFFER_SIZE];
      packet[0] = PKT_LOGIC_DATA;
      packet[1] = sampleCount & 0xFF;
      packet[2] = (sampleCount >> 8) & 0xFF;
      memcpy(&packet[3], logic_analyzer_get_buffer(), sampleCount);

      if (robust_write(packet, 3 + sampleCount)) {
        usb_web.flush();
      }
      logic_analyzer_clear_flag();
    } else {
      logic_analyzer_clear_flag();
    }
  }

  // 5. Check if Component Tester is done
  if (comp_tester_is_done()) {
    if (usb_web.connected()) {
      CompResult result = comp_tester_get_result();
      uint8_t packet[19];
      packet[0] = PKT_COMP_RESULT;
      packet[1] = 16;
      packet[2] = 0;
      memcpy(&packet[3], &result, 16);
      usb_web.write(packet, 19);
      usb_web.flush();
    } else {
      comp_tester_get_result(); // clear flag
    }
  }
}

void line_state_callback(bool connected) {
  if (!connected) {
    adc_sampler_stop();
    adc_ets_stop();
    pwm_gen_stop();
    logic_analyzer_stop();
    comp_tester_stop();
    benchmarkMode = false;
  }
}
