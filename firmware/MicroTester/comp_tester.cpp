#include "comp_tester.h"
#include <math.h>
#include "adc_sampler.h"
#include <Adafruit_TinyUSB.h>

static float vdda_mv = 3300.0f;
static uint16_t g_RL[3] = {6800, 6800, 6800};       // in 0.1 ohm units
static uint32_t g_RH[3] = {470000, 470000, 470000}; // in 1 ohm units

void comp_tester_set_cal(uint16_t vdda, const uint16_t rl[3], const uint32_t rh[3]) {
    if (vdda >= 2500 && vdda <= 4000) vdda_mv = (float)vdda;
    for (int i = 0; i < 3; i++) {
        if (rl && rl[i] >= 3000 && rl[i] <= 10000) g_RL[i] = rl[i];
        if (rh && rh[i] >= 100000 && rh[i] <= 1000000) g_RH[i] = rh[i];
    }
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

static void discharge_probes_completely(uint8_t probeA, uint8_t probeB);
static uint32_t measure_hfe(uint8_t c, uint8_t b, uint8_t e, bool is_pnp, uint16_t *out_vbe, uint16_t *out_iceo = NULL);
static bool measure_capacitor(uint8_t probeA, uint8_t probeB);
static uint16_t measure_rdson(uint8_t g, uint8_t d, uint8_t s, bool is_nch);
static uint16_t measure_vth(uint8_t g, uint8_t d, uint8_t s, bool is_nch);
static bool test_mosfet_channel(uint8_t g, uint8_t d, uint8_t s, bool is_nch, uint16_t* out_vth, uint16_t* out_rds);

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
    // 128x oversampling for resistors and general voltage (reduces noise by ~11x)
    for (int i = 0; i < 128; i++) {
        sum += analogRead(pin);
    }
    return sum / 128;
}

void comp_tester_init() {
    analogReadResolution(12);
    set_probe_hiz(0);
    set_probe_hiz(1);
    set_probe_hiz(2);
}

