#include "comp_tester.h"
#include <math.h>
#include "adc_sampler.h"
#include <Adafruit_TinyUSB.h>

static float vdda_mv = 3300.0f;
static uint16_t g_RL[3] = {6800, 6800, 6800};       // in 0.1 ohm units
static uint32_t g_RH[3] = {470000, 470000, 470000}; // in 1 ohm units
static uint32_t g_comp_oversample = 256;            // ADC averaging (64..65536), set from UI
static uint16_t g_esr_zero_x100 = 0;                // Loop resistance (switches + leads) in 0.01 ohm units

void comp_tester_set_cal(uint16_t vdda, const uint16_t rl[3], const uint32_t rh[3], uint16_t esr_zero_x100) {
    if (vdda >= 2500 && vdda <= 4000) vdda_mv = (float)vdda;
    for (int i = 0; i < 3; i++) {
        if (rl && rl[i] >= 3000 && rl[i] <= 10000) g_RL[i] = rl[i];
        if (rh && rh[i] >= 100000 && rh[i] <= 1000000) g_RH[i] = rh[i];
    }
    g_esr_zero_x100 = esr_zero_x100;
}

#define P1_ADC PA7
#define P1_RL  PB10
#define P1_RH  PB1

#define P2_ADC PA6
#define P2_RL  PB12
#define P2_RH  PB13

#define P3_ADC PA5
#define P3_RL  PB14
#define P3_RH  PB15

struct ProbeDef {
    uint8_t adc_pin;
    uint8_t rl_pin;
    uint8_t rh_pin;
};

const ProbeDef probes[3] = {
    {P1_ADC, P1_RL, P1_RH},
    {P2_ADC, P2_RL, P2_RH},
    {P3_ADC, P3_RL, P3_RH}
};

enum TesterState {
    STATE_IDLE,
    STATE_DISCHARGE,
    STATE_SCAN,
    STATE_ANALYZE,
    STATE_DONE
};

static TesterState state = STATE_IDLE;
static uint32_t state_timer = 0;
static uint8_t tester_mode = 0;
static uint8_t scan_step = 0;
static bool result_ready = false;
static CompResult final_result;

struct ScanData {
    uint16_t vA_rl, vB_rl, vC_rl;
    uint16_t vA_rh, vB_rh, vC_rh;
    bool is_capacitive;
};

// 6 permutations: {Drive VCC, Drive GND, Hi-Z}
const uint8_t perms[6][3] = {
    {0, 1, 2},
    {0, 2, 1},
    {1, 0, 2},
    {1, 2, 0},
    {2, 0, 1},
    {2, 1, 0}
};

static ScanData scan_results[6];

static void discharge_probes_completely(uint8_t probeA = 0, uint8_t probeB = 1);
static uint32_t measure_hfe(uint8_t c, uint8_t b, uint8_t e, bool is_pnp, uint16_t *out_vbe, uint16_t *out_iceo = NULL);
static bool measure_capacitor(uint8_t probeA, uint8_t probeB, uint16_t* out_vloss = NULL);
static uint16_t measure_esr_1khz(uint8_t probeA, uint8_t probeB, uint32_t c_pf = 0);
static uint16_t measure_rdson(uint8_t g, uint8_t d, uint8_t s, bool is_nch);
static uint16_t measure_vth(uint8_t g, uint8_t d, uint8_t s, bool is_nch);
static bool test_mosfet_channel(uint8_t g, uint8_t d, uint8_t s, bool is_nch, uint16_t* out_vth, uint16_t* out_rds);
static bool measure_inductor(uint8_t pA, uint8_t pB, uint32_t r_dc_ohm100, uint32_t* out_uH, uint32_t* out_freq_hz);

static void set_probe_hiz(uint8_t p) {
    pinMode(probes[p].rl_pin, INPUT);
    pinMode(probes[p].rh_pin, INPUT);
}

static void set_probe_rl_vcc(uint8_t p) {
    pinMode(probes[p].rh_pin, INPUT);
    pinMode(probes[p].rl_pin, OUTPUT);
    digitalWrite(probes[p].rl_pin, HIGH);
}

static void set_probe_rl_gnd(uint8_t p) {
    pinMode(probes[p].rh_pin, INPUT);
    pinMode(probes[p].rl_pin, OUTPUT);
    digitalWrite(probes[p].rl_pin, LOW);
}

static void set_probe_rh_vcc(uint8_t p) {
    pinMode(probes[p].rl_pin, INPUT);
    pinMode(probes[p].rh_pin, OUTPUT);
    digitalWrite(probes[p].rh_pin, HIGH);
}

static void set_probe_rh_gnd(uint8_t p) {
    pinMode(probes[p].rl_pin, INPUT);
    pinMode(probes[p].rh_pin, OUTPUT);
    digitalWrite(probes[p].rh_pin, LOW);
}

static uint16_t read_adc_avg(uint8_t pin) {
    uint32_t sum = 0;
    // Configurable oversampling (128..1024, set from web Settings)
    for (int i = 0; i < g_comp_oversample; i++) {
        sum += analogRead(pin);
    }
    return sum / g_comp_oversample;
}

void comp_tester_init() {
    analogReadResolution(12);
    set_probe_hiz(0);
    set_probe_hiz(1);
    set_probe_hiz(2);
}

void comp_tester_start(uint8_t mode, uint16_t oversample) {
    adc_sampler_stop();
    // 0 = 65536x, else clamp 64..65535
    if (oversample == 0) {
        g_comp_oversample = 65536;
    } else if (oversample < 64) {
        g_comp_oversample = 64;
    } else {
        g_comp_oversample = oversample;
    }
    uint16_t vref_raw = adc_sampler_measure_vrefint();
    if (vref_raw > 0) {
        vdda_mv = 1210.0f * 4096.0f / (float)vref_raw;
    }
    
    tester_mode = mode;
    state = STATE_DISCHARGE;
    state_timer = millis();
    result_ready = false;
    scan_step = 0;
    
    // Start discharge
    set_probe_rl_gnd(0);
    set_probe_rl_gnd(1);
    set_probe_rl_gnd(2);
}

void comp_tester_stop() {
    state = STATE_IDLE;
    set_probe_hiz(0);
    set_probe_hiz(1);
    set_probe_hiz(2);
}

bool comp_tester_is_done() {
    return result_ready;
}

CompResult comp_tester_get_result() {
    result_ready = false;
    return final_result;
}

// Targeted HFE measurement for BJTs
static uint32_t measure_hfe(uint8_t c, uint8_t b, uint8_t e, bool is_pnp, uint16_t* out_vbe, uint16_t* out_iceo) {
    // Discharge
    set_probe_rl_gnd(0);
    set_probe_rl_gnd(1);
    set_probe_rl_gnd(2);
    delay(10);
    
    if (!is_pnp) {
        set_probe_rl_vcc(c);
        set_probe_rl_gnd(e);
    } else {
        set_probe_rl_gnd(c);
        set_probe_rl_vcc(e);
    }
    
    // Step 1: Measure Leakage with Base OPEN
    set_probe_hiz(b);
    delay(5);
    
    uint32_t iceo_sum = 0;
    uint32_t t_start = millis();
    uint32_t samples = 0;
    while (millis() - t_start < 20) { // 20ms average for noise reduction
        iceo_sum += analogRead(is_pnp ? probes[c].adc_pin : probes[e].adc_pin);
        samples++;
    }
    uint8_t sensor_probe = is_pnp ? c : e;
    uint16_t v_leak_gnd = (samples > 0) ? (iceo_sum / samples) : read_adc_avg(probes[sensor_probe].adc_pin);
    if (out_iceo) {
        uint32_t rl_sensor = g_RL[sensor_probe] / 10;
        if (rl_sensor == 0) rl_sensor = 680;
        *out_iceo = (v_leak_gnd * (uint32_t)(vdda_mv * 1000) / 4096) / rl_sensor; // uA
    }
    uint16_t v_c_leak = read_adc_avg(probes[c].adc_pin);
    
    // Step 2: Drive Base and measure active parameters
    if (!is_pnp) {
        set_probe_rh_vcc(b);
    } else {
        set_probe_rh_gnd(b);
    }
    delay(5);
    
    uint16_t v_c = read_adc_avg(probes[c].adc_pin);
    uint16_t v_b = read_adc_avg(probes[b].adc_pin);
    uint16_t v_e = read_adc_avg(probes[e].adc_pin);
    
    uint32_t hfe = 0;
    uint32_t rl_c = g_RL[c] / 10;
    if (rl_c == 0) rl_c = 680;
    uint32_t rh_b = g_RH[b];
    if (rh_b == 0) rh_b = 470000;
    
    if (!is_pnp) {
        if (v_b < 4096 && v_c < 4096) {
            uint32_t drop_c = 4096 - v_c;
            uint32_t drop_c_leak = (v_c_leak < 4096) ? (4096 - v_c_leak) : 0;
            uint32_t drop_c_active = (drop_c > drop_c_leak) ? (drop_c - drop_c_leak) : 0;
            uint32_t drop_b = 4096 - v_b;
            if (drop_b > 0) {
                hfe = (uint32_t)(((uint64_t)drop_c_active * rh_b) / ((uint64_t)drop_b * rl_c));
            }
        }
        if (out_vbe) *out_vbe = (v_b > v_e) ? ((uint32_t)(v_b - v_e) * (uint32_t)vdda_mv / 4096) : 0;
    } else {
        // PNP: base is pulled to GND via RH_B, so base current flows OUT of the
        // base and I_B = v_b / RH_B (NOT (VCC - v_b) / RH_B). Using the wrong
        // drop term (~300-400 ticks) instead of v_b (~3700-3900 ticks) overstated
        // hFE by ~10x for germanium BJTs.
        uint32_t ib_ticks = v_b;
        if (ib_ticks > 0) {
            uint32_t v_c_active = (v_c > v_c_leak) ? (v_c - v_c_leak) : 0;
            hfe = (uint32_t)(((uint64_t)v_c_active * rh_b) / ((uint64_t)ib_ticks * rl_c));
        }
        if (out_vbe) *out_vbe = (v_e > v_b) ? ((uint32_t)(v_e - v_b) * (uint32_t)vdda_mv / 4096) : 0;
    }
    
    set_probe_hiz(0);
    set_probe_hiz(1);
    set_probe_hiz(2);
    
    return hfe;
}

