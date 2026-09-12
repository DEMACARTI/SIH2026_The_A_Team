# Adaptive Sonar TX — Module Console

Telemetry + visualization console for the adaptive sonar transmitter module (ESP32) on the AUV.
Works live over **USB serial** or **WiFi**, and falls back to a clearly-labelled **simulation**
when no hardware is reporting.

```
backend/    Node.js + TypeScript — Express REST, WebSocket hub, serial + WiFi ingestion, simulation fallback
frontend/   React + Vite dashboard (recharts, CSS modules, self-hosted IBM Plex fonts)
electron/   Desktop app shell — packages the above into one double-click app (Win/macOS/Linux)
firmware/   Reference ESP32 Arduino sketch implementing the device side of the contract
```

## Desktop app (any laptop, no Node.js required)

The console also ships as a native desktop app — a normal double-click install, no terminal, no
Node.js on the end user's machine. It's the *same* backend and dashboard, just wrapped in
[Electron](electron/main.js): Electron bundles its own Node.js runtime, which is used to run the
existing backend as a child process, on a free local port picked automatically.

```bash
npm install
npm run electron:dev          # build + launch the desktop app on this machine, for development
```

To produce an installer:

```bash
npm run electron:build:mac    # -> release/*.dmg, *.zip   (run on macOS)
npm run electron:build:win    # -> release/*.exe (installer + portable)   (run on Windows)
npm run electron:build:linux  # -> release/*.AppImage, *.deb   (run on Linux)
```

**Build each target on its own OS** (or via the included `.github/workflows/build-desktop.yml` — push
a `v*` tag, or run it manually from the Actions tab). The app bundles a native module (`serialport`) that
has to be compiled/fetched against that OS+architecture's ABI; that's not something one machine can
reliably cross-compile for the other two, so CI builds each platform on its own runner. `npm run
electron:build` alone builds only for the OS you're running it on.

These builds are unsigned (no paid code-signing certificate) — macOS will show an "unidentified
developer" warning (right-click → Open the first time) and Windows may show a SmartScreen prompt
(More info → Run anyway). Functionally identical either way.

## Quick start (running it as a normal web app instead)

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
npm run fake-device -- --wifi --fuzzy              # the REAL board's shape: fuzzy scores, sensor ADCs, real DAC samples
```

This shows as **LIVE · WiFi** (not simulated) because it really arrives over HTTP.

### Flashing the firmware

```bash
pio run -d firmware -t upload && pio device monitor -b 115200
```

Arduino IDE: open `firmware/sonar_tx/sonar_tx.ino`, board *ESP32 Dev Module*, install *ArduinoJson* 7.

This is the **real TX-only hardware** firmware: 3 pots stand in for temp/depth/turbidity sensors, fuzzy
logic picks one of 3 waveform modes, and a real Hann-windowed burst is generated and pushed out the DAC
(GPIO25) via a hardware-timer ISR. There's no receive/echo chain, so it reports that honestly — see
**Real fuzzy-logic hardware** below — instead of fabricating SNR/echo numbers.

> **DAC note:** the board's original code used the newer `driver/dac_continuous.h` DMA API. This repo's
> PlatformIO build couldn't find that header in the available `espressif32`/arduino-esp32 package (it
> depends on the exact ESP-IDF version bundled, which varies by toolchain/IDE setup), so the firmware here
> uses the universally-available `dacWrite()` + `hw_timer_t` ISR instead — same real generated buffer,
> clocked out in real time, just not DMA-backed. If your Arduino IDE / board-manager setup does have
> `dac_continuous`, swap `transmitBurst()` back to it for smoother output; both are noted in the file.

If you're instead adapting this for the **original SNR-driven design** (full TX+RX, adaptive gain — see
the "Behaviour worth knowing" section), that reference sketch is no longer in this repo; the data contract
below still supports it (`rx_available` defaults to `true`), and `backend/src/simulator.ts` is a working
implementation of it if you want a starting point.

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
{ "cmd": "set_waveform_mode", "value": "PHASE_CODED" }
```

The backend adds an `"id"` so a device listening on both links applies each command once. Frequencies snap
to the channel plan `[22, 26, 30, 34, 38, 42]` kHz; pulse width is clamped to 0.5–5 ms, gain to 0–40 dB.

Serial output rule for firmware: lines starting with `{` must be telemetry JSON; debug text goes on lines
starting with `# ` and appears in the console as `[DEV]`.

### Real fuzzy-logic hardware (TX-only, no receive chain)

The board actually on the bench is TX-only: 3 sensor pots (temp/depth/turbidity) feed a **fuzzy-logic**
mode selector, not an SNR feedback loop, and there's no receive/echo path to measure SNR, noise floor, or
target range at all. Reporting those as if they were real measurements would be dishonest, so the contract
has an escape hatch — a device with no receive chain sends `"rx_available": false` and omits them (the
backend defaults them to `0`/`false` rather than rejecting the message), and instead sends what it actually
has:

```json
{ "state": "ADAPT", "cycle": 3, "frequency_khz": 34, "pulse_width_ms": 120, "gain_db": 76,
  "waveform": "PHASE_CODED", "rx_available": false, "mode": "auto", "timestamp_ms": 1234567,
  "fuzzy": {
    "turbidity": { "low": 0, "med": 0.2, "high": 0.8 }, "depth": { "low": 1, "med": 0, "high": 0 },
    "temperature": { "cold": 0, "normal": 1, "warm": 0 }, "scores": { "lfm": 0.1, "geo": 0.05, "phase": 0.85 }
  },
  "sensor_raw": { "temp_adc": 2048, "depth_adc": 512, "turbidity_adc": 3800 } }
```

