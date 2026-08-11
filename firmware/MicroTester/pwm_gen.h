#ifndef PWM_GEN_H
#define PWM_GEN_H

#include <Arduino.h>

struct PwmConfig {
    uint8_t pinIndex;     // Pin index (0: PA8, 1: PA9, 2: PA10, 3: PB0, 4: PB1, 5: PB6, 6: PB7, 7: PB8, 8: PA0, 9: PB3, 10: PB9)
    uint8_t waveform;     // 0: Square (Meander 50%), 1: PWM (variable duty), 2: DC (Constant HIGH)
    uint32_t frequency;   // Frequency in Hz (1..42000000)
    uint8_t dutyCycle;    // Duty cycle in percent (0..100)
};

void pwm_gen_init();
void pwm_gen_start(PwmConfig cfg);
void pwm_gen_stop();
bool pwm_gen_is_running();
PwmConfig pwm_gen_get_config();

#endif // PWM_GEN_H
