#include "pwm_gen.h"

#if defined(ARDUINO_ARCH_STM32)
#include "HardwareTimer.h"
static HardwareTimer *MyTim = NULL;
#endif

static bool isRunning = false;
static PwmConfig currentConfig;

// Hardware PWM Pin Mapping for STM32 and Arduino
// STM32: PA8 (TIM1_CH1), PA9 (TIM1_CH2), PA10 (TIM1_CH3), PB0 (TIM3_CH3), PB1 (TIM3_CH4), PB6 (TIM4_CH1), PB7 (TIM4_CH2), PB8 (TIM4_CH3)
#if defined(ARDUINO_ARCH_STM32)
static const uint32_t PIN_MAP[] = { PA8, PA9, PA10, PB0, PB1, PB6, PB7, PB8 };
#else
static const uint8_t PIN_MAP[] = { 9, 10, 11, 3, 5, 6 };
#endif
static const uint8_t PIN_MAP_SIZE = sizeof(PIN_MAP) / sizeof(PIN_MAP[0]);

void pwm_gen_init() {
    isRunning = false;
}

void pwm_gen_start(PwmConfig cfg) {
    pwm_gen_stop(); // Reset active timer/pin state first

    if (cfg.pinIndex >= PIN_MAP_SIZE) cfg.pinIndex = 0;
    if (cfg.frequency == 0) cfg.frequency = 1000;
    if (cfg.dutyCycle > 100) cfg.dutyCycle = 100;

    uint32_t pin = PIN_MAP[cfg.pinIndex];
    pinMode(pin, OUTPUT);

    if (cfg.waveform == 2) {
        // DC Waveform: Constant HIGH output (3.3V)
        digitalWrite(pin, HIGH);
    } else {
        // For square waveform, force duty cycle to 50%
        uint8_t effectiveDuty = (cfg.waveform == 0) ? 50 : cfg.dutyCycle;

#if defined(ARDUINO_ARCH_STM32)
        TIM_TypeDef *Instance = (TIM_TypeDef *)pinmap_peripheral(digitalPinToPinName(pin), PinMap_PWM);
        if (Instance != NULL) {
            uint32_t channel = STM_PIN_CHANNEL(pinmap_function(digitalPinToPinName(pin), PinMap_PWM));
            MyTim = new HardwareTimer(Instance);
            MyTim->setPWM(channel, pin, cfg.frequency, effectiveDuty);
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
    if (!isRunning) return;

    uint32_t pinIndex = (currentConfig.pinIndex < PIN_MAP_SIZE) ? currentConfig.pinIndex : 0;
    uint32_t pin = PIN_MAP[pinIndex];

#if defined(ARDUINO_ARCH_STM32)
    if (MyTim != NULL) {
        MyTim->pause();
        delete MyTim;
        MyTim = NULL;
    }
#endif

    noTone(pin);
    digitalWrite(pin, LOW);

    isRunning = false;
}

bool pwm_gen_is_running() {
    return isRunning;
}

PwmConfig pwm_gen_get_config() {
    return currentConfig;
}