static uint16_t measure_rdson(uint8_t g, uint8_t d, uint8_t s, bool is_nch) {
    discharge_probes_completely(g, d);
    
    // Set up Source directly to GND (N-Ch) or VCC (P-Ch) for full 3.3V Vgs drive!
    if (is_nch) {
        set_probe_rl_vcc(d);   // Drain connected to VCC via RL
        set_probe_rl_vcc(g);   // Gate driven hard to VCC (3.3V)
        pinMode(probes[s].adc_pin, OUTPUT);
        digitalWrite(probes[s].adc_pin, LOW); // Direct 0-ohm Source GND drive
    } else {
        set_probe_rl_gnd(d);   // Drain connected to GND via RL
        set_probe_rl_gnd(g);   // Gate driven hard to GND (0V)
        pinMode(probes[s].adc_pin, OUTPUT);
        digitalWrite(probes[s].adc_pin, HIGH); // Direct 0-ohm Source VCC drive
    }
    delay(5);
    
    uint16_t vd = read_adc_avg(probes[d].adc_pin);
    uint16_t vs = read_adc_avg(probes[s].adc_pin);
    
    // Release pins safely
    set_probe_hiz(g); set_probe_hiz(d); set_probe_hiz(s);
    
    uint32_t rl_ohm = g_RL[d] / 10;
    if (rl_ohm == 0) rl_ohm = 680;
    
    uint32_t rds_mohm = 0;
    if (is_nch) {
        uint32_t drop_rl = (4095 > vd) ? (4095 - vd) : 1;
        if (drop_rl < 15) return 0xFFFF; // Channel did not open
        uint32_t vds_adc = (vd > vs) ? (vd - vs) : 0;
        rds_mohm = (uint32_t)((vds_adc * rl_ohm * 1000UL) / drop_rl);
    } else {
        uint32_t drop_rl = vd;
        if (drop_rl < 15) return 0xFFFF; // Channel did not open
        uint32_t vds_adc = (vs > vd) ? (vs - vd) : 0;
        rds_mohm = (uint32_t)((vds_adc * rl_ohm * 1000UL) / drop_rl);
    }
    
    if (rds_mohm >= 60000) return 0xFFFF;
    return (uint16_t)rds_mohm;
}

static uint16_t measure_vth(uint8_t g, uint8_t d, uint8_t s, bool is_nch) {
    discharge_probes_completely(g, s);
    
    if (is_nch) {
        set_probe_rl_vcc(d);
        set_probe_rl_gnd(s);
        set_probe_rh_vcc(g);    // Gate charged through RH 470k
    } else {
        set_probe_rl_gnd(d);
        set_probe_rl_vcc(s);
        set_probe_rh_gnd(g);
    }
    
    uint32_t t0 = millis();
    uint16_t vth_ticks = 0;
    
    while (millis() - t0 < 30) {
        uint16_t vd = analogRead(probes[d].adc_pin);
        bool threshold_crossed;
        if (is_nch) threshold_crossed = (vd < 3000);  // Conduction opens channel
        else        threshold_crossed = (vd > 1000);
        if (threshold_crossed) {
            uint16_t vg = analogRead(probes[g].adc_pin);
            vth_ticks = vg;
            break;
        }
        delayMicroseconds(100);
    }
    
    discharge_probes_completely(g, s);
    if (vth_ticks == 0) return 0;
    
    uint16_t mv = (uint16_t)(((uint32_t)vth_ticks * (uint32_t)vdda_mv) / 4096);
    if (is_nch) return mv;
    return (vdda_mv > mv) ? (uint16_t)(vdda_mv - mv) : 0;
}

static bool test_mosfet_channel(uint8_t g, uint8_t d, uint8_t s, bool is_nch,
                                uint16_t* out_vth, uint16_t* out_rds) {
    discharge_probes_completely(g, s);
    
    // Step A: Check channel is OFF at Vgs = 0
    if (is_nch) {
        set_probe_rl_vcc(d);
        set_probe_rl_gnd(s);
        set_probe_rl_gnd(g);    // Vgs = 0
    } else {
        set_probe_rl_gnd(d);
        set_probe_rl_vcc(s);
        set_probe_rl_vcc(g);
    }
    delay(5);
    uint16_t v_d_zero = read_adc_avg(probes[d].adc_pin);
    
    // Step B: Turn ON channel via Gate drive (using RL for strong drive on power MOSFETs)
    if (is_nch) set_probe_rl_vcc(g);  // Gate to VCC
    else        set_probe_rl_gnd(g);  // Gate to GND
    delay(10);
    
    uint16_t v_d_open = read_adc_avg(probes[d].adc_pin);
    set_probe_hiz(g);
    
    bool opened_by_gate;
    if (is_nch) opened_by_gate = (v_d_zero > 2200) && (v_d_open < v_d_zero - 500);
    else        opened_by_gate = (v_d_zero < 1800) && (v_d_open > v_d_zero + 500);
    
    if (!opened_by_gate) return false;
    
    *out_rds = measure_rdson(g, d, s, is_nch);
    *out_vth = measure_vth(g, d, s, is_nch);
    
    return true;
}

static bool measure_inductor(uint8_t pA, uint8_t pB, uint32_t r_dc_ohm100, uint32_t* out_uH, uint32_t* out_freq_hz) {
    if (pA >= 3 || pB >= 3 || pA == pB) return false;
    
    // Inductors, relay coils, and RF chokes can have DC resistance up to ~1200 ohms
    float r_dc = (float)r_dc_ohm100 / 100.0f;
    if (r_dc > 1200.0f) return false;
    
    set_probe_hiz(0); set_probe_hiz(1); set_probe_hiz(2);
    
    float r_senseA = (float)g_RL[pA] / 10.0f;
    if (r_senseA < 100.0f) r_senseA = 680.0f;
    float r_senseB = (float)g_RL[pB] / 10.0f;
    if (r_senseB < 100.0f) r_senseB = 680.0f;
    
    uint8_t adcPinA = probes[pA].adc_pin;
    uint8_t adcPinB = probes[pB].adc_pin;
    
    float measuredL_uH = 0.0f;
    uint32_t bestFreq = 1000;
    bool foundInductor = false;
    
    #if defined(ARDUINO_ARCH_STM32)
    // Enable DWT cycle counter
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
    
    uint8_t pinA_num = (pA == 0 ? 7 : (pA == 1 ? 6 : 5));
    uint8_t pinB_num = (pB == 0 ? 7 : (pB == 1 ? 6 : 5));
    
    uint32_t setMaskA   = (1UL << pinA_num);
    uint32_t resetMaskA = (1UL << (pinA_num + 16));
    uint32_t readMaskB  = (1UL << pinB_num);
    
    set_probe_rl_gnd(pB); // Probe B grounded via 680 ohm RL
    pinMode(adcPinB, INPUT);
    pinMode(adcPinA, OUTPUT);
    GPIOA->BSRR = resetMaskA;
    delayMicroseconds(200);
    
    uint32_t cpu_freq = SystemCoreClock;
    if (cpu_freq < 10000000) cpu_freq = 84000000; // Fallback sanity check
    
    // Check if line is initially LOW
    if ((GPIOA->IDR & readMaskB) == 0) {
        uint32_t total_cycles = 0;
        int numTests = 64;
        int validTests = 0;
        
        // Ultra-fast 2-cycle pulse measurement with parasitic capacitance (Cp) spike rejection
        auto measure_pulse = [&](uint32_t max_cyc) -> uint32_t {
            uint32_t t_start = DWT->CYCCNT;
            GPIOA->BSRR = setMaskA; // Atomic 1-cycle HIGH write
            
            // Ultra-tight 2-cycle polling loop (highest sub-nanosecond resolution)
            while ((GPIOA->IDR & readMaskB) == 0) {
                if ((DWT->CYCCNT - t_start) > max_cyc) break;
            }
            uint32_t elapsed = DWT->CYCCNT - t_start;
            
            // If transition occurred very quickly (< 300 cycles / ~3.5 us),
            // check if this is a transient capacitive feedthrough spike (Cp)
            // from a medium/large multi-layer coil that will collapse back to 0:
            if (elapsed < 300 && elapsed < max_cyc) {
                uint32_t t_chk = DWT->CYCCNT;
                while ((DWT->CYCCNT - t_chk) < 180) {
                    if ((GPIOA->IDR & readMaskB) == 0) {
                        // Pin dropped back to 0! It was a capacitive spike from a large coil.
                        // Now wait in the tight loop for the real inductive current rise:
                        while ((GPIOA->IDR & readMaskB) == 0) {
                            if ((DWT->CYCCNT - t_start) > max_cyc) break;
                        }
                        elapsed = DWT->CYCCNT - t_start;
                        break;
                    }
                }
            }
            
            GPIOA->BSRR = resetMaskA; // Reset line to LOW
            return elapsed;
        };
        
        // Single trial to estimate magnitude (up to 100ms timeout)
        uint32_t timeout_cyc = cpu_freq / 10; // 100 ms timeout for initial probe
        uint32_t first_cyc = measure_pulse(timeout_cyc);
        
        // Dynamic discharge time: complete 5*tau discharge (tau ~= first_cyc / 0.7)
        uint32_t us_per_cyc_scaled = (cpu_freq / 1000000UL);
        if (us_per_cyc_scaled == 0) us_per_cyc_scaled = 84;
        uint32_t discharge_us = 40 + (uint32_t)(((uint64_t)first_cyc * 8ULL) / us_per_cyc_scaled);
        if (discharge_us > 25000) discharge_us = 25000; // Cap max discharge at 25 ms
        
        uint32_t test_timeout = (first_cyc * 3) + (cpu_freq / 500); // At least 2ms
        if (test_timeout > (cpu_freq / 20)) test_timeout = cpu_freq / 20; // Cap max per test at 50 ms
        
        if (first_cyc >= timeout_cyc) {
            // Line never triggered (Rdc too high or open)
            numTests = 0;
        } else if (first_cyc > 40000) {
            // Very large coil (> 500 mH)
            numTests = 4;
        } else if (first_cyc > 8000) {
            // Large coil (100 mH .. 500 mH)
            numTests = 8;
        } else if (first_cyc > 1000) {
            // Medium coil (10 mH .. 100 mH, e.g. 23.2 mH ~ 1900 cyc)
            numTests = 16;
        } else if (first_cyc > 100) {
            // Small coil (1 mH .. 10 mH)
            numTests = 32;
        } else {
            // Micro coil (< 1 mH)
            numTests = 64;
        }
        
        // Ensure complete discharge after the initial estimation pulse
        delayMicroseconds(discharge_us);
        
        for (int test = 0; test < numTests; test++) {
            // Active discharge between tests
            GPIOA->BSRR = resetMaskA;
            delayMicroseconds(discharge_us);
            
            __disable_irq(); // Disable interrupts only during immediate pulse timing
            uint32_t elapsed_cyc = measure_pulse(test_timeout);
            __enable_irq();
            
            if (elapsed_cyc >= 3 && elapsed_cyc < test_timeout) {
                total_cycles += elapsed_cyc;
                validTests++;
            }
        }
        
        if (validTests >= (numTests / 2) && validTests > 0) {
            float avg_cycles = (float)total_cycles / (float)validTests;
            
            // Hardware baseline for the ultra-tight loop: GPIO synchronizer + bus pipeline latency
            // Exactly 16.35 cycles on pure short circuit (0-ohm wire)
            float baseline_cycles = 16.35f + (r_dc / 80.0f);
            float net_cycles = (avg_cycles > baseline_cycles) ? (avg_cycles - baseline_cycles) : 0.0f;
            
            float v_supply = (vdda_mv > 2000.0f) ? (vdda_mv / 1000.0f) : 3.30f;
            float r_fast = 25.0f + r_dc + r_senseB;
            float v_steady = v_supply * (r_senseB / r_fast);
            
            // Input threshold V_IT ~ 0.515 * V_supply (~1.70V at 3.3V, STM32F4 Schmitt trigger VT+)
            float v_it = 0.515f * v_supply;
            float k_thresh = 0.775f;
            if (v_steady > (v_it + 0.05f)) {
                float v_ratio = v_it / v_steady;
                if (v_ratio > 0.95f) v_ratio = 0.95f;
                k_thresh = -logf(1.0f - v_ratio);
                if (k_thresh < 0.1f) k_thresh = 0.775f;
            }
            
            float t_sec = net_cycles / (float)cpu_freq;
            float tau = t_sec / k_thresh;
            float l_fast_uH = tau * r_fast * 1000000.0f;
            
            // Real physical inductors threshold: allow down to 5 uH
            float min_l_uH = 5.0f + (r_dc * 0.15f);
            
            uint32_t candidateFreq = 1000;
            if (l_fast_uH >= 1000000.0f)     candidateFreq = 100;     // >= 1 H: 100 Hz
            else if (l_fast_uH >= 10000.0f)  candidateFreq = 1000;    // 10 mH .. 1 H: 1 kHz
            else if (l_fast_uH >= 100.0f)    candidateFreq = 10000;   // 100 uH .. 10 mH: 10 kHz
            else                             candidateFreq = 100000;  // < 100 uH: 100 kHz

            float q_factor = (r_dc > 0.05f) ? ((2.0f * 3.14159f * candidateFreq * (l_fast_uH * 1e-6f)) / r_dc) : 10.0f;

            // Inductor must have measurable delay, exceed Rdc noise threshold, and have valid Q factor
            if (net_cycles >= 0.5f && l_fast_uH >= min_l_uH && q_factor >= 0.05f) {
                measuredL_uH = l_fast_uH;
                bestFreq = candidateFreq;
                foundInductor = true;
            }
        }
    }
    pinMode(adcPinA, INPUT_ANALOG);
    pinMode(adcPinB, INPUT_ANALOG);
    set_probe_hiz(pA);
    set_probe_hiz(pB);
    #endif
    
    if (foundInductor && measuredL_uH >= 1.0f) {
        if (out_uH) *out_uH = (uint32_t)(measuredL_uH * 1000.0f); // Return in nH (1 uH = 1000 nH)
        if (out_freq_hz) *out_freq_hz = bestFreq;
        return true;
    }
    
    return false;
}

