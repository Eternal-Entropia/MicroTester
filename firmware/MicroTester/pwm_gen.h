#ifndef PWM_GEN_H
#define PWM_GEN_H

#include <Arduino.h>

struct PwmConfig {
    uint8_t pinIndex;     // Pin index (0: PB12, 1: PB13, 2: PB14, 3: PB15, 4: PA8, 5: PA9)
    uint8_t waveform;     // 0: Square (Meander 50%), 1: PWM (variable duty), 2: DC (Constant HIGH)
    uint32_t frequency;   // Frequency in Hz (1..10000000)
    uint8_t dutyCycle;    // Duty cycle in percent (0..100)
};

void pwm_gen_init();
void pwm_gen_start(PwmConfig cfg);
void pwm_gen_stop();
bool pwm_gen_is_running();
PwmConfig pwm_gen_get_config();

#endif // PWM_GEN_H