void comp_tester_start(uint8_t mode) {
    adc_sampler_stop();
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
        uint32_t drop_b_pnp = 4096 - v_b;
        if (drop_b_pnp > 0) {
            uint32_t v_c_active = (v_c > v_c_leak) ? (v_c - v_c_leak) : 0;
            hfe = (uint32_t)(((uint64_t)v_c_active * rh_b) / ((uint64_t)drop_b_pnp * rl_c));
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
    
    // ============ STEP 1: Check for SHORT (< 0.5 Ohm) ============
    // Check if it's a 3-way short (calibration mode)
    uint16_t diff01 = (GET_V(0, 0, false) > GET_V(0, 1, false)) ? (GET_V(0, 0, false) - GET_V(0, 1, false)) : (GET_V(0, 1, false) - GET_V(0, 0, false));
    uint16_t diff02 = (GET_V(1, 0, false) > GET_V(1, 2, false)) ? (GET_V(1, 0, false) - GET_V(1, 2, false)) : (GET_V(1, 2, false) - GET_V(1, 0, false));
    uint16_t diff12 = (GET_V(3, 1, false) > GET_V(3, 2, false)) ? (GET_V(3, 1, false) - GET_V(3, 2, false)) : (GET_V(3, 2, false) - GET_V(3, 1, false));

    if (GET_V(0, 0, false) > 500 && GET_V(1, 0, false) > 500 && GET_V(3, 1, false) > 500 && 
        diff01 < 15 && diff02 < 15 && diff12 < 15) {
        
        // It's a 3-way short! Perform highly precise, slow calibration.
        uint32_t vV_01_rl = 0, vG_01_rl = 0, vV_02_rl = 0, vG_02_rl = 0, vV_12_rl = 0, vG_12_rl = 0;
        uint32_t vV_01_rh = 0, vG_01_rh = 0, vV_02_rh = 0, vG_02_rh = 0;

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
            
            // 5. Average 65536 samples for extreme precision
            uint32_t sumV = 0, sumG = 0;
            for (int i = 0; i < 65536; i++) {
                sumV += analogRead(probes[pV].adc_pin);
                sumG += analogRead(probes[pG].adc_pin);
            }
            
            uint32_t valV = sumV / 65536;
            uint32_t valG = sumG / 65536;
            
            if (step == 0) { vV_01_rl = valV; vG_01_rl = valG; }
            else if (step == 1) { vV_02_rl = valV; vG_02_rl = valG; }
            else if (step == 2) { vV_12_rl = valV; vG_12_rl = valG; }
            else if (step == 3) { vV_01_rh = valV; vG_01_rh = valG; }
            else if (step == 4) { vV_02_rh = valV; vG_02_rh = valG; }
        }
        
        // Ensure probes are left safely off
        set_probe_hiz(0); set_probe_hiz(1); set_probe_hiz(2);
        
        uint32_t V01 = (vV_01_rl + vG_01_rl) / 2;
        uint32_t V02 = (vV_02_rl + vG_02_rl) / 2;
        
        // R_L0 is anchor (680 ohms nominal)
        uint32_t R_L0 = 6800; // in 0.1 ohm units
        uint32_t R_L1 = (V01 * 6800) / (4096 - V01);
        uint32_t R_L2 = (V02 * 6800) / (4096 - V02);
        
        // 470k check
        uint32_t VH01 = (vV_01_rh + vG_01_rh) / 2;
        uint32_t VH02 = (vV_02_rh + vG_02_rh) / 2;
        
        uint32_t R_H0 = 47000; // in 10 ohm units (470k)
        uint32_t R_H1 = (VH01 * 47000) / (4096 - VH01);
        uint32_t R_H2 = (VH02 * 47000) / (4096 - VH02);
        
        uint32_t diff01_cal = (vV_01_rl > vG_01_rl) ? (vV_01_rl - vG_01_rl) : (vG_01_rl - vV_01_rl);
        uint32_t diff02_cal = (vV_02_rl > vG_02_rl) ? (vV_02_rl - vG_02_rl) : (vG_02_rl - vV_02_rl);
        uint32_t diff12_cal = (vV_12_rl > vG_12_rl) ? (vV_12_rl - vG_12_rl) : (vG_12_rl - vV_12_rl);
        uint32_t avg_diff = (diff01_cal + diff02_cal + diff12_cal) / 3;
        uint32_t wire_r100 = 68000UL * avg_diff / V01; // in 0.01 ohm units
        
        final_result.type = COMP_SHORT;
        final_result.pinA = 0; final_result.pinB = 1; final_result.pinC = 255; // 255 flags 3-way calib
        final_result.value1 = (R_L0 & 0xFFFF) | ((R_L1 & 0xFFFF) << 16);
        final_result.value2 = (R_L2 & 0xFFFF) | ((wire_r100 & 0xFFFF) << 16);
        final_result.value3 = (R_H1 & 0xFFFF) | ((R_H2 & 0xFFFF) << 16);
        return;
    }

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
            uint32_t R100 = (uint32_t)68000UL * diff / vG; // 0.01 ohm units
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
        
        uint32_t R = 0;
        bool valid_r = false;
        
        if (vG_rl > 20 && vG_rl < 4050 && vV_rl > vG_rl) {
            uint32_t diff = vV_rl - vG_rl;
            uint32_t rl_sum = (g_RL[pV] + g_RL[pG]) / 20; // in Ohms
            if (rl_sum == 0) rl_sum = 680;
            R = (uint32_t)rl_sum * diff / vG_rl;
            valid_r = true;
        } else if (vG_rh > 80 && vG_rh < 4050 && vV_rh > vG_rh) {
            uint32_t diff = vV_rh - vG_rh;
            uint32_t rh_sum = (g_RH[pV] + g_RH[pG]) / 2; // in Ohms
            if (rh_sum == 0) rh_sum = 470000;
            R = (uint32_t)rh_sum * diff / vG_rh;
            valid_r = true;
        }
        
        if (valid_r) {
            for (int p = 0; p < 3; p++) {
                if (rpairs[p].a == pV && rpairs[p].b == pG) {
                    rpairs[p].r_fwd = R; rpairs[p].fwd_ok = true;
                } else if (rpairs[p].a == pG && rpairs[p].b == pV) {
                    rpairs[p].r_rev = R; rpairs[p].rev_ok = true;
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
                final_result.type = COMP_RESISTOR;
                final_result.pinA = rpairs[p].a;
                final_result.pinB = rpairs[p].b;
                final_result.pinC = 3 - (rpairs[p].a + rpairs[p].b);
                final_result.value1 = r_vals[p] * 100;
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
                // A diode should have significantly less reverse conduction than forward.
                // A resistor will have equal conduction. AC noise might cause some reverse leakage.
                reverse_blocked = (rev_vG < (vG / 4) + 40); 
            }
            
            if (vf_mv > 100 && vf_mv < 3500 && reverse_blocked) {
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
    set_probe_rl_gnd(probeA);
    set_probe_rl_gnd(probeB);
    set_probe_rl_gnd(3 - (probeA + probeB));
    
    uint32_t t_start = millis();
    while (millis() - t_start < 20000) { // 20 seconds max active discharge
#if defined(ARDUINO_ARCH_STM32)
        TinyUSB_Device_Task();
#endif
        uint16_t vA = analogRead(probes[probeA].adc_pin);
        uint16_t vB = analogRead(probes[probeB].adc_pin);
        
        if (vA < 30 && vB < 30) {
            break; // Residual voltage cleared completely (< 24 mV)
        }
        
        delay(15);
    }
    
    set_probe_hiz(0);
    set_probe_hiz(1);
    set_probe_hiz(2);
}

// Fast pulse measurement for capacitor ESR (Equivalent Series Resistance)
// Uses a two-point extrapolation method to cancel out capacitive charging error.
static uint16_t measure_esr(uint8_t probeA, uint8_t probeB) {
    discharge_probes_completely(probeA, probeB);

    // The user requested a 1kHz square wave ESR measurement.
    // 1kHz = 500us positive half-cycle, 500us negative half-cycle.
    // During each half-cycle, the capacitor charges linearly (triangle wave).
    // The triangle wave crosses 0V at exactly the midpoint of the half-cycle (250us).
    // By taking a burst of samples perfectly centered at 250us, the average capacitive
    // voltage is exactly 0V, leaving ONLY the pure ESR voltage drop!
    // Subtracting the negative half-cycle cancels out any ADC or hardware offsets.

    // 1. Measure ADC sampling speed to perfectly center the burst
    uint32_t cal_start = micros();
    for (int k = 0; k < 16; k++) {
        analogRead(probes[probeA].adc_pin);
        analogRead(probes[probeB].adc_pin);
    }
    uint32_t sampling_time = micros() - cal_start;
    
    // If sampling is too slow for 16 pairs in 500us, reduce the burst size
    int samples_per_half = 16;
    if (sampling_time > 450) {
        samples_per_half = 8;
        sampling_time /= 2;
    }
    
    uint32_t start_delay = 0;
    if (sampling_time < 500) {
        start_delay = (500 - sampling_time) / 2;
    }

    uint32_t vA_pos_sum = 0;
    uint32_t vB_pos_sum = 0;
    uint32_t vA_neg_sum = 0;
    uint32_t vB_neg_sum = 0;
    
    const int num_cycles = 64; // 64 cycles at 1ms = 64ms.
    
    // Pre-condition the capacitor with a few cycles to establish the steady-state triangle wave
    for (int i = 0; i < 4; i++) {
        set_probe_rl_vcc(probeA);
        set_probe_rl_gnd(probeB);
        delayMicroseconds(500);
        set_probe_rl_gnd(probeA);
        set_probe_rl_vcc(probeB);
        delayMicroseconds(500);
    }

    for (int i = 0; i < num_cycles; i++) {
        // --- POSITIVE HALF-CYCLE (500us) ---
        uint32_t t_start = micros();
        set_probe_rl_vcc(probeA);
        set_probe_rl_gnd(probeB);
        
        while (micros() - t_start < start_delay) {} // Wait to center the burst
        
        for (int k = 0; k < samples_per_half; k++) {
            vA_pos_sum += analogRead(probes[probeA].adc_pin);
            vB_pos_sum += analogRead(probes[probeB].adc_pin);
        }
        
        while (micros() - t_start < 500) {} // Wait until exactly 500us
        
        // --- NEGATIVE HALF-CYCLE (500us) ---
        t_start = micros();
        set_probe_rl_gnd(probeA);
        set_probe_rl_vcc(probeB);
        
        while (micros() - t_start < start_delay) {}
        
        for (int k = 0; k < samples_per_half; k++) {
            vA_neg_sum += analogRead(probes[probeA].adc_pin);
            vB_neg_sum += analogRead(probes[probeB].adc_pin);
        }
        
        while (micros() - t_start < 500) {}
    }
    
    set_probe_hiz(probeA);
    set_probe_hiz(probeB);
    discharge_probes_completely(probeA, probeB);
    
    uint32_t total_samples = num_cycles * samples_per_half;
    
    float vA_pos = (float)vA_pos_sum / total_samples;
    float vB_pos = (float)vB_pos_sum / total_samples;
    float vA_neg = (float)vA_neg_sum / total_samples;
    float vB_neg = (float)vB_neg_sum / total_samples;
    
    // ESR drop is the difference between A and B
    float diff_pos = vA_pos - vB_pos; // Should be +V_ESR
    float diff_neg = vA_neg - vB_neg; // Should be -V_ESR (since A is GND, B is VCC)
    
    // Subtracting them completely cancels any static ADC or hardware offsets
    float v_esr_drop = (diff_pos - diff_neg) / 2.0f;
    
    if (v_esr_drop < 0.0f) v_esr_drop = 0.0f;
    
    // The current is determined by the pull-up and pull-down resistors.
    // v_mid is the voltage at the midpoint (in ADC ticks, around 2048).
    // Since the capacitor is in series with the 680 ohm ground resistor,
    // the voltage across the ground resistor is exactly v_mid.
    float v_mid = (vA_pos + vB_pos) / 2.0f;
        
    if (v_mid > 0.0f && v_esr_drop > 0.0f) {
        float rl_b = (g_RL[probeB] > 0) ? ((float)g_RL[probeB] / 10.0f) : 680.0f;
        float esr = (v_esr_drop / v_mid) * rl_b;
        esr -= 0.05f;
        uint32_t r_esr_x100 = (uint32_t)(esr * 100.0f);
        if (r_esr_x100 > 65000) r_esr_x100 = 65000;
        return (uint16_t)r_esr_x100;
    }
    
    return 0;
}

// ============ STM32 RC Time Constant Capacitor Measurement ============
static bool measure_capacitor(uint8_t probeA, uint8_t probeB) {
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
        
        // 128x Oversampling to completely eliminate ADC noise and improve resolution
        for (int i = 0; i < 128; i++) {
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
        
        uint16_t v_zero = v_zero_sum / 128;
        uint16_t v_share = v_share_sum / 128;
        
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
    set_probe_rl_gnd(probeB);
    set_probe_rh_vcc(probeA);
    delayMicroseconds(10); // Very short settle
    
    // Threshold for SmallCap: 63.2% VCC
    uint16_t threshold_small = 2589; 

    // Initial voltage check — MUST be low before starting timing
    uint16_t v_start = analogRead(probes[probeA].adc_pin);
    if (v_start < 300) {
        uint32_t t_start = micros();
        uint32_t timeout_us = 50000; // 50 ms max for small caps
        bool r1_ok = false;
        uint32_t elapsed = 0;

        while (micros() - t_start < timeout_us) {
            uint16_t v = analogRead(probes[probeA].adc_pin);
            if (v >= threshold_small) {
                elapsed = micros() - t_start;
                r1_ok = true;
                break;
            }
        }

        set_probe_hiz(probeA);
        set_probe_hiz(probeB);

        if (r1_ok && elapsed >= 15) {
            // C = t / R_high
            uint32_t rh_val = g_RH[probeA];
            if (rh_val == 0) rh_val = 470000;
            uint32_t c_pf = (uint32_t)((uint64_t)elapsed * 1000000000ULL / (uint64_t)rh_val);
            
            // Subtract basic stray capacitance of probes/ADC
            if (c_pf > 25) c_pf -= 25; else c_pf = 0;

            if (c_pf > 10) {
                final_result.type = COMP_CAPACITOR;
                final_result.pinA = probeA;
                final_result.pinB = probeB;
                final_result.pinC = 3 - (probeA + probeB);
                final_result.value1 = c_pf; // pF
                final_result.value2 = 0; // No ESR for small caps
                discharge_probes_completely(probeA, probeB);
                return true;
            }
        }
    } else {
        set_probe_hiz(probeA);
        set_probe_hiz(probeB);
    }

    // ==========================================================
    // Range 2: Large Capacitors (using R_low = 680, R_low = 680)
    // ==========================================================
    discharge_probes_completely(probeA, probeB);

    set_probe_rl_gnd(probeB);
    set_probe_rl_vcc(probeA);
    delayMicroseconds(10); // Short settle for accurate v_start

    // Initial check to calculate dynamic threshold
    v_start = analogRead(probes[probeA].adc_pin);
    
    // Dynamic 1-tau threshold: V_threshold = VCC - (VCC - V_start) * (1/e)
    // 1/e = 0.367879. This perfectly compensates for internal P-FET/N-FET asymmetry!
    uint16_t threshold_large = 4095 - (uint16_t)((4095.0f - v_start) * 0.367879f);

    if (v_start < 300 && v_start < threshold_large) {
        uint32_t t_start = micros();
        uint32_t timeout_us = 2500000; // 2.5 seconds max (up to ~1800 uF)
        bool r2_ok = false;
        uint32_t elapsed = 0;

        while (micros() - t_start < timeout_us) {
            uint16_t v = analogRead(probes[probeA].adc_pin);
            if (v >= threshold_large) {
                elapsed = micros() - t_start;
                r2_ok = true;
                break;
            }
            
            // Abort if voltage isn't rising
            if (micros() - t_start > 1000 && v < 2000) {
                break;
            }
        }

        set_probe_hiz(probeA);
        set_probe_hiz(probeB);

        if (r2_ok && elapsed > 20) {
            // C = t / R_total
            uint32_t rl_sum = (g_RL[probeA] + g_RL[probeB]) / 10;
            if (rl_sum == 0) rl_sum = 1360;
            uint32_t c_pf = (uint32_t)((uint64_t)elapsed * 913242ULL / (uint64_t)rl_sum);

            final_result.type = COMP_CAPACITOR;
            final_result.pinA = probeA;
            final_result.pinB = probeB;
            final_result.pinC = 3 - (probeA + probeB);
            final_result.value1 = c_pf; // pF
            if (final_result.value1 >= 1000000) { // >= 1 uF only
                final_result.value2 = measure_esr(probeA, probeB); 
            } else {
                final_result.value2 = 0;
            }
            discharge_probes_completely(probeA, probeB);
            return true;
        }
    }

    set_probe_hiz(probeA);
    set_probe_hiz(probeB);
    return false;
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
                
                // If it looks like a short or huge capacitor, give it 50ms more to charge!
                if (early_gnd > 1000 && (early_gnd < late_gnd + 5)) {
                    delay(50);
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
                
                // Check if current decayed (characteristic of capacitor charging)
                // Threshold lowered to 5 to catch slow-charging large capacitors
                if (early_gnd > 150 && late_gnd < early_gnd - 5) {
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
            
            // Targeted capacitor measurement comparing all pair directions
            if (final_result.type == COMP_NONE) {
                CompResult original_result = final_result;
                CompResult best_cap;
                memset(&best_cap, 0, sizeof(best_cap));
                
                // Test probe pairs in both forward and reverse polarities
                for (uint8_t a = 0; a < 3; a++) {
                    for (uint8_t b = 0; b < 3; b++) {
                        if (a == b) continue;
                        
                        memset(&final_result, 0, sizeof(final_result));
                        if (measure_capacitor(a, b)) {
                            // Reverse biasing an electrolytic capacitor creates a depletion region 
                            // that acts as a series capacitor, physically LOWERING the total effective capacitance. 
                            // Therefore, the true forward polarity is the one with the HIGHER measured capacitance.
                            if (best_cap.type != COMP_CAPACITOR || final_result.value1 > best_cap.value1) {
                                best_cap = final_result;
                            }
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



