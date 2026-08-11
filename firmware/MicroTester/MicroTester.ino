#include "Adafruit_TinyUSB.h"
#include "protocol.h"
#include "adc_sampler.h"
#include "pwm_gen.h"
#include "comp_tester.h"

bool oscMode = false; // true = oscilloscope, false = voltmeter

// WebUSB object
Adafruit_USBD_WebUSB usb_web;

// Forward declaration
void line_state_callback(bool connected);

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

  // Configure WebUSB
  usb_web.setLineStateCallback(line_state_callback);
  usb_web.begin();

  adc_sampler_init();
  pwm_gen_init();
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
      cfg.enableBias = (len >= 3) ? (payload[2] != 0) : false;
      oscMode = false;
      adc_sampler_start(cfg);
    }
    else if (cmd == CMD_VOLT_STOP) {
      adc_sampler_stop();
      oscMode = false;
    }
    else if (cmd == CMD_VOLT_SET_BIAS && len >= 1) { // CMD_VOLT_SET_BIAS
      adc_sampler_set_bias(payload[0] != 0);
    }
    else if (cmd == CMD_GET_VREF) {
      adc_sampler_stop();
      uint32_t sum = adc_sampler_measure_vrefint_sum4096();
      
      uint8_t packet[7];
      packet[0] = PKT_VREF_DATA;
      packet[1] = 4; // len low
      packet[2] = 0; // len hi
      packet[3] = sum & 0xFF;
      packet[4] = (sum >> 8) & 0xFF;
      packet[5] = (sum >> 16) & 0xFF;
      packet[6] = (sum >> 24) & 0xFF;
      usb_web.write(packet, 7);
      usb_web.flush();
    }
    else if (cmd == CMD_OSC_START && len >= 10) {
      AdcConfig cfg;
      cfg.pinMask = payload[0];               // New: bitmask of active channels
      cfg.oversample = payload[1];
      cfg.rateKHz = (uint32_t)payload[2] | ((uint32_t)payload[3] << 8);
      cfg.trigEdge = payload[4];
      cfg.trigLevel = (uint16_t)payload[5] | ((uint16_t)payload[6] << 8);
      cfg.trigMode = payload[7];
      cfg.reqSamples = (uint16_t)payload[8] | ((uint16_t)payload[9] << 8);
      cfg.isOscilloscope = true;
      cfg.enableBias = (len >= 11) ? (payload[10] != 0) : true;
      cfg.bitness12 = (len >= 12) ? (payload[11] != 0) : false;
      cfg.sessionId = (len >= 13) ? payload[12] : 0;
      // Trigger channel (for single mode, same as pin; for multi, first set bit)
      uint8_t pin = 0;
      for (uint8_t i = 0; i < 4; i++) {
        if (cfg.pinMask & (1 << i)) { pin = i; break; }
      }
      cfg.pin = (len >= 14) ? payload[13] : pin;

      oscMode = true;
      adc_sampler_stop();
      adc_sampler_start(cfg);
    }
    else if (cmd == CMD_OSC_STOP) {
      adc_sampler_stop();
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
    else if (cmd == CMD_COMP_TEST) {
      adc_sampler_stop();
      oscMode = false;
      uint8_t mode = 0;
      if (len >= 1) mode = payload[0];
      comp_tester_start(mode);
    }
    else if (cmd == CMD_COMP_STOP) {
      comp_tester_stop();
    }
    else if (cmd == CMD_COMP_SET_CAL && len >= 20) {
      uint16_t vdda_mv = (uint16_t)payload[0] | ((uint16_t)payload[1] << 8);
      uint16_t rl[3];
      rl[0] = (uint16_t)payload[2] | ((uint16_t)payload[3] << 8);
      rl[1] = (uint16_t)payload[4] | ((uint16_t)payload[5] << 8);
      rl[2] = (uint16_t)payload[6] | ((uint16_t)payload[7] << 8);
      uint32_t rh[3];
      rh[0] = (uint32_t)payload[8] | ((uint32_t)payload[9] << 8) | ((uint32_t)payload[10] << 16) | ((uint32_t)payload[11] << 24);
      rh[1] = (uint32_t)payload[12] | ((uint32_t)payload[13] << 8) | ((uint32_t)payload[14] << 16) | ((uint32_t)payload[15] << 24);
      rh[2] = (uint32_t)payload[16] | ((uint32_t)payload[17] << 8) | ((uint32_t)payload[18] << 16) | ((uint32_t)payload[19] << 24);
      comp_tester_set_cal(vdda_mv, rl, rh);
    }
  }

  // 2. Run Sampler Loops
  adc_sampler_loop();
  comp_tester_loop();

  // 3.5 Check if ADC sampler has data available
  if (oscMode) {
    uint8_t* framePtr;
    uint16_t frameLen;
    if (adc_osc_process_frame(&framePtr, &frameLen)) {
      if (usb_web.connected()) {
        // Frame payload layout: [sessionId][chMask][data...]
        // chMask lets host know which channels are present (0 when single-chan ETS).
        uint8_t chMask = adc_sampler_get_channel_mask();
        uint16_t totalLen = frameLen + 2;
        uint8_t header[3];
        header[0] = PKT_OSCILLOSCOPE_DATA;
        header[1] = totalLen & 0xFF;
        header[2] = (totalLen >> 8) & 0xFF;
        uint8_t meta[2];
        meta[0] = adc_sampler_get_session_id();
        meta[1] = chMask;

        if (robust_write(header, 3) && robust_write(meta, 2) && robust_write(framePtr, frameLen)) {
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


  // 5. Check if Component Tester is done
  if (comp_tester_is_done()) {
    if (usb_web.connected()) {
      CompResult result = comp_tester_get_result();
      uint8_t packet[23];
      packet[0] = PKT_COMP_RESULT;
      packet[1] = sizeof(CompResult);
      packet[2] = 0;
      memcpy(&packet[3], &result, sizeof(CompResult));
      usb_web.write(packet, 3 + sizeof(CompResult));
      usb_web.flush();
    } else {
      comp_tester_get_result(); // clear flag
    }
  }
}

void line_state_callback(bool connected) {
  if (!connected) {
    adc_sampler_stop();
    pwm_gen_stop();
    comp_tester_stop();
  }
}
