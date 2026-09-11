/*
 * Adaptive Sonar TX module — REFERENCE firmware (ESP32, Arduino framework)
 * =========================================================================
 *
 * This sketch is the device side of the app's data contract. It runs the
 * IDLE → TRANSMIT → LISTEN → PROCESS → ADAPT state machine once per second,
 * reports every step as one JSON telemetry object, and accepts host commands.
 * The echo/DSP numbers are SIMULATED — swap the bodies of the hw*() hooks
 * below for the real driver + DSP code and leave the rest alone.
 *
 * LINKS (both can be active at once; the backend de-duplicates):
 *   USB serial  115200 baud. Telemetry out: one JSON object per line.
 *               Commands in: one JSON object per line.
 *   WiFi        POST http://BACKEND_HOST:BACKEND_PORT/api/telemetry   (same JSON)
 *               GET  http://BACKEND_HOST:BACKEND_PORT/api/commands/pending
 *                    every 500 ms → {"commands":[ {...}, ... ]}
 *
 * TELEMETRY (device → app) — required fields:
 *   {"state":"LISTEN","cycle":42,"frequency_khz":30,"pulse_width_ms":1.5,
 *    "gain_db":18,"waveform":"LFM_CHIRP","snr_db":8.4,"noise_floor_db":34.2,
 *    "target_present":true,"target_range_m":22.1,"timestamp_ms":1234567}
 *   Optional extensions this sketch also sends:
 *    "mode":"auto"|"manual"   current operating mode
 *    "log":"..."              human-readable reasoning (shown in the decision log)
 *
 * COMMANDS (app → device):
 *   {"cmd":"set_mode","value":"auto"}      {"cmd":"set_mode","value":"manual"}
 *   {"cmd":"set_params","frequency_khz":30,"pulse_width_ms":1.5,"gain_db":18}
 *   {"cmd":"trigger_ping"}
 *   The backend adds an "id"; a command seen twice (USB + WiFi) is applied once.
 *
 * RULES FOR SERIAL OUTPUT: any line starting with '{' must be valid telemetry
 * JSON. Put debug text on lines starting with "# " — the app shows those as
 * [DEV] console lines instead of flagging them as malformed.
 *
 * Library: ArduinoJson v7 (Library Manager: "ArduinoJson" by Benoit Blanchon).
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>

// ============================== USER CONFIG ===============================
#define WIFI_SSID        ""               // leave empty for USB-serial only
#define WIFI_PASS        ""
#define BACKEND_HOST     "192.168.1.100"  // laptop running the backend (Control tab shows its IP)
#define BACKEND_PORT     8080
#define SERIAL_BAUD      115200
#define TICK_MS          1000             // one state-machine step per second
#define COMMAND_POLL_MS  500
#define HTTP_TIMEOUT_MS  400              // keep short: HTTP calls block the loop
#define BACKOFF_POLL_MS  3000             // poll less often while the backend is unreachable

// ============================== CONTRACT ==================================
enum SonarState : uint8_t { IDLE, TRANSMIT, LISTEN, PROCESS, ADAPT };
static const char *const STATE_NAMES[] = {"IDLE", "TRANSMIT", "LISTEN", "PROCESS", "ADAPT"};

static const int FREQ_CHANNELS_KHZ[] = {22, 26, 30, 34, 38, 42};
static const int NUM_CHANNELS = sizeof(FREQ_CHANNELS_KHZ) / sizeof(FREQ_CHANNELS_KHZ[0]);

// Adaptive thresholds — keep in sync with backend/src/simulator.ts (ADAPT_RULES).
constexpr float SNR_LOW_DB = 6.0f;
constexpr float SNR_HIGH_DB = 18.0f;
constexpr float NOISE_HOP_DB = 40.0f;
constexpr float GAIN_MIN_DB = 0.0f, GAIN_MAX_DB = 40.0f, GAIN_FLOOR_DB = 6.0f;
constexpr float GAIN_STEP_UP_DB = 3.0f, GAIN_STEP_DOWN_DB = 2.0f;
constexpr float PULSE_MIN_MS = 0.5f, PULSE_MAX_MS = 5.0f, PULSE_STEP_MS = 0.4f;

struct TxParams {
  int frequencyKhz = 30;
  float pulseWidthMs = 1.5f;
  float gainDb = 18.0f;
  bool chirp = true;  // true = LFM_CHIRP, false = CW_PULSE
};

struct Sensed {
  float snrDb = 8.0f;
  float noiseFloorDb = 34.0f;
  bool targetPresent = true;
  float rangeM = 22.0f;
};

// ============================== STATE =====================================
static SonarState state = IDLE;
static uint32_t cycle = 0;
static bool autoMode = true;
static bool pingRequested = false;
static TxParams tx;
static Sensed sensed;
static String stepLog;  // reasoning for the current step → optional "log" field

static bool wifiEnabled = false;
static bool wifiWasConnected = false;
static bool backendReachable = true;
static uint32_t lastTickMs = 0;
static uint32_t lastPollMs = 0;

static const String TELEMETRY_URL = String("http://") + BACKEND_HOST + ":" + BACKEND_PORT + "/api/telemetry";
static const String COMMANDS_URL = String("http://") + BACKEND_HOST + ":" + BACKEND_PORT + "/api/commands/pending";

// ============================== HELPERS ===================================
static float frand() { return (float)esp_random() / (float)UINT32_MAX; }  // 0..1
static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static float round1(float v) { return roundf(v * 10.0f) / 10.0f; }

static int nearestChannel(float khz) {
  int best = FREQ_CHANNELS_KHZ[0];
  for (int i = 1; i < NUM_CHANNELS; i++)
    if (fabsf(FREQ_CHANNELS_KHZ[i] - khz) < fabsf(best - khz)) best = FREQ_CHANNELS_KHZ[i];
  return best;
}

static int nextChannel(int khz) {
  for (int i = 0; i < NUM_CHANNELS; i++)
    if (FREQ_CHANNELS_KHZ[i] == khz) return FREQ_CHANNELS_KHZ[(i + 1) % NUM_CHANNELS];
  return FREQ_CHANNELS_KHZ[0];
}

// ========================= HARDWARE HOOKS (replace) =======================
// These are the only functions that should need to change for real hardware.

/** Push new TX parameters to the DAC waveform generator, PA gain stage and T/R timing. */
void hwApplyTxParams(const TxParams &p) {
  (void)p;  // TODO: real driver code
}