static void analyze_data() {
    memset(&final_result, 0, sizeof(final_result));
    
    // Helper: get voltage at specific probe from scan result
    #define GET_V(scan_idx, probe_idx, is_rh) \
        ((probe_idx == 0) ? (is_rh ? scan_results[scan_idx].vA_rh : scan_results[scan_idx].vA_rl) : \
         (probe_idx == 1) ? (is_rh ? scan_results[scan_idx].vB_rh : scan_results[scan_idx].vB_rl) : \
                            (is_rh ? scan_results[scan_idx].vC_rh : scan_results[scan_idx].vC_rl))
    
    // Check if any probe pair showed capacitive current decay during SCAN
    bool overall_capacitive = false;
    for (int i = 0; i < 6; i++) {
        if (scan_results[i].is_capacitive) {
            overall_capacitive = true;
            break;
        }
    }
    
    // If capacitive decay was detected during scan, skip Resistor & Diode checks!
    if (overall_capacitive) {
        final_result.type = COMP_NONE; // Will be measured by measure_capacitor
        return;
    }
    
    // Check if it's a 3-way short (calibration mode)
    uint16_t diff01 = (GET_V(0, 0, false) > GET_V(0, 1, false)) ? (GET_V(0, 0, false) - GET_V(0, 1, false)) : (GET_V(0, 1, false) - GET_V(0, 0, false));
    uint16_t diff02 = (GET_V(1, 0, false) > GET_V(1, 2, false)) ? (GET_V(1, 0, false) - GET_V(1, 2, false)) : (GET_V(1, 2, false) - GET_V(1, 0, false));
    uint16_t diff12 = (GET_V(3, 1, false) > GET_V(3, 2, false)) ? (GET_V(3, 1, false) - GET_V(3, 2, false)) : (GET_V(3, 2, false) - GET_V(3, 1, false));

    if (GET_V(0, 0, false) > 500 && GET_V(1, 0, false) > 500 && GET_V(3, 1, false) > 500 && 
        diff01 < 15 && diff02 < 15 && diff12 < 15) {
        
        // It's a 3-way short! Fast oversampling calibration (~100 ms total)
        float vV_01_rl = 0, vG_01_rl = 0, vV_02_rl = 0, vG_02_rl = 0, vV_12_rl = 0, vG_12_rl = 0;
        float vV_01_rh = 0, vG_01_rh = 0, vV_02_rh = 0, vG_02_rh = 0;

        for (int step = 0; step < 5; step++) {
            uint8_t pV = (step == 0 || step == 3) ? 0 : ((step == 2) ? 1 : 0);
            uint8_t pG = (step == 0 || step == 3) ? 1 : ((step == 2) ? 2 : 2);
            bool use_rh = (step >= 3);
            
            // 1. Discharge everything to ground
            set_probe_rl_gnd(0); set_probe_rl_gnd(1); set_probe_rl_gnd(2);
            delay(use_rh ? 60 : 20);
            
            // 2. Set HiZ
            set_probe_hiz(0); set_probe_hiz(1); set_probe_hiz(2);
            
            // 3. Apply test voltage
            if (use_rh) {
                set_probe_rh_vcc(pV);
                set_probe_rh_gnd(pG);
            } else {
                set_probe_rl_vcc(pV);
                set_probe_rl_gnd(pG);
            }
            
            // 4. Wait for RC settling (very long for 470k)
            delay(use_rh ? 120 : 25);
            
            // 5. Configurable oversampling with clean static analogRead (64..65536x)
            uint32_t sumV = 0, sumG = 0;
            for (uint32_t i = 0; i < g_comp_oversample; i++) {
                sumV += analogRead(probes[pV].adc_pin);
                sumG += analogRead(probes[pG].adc_pin);
            }

            float valV = (float)sumV / (float)g_comp_oversample;
            float valG = (float)sumG / (float)g_comp_oversample;
            
            if (step == 0) { vV_01_rl = valV; vG_01_rl = valG; }
            else if (step == 1) { vV_02_rl = valV; vG_02_rl = valG; }
            else if (step == 2) { vV_12_rl = valV; vG_12_rl = valG; }
            else if (step == 3) { vV_01_rh = valV; vG_01_rh = valG; }
            else if (step == 4) { vV_02_rh = valV; vG_02_rh = valG; }
        }
        
        // Ensure probes are left safely off
        set_probe_hiz(0); set_probe_hiz(1); set_probe_hiz(2);
        
        float V01 = (vV_01_rl + vG_01_rl) / 2.0f;
        float V02 = (vV_02_rl + vG_02_rl) / 2.0f;
        
        // R_L0 is anchor (680 ohms nominal)
        uint32_t R_L0 = 6800; // in 0.1 ohm units
        uint32_t R_L1 = (uint32_t)((V01 * 6800.0f) / (4096.0f - V01));
        uint32_t R_L2 = (uint32_t)((V02 * 6800.0f) / (4096.0f - V02));
        
        // 470k check
        float VH01 = (vV_01_rh + vG_01_rh) / 2.0f;
        float VH02 = (vV_02_rh + vG_02_rh) / 2.0f;
        
        uint32_t R_H0 = 47000; // in 10 ohm units (470k)
        uint32_t R_H1 = (uint32_t)((VH01 * 47000.0f) / (4096.0f - VH01));
        uint32_t R_H2 = (uint32_t)((VH02 * 47000.0f) / (4096.0f - VH02));
        
        // Measure dynamic 1 kHz ESR zero baseline across the shorted probes (cancels ADC channel DC offset)
        uint16_t saved_zero = g_esr_zero_x100;
        g_esr_zero_x100 = 0;
        uint16_t esr_z01 = measure_esr_1khz(0, 1, 0);
        uint16_t esr_z02 = measure_esr_1khz(0, 2, 0);
        uint16_t esr_z12 = measure_esr_1khz(1, 2, 0);
        uint32_t esr_zero_avg = (esr_z01 + esr_z02 + esr_z12) / 3;
        g_esr_zero_x100 = saved_zero;

        // Wire R offset (in 0.01 ohm units) is purely the physical lead resistance
        uint32_t wire_r100 = esr_zero_avg;

        final_result.type = COMP_SHORT;
        final_result.pinA = 0; final_result.pinB = 1; final_result.pinC = 255; // 255 flags 3-way calib
        final_result.value1 = (R_L0 & 0xFFFF) | ((R_L1 & 0xFFFF) << 16);
        final_result.value2 = (R_L2 & 0xFFFF) | ((wire_r100 & 0xFFFF) << 16);
        final_result.value3 = (R_H1 & 0xFFFF) | ((R_H2 & 0xFFFF) << 16);
        final_result.flags = (uint16_t)(esr_zero_avg & 0xFFFF);
        return;
    }

    // ============ STEP 1: Check for SHORT (< 0.5 Ohm) ============
    for (int i = 0; i < 6; i++) {
        uint8_t pV = perms[i][0]; // VCC probe
        uint8_t pG = perms[i][1]; // GND probe
        uint16_t vV = GET_V(i, pV, false);
        uint16_t vG = GET_V(i, pG, false);
        
        // Find reverse direction permutation (swap pV and pG)
        int rev_i = -1;
        for (int r = 0; r < 6; r++) {
            if (perms[r][0] == pG && perms[r][1] == pV) { rev_i = r; break; }
        }
        uint16_t rev_vV = (rev_i >= 0) ? GET_V(rev_i, pG, false) : 0;
        uint16_t rev_vG = (rev_i >= 0) ? GET_V(rev_i, pV, false) : 0;

        uint32_t diff_fwd = (vV > vG) ? (vV - vG) : (vG - vV);
        uint32_t diff_rev = (rev_vV > rev_vG) ? (rev_vV - rev_vG) : (rev_vG - rev_vV);

        // Real Short Circuit MUST conduct symmetrically in BOTH forward and reverse directions!
        if (vV > 500 && vG > 500 && diff_fwd < 15 && rev_vV > 500 && rev_vG > 500 && diff_rev < 15) {
            uint32_t diff = (diff_fwd + diff_rev) / 2;
            uint32_t rl_gnd = g_RL[pG] / 10;
            if (rl_gnd == 0) rl_gnd = 680;
            uint32_t R100 = (uint32_t)(((uint64_t)rl_gnd * 100ULL * (uint64_t)diff) / (uint64_t)vG);
            
            // Check if this low DC resistance component is an Inductor before declaring Short Circuit!
            uint32_t ind_uH = 0, ind_freq = 0;
            if (measure_inductor(pV, pG, R100, &ind_uH, &ind_freq)) {
                final_result.type = COMP_INDUCTOR;
                final_result.pinA = pV;
                final_result.pinB = pG;
                final_result.pinC = 3 - (pV + pG);
                final_result.value1 = ind_uH;
                final_result.value2 = R100;
                final_result.value3 = ind_freq;
                final_result.flags = 0;
                return;
            }

            final_result.type = COMP_SHORT;
            final_result.pinA = pV;
            final_result.pinB = pG;
            final_result.pinC = 3 - (pV + pG);
            final_result.value1 = R100;
            return;
        }
    }
    
    // ============ STEP 2: Check for OPEN (No component) ============
    bool current_found = false;
    for (int i = 0; i < 6; i++) {
        uint8_t pG = perms[i][1];
        uint16_t vG_rl = GET_V(i, pG, false); // R_low
        uint16_t vG_rh = GET_V(i, pG, true);  // R_high
        
        if (vG_rl > 150 || vG_rh > 250) {
            current_found = true;
            break;
        }
    }
    if (!current_found) {
        final_result.type = COMP_OPEN;
        return;
    }
    
    // ============ STEP 3: RESISTOR DETECTION (Bidirectional conduction) ============
    struct RPair { uint8_t a, b; uint32_t r_fwd, r_rev; bool fwd_ok, rev_ok; };
    RPair rpairs[3] = {
        {0, 1, 0, 0, false, false},
        {0, 2, 0, 0, false, false},
        {1, 2, 0, 0, false, false}
    };
    
    for (int i = 0; i < 6; i++) {
        uint8_t pV = perms[i][0];
        uint8_t pG = perms[i][1];
        uint16_t vV_rl = GET_V(i, pV, false);
        uint16_t vG_rl = GET_V(i, pG, false);
        uint16_t vV_rh = GET_V(i, pV, true);
        uint16_t vG_rh = GET_V(i, pG, true);
        
        uint32_t R100 = 0;
        bool valid_r = false;
        
        if (vG_rl > 20 && vG_rl < 4050 && vV_rl > vG_rl) {
            uint32_t diff = vV_rl - vG_rl;
            uint32_t rl_gnd = g_RL[pG] / 10; // in Ohms
            if (rl_gnd == 0) rl_gnd = 680;
            R100 = (uint32_t)(((uint64_t)rl_gnd * 100ULL * (uint64_t)diff) / (uint64_t)vG_rl);
            valid_r = true;
        } else if (vG_rh > 80 && vG_rh < 4050 && vV_rh > vG_rh) {
            uint32_t diff = vV_rh - vG_rh;
            uint32_t rh_gnd = g_RH[pG]; // in Ohms
            if (rh_gnd == 0) rh_gnd = 470000;
            R100 = (uint32_t)(((uint64_t)rh_gnd * 100ULL * (uint64_t)diff) / (uint64_t)vG_rh);
            valid_r = true;
        }
        
        if (valid_r) {
            for (int p = 0; p < 3; p++) {
                if (rpairs[p].a == pV && rpairs[p].b == pG) {
                    rpairs[p].r_fwd = R100; rpairs[p].fwd_ok = true;
                } else if (rpairs[p].a == pG && rpairs[p].b == pV) {
                    rpairs[p].r_rev = R100; rpairs[p].rev_ok = true;
                }
            }
        }
    }
    
    uint32_t r_vals[3] = {0, 0, 0};
    bool r_valid[3] = {false, false, false};
    int valid_count = 0;

    for (int p = 0; p < 3; p++) {
        // Resistor must conduct in BOTH directions with symmetric resistance (within 35%)
        if (rpairs[p].fwd_ok && rpairs[p].rev_ok) {
            uint32_t r1 = rpairs[p].r_fwd;
            uint32_t r2 = rpairs[p].r_rev;
            uint32_t max_r = (r1 > r2) ? r1 : r2;
            uint32_t diff = (r1 > r2) ? (r1 - r2) : (r2 - r1);
            
            // Prevent 32-bit overflow when multiplying by 100 for large resistances
            if (max_r > 0 && ((uint64_t)diff * 100 / max_r) < 35) {
                r_vals[p] = (r1 + r2) / 2;
                r_valid[p] = true;
                valid_count++;
            }
        }
    }

    if (valid_count == 1) {
        for (int p = 0; p < 3; p++) {
            if (r_valid[p]) {
                uint8_t pA = rpairs[p].a;
                uint8_t pB = rpairs[p].b;
                uint32_t ind_uH = 0, ind_freq = 0;
                if (measure_inductor(pA, pB, r_vals[p], &ind_uH, &ind_freq)) {
                    final_result.type = COMP_INDUCTOR;
                    final_result.pinA = pA;
                    final_result.pinB = pB;
                    final_result.pinC = 3 - (pA + pB);
                    final_result.value1 = ind_uH;
                    final_result.value2 = r_vals[p];
                    final_result.value3 = ind_freq;
                    final_result.flags = 0;
                    return;
                }
                final_result.type = COMP_RESISTOR;
                final_result.pinA = pA;
                final_result.pinB = pB;
                final_result.pinC = 3 - (pA + pB);
                final_result.value1 = r_vals[p];
                final_result.value2 = 0;
                final_result.flags = 1;
                return;
            }
        }
    }
    if (valid_count == 2 || valid_count == 3) {
        // Find the two smallest resistors
        uint8_t min1 = 3, min2 = 3;
        uint32_t min1_val = 0xFFFFFFFF, min2_val = 0xFFFFFFFF;
        
        for (int p = 0; p < 3; p++) {
            if (r_valid[p]) {
                if (r_vals[p] < min1_val) {
                    min2_val = min1_val;
                    min2 = min1;
                    min1_val = r_vals[p];
                    min1 = p;
                } else if (r_vals[p] < min2_val) {
                    min2_val = r_vals[p];
                    min2 = p;
                }
            }
        }
        
        if (min1 < 3 && min2 < 3) {
            // Find common pin
            uint8_t common = 3, pA = 3, pC = 3;
            if (rpairs[min1].a == rpairs[min2].a) { common = rpairs[min1].a; pA = rpairs[min1].b; pC = rpairs[min2].b; }
            else if (rpairs[min1].a == rpairs[min2].b) { common = rpairs[min1].a; pA = rpairs[min1].b; pC = rpairs[min2].a; }
            else if (rpairs[min1].b == rpairs[min2].a) { common = rpairs[min1].b; pA = rpairs[min1].a; pC = rpairs[min2].b; }
            else if (rpairs[min1].b == rpairs[min2].b) { common = rpairs[min1].b; pA = rpairs[min1].a; pC = rpairs[min2].a; }
            
            final_result.type = COMP_RESISTOR;
            final_result.pinA = pA;
            final_result.pinB = common;
            final_result.pinC = pC;
            final_result.value1 = min1_val * 100;
            final_result.value2 = min2_val * 100;
            return;
        }
    }

    // ============ STEP 4: Detect DIODES and count junctions ============
    struct DiodeInfo {
        uint8_t anode;
        uint8_t cathode;
        uint16_t vf_mv;  // Forward voltage in mV
        bool valid;
    };
    DiodeInfo diodes[6];
    int diode_count = 0;
    
    for (int i = 0; i < 6; i++) {
        uint8_t pV = perms[i][0];
        uint8_t pG = perms[i][1];
        uint16_t vV = GET_V(i, pV, false);
        uint16_t vG = GET_V(i, pG, false);
        
        if (vG > 100) {
            uint16_t vf_adc = (vV > vG) ? (vV - vG) : 0;
            uint16_t vf_mv = (uint32_t)vf_adc * (uint32_t)vdda_mv / 4096;
            
            // Find reverse permutation
            int rev_idx = -1;
            for (int j = 0; j < 6; j++) {
                if (perms[j][0] == pG && perms[j][1] == pV) {
                    rev_idx = j;
                    break;
                }
            }
            
            bool reverse_blocked = false;
            if (rev_idx >= 0) {
                uint16_t rev_vG = GET_V(rev_idx, pV, false);
                // A true diode MUST have near-zero reverse conduction.
                // A bidirectional resistor conducts equally in reverse (rev_vG ≈ vG).
                reverse_blocked = (rev_vG < 80) && (rev_vG < (vG / 5)); 
            }
            
            // Diode forward voltage must be at least 180 mV (Schottky) to 3500 mV (LED)
            if (vf_mv >= 180 && vf_mv < 3500 && reverse_blocked) {
                diodes[diode_count].anode = pV;
                diodes[diode_count].cathode = pG;
                diodes[diode_count].vf_mv = vf_mv;
                diodes[diode_count].valid = true;
                diode_count++;
            }
        }
    }
    
    // ============ STEP 5: BJT Detection ============
    if (diode_count >= 2) {
        for (int b = 0; b < 3; b++) {
            int npn_junctions = 0, pnp_junctions = 0;
            int npn_idx[2] = {-1, -1}, pnp_idx[2] = {-1, -1};
            
            for (int d = 0; d < diode_count; d++) {
                if (diodes[d].anode == b) {
                    if (npn_junctions < 2) npn_idx[npn_junctions] = d;
                    npn_junctions++;
                }
                if (diodes[d].cathode == b) {
                    if (pnp_junctions < 2) pnp_idx[pnp_junctions] = d;
                    pnp_junctions++;
                }
            }
            
            if (npn_junctions == 2) {
                // Potential NPN BJT (base is anode for 2 junctions)
                uint8_t pin1 = diodes[npn_idx[0]].cathode;
                uint8_t pin2 = diodes[npn_idx[1]].cathode;
                
                // Measure HFE in both directions to distinguish C and E
                uint16_t vbe1 = 0, vbe2 = 0;
                uint16_t iceo1 = 0, iceo2 = 0;
                uint32_t hfe1 = measure_hfe(pin1, b, pin2, false, &vbe1, &iceo1);
                uint32_t hfe2 = measure_hfe(pin2, b, pin1, false, &vbe2, &iceo2);
                
                uint8_t collector, emitter;
                uint32_t hfe;
                uint16_t vbe, iceo;
                if (hfe1 >= hfe2) {
                    collector = pin1; emitter = pin2; hfe = hfe1; vbe = vbe1; iceo = iceo1;
                } else {
                    collector = pin2; emitter = pin1; hfe = hfe2; vbe = vbe2; iceo = iceo2;
                }
                
                if (hfe >= 10) {
                    final_result.type = COMP_BJT;
                    final_result.pinA = b;          // Base
                    final_result.pinB = collector;  // Collector
                    final_result.pinC = emitter;    // Emitter
                    final_result.value1 = hfe;
                    final_result.value2 = vbe;
                    if (iceo > 4095) iceo = 4095;
                    final_result.flags = FLAG_NPN | (iceo << 4);
                    return;
                }
            }
            
            if (pnp_junctions == 2) {
                // Potential PNP BJT (base is cathode for 2 junctions)
                uint8_t pin1 = diodes[pnp_idx[0]].anode;
                uint8_t pin2 = diodes[pnp_idx[1]].anode;
                
                uint16_t vbe1 = 0, vbe2 = 0;
                uint16_t iceo1 = 0, iceo2 = 0;
                uint32_t hfe1 = measure_hfe(pin1, b, pin2, true, &vbe1, &iceo1);
                uint32_t hfe2 = measure_hfe(pin2, b, pin1, true, &vbe2, &iceo2);
                
                uint8_t collector, emitter;
                uint32_t hfe;
                uint16_t vbe, iceo;
                if (hfe1 >= hfe2) {
                    collector = pin1; emitter = pin2; hfe = hfe1; vbe = vbe1; iceo = iceo1;
                } else {
                    collector = pin2; emitter = pin1; hfe = hfe2; vbe = vbe2; iceo = iceo2;
                }
                
                if (hfe >= 10) {
                    final_result.type = COMP_BJT;
                    final_result.pinA = b;
                    final_result.pinB = collector;
                    final_result.pinC = emitter;
                    final_result.value1 = hfe;
                    final_result.value2 = vbe;
                    if (iceo > 4095) iceo = 4095;
                    final_result.flags = FLAG_PNP | (iceo << 4);
                    return;
                }
            }
        }
    }

    // ============ STEP 5.5: MOSFET Detection (Enhancement Mode) ============
    if (diode_count >= 1 && diode_count <= 2) {
        for (int dIdx = 0; dIdx < diode_count; dIdx++) {
            uint8_t pinA = diodes[dIdx].anode;
            uint8_t pinK = diodes[dIdx].cathode;
            uint8_t pin3 = 3 - pinA - pinK;
            
            // Candidate Gate pin3 MUST NOT form any PN junction diodes
            bool g_in_any_diode = false;
            for (int j = 0; j < diode_count; j++) {
                if (diodes[j].anode == pin3 || diodes[j].cathode == pin3) {
                    g_in_any_diode = true;
                    break;
                }
            }
            if (g_in_any_diode) continue;
            
            uint16_t vth_mv = 0, rds_mohm = 0;
            
            // 1. Test N-channel enhancement (D = pinK, S = pinA, G = pin3)
            if (test_mosfet_channel(pin3, pinK, pinA, true, &vth_mv, &rds_mohm)) {
                final_result.type = COMP_MOSFET;
                final_result.pinA = pin3;   // Gate
                final_result.pinB = pinK;   // Drain
                final_result.pinC = pinA;   // Source
                final_result.value1 = vth_mv;
                final_result.value2 = rds_mohm;
                final_result.flags = FLAG_NCH | FLAG_ENHANCEMENT;
                return;
            }
            
            // 2. Test P-channel enhancement (D = pinA, S = pinK, G = pin3)
            if (test_mosfet_channel(pin3, pinA, pinK, false, &vth_mv, &rds_mohm)) {
                final_result.type = COMP_MOSFET;
                final_result.pinA = pin3;   // Gate
                final_result.pinB = pinA;   // Drain
                final_result.pinC = pinK;   // Source
                final_result.value1 = vth_mv;
                final_result.value2 = rds_mohm;
                final_result.flags = FLAG_PCH | FLAG_ENHANCEMENT;
                return;
            }
        }
    }
    
    // ============ STEP 6: Single DIODE ============
    if (diode_count == 1 || diode_count == 2) {
        final_result.type = COMP_DIODE;
        final_result.pinA = diodes[0].anode;
        final_result.pinB = diodes[0].cathode;
        final_result.value1 = diodes[0].vf_mv;
        final_result.value2 = 0; // Will be measured in loop()
        final_result.flags = 0;
        return;
    }
    // Nothing identified
    final_result.type = COMP_NONE;
}
static void discharge_probes_completely(uint8_t probeA, uint8_t probeB) {
    (void)probeA; (void)probeB;
    set_probe_rl_gnd(0);
    set_probe_rl_gnd(1);
    set_probe_rl_gnd(2);
    
    uint32_t t_start = millis();
    while (millis() - t_start < 250) {
#if defined(ARDUINO_ARCH_STM32)
        TinyUSB_Device_Task();
#endif
        uint16_t v0 = analogRead(probes[0].adc_pin);
        uint16_t v1 = analogRead(probes[1].adc_pin);
        uint16_t v2 = analogRead(probes[2].adc_pin);
        if (v0 < 40 && v1 < 40 && v2 < 40) break;
        delay(5);
    }
    
    set_probe_hiz(0);
    set_probe_hiz(1);
    set_probe_hiz(2);
}

