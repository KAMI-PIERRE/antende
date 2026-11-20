# antende ESP32 pin-to-pin connections

This wiring is for a standard ESP32 DevKit and an MFRC522 RC522 module. Confirm the pin labels printed on your specific boards before powering them.

## RC522 RFID reader → ESP32

| RC522 pin | ESP32 pin | Notes |
|---|---|---|
| 3.3V | 3V3 | **Never connect RC522 VCC to 5V.** |
| GND | GND | Common ground |
| SDA / SS | GPIO 5 | SPI chip select |
| SCK | GPIO 18 | SPI clock |
| MOSI | GPIO 23 | SPI controller → reader |
| MISO | GPIO 19 | Reader → SPI controller |
| RST | GPIO 22 | Reset |
| IRQ | Not connected | Not used by this firmware |

## LEDs → ESP32

For each LED, connect its anode (long leg) to the GPIO through a 220 Ω series resistor. Connect its cathode (short leg / flat side) to GND.

| Part | Pin-to-pin connection |
|---|---|
| Green LED anode | GPIO 26 → 220 Ω resistor → LED anode |
| Green LED cathode | LED cathode → GND |
| Red LED anode | GPIO 27 → 220 Ω resistor → LED anode |
| Red LED cathode | LED cathode → GND |

## Active buzzer → ESP32 (recommended transistor driver)

Use an NPN transistor such as a 2N2222/BC547 when the buzzer current is not known or exceeds a GPIO-safe load. This keeps the buzzer load off the ESP32 pin.

| Part | Pin-to-pin connection |
|---|---|
| GPIO control | GPIO 25 → 1 kΩ resistor → NPN base |
| Transistor emitter | NPN emitter → GND |
| Transistor collector | NPN collector → buzzer negative (−) |
| Buzzer positive (+) | Buzzer positive → supply matching the buzzer rating |
| Shared ground | Buzzer supply negative → ESP32 GND |

Check the transistor pinout from its datasheet; package pin order varies. If the buzzer is magnetic/inductive, place a flyback diode across it (cathode to buzzer supply positive, anode to collector/buzzer negative). For a low-current 3.3 V active buzzer, direct GPIO drive is possible only when its datasheet confirms the GPIO current is safe; the transistor connection is preferred.

## Power and safety

- Power the ESP32 from USB or its documented board input. Power the RC522 from the ESP32 **3.3 V** rail only.
- All components and any separate buzzer supply must share a common ground.
- Do not connect any 5 V signal to an ESP32 or RC522 input.
- Make wiring changes with power disconnected. Verify LED polarity and transistor pins before powering.

## Signal behavior

| Server result | Green LED | Red LED | Buzzer |
|---|---|---|---|
| Attendance saved | Briefly on | Off | One short beep |
| Unknown/inactive card | Off | Briefly on | Two short beeps |
| Duplicate for the daily session | Off | Briefly on | One longer beep |
| Network/server failure | Off | Flashes | Three short error beeps |
| Registration scan captured | Briefly on | Off | One short beep |

The firmware only gives attendance-success feedback after the API returns `accepted`; it does not confirm success offline.