/** Switch the T/R switch to TX and fire one burst with the current parameters. */
void hwTransmitPing(const TxParams &p) {
  (void)p;  // TODO: real driver code
}

/**
 * Capture the echo window through LNA → ADC and fill in what was sensed.
 * SIMULATED: random-walk noise floor, target present ~72% of the time,
 * echo strength from gain and range. Replace with ADC capture + detection.
 */
void hwAcquireEcho(const TxParams &p, Sensed &s) {
  s.noiseFloorDb = clampf(s.noiseFloorDb + (frand() - 0.5f) * 5.0f, 20.0f, 55.0f);
  bool present = frand() < 0.72f;
  if (present) {
    float base = s.targetPresent ? s.rangeM : 15.0f + frand() * 70.0f;
    float drift = s.targetPresent ? (frand() - 0.5f) * 8.0f : 0.0f;
    s.rangeM = clampf(base + drift, 4.0f, 95.0f);
  }
  s.targetPresent = present;
  float targetStrength = 14.0f + frand() * 10.0f;
  float attenuation = s.rangeM * 0.16f + 4.0f;
  float echoAmp = present ? p.gainDb * 0.55f + targetStrength - attenuation : p.gainDb * 0.1f - 6.0f;
  echoAmp = clampf(echoAmp, -10.0f, 60.0f);
  s.snrDb = clampf(echoAmp - s.noiseFloorDb * 0.55f, -8.0f, 32.0f);
}

/** Run the matched filter / pulse compression. Returns the processing gain in dB. SIMULATED. */
float hwMatchedFilter(const TxParams &p, Sensed &s) {
  float gain = p.pulseWidthMs * 1.6f;
  s.snrDb = clampf(s.snrDb + gain, -8.0f, 34.0f);
  return gain;
}