// ============ ESR + Dissipation Factor Measurement @ 1 kHz ============
// Drives a 1 kHz square wave through the RL switches (VCC/GND toggling).
// Symmetrically samples in balanced dual quadruplets at (250 - Delta) us and (250 + Delta) us.
// Because the charging ramp of the capacitor is linear across the half-cycle,
// summing samples symmetric to the exact midpoint T/4 (250 us) cancels the capacitive
// triangle voltage (I/C * t) down to 0.000, isolating PURE ohmic ESR drop.
static uint16_t measure_esr_1khz(uint8_t probeA, uint8_t probeB, uint32_t c_pf) {
    const uint32_t HALF_US = 500; // 1 kHz half-period in microseconds

    discharge_probes_completely(probeA, probeB);

    // Setup pin modes ONCE before the loop to eliminate pinMode overhead
    pinMode(probes[probeA].rh_pin, INPUT);
    pinMode(probes[probeB].rh_pin, INPUT);
    pinMode(probes[probeA].rl_pin, OUTPUT);
    pinMode(probes[probeB].rl_pin, OUTPUT);

    // 1. Measure ADC quad sampling speed (time for 4 reads: A, B, B, A)
    uint32_t cal_start = micros();
    for (int k = 0; k < 8; k++) {
        analogRead(probes[probeA].adc_pin);
        analogRead(probes[probeB].adc_pin);
        analogRead(probes[probeB].adc_pin);
        analogRead(probes[probeA].adc_pin);
    }
    uint32_t quad_time = (micros() - cal_start) / 8;
    if (quad_time == 0) quad_time = 1;

    // 2. Symmetric dual-sample timing around the midpoint (250 us)
    // Quad 1 is centered at (250 - delta) us, Quad 2 is centered at (250 + delta) us
    // Default delta = 100 us -> centers at 150 us and 350 us
    uint32_t delta_mid = 100;
    if (quad_time > 150) delta_mid = (HALF_US - quad_time) / 2;

    uint32_t t_s1 = (250 >= (delta_mid + quad_time / 2)) ? (250 - delta_mid - quad_time / 2) : 0;
    uint32_t t_s2 = 250 + delta_mid - quad_time / 2;
    if (t_s2 + quad_time > HALF_US) t_s2 = HALF_US - quad_time;

    uint32_t vA_pos_sum = 0, vB_pos_sum = 0;
    uint32_t vA_neg_sum = 0, vB_neg_sum = 0;

    const int num_cycles = 512; // ~512 ms accumulation -> noise floor ~ +-0.005 ohm

    // Pre-condition: establish the steady-state triangle wave
    for (int i = 0; i < 16; i++) {
        digitalWrite(probes[probeA].rl_pin, HIGH);
        digitalWrite(probes[probeB].rl_pin, LOW);
        delayMicroseconds(HALF_US);
        digitalWrite(probes[probeA].rl_pin, LOW);
        digitalWrite(probes[probeB].rl_pin, HIGH);
        delayMicroseconds(HALF_US);
    }

    for (int i = 0; i < num_cycles; i++) {
        // --- POSITIVE HALF-CYCLE: A -> VCC via RL, B -> GND via RL ---
        digitalWrite(probes[probeA].rl_pin, HIGH);
        digitalWrite(probes[probeB].rl_pin, LOW);
        uint32_t t_start = micros();

        // Quad 1: centered at (250 - delta) us
        while (micros() - t_start < t_s1) {}
        vA_pos_sum += analogRead(probes[probeA].adc_pin);
        vB_pos_sum += analogRead(probes[probeB].adc_pin);
        vB_pos_sum += analogRead(probes[probeB].adc_pin);
        vA_pos_sum += analogRead(probes[probeA].adc_pin);

        // Quad 2: centered at (250 + delta) us (slope cancels Quad 1)
        while (micros() - t_start < t_s2) {}
        vA_pos_sum += analogRead(probes[probeA].adc_pin);
        vB_pos_sum += analogRead(probes[probeB].adc_pin);
        vB_pos_sum += analogRead(probes[probeB].adc_pin);
        vA_pos_sum += analogRead(probes[probeA].adc_pin);

        while (micros() - t_start < HALF_US) {}

        // --- NEGATIVE HALF-CYCLE: A -> GND via RL, B -> VCC via RL ---
        digitalWrite(probes[probeA].rl_pin, LOW);
        digitalWrite(probes[probeB].rl_pin, HIGH);
        t_start = micros();

        // Quad 1: centered at (250 - delta) us
        while (micros() - t_start < t_s1) {}
        vA_neg_sum += analogRead(probes[probeA].adc_pin);
        vB_neg_sum += analogRead(probes[probeB].adc_pin);
        vB_neg_sum += analogRead(probes[probeB].adc_pin);
        vA_neg_sum += analogRead(probes[probeA].adc_pin);

        // Quad 2: centered at (250 + delta) us (slope cancels Quad 1)
        while (micros() - t_start < t_s2) {}
        vA_neg_sum += analogRead(probes[probeA].adc_pin);
        vB_neg_sum += analogRead(probes[probeB].adc_pin);
        vB_neg_sum += analogRead(probes[probeB].adc_pin);
        vA_neg_sum += analogRead(probes[probeA].adc_pin);

        while (micros() - t_start < HALF_US) {}
    }

    set_probe_hiz(probeA);
    set_probe_hiz(probeB);
    discharge_probes_completely(probeA, probeB);

    uint32_t total_samples = (uint32_t)num_cycles * 4; // 2 quads = 4 (A, B) pairs per half-cycle

    float vA_pos = (float)vA_pos_sum / total_samples;
    float vB_pos = (float)vB_pos_sum / total_samples;
    float vA_neg = (float)vA_neg_sum / total_samples;
    float vB_neg = (float)vB_neg_sum / total_samples;

    // Differential ESR drop; subtracting halves cancels ADC offset and drift.
    float diff_pos = vA_pos - vB_pos;
    float diff_neg = vA_neg - vB_neg;
    float v_esr_drop = (diff_pos - diff_neg) / 2.0f;

    // Sanity: both rails must actually toggle (probe present and switching works)
    if (vB_pos_sum == 0 || vA_pos_sum == 0) return 0;

    // Include calibrated RL resistors
    float r_tot = ((float)g_RL[probeA] + (float)g_RL[probeB]) / 10.0f;
    if (r_tot < 200.0f) r_tot = 1360.0f;
    float vdda_v = vdda_mv / 1000.0f;
    float i_loop = vdda_v / r_tot;

    // Convert the averaged drop from ADC counts to volts.
    float v_drop_v = v_esr_drop * vdda_v / 4096.0f;

    // Compensate for non-linear exponential curvature at 1 kHz for smaller electrolytic caps (< 100 uF)
    if (c_pf >= 1000000) {
        float c_farad = (float)c_pf * 1e-12f;
        float tau = r_tot * c_farad;
        if (tau > 0.00005f) {
            float x = (float)HALF_US * 1e-6f / (4.0f * tau);
            if (x < 2.0f) {
                float v_cap_offset = vdda_v * (x * x / 2.0f);
                v_drop_v = (v_drop_v > v_cap_offset) ? (v_drop_v - v_cap_offset) : 0.0f;
            }
        }
    }

    // Pure physical ESR; g_esr_zero_x100 is calibrated from Calibration tab (0 by default)
    float zero_offset = (float)g_esr_zero_x100 / 100.0f;
    float esr = (i_loop > 0.0f) ? (v_drop_v / i_loop - zero_offset) : 0.0f;

    if (esr < 0.0f) esr = 0.0f;
    uint32_t r_esr_x100 = (uint32_t)(esr * 100.0f);
    if (r_esr_x100 > 65000) r_esr_x100 = 65000;
    return (uint16_t)r_esr_x100;
}

