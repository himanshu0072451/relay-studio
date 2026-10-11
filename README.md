# Relay Studio

**Turning music into mechanical rhythm, one relay click at a time.**

Relay Studio is an experimental hardware-meets-software project that connects an ESP32 to a custom web dashboard to control a four-channel relay module in real time.

The idea is simple: take something usually used for switching electrical loads and turn it into a physical, rhythm-driven experience. From manual relay controls to music-inspired sequences, Relay Studio explores the intersection of embedded systems, web development, and creative electronics.

No unnecessary complexity. Just code, circuits, and satisfying mechanical clicks.

## Features

- **Real-time relay control** — Control four relay channels through a custom web interface.
- **ESP32 integration** — Communicate with the hardware over Wi-Fi.
- **Music-inspired experiments** — Build toward translating musical beats and rhythmic patterns into relay sequences.
- **Piano-style interaction** — Experiment with interactive controls that trigger individual relays.
- **Node.js backend** — Handle communication between the dashboard and ESP32.
- **Automatic pulse control** — Support timed relay activations with automatic shutoff.
- **Safety-first firmware** — Initialize outputs to OFF and force them OFF after detected communication failures.
- **Custom dashboard** — A dedicated interface for experimenting with hardware in real time.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Microcontroller | ESP32 |
| Firmware | Arduino / C++ |
| Backend | Node.js |
| Frontend | HTML, CSS, JavaScript |
| Communication | HTTP over local Wi-Fi |
| JSON handling | ArduinoJson |
| Hardware | Four-channel relay module |

## How It Works

1. The web dashboard sends a control request to the Node.js server.
2. The server queues the requested relay state.
3. The ESP32 polls the server over the local network.
4. The firmware applies the requested state to the relay GPIO pins.
5. The ESP32 reports its current relay mask back to the server.

Each relay is represented by one bit in a four-bit mask:

| Relay | GPIO | Mask |
| --- | --- | --- |
| Relay 1 | GPIO 16 | `1` |
| Relay 2 | GPIO 17 | `2` |
| Relay 3 | GPIO 18 | `4` |
| Relay 4 | GPIO 19 | `8` |

For example, a mask of `5` activates Relay 1 and Relay 3, assuming the command is accepted and applied successfully.

## Project Structure

```text
relay-studio/
├── esp32/
│   └── RelayStudioESP32/
│       └── RelayStudioESP32.ino
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── server.js
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

Your actual project structure may vary as development continues.

## Getting Started

### Prerequisites

- Node.js and npm
- Arduino IDE
- ESP32 board support installed in Arduino IDE
- ArduinoJson library
- ESP32 and computer connected to the same reachable local network
- A compatible four-channel relay module

### 1. Clone the repository

```bash
git clone https://github.com/himanshu0072451/relay-studio.git
cd relay-studio
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure the server

Create your local `.env` file using `.env.example` as a reference. Set the server's required port and ESP32 authentication token according to the configuration supported by `server.js`.

Never commit your real `.env` file or credentials.

### 4. Configure the ESP32

Open:

```text
esp32/RelayStudioESP32/RelayStudioESP32.ino
```

Configure your Wi-Fi credentials, server IP address, server port, and authentication token.

Install the ArduinoJson library through Arduino IDE's Library Manager, select the correct ESP32 board and port, and upload the firmware.

**Important:** The ESP32 must use the computer's reachable LAN IP address, not `localhost`.

### 5. Start the server

```bash
npm start
```

Open the local dashboard at the address and port printed by the server.

## Hardware Setup

The default firmware uses the following GPIO mapping:

- GPIO 16 → Relay 1
- GPIO 17 → Relay 2
- GPIO 18 → Relay 3
- GPIO 19 → Relay 4

The firmware is configured for active-LOW relay inputs by default. Verify your module's input polarity and supply requirements before powering it.

## Safety Notes

Relay Studio is an experimental electronics project.

- Test with relay contacts disconnected from mains voltage.
- Use an appropriate regulated supply for the relay module.
- Never power relay coils directly from ESP32 GPIO pins.
- Verify wiring, module ratings, isolation, and load requirements before connecting any real load.
- Software timeouts are not a substitute for hardware protection or safe electrical design.

## Project Status

Relay Studio is a work in progress. The core ESP32-to-server relay-control path is working, and the project is evolving toward richer interactive controls and music-driven behavior.

Features described as experiments or planned capabilities may require additional implementation.


## Contributing

Ideas, bug reports, and improvements are welcome. If you're experimenting with ESP32, embedded systems, web interfaces, or creative electronics, feel free to explore the project and share suggestions.

## 📄 License

I Don't have any;)

---

**Built with curiosity, and chaos.**