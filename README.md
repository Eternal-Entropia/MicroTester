<p align="center">
  <a href="https://eternal-entropia.github.io/MicroTester/web/start.html"><img src="logo.svg" alt="MicroTester Logo" width="320"></a><br>
  <strong>MCU-based Instrument Suite</strong>
</p>

Turn your microcontroller into a multi-channel oscilloscope, voltmeter, signal generator, and component tester using Chromium based browser 

---

## Features & Capabilities

MicroTester transforms low-cost microcontrollers into a powerful desktop laboratory:

- **Oscilloscope**: Multi-channel waveform visualization with Equivalent Time Sampling (ETS), up to 3.8 MHz Real-Time mode (experimental), trigger controls, and timebase scaling.
- **Voltmeter**: Multi-channel voltage measurement with ADC oversampling for enhanced precision and ±30V auto-polarity detection.
- **Signal Generator**: Programmable PWM and sine,sawtooth signal generation.
- **Component Tester**: Automatic pinout detection and parameter measurement for:
  - **Resistors**: 0.1 Ω .. 10 MΩ
  - **Capacitors**: 1 pF .. 10,000 µF + ESR (Equivalent Series Resistance)
  - **Diodes & LEDs**: Forward Voltage ($V_f$) & Pinout (Anode/Cathode)
  - **BJT Transistors**: $h_{FE} / \beta$, $V_{be}$, and Pinout (B, C, E)
  - **MOSFETs (N-Ch / P-Ch)**: $V_{th}$, Gate Capacitance ($C_g$), $R_{ds(on)}$, Pinout (G, D, S), and Body Diode $V_f$
  - **Inductors & Coils**: • Inductance (L): 10 µH .. 1000 H • DC Resistance (Rdc), Q Factor & Reactance (XL)

---

## Supported Microcontrollers

| MCU Model | Board | Specs | Status |
| :--- | :--- | :--- | :--- |
| **STM32F401** | Black Pill | 84MHz • 12-bit ADC | **Available Now** |
| **STM32F103** | Blue Pill | 72MHz • 12-bit ADC | Coming Soon |
| **RP2040** | Raspberry Pi Pico | 133MHz • 12-bit ADC | Coming Soon |
| **ESP32-S3** | Heltec v3 | 240MHz • 12-bit ADC | Coming Soon |

## Getting Started

1. **Flash Firmware**: Compile and upload the firmware in `firmware/MicroTester` to your STM32F401 (Black Pill) using Arduino IDE / STM32Duino.
2. **Launch Web UI**: Open `web/start.html` or `web/main.html` in your browser.
3. **Connect**: Connect your MCU via Serial/WebUSB and start measuring!

## Release History

beta v1:beta support f401:voltmeter with oversampling, oscil with ETS, transisntor tester(R,C,diode, BJT), PWM generator

beta v2:added multi channel oscil. and fix +-30 volt auto polarity. added 3.8mhz realtime mode for oscil (unstable). minor fix for web ui.

beta v2.1: fix pinout for component tester

beta v3: Added new calibration. fix bugs. added bugs. now component tester measures mosfet
ETS work on aliasing signals.

beta v4: added Signal generator. update design. added 3.3v voltage range for oscil and voltmeter

beta v5: added PWA and icon. added inductors in component tester. minor fix


Lib usage in project:

usbdfu: https://github.com/devanlai/webdfu