// ============ STM32 RC Time Constant Capacitor Measurement ============
static bool measure_capacitor(uint8_t probeA, uint8_t probeB, uint16_t* out_vloss) {
    if (out_vloss) *out_vloss = 0;

    // 1. Active complete discharge of probes
    discharge_probes_completely(probeA, probeB);

    // ==========================================================
    // Range 0: Ultra-Small Capacitors (Charge Sharing Method)
    // ==========================================================
    if (tester_mode == 1) {
        // This method uses the STM32 internal ADC Sample & Hold capacitor (~5.5pF for F401).
        uint8_t probeC = 3 - (probeA + probeB);
        
        uint32_t v_zero_sum = 0;
        uint32_t v_share_sum = 0;
        
        // Configurable oversampling (128..1024) to eliminate ADC noise and improve resolution
        for (int i = 0; i < g_comp_oversample; i++) {
            // --- 1. Measure dynamic V_zero on probeC ---
            set_probe_rl_gnd(probeA);
            set_probe_rl_gnd(probeB);
            set_probe_hiz(probeC);
            set_probe_rl_vcc(probeA); // Use probeA to charge ADC to VCC
            delayMicroseconds(2);
            
            analogRead(probes[probeA].adc_pin); // Mux to A
            v_zero_sum += analogRead(probes[probeC].adc_pin); // Mux to C, share and read
            
            // Fast discharge for small capacitors
            set_probe_rl_gnd(probeA);
            delayMicroseconds(10);
            
            // --- 2. Measure V_share on probeA (which has the capacitor connected to GND) ---
            set_probe_rl_gnd(probeB);
            set_probe_hiz(probeA);
            set_probe_rl_vcc(probeC); // Use probeC to charge ADC to VCC
            delayMicroseconds(2);
            
            analogRead(probes[probeC].adc_pin); // Mux to C
            v_share_sum += analogRead(probes[probeA].adc_pin); // Mux to A, share and read
            
            // Fast discharge
            set_probe_rl_gnd(probeA);
            set_probe_rl_gnd(probeC);
            delayMicroseconds(10);
        }
        
        uint16_t v_zero = v_zero_sum / g_comp_oversample;
        uint16_t v_share = v_share_sum / g_comp_oversample;
        
        // Safeguard v_zero just in case
        if (v_zero < 800) v_zero = 1750;
        
        // If v_share dropped significantly compared to v_zero, there is a capacitor!
        if (v_share > 20 && v_share < (v_zero - 20)) {
            // Internal holding cap (ADC + MUX) is empirically around 10.4pF based on 32pF test.
            // Constant = 10.4pF * 4095 * 10 = ~425000
            uint32_t c_pf_x10 = (425000UL / v_share) - (425000UL / v_zero);
            
            // Allow reporting up to ~8000pF in this mode (covers power MOSFET Cg).
            if (c_pf_x10 > 2 && c_pf_x10 < 80000) { 
                final_result.type = COMP_CAPACITOR;
                final_result.pinA = probeA;
                final_result.pinB = probeB;
                final_result.pinC = probeC;
                final_result.value1 = c_pf_x10 / 10; // pF
                final_result.value2 = 0;
                final_result.value3 = 0;
                final_result.flags = 0;
                discharge_probes_completely(probeA, probeB);
                return true;
            }
        }
        
        // In pF Mode, we ONLY care about ultra-small capacitors. 
        // Do not fall through to Range 1 & Range 2 (which have long timeouts).
        discharge_probes_completely(probeA, probeB);
        return false;
    }
    
    discharge_probes_completely(probeA, probeB);

    // ==========================================================
    // Range 1: Small Capacitors (using R_high = 470k, R_low = 680)
    // ==========================================================
    set_probe_rl_gnd(probeA);
    set_probe_rl_gnd(probeB);
    delay(20);
    set_probe_hiz(probeA);
    set_probe_hiz(probeB);

    uint16_t v_start = analogRead(probes[probeA].adc_pin);
    if (v_start < 100) {
        set_probe_rl_gnd(probeB);
        set_probe_rh_vcc(probeA);
        delayMicroseconds(5);

        uint32_t t_start = micros();
        uint32_t timeout_us = 45000; // 45 ms max (covers up to ~100 nF)
        bool r1_ok = false;
        uint32_t t_v1 = 0, t_v2 = 0;
        bool hit_v1 = false;

        while (micros() - t_start < timeout_us) {
            uint16_t v = analogRead(probes[probeA].adc_pin);
            if (!hit_v1 && v >= 300) {
                t_v1 = micros();
                hit_v1 = true;
            }
            if (hit_v1 && v >= 1000) {
                t_v2 = micros();
                r1_ok = true;
                break;
            }
        }

        set_probe_hiz(probeA);
        set_probe_hiz(probeB);

        if (r1_ok && t_v2 > t_v1) {
            uint32_t dt = t_v2 - t_v1;

            // Measure voltage loss percentage over 500 ms in Hi-Z
            set_probe_hiz(probeA);
            set_probe_rl_gnd(probeB);
            delay(10);

            uint16_t v_loss_start = read_adc_avg(probes[probeA].adc_pin);
            delay(500); // 500 ms timer in Hi-Z
            uint16_t v_loss_end = read_adc_avg(probes[probeA].adc_pin);
            set_probe_hiz(probeB);

            uint16_t vloss_pct_x10 = 0;
            if (v_loss_start > v_loss_end && v_loss_start > 500) {
                uint32_t drop = v_loss_start - v_loss_end;
                vloss_pct_x10 = (uint16_t)((drop * 1000UL) / v_loss_start);
                if (vloss_pct_x10 > 999) vloss_pct_x10 = 999;
            }
            if (out_vloss) *out_vloss = vloss_pct_x10;

            // C = tau / R_high (tau = dt * 4.90196; rh_val in ohms => C in pF = dt * 4901960 / rh_val)
            uint32_t rh_val = g_RH[probeA];
            if (rh_val == 0) rh_val = 470000;
            uint32_t c_pf = (uint32_t)((uint64_t)dt * 4901960ULL / (uint64_t)rh_val);
            
            // Subtract basic stray capacitance of probes/ADC (~30 pF)
            if (c_pf > 30) c_pf -= 30; else c_pf = 0;

            if (c_pf >= 2000) {
                final_result.type = COMP_CAPACITOR;
                final_result.pinA = probeA;
                final_result.pinB = probeB;
                final_result.pinC = 3 - (probeA + probeB);
                final_result.value1 = c_pf; // pF
                final_result.value2 = 0;
                final_result.value3 = 0;
                final_result.flags = 0;
                final_result.vloss_x10 = vloss_pct_x10;
                discharge_probes_completely(probeA, probeB);
                return true;
            }
        }
    } else {
        set_probe_hiz(probeA);
        set_probe_hiz(probeB);
    }

    // ==========================================================
    // Range 2: Large Capacitors (Fast Differential Charge)
    // ==========================================================
    set_probe_rl_gnd(probeA);
    set_probe_rl_gnd(probeB);
    delay(30);

    set_probe_rl_gnd(probeB);
    uint32_t t_start = micros();
    set_probe_rl_vcc(probeA); // Start charging through 680 ohm RL
    
    uint32_t timeout_us = 5000000; // 5.0 seconds max (up to ~4700 uF)
    bool r2_ok = false;
    uint32_t t_v1 = 0, t_v2 = 0;
    bool hit_v1 = false;

    // Measure time between V_diff = 300 (0.24V) and V_diff = 1000 (0.81V)
    // True capacitor voltage V_cap = V(probeA) - V(probeB)
    // Factor: tau = dt * 4.90196
    while (micros() - t_start < timeout_us) {
        uint16_t va = analogRead(probes[probeA].adc_pin);
        uint16_t vb = analogRead(probes[probeB].adc_pin);
        int16_t v_diff = (int16_t)va - (int16_t)vb;
        
        if (!hit_v1 && v_diff >= 300) {
            t_v1 = micros();
            hit_v1 = true;
        }
        if (hit_v1 && v_diff >= 1000) {
            t_v2 = micros();
            r2_ok = true;
            break;
        }
    }

    if (r2_ok && t_v2 > t_v1) {
        uint32_t dt = t_v2 - t_v1;

        // Disconnect charging, tie probeB to GND, and settle initial resistor step
        set_probe_hiz(probeA);
        set_probe_rl_gnd(probeB);
        delay(10);

        // Read true resting capacitor voltage before hold timer starts
        uint16_t v_loss_start = read_adc_avg(probes[probeA].adc_pin);

        // 1000 ms self-discharge hold timer in Hi-Z for ~2.6% Vloss
        delay(1000);

        // Read final resting capacitor voltage
        uint16_t v_loss_end = read_adc_avg(probes[probeA].adc_pin);
        set_probe_hiz(probeB);

        uint16_t vloss_pct_x10 = 0;
        if (v_loss_start > v_loss_end && v_loss_start > 500) {
            uint32_t drop = v_loss_start - v_loss_end;
            vloss_pct_x10 = (uint16_t)((drop * 1000UL) / v_loss_start);
            if (vloss_pct_x10 > 999) vloss_pct_x10 = 999;
        }
        if (out_vloss) *out_vloss = vloss_pct_x10;

        // C = tau / R_total (tau = dt * 4.90196; rl_sum in ohms => C in pF = dt * 4901960 / rl_sum)
        uint32_t rl_sum = (g_RL[probeA] + g_RL[probeB]) / 10;
        if (rl_sum == 0) rl_sum = 1360;
        uint32_t c_pf = (uint32_t)((uint64_t)dt * 4901960ULL / (uint64_t)rl_sum);

        final_result.type = COMP_CAPACITOR;
        final_result.pinA = probeA;
        final_result.pinB = probeB;
        final_result.pinC = 3 - (probeA + probeB);
        final_result.value1 = c_pf; // pF
        final_result.value2 = 0;
        final_result.value3 = 0;
        final_result.flags = 0;
        final_result.vloss_x10 = vloss_pct_x10;
        if (c_pf >= 1000000) { // >= 1 uF: ESR measured at 1 kHz, tan(delta) standard @ 1 kHz
            uint16_t esr_x100 = measure_esr_1khz(probeA, probeB, c_pf);
            final_result.value2 = esr_x100;
            if (esr_x100 > 0) {
                // tan(delta) dissipation factor @ 1 kHz: D = 2*pi*1000*C*ESR
                float c_farad = (float)c_pf * 1e-12f;
                float esr_ohm = (float)esr_x100 / 100.0f;
                float tan_delta = 2.0f * 3.14159265f * 1000.0f * c_farad * esr_ohm;
                uint32_t td_x10000 = (uint32_t)(tan_delta * 10000.0f);
                if (td_x10000 > 65000) td_x10000 = 65000;
                final_result.value3 = td_x10000;
            }
        }
        discharge_probes_completely(probeA, probeB);
        return true;
    }

    set_probe_hiz(probeA);
    set_probe_hiz(probeB);
    return false;
}