On a `TRANSMIT` frame it also attaches the **real generated DAC buffer** (decimated to ≤300 points — the
raw 32k-sample burst is far too big for one JSON line), so the Signal tab plots the actual waveform instead
of a synthetic reconstruction: `"waveform_samples": [128, 200, ...]`, `"sample_rate_hz": 160000`,
`"duration_ms": 120`.

On this hardware, `frequency_khz`/`pulse_width_ms`/`gain_db` mean something different than the SNR-driven
design: the real top sweep frequency (kHz), real burst duration (ms), and a real DAC amplitude scale
(20–110 — **not** literal dB, despite the field name kept for contract compatibility). There's also no
continuous parameter control — manual mode picks one of the 3 waveform modes directly via
`set_waveform_mode` (`set_params` is accepted but has no effect, and is logged as such).

The frontend switches its Signal/Adaptive-logic/Control panels to fuzzy-hardware mode automatically
whenever `rx_available === false` on the latest telemetry (`isFuzzyHardware()` in `frontend/src/types.ts`)
— no manual toggle needed, and nothing here breaks the original SNR-driven simulator/legacy path, which
still works exactly as before when a device sends full RX telemetry.

### Spectrogram of the transmitted signal (needs hardware you haven't built yet)

The judging criteria call for validating the transmitted wave via FFT/spectrogram — the real, physical
signal, not just the digital buffer that generated it. That needs a receive path this board doesn't have:
wire the DAC's analog output (GPIO25) — **through your analog conditioning circuit (LPF + op-amp buffer)
once you build it, not directly** — into a spare ADC pin (GPIO33), then flip
`ENABLE_SPECTROGRAM_MONITOR` to `1` at the top of `firmware/sonar_tx/sonar_tx.ino`. Left at `0` by default:
an unwired ADC pin has no meaningful signal, and the firmware won't send fabricated spectrogram data.

Once enabled, on every transmit the firmware samples that pin while the burst plays, runs a self-contained
on-device FFT (radix-2, no external DSP library — same file), and attaches the result as an optional
`spectrogram` field: `{"freq_step_hz": ..., "frame_step_ms": ..., "frames": [[0-255, ...], ...]}` (time ×
frequency magnitude grid). The Signal tab renders it as a heatmap automatically whenever it's present — no
frontend changes needed once you wire the hardware.

**Two things worth knowing before you wire it up**, both discovered building this without the real
hardware to test against yet:

- **It polls in the foreground, not a timer interrupt.** The first version sampled the ADC from inside a
  hardware timer ISR (to run precisely alongside the DAC's own ISR-driven playback) — `analogRead()` from
  inside an ISR at that rate starved the scheduler and crashed the board (`TG1WDT_SYS_RESET`) on every
  transmit. It now polls in a plain foreground loop instead (safe), started right before the DAC timer so
  it still overlaps the actual burst.
- **Measured ADC throughput is ~12kHz, not the 100kHz target.** Using the low-level `adc1_get_raw()` API
  (already ~3x faster than `analogRead()`), sampling still tops out around 12kHz on this board — Nyquist
  ~6kHz, well short of resolving the full 10–50kHz sweep without aliasing. The firmware measures its
  actual achieved rate every capture (never assumes the target) and labels the spectrogram's frequency
  axis from that measurement, so what you see is honestly-scaled even though it's a coarse, partial view of
  the spectrum for now. Getting the full range needs the ESP32's ADC continuous/DMA mode instead of polled
  reads — worth pursuing once you have the loopback hardware to validate against a real signal.

Until the loopback exists, `npm run fake-device -- --wifi --fuzzy --spectrogram` exercises the same
pipeline (contract, backend, heatmap rendering) with a **synthetic** spectrogram — a Gaussian energy peak
placed at the analytically-known instantaneous frequency, not a real transform of a real signal. It's there
to prove the plumbing and the heatmap render correctly ahead of the hardware; treat it as a rendering test
only, never as a stand-in for a validated spectrum.

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
- **Scope trace** on the Signal tab is reconstructed from range / SNR / noise for the SNR-driven design (the
  contract carries scalars, not raw samples there) — the panel header says so. For the real fuzzy hardware,
  it instead plots the actual `waveform_samples` DAC buffer captured on the last transmit — genuinely real,
  not reconstructed — and says *that*, too. It persists across a page refresh and past the next status
  frame (via the store's `lastBurst`, seeded from the `hello` history replay), not just for the one React
  render right after the ping.
- **Waveform formation**, on the Signal tab under the scope: a small chart of the *commanded* frequency
  sweep (LFM's linear ramp vs. Geometric's exponential one) or phase pattern (Phase-coded's 0°/180° square
  wave), computed live from the current waveform type + top frequency + duration — the same formulas the
  firmware itself uses to generate the burst (`frontend/src/components/SignalPanel.tsx`,
  `formationTrace()`). It updates every tick, even between transmits, as the sensor readings move the
  commanded parameters — clearly labelled "computed … not measured" since it isn't derived from the
  (far too sparse, at any JSON-line-sized sample count) captured buffer.
- **Fuzzy membership curves**, in the fuzzy hardware's Signal tab panel: the exact triangular low/med/high
  membership functions the device evaluates (`frontend/src/fuzzy.ts`, same breakpoints as firmware's
  `fuzzify()`), each with the current raw sensor reading marked on it. Turn a pot and the marker slides and
  the highlighted (dominant) membership swaps live — the direct, visual answer to "why did the mode just
  change." Only the curve *shapes* are computed client-side for drawing; the membership degrees plotted on
  them always come from the device's own telemetry, never recomputed.

## Tests

```bash
npm test          # backend unit tests: contract validation, adaptive rules, fallback, dedupe, queue
npm run typecheck
pio run -d firmware
```
# SIH2026_The_A_Team
