# Adaptive Sonar TX — Module Console

Telemetry + visualization console for the adaptive sonar transmitter module (ESP32) on the AUV.
Works live over **USB serial** or **WiFi**, and falls back to a clearly-labelled **simulation**
when no hardware is reporting.

```
backend/    Node.js + TypeScript — Express REST, WebSocket hub, serial + WiFi ingestion, simulation fallback
frontend/   React + Vite dashboard (recharts, CSS modules, self-hosted IBM Plex fonts)
firmware/   Reference ESP32 Arduino sketch implementing the device side of the contract
```

## Quick start

```bash
npm install          # once, from the repo root (npm workspaces)

npm run dev          # backend on :8080 + Vite on :5173 (proxies /api and /ws) — open http://localhost:5173
# or, for a demo: one process, one port
npm run build && npm start      # http://localhost:8080
```

With nothing connected the dashboard shows **SIMULATED** data straight away. To go live:

- **USB:** plug in the ESP32 → *Control* tab → pick the port (CP210x / CH340 ports are listed first) → *Connect*.
  Or start with `SERIAL_PORT=/dev/cu.usbserial-0001 npm start`.
- **WiFi:** set `WIFI_SSID`, `WIFI_PASS`, `BACKEND_HOST` (the laptop's LAN IP — shown in the Control tab) in
  `firmware/sonar_tx/sonar_tx.ino` and flash it. The laptop's firewall must allow inbound TCP 8080.

The UI is reachable from a phone on the same network (`http://<laptop-ip>:5173` in dev, `:8080` after build).

### No hardware? Fake one through the real ingestion paths

```bash
npm run fake-device -- --wifi                      # posts telemetry + polls commands like the ESP32 would
npm run fake-device -- --serial /dev/cu.XXX        # speaks the contract over a serial port
npm run fake-device -- --wifi --garbage            # ...and injects malformed lines to prove they're tolerated
```

This shows as **LIVE · WiFi** (not simulated) because it really arrives over HTTP.

### Flashing the firmware

```bash
pio run -d firmware -t upload && pio device monitor -b 115200
```

Arduino IDE: open `firmware/sonar_tx/sonar_tx.ino`, board *ESP32 Dev Module*, install *ArduinoJson* 7.
The echo/DSP numbers in the sketch are simulated; replace the `hw*()` hook functions with the real driver
and DSP code — the state machine, telemetry and command handling can stay as they are.

## Data contract

Defined once in [`backend/src/contract.ts`](backend/src/contract.ts), mirrored in
[`frontend/src/types.ts`](frontend/src/types.ts) and the header of the firmware sketch.

**Telemetry** (device → app): one JSON object per line on serial, or per `POST /api/telemetry` body.

```json
{ "state": "LISTEN", "cycle": 42, "frequency_khz": 30, "pulse_width_ms": 1.5, "gain_db": 18,
  "waveform": "LFM_CHIRP", "snr_db": 8.4, "noise_floor_db": 34.2, "target_present": true,
  "target_range_m": 22.1, "timestamp_ms": 1234567 }
```

Optional extensions (the backend works without them): `"mode": "auto" | "manual"` and `"log": "…"` — the
device's reasoning for that step. Without `log`, the backend infers the ADAPT reasoning from parameter
changes and marks it `(inferred)`.

**Commands** (app → device): one JSON line written to serial, and always also queued for
`GET /api/commands/pending` (returns `{"commands": [...]}`, drained on read, 15 s expiry).

```json
{ "cmd": "set_mode", "value": "auto" }
{ "cmd": "set_params", "frequency_khz": 30, "pulse_width_ms": 1.5, "gain_db": 18 }
{ "cmd": "trigger_ping" }
```

The backend adds an `"id"` so a device listening on both links applies each command once. Frequencies snap
to the channel plan `[22, 26, 30, 34, 38, 42]` kHz; pulse width is clamped to 0.5–5 ms, gain to 0–40 dB.

Serial output rule for firmware: lines starting with `{` must be telemetry JSON; debug text goes on lines
starting with `# ` and appears in the console as `[DEV]`.

## Backend API

| Method | Path | |
|---|---|---|
| GET | `/api/status` | serial state, WiFi last-seen, simulated?, LAN addresses, queue depth |
| GET | `/api/ports` | serial ports, likely-ESP32 first (macOS `/dev/cu.*`) |
| POST | `/api/connect` | `{ "port": "/dev/cu.usbserial-0001", "baudRate": 115200 }` |
| POST | `/api/disconnect` | close serial (disables auto-reconnect) |
| POST | `/api/telemetry` | WiFi ingestion — same schema as a serial line |
| POST | `/api/commands` | send a command (validated; 400 with a reason otherwise) |
| GET | `/api/commands/pending` | device poll (~500 ms) |
| GET | `/api/history` | ring buffer (last 50 messages) + console log |
| WS | `/ws` | `hello` (status + history + log) on connect, then `telemetry`, `log`, `status` (≥1 Hz) |

Every telemetry message is tagged `"source": "serial" | "wifi" | "simulated"`.

Environment: `PORT` (8080), `SIM_TIMEOUT_MS` (5000), `SIM_TICK_MS` (1000), `SIMULATION=off`,
`SERIAL_PORT`, `SERIAL_BAUD` (115200).

## Behaviour worth knowing

- **Simulation fallback** starts when no real telemetry has arrived for `SIM_TIMEOUT_MS`, and continues from
  the device's last known parameters/mode rather than resetting. Real telemetry stops it immediately.
  Simulated data is never passed off as real: red hatched *SIMULATED* badge + banner, `SIM` tags in the
  console and ping table, and dashed lines in the trend charts.
- **Adaptive rules** (sim + firmware): on ADAPT in auto mode, SNR < 6 dB → gain +3 dB (cap 40), pulse
  +0.4 ms (cap 5), LFM chirp, and hop to the next channel if noise floor > 40 dB; SNR > 18 dB → gain −2 dB
  (floor 6) and CW pulse for close targets. Every decision logs its reasoning, including "holding".
- **Serial resilience:** malformed / non-contract lines are logged (rate-limited) and skipped. An unplugged
  device — or one that goes silent — is detected within ~3 s (a harmless empty-line write probes the port),
  status flips to `reconnecting`, and the same port is re-opened automatically when it comes back.
- **Frontend:** WebSocket reconnect with exponential backoff (0.5 s → 5 s cap) plus a silence watchdog;
  data dims and a banner counts down while the backend is unreachable. Components subscribe to individual
  store fields, so a telemetry tick re-renders only what changed; chart history is capped at 40 cycles.
  `prefers-reduced-motion` disables the flow dots, glow pulses and value flashes.
- **Scope trace** on the Signal tab is reconstructed from range / SNR / noise (the contract carries scalars,
  not raw samples), and says so in the panel header.

## Tests

```bash
npm test          # backend unit tests: contract validation, adaptive rules, fallback, dedupe, queue
npm run typecheck
pio run -d firmware
```
# SIH2026_The_A_Team
