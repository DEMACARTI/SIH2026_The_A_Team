# Build prompt for Claude Code

Copy everything below into Claude Code as your starting instruction.

---

## Project

Build a complete, working telemetry + visualization app for an **adaptive sonar transmitter module** custom-built for an AUV, running on an **ESP32**. This is a hackathon deliverable — it needs to actually work live against real hardware over USB serial or WiFi, fall back gracefully to a clearly-labeled simulation when no hardware is connected, and look and feel like a real instrumentation console: responsive on any screen size, and dynamic (live-updating, no jank, no full-page re-renders).

Build it as a monorepo with three parts:

```
/backend    - Node.js/Express + WebSocket telemetry hub
/frontend   - React + Vite dashboard
/firmware   - Reference ESP32 Arduino sketch
```

## Stack decision (use this, don't re-litigate it)

- **Backend: Node.js + TypeScript**, Express, `ws` for WebSocket, `serialport` (npm) for USB. One language across backend and frontend keeps this fast to build and debug live at a hackathon table.
- **Frontend: React + Vite**, `recharts` for graphs, plain CSS-in-JS or CSS modules (no heavy UI kit — this needs a distinctive instrumentation look, not a generic component library).
- **Firmware: Arduino framework on ESP32**, `ArduinoJson` for serialization, `WiFi.h` + `HTTPClient.h` for WiFi telemetry.

## Data contract (implement exactly this — it's the seam between hardware and software)

**Telemetry message** (device → app), one JSON object per line over Serial, or one JSON object per HTTP POST body over WiFi:

```json
{
  "state": "IDLE | TRANSMIT | LISTEN | PROCESS | ADAPT",
  "cycle": 42,
  "frequency_khz": 30,
  "pulse_width_ms": 1.5,
  "gain_db": 18,
  "waveform": "LFM_CHIRP | CW_PULSE",
  "snr_db": 8.4,
  "noise_floor_db": 34.2,
  "target_present": true,
  "target_range_m": 22.1,
  "timestamp_ms": 1234567
}
```

**Command message** (app → device), one JSON object per line written to Serial, or picked up by the device polling `GET /api/commands/pending`:

```json
{ "cmd": "set_mode", "value": "auto" }
{ "cmd": "set_mode", "value": "manual" }
{ "cmd": "set_params", "frequency_khz": 30, "pulse_width_ms": 1.5, "gain_db": 18 }
{ "cmd": "trigger_ping" }
```

## Backend requirements

1. **Serial ingestion**: list available serial ports (`GET /api/ports`), open a connection (`POST /api/connect` with `{port, baudRate}`, default 115200), read newline-delimited JSON, tolerate malformed lines without crashing (log and skip), auto-detect disconnect and surface it in status.
2. **WiFi ingestion**: `POST /api/telemetry` accepts the same schema from the ESP32 over the local network.
3. **Command channel**: `POST /api/commands` from the frontend. If a serial connection is open, write the command as a JSON line directly to the port. Always also queue it for `GET /api/commands/pending` so a WiFi-connected device can pick it up on its next poll (poll interval ~500ms on the device side).
4. **Live push**: normalize both ingestion paths into one stream and broadcast over a WebSocket (`/ws`) to all connected frontend clients. Tag every message with `"source": "serial" | "wifi" | "simulated"`.
5. **Simulation fallback**: if no real telemetry has arrived in the last 5 seconds (configurable), run an internal simulation loop generating physically plausible values (same adaptive rules as below) and stream those instead, always tagged `"source": "simulated"`. Never let simulated data look identical to real data in the UI — this needs to be honest, not just functional.
6. **Status endpoint**: `GET /api/status` returns connection state for serial, last WiFi telemetry timestamp, and whether the stream is currently simulated.
7. Keep an in-memory ring buffer of the last ~50 telemetry messages per connected client session for chart history on reconnect/refresh.

## Adaptive simulation rules (for the fallback engine — mirror this in the demo data)

- Cycle through `IDLE → TRANSMIT → LISTEN → PROCESS → ADAPT` on a ~1s tick.
- On `LISTEN`: derive a target range, echo amplitude, and SNR from current gain and a random-walked noise floor.
- On `ADAPT` (auto mode only): if SNR < 6dB, raise gain (cap 40dB), lengthen pulse width (cap 5ms), and hop to the next frequency channel from `[22, 26, 30, 34, 38, 42]` kHz if noise floor > 40dB. If SNR > 18dB, lower gain to save power. Log the reasoning for every decision, not just the new values.

## Frontend requirements

Reuse this exact visual language (already validated) — dark instrumentation console, not a generic SaaS dashboard:

- Background `#060A10`, panels `#0D141C`, hairline borders `#1C2A35`.
- One functional accent pair only: cyan `#3ED6C7` for live RF/signal activity, amber `#F0A94E` for DSP/adaptive-decision activity. Don't introduce a third accent.
- Typography: IBM Plex Sans for labels/headers, IBM Plex Mono for all numeric telemetry and log lines (justified — this is what real instrumentation readouts look like).
- Sharp/near-sharp corners, no drop shadows, no rounded "card" treatment.

Screens/panels (tabbed, same structure as the earlier prototype, now wired to real data):

1. **Architecture** — animated block diagram (transducer → T/R switch → DAC/PA and LNA/ADC → DSP core → comms), flow animation follows the live `state` field.
2. **Signal** — live return-amplitude trace, active frequency channel indicator, scrolling ping history table.
3. **Adaptive logic** — circular state-machine diagram with the live state highlighted, live-updating trend charts (frequency, gain, SNR with a 6dB reference line, noise floor) built from the telemetry stream, and a running decision log.
4. **Control** — Auto/Manual toggle, sliders for frequency/pulse width/gain (disabled unless Manual), "trigger ping" button, serial port picker + WiFi status, all wired to `POST /api/commands`.

Always-visible: a telemetry strip (frequency, pulse width, gain, waveform, SNR, noise floor, range, mode) and a persistent auto-scrolling console log, both fed by the WebSocket stream. Show a small, unmissable "SIMULATED" badge whenever `source !== "real"`.

### Responsiveness & "dynamic" requirements — be explicit about both meanings

**Responsive (layout):**
- Fully usable from a phone-width viewport (~360px) up through a wide desktop monitor. Panels reflow to a single column below ~768px; the telemetry strip wraps instead of overflowing; the tab bar becomes horizontally scrollable on narrow screens instead of wrapping into two rows.
- Test and fix actual breakpoints — don't just add `flex-wrap` and call it done.

**Dynamic (real-time behavior):**
- WebSocket client with automatic reconnect (exponential backoff, cap ~5s) and a visible connection-status indicator — never fail silently.
- Chart history capped (last ~30–40 points) so the UI stays fast over a long demo; don't let arrays grow unbounded.
- No full-page re-renders on each telemetry tick — isolate state updates so only the components that changed (readouts, active chart, console) re-render. Memoize chart components appropriately.
- Respect `prefers-reduced-motion` for the flow-animation and state-machine glow effects.
- Target smooth updates at the ~1Hz telemetry rate with no visible stutter; the architecture-diagram animation and chart transitions should feel continuous, not like a page reload.

## Firmware (reference implementation, not production firmware)

Write an ESP32 Arduino sketch that:
- Emits a telemetry JSON line over `Serial` (115200 baud) once per second, cycling through the state machine and generating the same plausible adaptive values described above.
- Also attempts to POST the same JSON to `http://<backend-host>:<port>/api/telemetry` if WiFi is configured (credentials as `#define` placeholders at the top of the file).
- Polls `GET /api/commands/pending` every 500ms when on WiFi, and reads newline-delimited command JSON from `Serial` when on USB, and applies `set_mode` / `set_params` / `trigger_ping` to its local state.
- Comment it clearly — this is the contract the whole app depends on, so it should be easy for a teammate to adapt to the real firmware's actual sensor/DSP code later.

## Build order (do this incrementally, don't try to do it all at once)

1. Scaffold the monorepo and get the frontend rendering against **hardcoded mock data** first — this must look right before anything is wired up.
2. Build the backend with the simulation engine only, streaming over WebSocket. Confirm the frontend updates live from simulated data end-to-end.
3. Add serial ingestion and the port picker; test against the ESP32 sketch over USB.
4. Add WiFi ingestion and command polling; test against the same sketch on WiFi.
5. Do a pass on responsiveness at 360px, 768px, and 1440px widths, and a pass on reconnect/error states (unplug the USB cable mid-demo and confirm the app recovers instead of breaking).

## Acceptance criteria

- App runs with zero hardware connected and clearly shows simulated data without looking broken or looking fake.
- App runs against the reference ESP32 sketch over USB serial and shows real data with the "SIMULATED" badge gone.
- Same, over WiFi.
- Sending a command from the Control tab visibly changes device behavior (state/log reflects it) within ~1-2 seconds.
- Resizing the browser from desktop to phone width keeps every panel usable, nothing overflows or gets clipped.
- Unplugging the device mid-session shows a clear disconnected state and the app doesn't crash or freeze.