static void test_and_compare_cap(uint8_t a, uint8_t b, CompResult* best_cap) {
    uint16_t vloss_ab = 0, vloss_ba = 0;
    CompResult res_ab, res_ba;
    memset(&res_ab, 0, sizeof(res_ab));
    memset(&res_ba, 0, sizeof(res_ba));
    
    memset(&final_result, 0, sizeof(final_result));
    bool ok_ab = measure_capacitor(a, b, &vloss_ab);
    if (ok_ab) res_ab = final_result;
    
    // Fast-path: If large electrolytic (>= 10 uF) with low loss (<= 4.5%) is already detected in forward direction,
    // accept it immediately without wasting time on slow reverse test
    if (ok_ab && res_ab.value1 >= 10000000 && vloss_ab <= 45) {
        res_ab.flags |= FLAG_POLARIZED;
        if (best_cap->type != COMP_CAPACITOR || res_ab.value1 > best_cap->value1) {
            *best_cap = res_ab;
        }
        return;
    }

    memset(&final_result, 0, sizeof(final_result));
    bool ok_ba = measure_capacitor(b, a, &vloss_ba);
    if (ok_ba) res_ba = final_result;
    
    if (!ok_ab && !ok_ba) return;
    
    CompResult chosen;
    memset(&chosen, 0, sizeof(chosen));
    
    if (ok_ab && !ok_ba) {
        chosen = res_ab;
        chosen.vloss_x10 = vloss_ab;
        if (chosen.value1 >= 1000000) chosen.flags |= FLAG_POLARIZED;
    } else if (!ok_ab && ok_ba) {
        chosen = res_ba;
        chosen.vloss_x10 = vloss_ba;
        if (chosen.value1 >= 1000000) chosen.flags |= FLAG_POLARIZED;
    } else {
        // Both directions measured successfully
        uint32_t c_ab = res_ab.value1;
        uint32_t c_ba = res_ba.value1;
        uint32_t c_avg = (c_ab + c_ba) / 2;
        
        if (c_avg >= 1000000) { // >= 1 uF: evaluate electrolytic polarity
            int32_t loss_diff = (int32_t)vloss_ab - (int32_t)vloss_ba;
            uint32_t c_diff = (c_ab > c_ba) ? (c_ab - c_ba) : (c_ba - c_ab);
            
            // Forward polarity has lower loss/leakage (lower vloss percentage)
            if (loss_diff <= -2 || (loss_diff < 2 && c_ab < c_ba && c_diff * 100 / c_avg >= 6)) {
                // a->b is forward: a is Anode (+), b is Cathode (-)
                chosen = res_ab;
                chosen.vloss_x10 = vloss_ab;
                chosen.flags |= FLAG_POLARIZED;
            } else if (loss_diff >= 2 || (loss_diff > -2 && c_ba < c_ab && c_diff * 100 / c_avg >= 6)) {
                // b->a is forward: b is Anode (+), a is Cathode (-)
                chosen = res_ba;
                chosen.vloss_x10 = vloss_ba;
                chosen.flags |= FLAG_POLARIZED;
            } else {
                // Symmetric non-polarized cap (e.g. 10 uF MLCC / film)
                chosen = res_ab;
                chosen.value1 = c_avg;
                chosen.vloss_x10 = (vloss_ab + vloss_ba) / 2;
                chosen.flags &= ~FLAG_POLARIZED;
            }
        } else {
            // Small non-polarized cap (< 1 uF)
            chosen = res_ab;
            chosen.value1 = c_avg;
            chosen.vloss_x10 = vloss_ab;
            chosen.flags &= ~FLAG_POLARIZED;
        }
    }

    if (best_cap->type != COMP_CAPACITOR || chosen.value1 > best_cap->value1) {
        *best_cap = chosen;
    }
}