// ============================== ADAPTIVE LOGIC ============================
/** Adjust TX parameters from the last SNR / noise estimate. Always explains itself in stepLog. */
void adapt() {
  const String snr = "SNR " + String(sensed.snrDb, 1) + "dB";
  if (!autoMode) {
    stepLog = snr + " — manual mode, operator parameters held";
    return;
  }

  if (sensed.snrDb < SNR_LOW_DB) {
    String changes;
    if (tx.gainDb < GAIN_MAX_DB) {
      float prev = tx.gainDb;
      tx.gainDb = clampf(tx.gainDb + GAIN_STEP_UP_DB, GAIN_MIN_DB, GAIN_MAX_DB);
      changes += "gain " + String(prev, 0) + "→" + String(tx.gainDb, 0) + "dB";
    } else {
      changes += "gain already at 40dB cap";
    }
    if (tx.pulseWidthMs < PULSE_MAX_MS) {
      float prev = tx.pulseWidthMs;
      tx.pulseWidthMs = round1(clampf(tx.pulseWidthMs + PULSE_STEP_MS, PULSE_MIN_MS, PULSE_MAX_MS));
      changes += ", pulse " + String(prev, 1) + "→" + String(tx.pulseWidthMs, 1) + "ms";
    } else {
      changes += ", pulse already at 5ms cap";
    }
    if (!tx.chirp) {
      tx.chirp = true;
      changes += ", waveform → LFM chirp for pulse-compression gain";
    }
    stepLog = snr + " < 6dB → " + changes;
    if (sensed.noiseFloorDb > NOISE_HOP_DB) {
      int next = nextChannel(tx.frequencyKhz);
      stepLog += "; noise " + String(sensed.noiseFloorDb, 1) + "dB > 40dB → hop " + String(tx.frequencyKhz) + "→" + String(next) + "kHz";
      tx.frequencyKhz = next;
    }
  } else if (sensed.snrDb > SNR_HIGH_DB) {
    String changes;
    if (tx.gainDb > GAIN_FLOOR_DB) {
      float prev = tx.gainDb;
      tx.gainDb = max(GAIN_FLOOR_DB, tx.gainDb - GAIN_STEP_DOWN_DB);
      changes += "gain " + String(prev, 0) + "→" + String(tx.gainDb, 0) + "dB to save power";
    }
    if (sensed.targetPresent && sensed.rangeM < 30.0f && tx.chirp) {
      tx.chirp = false;
      if (changes.length()) changes += ", ";
      changes += "close target (" + String(sensed.rangeM, 1) + "m) → CW pulse";
    }
    stepLog = changes.length() ? snr + " > 18dB → " + changes : snr + " > 18dB but gain at 6dB floor — holding";
  } else {
    stepLog = snr + " within 6–18dB band — nominal, holding parameters";
  }
  hwApplyTxParams(tx);
}

/** Advance the state machine by one step. */
void stepStateMachine() {
  stepLog = "";
  if (pingRequested) {
    pingRequested = false;
    state = TRANSMIT;  // operator ping: skip straight to transmit
  } else {
    state = (SonarState)((state + 1) % 5);
  }

  switch (state) {
    case IDLE:
      break;
    case TRANSMIT:
      cycle++;
      hwTransmitPing(tx);
      break;
    case LISTEN:
      hwAcquireEcho(tx, sensed);
      break;
    case PROCESS: {
      float g = hwMatchedFilter(tx, sensed);
      stepLog = "matched filter +" + String(g, 1) + "dB → SNR " + String(sensed.snrDb, 1) + "dB, noise floor " + String(sensed.noiseFloorDb, 1) + "dB";
      break;
    }
    case ADAPT:
      adapt();
      break;
  }
}

// ============================== TELEMETRY =================================
/** Serialize the current state in the contract format. Floats go out with 1 decimal. */
String buildTelemetry() {
  JsonDocument doc;
  doc["state"] = STATE_NAMES[state];
  doc["cycle"] = cycle;
  doc["frequency_khz"] = tx.frequencyKhz;
  doc["pulse_width_ms"] = serialized(String(tx.pulseWidthMs, 1));
  doc["gain_db"] = (int)lroundf(tx.gainDb);
  doc["waveform"] = tx.chirp ? "LFM_CHIRP" : "CW_PULSE";
  doc["snr_db"] = serialized(String(sensed.snrDb, 1));
  doc["noise_floor_db"] = serialized(String(sensed.noiseFloorDb, 1));
  doc["target_present"] = sensed.targetPresent;
  doc["target_range_m"] = serialized(String(sensed.targetPresent ? sensed.rangeM : 0.0f, 1));
  doc["timestamp_ms"] = millis();
  doc["mode"] = autoMode ? "auto" : "manual";
  if (stepLog.length()) doc["log"] = stepLog;
  String out;
  serializeJson(doc, out);
  return out;
}

void postTelemetry(const String &body) {
  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(TELEMETRY_URL)) return;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  http.end();
  bool ok = code == 200;
  if (ok != backendReachable) Serial.printf("# backend %s (%s, HTTP %d)\n", ok ? "reachable" : "UNREACHABLE", TELEMETRY_URL.c_str(), code);
  backendReachable = ok;
}

// ============================== COMMANDS ==================================
static long long recentIds[16];
static uint8_t recentCount = 0, recentNext = 0;

