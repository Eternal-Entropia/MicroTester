#include "pwm_gen.h"

#if defined(ARDUINO_ARCH_STM32)
#include "HardwareTimer.h"
static HardwareTimer *MyTim = NULL;
#endif

static bool isRunning = false;
static PwmConfig currentConfig;

// Hardware PWM Pin Mapping for STM32 and Arduino
// STM32: PA8 (TIM1_CH1), PA9 (TIM1_CH2), PA10 (TIM1_CH3), PB0 (TIM3_CH3), PB1 (TIM3_CH4), PB6 (TIM4_CH1), PB7 (TIM4_CH2), PB8 (TIM4_CH3), PA0 (TIM2_CH1), PB3 (TIM2_CH2), PB9 (TIM4_CH4)
#if defined(ARDUINO_ARCH_STM32)
static const uint32_t PIN_MAP[] = { PA8, PA9, PA10, PB0, PB1, PB6, PB7, PB8, PA0, PB3, PB9 };
#else
static const uint8_t PIN_MAP[] = { 9, 10, 11, 3, 5, 6 };
#endif
static const uint8_t PIN_MAP_SIZE = sizeof(PIN_MAP) / sizeof(PIN_MAP[0]);

void pwm_gen_init() {
    isRunning = false;
}

void pwm_gen_start(PwmConfig cfg) {
    if (cfg.pinIndex >= PIN_MAP_SIZE) cfg.pinIndex = 0;
    if (cfg.frequency == 0) cfg.frequency = 1000;
    if (cfg.frequency > 42000000UL) cfg.frequency = 42000000UL; // Max 42 MHz (F_TIM / 2)
    if (cfg.dutyCycle > 100) cfg.dutyCycle = 100;

    uint32_t pin = PIN_MAP[cfg.pinIndex];
    uint8_t effectiveDuty = (cfg.waveform == 0) ? 50 : cfg.dutyCycle;

    // Fast-path for dynamic frequency/duty updates (avoids glitching and timer restarts)
    if (isRunning && currentConfig.pinIndex == cfg.pinIndex && currentConfig.waveform == cfg.waveform && cfg.waveform != 2) {
#if defined(ARDUINO_ARCH_STM32)
        if (MyTim != NULL) {
            uint32_t channel = STM_PIN_CHANNEL(pinmap_function(digitalPinToPinName(pin), PinMap_PWM));
            if (currentConfig.frequency != cfg.frequency) {
                MyTim->setOverflow(cfg.frequency, HERTZ_FORMAT);
            }
            uint32_t arr = MyTim->getOverflow();
            uint32_t compare = (cfg.waveform == 0) ? ((arr + 1) / 2) : ((arr + 1) * effectiveDuty / 100);
            MyTim->setCaptureCompare(channel, compare, TICK_COMPARE_FORMAT);
        } else {
            if (currentConfig.frequency != cfg.frequency && cfg.waveform == 0) tone(pin, cfg.frequency);
            if (cfg.waveform != 0) analogWrite(pin, (uint32_t)effectiveDuty * 255 / 100);
        }
#else
        if (currentConfig.frequency != cfg.frequency && cfg.waveform == 0) tone(pin, cfg.frequency);
        if (cfg.waveform != 0) analogWrite(pin, (uint32_t)effectiveDuty * 255 / 100);
#endif
        currentConfig = cfg;
        return;
    }

    pwm_gen_stop(); // Reset active timer/pin state if pin or waveform changed

    pinMode(pin, OUTPUT);

#if defined(ARDUINO_ARCH_STM32)
    // Set GPIO OSPEEDR to Very High Speed for crisp pulse edges at MHz frequencies
    GPIO_TypeDef *port = get_GPIO_Port(STM_PORT(digitalPinToPinName(pin)));
    uint32_t pinNum = STM_PIN(digitalPinToPinName(pin));
    if (port) {
        port->OSPEEDR |= (3UL << (pinNum * 2));
    }
#endif

    if (cfg.waveform == 2) {
        // DC Waveform: Constant HIGH output (3.3V)
        digitalWrite(pin, HIGH);
    } else {
#if defined(ARDUINO_ARCH_STM32)
        TIM_TypeDef *Instance = (TIM_TypeDef *)pinmap_peripheral(digitalPinToPinName(pin), PinMap_PWM);
        if (Instance != NULL) {
            uint32_t channel = STM_PIN_CHANNEL(pinmap_function(digitalPinToPinName(pin), PinMap_PWM));
            MyTim = new HardwareTimer(Instance);
            MyTim->setMode(channel, TIMER_OUTPUT_COMPARE_PWM1, pin);
            MyTim->setOverflow(cfg.frequency, HERTZ_FORMAT);
            uint32_t arr = MyTim->getOverflow();
            uint32_t compare = (cfg.waveform == 0) ? ((arr + 1) / 2) : ((arr + 1) * effectiveDuty / 100);
            MyTim->setCaptureCompare(channel, compare, TICK_COMPARE_FORMAT);
            MyTim->resume();
        } else {
            if (cfg.waveform == 0) {
                tone(pin, cfg.frequency);
            } else {
                uint32_t val = (uint32_t)effectiveDuty * 255 / 100;
                analogWrite(pin, val);
            }
        }
#else
        if (cfg.waveform == 0) {
            tone(pin, cfg.frequency);
        } else {
            uint32_t val = (uint32_t)effectiveDuty * 255 / 100;
            analogWrite(pin, val);
        }
#endif
    }

    currentConfig = cfg;
    isRunning = true;
}

void pwm_gen_stop() {
#if defined(ARDUINO_ARCH_STM32)
    if (MyTim != NULL) {
        MyTim->pause();
        delete MyTim;
        MyTim = NULL;
    }
#endif

    if (isRunning && currentConfig.pinIndex < PIN_MAP_SIZE) {
        uint32_t pin = PIN_MAP[currentConfig.pinIndex];
        noTone(pin);
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
    }

    isRunning = false;
}