void comp_tester_loop() {
    switch (state) {
        case STATE_IDLE:
            break;
            
        case STATE_DISCHARGE:
            if (millis() - state_timer >= 100) {
                state = STATE_SCAN;
                scan_step = 0;
            }
            break;
            
        case STATE_SCAN:
            if (scan_step < 6) {
                uint8_t pVCC = perms[scan_step][0];
                uint8_t pGND = perms[scan_step][1];
                uint8_t pHiZ = perms[scan_step][2];
                
                // Discharge all probes completely before each scan step
                discharge_probes_completely(0, 1);

                // R_low scan
                set_probe_rl_vcc(pVCC);
                set_probe_rl_gnd(pGND);
                set_probe_hiz(pHiZ);
                
                // Read early voltage (t = 0.5 ms)
                delayMicroseconds(500); // Give ADC/GPIO time to settle
                uint16_t early_gnd = read_adc_avg(probes[pGND].adc_pin);
                
                delay(5);
                
                // Read late voltage (t = 5.5 ms)
                uint16_t late_gnd = read_adc_avg(probes[pGND].adc_pin);
                
                // If the GND node is high and barely decays over 5 ms, it is either a short,
                // a low-resistance component, a diode, OR a LARGE capacitor (tau >> 5 ms).
                // Extend the observation window so slow capacitor charging current
                // decay becomes visible (e.g. 470 uF: tau ~640 ms, only ~3% drop at 5.5 ms,
                // but ~27% after the extra 250 ms).
                if (early_gnd > 1000 && late_gnd > (early_gnd - 150)) {
                    delay(250);
                    late_gnd = read_adc_avg(probes[pGND].adc_pin);
                }
                
                // We MUST NOT read the pHiZ pin! The STM32 ADC sampling capacitor 
                // injects charge into floating pins, which can turn ON a transistor's Base/Gate!
                scan_results[scan_step].vA_rl = 0;
                scan_results[scan_step].vB_rl = 0;
                scan_results[scan_step].vC_rl = 0;

                if (pVCC == 0) scan_results[scan_step].vA_rl = read_adc_avg(probes[0].adc_pin);
                if (pVCC == 1) scan_results[scan_step].vB_rl = read_adc_avg(probes[1].adc_pin);
                if (pVCC == 2) scan_results[scan_step].vC_rl = read_adc_avg(probes[2].adc_pin);

                if (pGND == 0) scan_results[scan_step].vA_rl = late_gnd;
                if (pGND == 1) scan_results[scan_step].vB_rl = late_gnd;
                if (pGND == 2) scan_results[scan_step].vC_rl = late_gnd;
                
                // Check if current decayed significantly (characteristic of capacitor charging).
                // Requiring a 3/4 (25%+) decay over the 5 ms window missed large electrolytics
                // (e.g. 33 uF has tau ~45 ms and only decays ~12%), which then fell through to the
                // resistor/inductor path and were reported as fake inductors.
                // Resistors/inductors/diodes have static current (noise < 20 counts) and never
                // trigger capacitive decay, so a modest 150-count drop is a safe detector.
                if (early_gnd > 300 && late_gnd < (early_gnd - 150)) {
                    scan_results[scan_step].is_capacitive = true;
                } else {
                    scan_results[scan_step].is_capacitive = false;
                }

                // R_high scan
                set_probe_rh_vcc(pVCC);
                set_probe_rh_gnd(pGND);
                set_probe_hiz(pHiZ);
                
                delay(5);
                
                scan_results[scan_step].vA_rh = 0;
                scan_results[scan_step].vB_rh = 0;
                scan_results[scan_step].vC_rh = 0;

                if (pVCC == 0) scan_results[scan_step].vA_rh = read_adc_avg(probes[0].adc_pin);
                if (pVCC == 1) scan_results[scan_step].vB_rh = read_adc_avg(probes[1].adc_pin);
                if (pVCC == 2) scan_results[scan_step].vC_rh = read_adc_avg(probes[2].adc_pin);

                if (pGND == 0) scan_results[scan_step].vA_rh = read_adc_avg(probes[0].adc_pin);
                if (pGND == 1) scan_results[scan_step].vB_rh = read_adc_avg(probes[1].adc_pin);
                if (pGND == 2) scan_results[scan_step].vC_rh = read_adc_avg(probes[2].adc_pin);
                
                scan_step++;
            } else {
                set_probe_hiz(0);
                set_probe_hiz(1);
                set_probe_hiz(2);
                state = STATE_ANALYZE;
            }
            break;
            
        case STATE_ANALYZE:
            if (tester_mode == 1) {
                final_result.type = COMP_NONE;
            } else {
                analyze_data();
            }
            
            // Targeted capacitor measurement. Prefer probe pairs that already showed
            // capacitive decay during the scan; fall back to all pairs if the
            // scan flagged nothing (e.g. ultra-small caps in charge-sharing mode).
            if (final_result.type == COMP_NONE || final_result.type == COMP_OPEN) {
                CompResult original_result = final_result;
                CompResult best_cap;
                memset(&best_cap, 0, sizeof(best_cap));
                bool tried[3][3];
                memset(tried, 0, sizeof(tried));
                
                // Test the scan-detected pairs in both polarities with leakage/loss comparison
                for (int i = 0; i < 6; i++) {
                    if (!scan_results[i].is_capacitive) continue;
                    uint8_t a = perms[i][0];
                    uint8_t b = perms[i][1];
                    if (tried[a][b]) continue;
                    tried[a][b] = tried[b][a] = true;
                    
                    test_and_compare_cap(a, b, &best_cap);
                }
                
                // Fallback: scan flagged nothing (e.g. ultra-small pF caps or film caps),
                // test all probe pairs in both polarities.
                if (best_cap.type != COMP_CAPACITOR) {
                    for (uint8_t a = 0; a < 3; a++) {
                        for (uint8_t b = a + 1; b < 3; b++) {
                            if (tried[a][b]) continue;
                            tried[a][b] = tried[b][a] = true;
                            
                            test_and_compare_cap(a, b, &best_cap);
                        }
                    }
                }
                
                if (best_cap.type == COMP_CAPACITOR) {
                    final_result = best_cap;
                } else {
                    final_result = original_result;
                }
            } else if (final_result.type == COMP_DIODE) {
                // Measure parasitic capacitance of the diode in reverse bias
                // measure_capacitor(probeA, probeB) charges probeA (VCC) and grounds probeB (GND).
                // So we must pass Cathode as probeA, and Anode as probeB.
                // In analyze_data: pinA = Anode, pinB = Cathode. So probeA = pinB, probeB = pinA.
                CompResult original_result = final_result;
                
                // We temporally set tester_mode to 1 to ONLY allow Range 0 to execute.
                // Range 1 and Range 2 use slow RC charging, which is completely broken by the 
                // reverse DC leakage current of a diode, causing it to measure huge garbage values (like 40nF).
                uint8_t old_mode = tester_mode;
                tester_mode = 1;
                
                if (measure_capacitor(original_result.pinB, original_result.pinA)) {
                    // It found a capacitor (parasitic)! 
                    // measure_capacitor will overwrite final_result with COMP_CAPACITOR
                    // We extract the capacitance and restore the original Diode result
                    uint32_t cap_val = final_result.value1;
                    final_result = original_result;
                    final_result.value2 = cap_val; 
                } else {
                    // Failed to measure (e.g. timeout due to leakage), restore original
                    final_result = original_result;
                }
                
                tester_mode = old_mode;
            } else if (final_result.type == COMP_BJT) {
                CompResult original_result = final_result;
                uint8_t old_mode = tester_mode;
                tester_mode = 1; // Only use fast charge for tiny parasitic capacitance
                
                uint8_t probeA, probeB;
                if (original_result.flags & FLAG_NPN) {
                    probeA = original_result.pinB; // Collector to VCC
                    probeB = original_result.pinA; // Base to GND
                } else {
                    probeA = original_result.pinA; // Base to VCC
                    probeB = original_result.pinB; // Collector to GND
                }
                
                if (measure_capacitor(probeA, probeB)) {
                    uint32_t cap_val = final_result.value1;
                    final_result = original_result;
                    // Store Vbe in lower 16 bits, Capacitance in upper 16 bits
                    final_result.value2 = (original_result.value2 & 0xFFFF) | (cap_val << 16);
                } else {
                    final_result = original_result;
                }
                
                tester_mode = old_mode;
            } else if (final_result.type == COMP_MOSFET) {
                CompResult original_result = final_result;
                uint8_t old_mode = tester_mode;
                tester_mode = 1; // Range 0 fast charge sharing mode for parasitic Cg
                
                // Measure Gate-to-Source capacitance Cg (pinA = Gate, pinC = Source)
                if (measure_capacitor(original_result.pinA, original_result.pinC)) {
                    uint32_t c_g = final_result.value1;
                    final_result = original_result;
                    final_result.value3 = c_g;
                } else {
                    final_result = original_result;
                }
                
                tester_mode = old_mode;
            }
            
            result_ready = true;
            state = STATE_DONE;
            break;
            
        case STATE_DONE:
            break;
    }
}