/** True if this command id was already applied (it arrives over both USB and WiFi). */
static bool alreadyApplied(long long id) {
  for (uint8_t i = 0; i < recentCount; i++)
    if (recentIds[i] == id) return true;
  recentIds[recentNext] = id;
  recentNext = (recentNext + 1) % 16;
  if (recentCount < 16) recentCount++;
  return false;
}

void applyCommand(JsonObjectConst c) {
  if (!c["id"].isNull() && alreadyApplied(c["id"].as<long long>())) return;
  const char *cmd = c["cmd"] | "";

  if (strcmp(cmd, "set_mode") == 0) {
    const char *v = c["value"] | "";
    if (strcmp(v, "auto") == 0) autoMode = true;
    else if (strcmp(v, "manual") == 0) autoMode = false;
    else { Serial.printf("# rejected set_mode value '%s'\n", v); return; }
    Serial.printf("# mode → %s\n", autoMode ? "auto" : "manual");
  } else if (strcmp(cmd, "set_params") == 0) {
    if (c["frequency_khz"].is<float>()) tx.frequencyKhz = nearestChannel(c["frequency_khz"].as<float>());
    if (c["pulse_width_ms"].is<float>()) tx.pulseWidthMs = round1(clampf(c["pulse_width_ms"].as<float>(), PULSE_MIN_MS, PULSE_MAX_MS));
    if (c["gain_db"].is<float>()) tx.gainDb = roundf(clampf(c["gain_db"].as<float>(), GAIN_MIN_DB, GAIN_MAX_DB));
    hwApplyTxParams(tx);
    Serial.printf("# params → %dkHz / %.1fms / %.0fdB\n", tx.frequencyKhz, tx.pulseWidthMs, tx.gainDb);
  } else if (strcmp(cmd, "trigger_ping") == 0) {
    pingRequested = true;
    Serial.println("# ping requested by host");
  } else {
    Serial.printf("# unknown command '%s'\n", cmd);
  }
}

/** USB: accumulate bytes into lines; each non-empty line is one command object. */
void readSerialCommands() {
  static char line[256];
  static size_t len = 0;
  static bool overflow = false;
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (len > 0 && !overflow) {
        line[len] = '\0';
        JsonDocument doc;
        if (deserializeJson(doc, line)) Serial.println("# ignored malformed command line");
        else applyCommand(doc.as<JsonObjectConst>());
      }
      len = 0;  // empty lines (the host's liveness probe) are ignored
      overflow = false;
    } else if (len < sizeof(line) - 1) {
      line[len++] = ch;
    } else {
      overflow = true;  // drop over-long lines entirely
    }
  }
}

/** WiFi: fetch and apply everything queued for us since the last poll. */
void pollCommands() {
  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(COMMANDS_URL)) return;
  int code = http.GET();
  if (code == 200) {
    JsonDocument doc;
    if (!deserializeJson(doc, http.getString())) {
      for (JsonObjectConst c : doc["commands"].as<JsonArrayConst>()) applyCommand(c);
    }
  }
  http.end();
  backendReachable = code == 200;
}

// ============================== SETUP / LOOP ==============================
void setupWifi() {
  if (strlen(WIFI_SSID) == 0) {
    Serial.println("# WiFi disabled (WIFI_SSID empty) — USB serial only");
    return;
  }
  wifiEnabled = true;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);  // non-blocking; loop() reports when it connects
  Serial.printf("# WiFi connecting to '%s', backend %s\n", WIFI_SSID, TELEMETRY_URL.c_str());
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(200);
  Serial.println();
  Serial.println("# adaptive sonar TX module online — reference firmware 1.0");
  hwApplyTxParams(tx);
  setupWifi();
  lastTickMs = millis();
}

void loop() {
  readSerialCommands();

  bool wifiUp = wifiEnabled && WiFi.status() == WL_CONNECTED;
  if (wifiUp != wifiWasConnected) {
    wifiWasConnected = wifiUp;
    if (wifiUp) Serial.printf("# WiFi connected, IP %s\n", WiFi.localIP().toString().c_str());
    else if (wifiEnabled) Serial.println("# WiFi disconnected — retrying");
  }

  uint32_t now = millis();
  uint32_t pollEvery = backendReachable ? COMMAND_POLL_MS : BACKOFF_POLL_MS;
  if (wifiUp && now - lastPollMs >= pollEvery) {
    lastPollMs = now;
    pollCommands();
  }

  if (now - lastTickMs >= TICK_MS || pingRequested) {
    lastTickMs = now;
    stepStateMachine();
    String line = buildTelemetry();
    Serial.println(line);             // USB: one JSON object per line
    if (wifiUp) postTelemetry(line);  // WiFi: same object as the POST body
  }
}
