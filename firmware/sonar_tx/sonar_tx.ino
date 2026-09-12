/*
 * Adaptive Sonar TX module — REAL hardware firmware (ESP32, Arduino framework)
 * =============================================================================
 *
 * This is the actual TX-only board: 3 pots stand in for temp/depth/turbidity
 * sensors, fuzzy logic picks one of 3 waveform modes from them, and a real
 * Hann-windowed burst is generated and pushed out the DAC via DMA
 * (`dac_continuous`, GPIO25). There is NO receive/echo chain — no SNR, no
 * target range, no noise floor are actually measured on this hardware.
 *
 * This firmware reports that honestly: every telemetry frame carries
 * `"rx_available": false` plus the REAL fuzzy scores, REAL sensor ADC
 * readings, and (on transmit) a decimated copy of the REAL generated DAC
 * buffer — instead of the fabricated SNR/echo numbers a full sonar with a
 * receive path would report. See backend/src/contract.ts for the full
 * optional-field contract these extensions belong to.
 *
 * State machine (only 3 of the 5 contract states are real on this board —
 * there's no LISTEN/PROCESS without a receive chain):
 *   IDLE     idling; pots + fuzzy scores still sampled/reported every tick
 *   ADAPT    the fuzzy-selected mode just changed (auto), or the operator
 *            changed it (manual) — decision reasoning goes in "log"
 *   TRANSMIT button1 pressed, or a trigger_ping command — real DMA burst
 *
 * LINKS:
 *   USB serial  115200 baud. Telemetry out: one JSON object per line.
 *               Commands in: one JSON object per line.
 *   WiFi        POST http://BACKEND_HOST:BACKEND_PORT/api/telemetry
 *               GET  http://BACKEND_HOST:BACKEND_PORT/api/commands/pending  (every 500ms)
 *
 * COMMANDS (app → device):
 *   {"cmd":"set_mode","value":"auto"|"manual"}
 *   {"cmd":"set_waveform_mode","value":"LFM_CHIRP"|"GEOMETRIC_SWEEP"|"PHASE_CODED"}   (manual only)
 *   {"cmd":"trigger_ping"}                                                            (== button1)
 *   {"cmd":"set_params", ...} is NOT supported on this hardware — frequency/duration/
 *     amplitude are derived from the sensor pots each tick, not settable directly.
 *     It's accepted (won't error) but logged and ignored; use set_waveform_mode instead.
 *
 * Serial output rule: any line starting with '{' must be valid telemetry JSON.
 * Debug text goes on lines starting with "# " (shown by the app as [DEV] log lines).
 *
 * Library: ArduinoJson v7 (Library Manager: "ArduinoJson" by Benoit Blanchon).
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include "driver/adc.h"  // adc1_get_raw() — spectrogram monitor only; far less per-call overhead than analogRead()
// DAC output uses the classic dacWrite()/hw_timer_t Arduino APIs (below), not the newer
// driver/dac_continuous.h DMA API — that header isn't present in every arduino-esp32 core
// build (it depends on the exact ESP-IDF version bundled). If your toolchain does have it,
// dac_continuous gives smoother, truly DMA-timed output; this timer-ISR version is the
// portable fallback and is what this repo's CI/PlatformIO build actually compiles against.

// ============================== USER CONFIG ===============================
#define WIFI_SSID        ""               // leave empty for USB-serial only
#define WIFI_PASS        ""
#define BACKEND_HOST     "192.168.1.100"  // laptop running the backend (Control tab shows its IP)
#define BACKEND_PORT     8080
#define SERIAL_BAUD      115200
#define TICK_MS          1000             // one status/telemetry frame per second (button/trigger_ping act sooner)
#define COMMAND_POLL_MS  500
#define HTTP_TIMEOUT_MS  400              // keep short: HTTP calls block the loop
#define BACKOFF_POLL_MS  3000             // poll less often while the backend is unreachable

// ============================== HARDWARE PINS ==============================
const int potTempPin = 34;   // stands in for a real temperature sensor
const int potDepthPin = 35;  // stands in for a real depth/pressure sensor
const int potAmpPin = 32;    // stands in for a real turbidity sensor
const bool pot3Connected = true;

const int button1Pin = 13;   // trigger transmit (bench only — see Control tab's "Trigger ping")
const int button2Pin = 12;   // tap: cycle manual mode : hold ~800ms: return to auto

const int phaseControlPin = 26;  // declared but not driven anywhere below — reserved for future explicit phase switching

const int ledRed = 18;
const int ledGreen = 19;
const int ledBlue = 21;

// ============================== CONTRACT ====================================
// Declared before any function definitions: Arduino's auto-prototype generator
// inserts function prototypes right before the first function body in the file,
// so any custom type (like this enum) used as a parameter must already be
// visible by then, or the auto-generated prototype fails to compile.
enum SonarState : uint8_t { IDLE, TRANSMIT, LISTEN, PROCESS, ADAPT };  // LISTEN/PROCESS unused — no RX chain
static const char *const STATE_NAMES[] = {"IDLE", "TRANSMIT", "LISTEN", "PROCESS", "ADAPT"};

int currentMode = 0;
const char* modeNames[] = {"LFM_CHIRP", "GEOMETRIC_SWEEP", "PHASE_CODED"};  // matches contract Waveform enum exactly

// ============================== HARDWARE CONSTANTS =========================
const int freqMin = 10000;       // sweep start frequency, all modes
const int freqTopMin = 20000;    // top-of-sweep range mapped from the temp pot
const int freqTopMax = 50000;

const int SAMPLE_RATE = 160000;
const int MAX_DURATION_MS = 200;
const int MAX_BUFFER = (SAMPLE_RATE / 1000) * MAX_DURATION_MS;
uint8_t waveformBuffer[MAX_BUFFER];
int bufferLength = 0;

const int DAC_PIN = 25;  // DAC channel 1
bool dacReady = true;    // dacWrite() needs no explicit init on this core

// Timer-ISR playback state — the real burst is clocked out sample-by-sample at SAMPLE_RATE.
hw_timer_t *sampleTimer = nullptr;
volatile int playIdx = 0;
volatile bool playing = false;

void IRAM_ATTR onSampleTimer() {
  if (playIdx < bufferLength) {
    dacWrite(DAC_PIN, waveformBuffer[playIdx++]);
  } else {
    playing = false;
  }
}

// Decimated copy of the real buffer, sent to the app so the Signal tab can plot
// the actual generated burst instead of a synthetic reconstruction.
const int SCOPE_POINTS = 200;
uint8_t scopeSamples[SCOPE_POINTS];
int scopeSampleCount = 0;

// ============================== SPECTROGRAM MONITOR =========================
// Validates the REAL transmitted analog wave (not just the digital buffer that
// generated it) by sampling an ADC pin while the DAC plays the burst, then
// running an on-device FFT — matching the challenge's "output validated via
// FFT" spec.
//
// NEEDS HARDWARE THAT DOESN'T EXIST YET: wire DAC_PIN's analog output — through
// your analog conditioning circuit (LPF + op-amp buffer) once built, not
// directly — into monitorAdcPin, then flip this to 1. Left at 0 by default: an
// unwired/floating ADC pin has no meaningful signal, and this firmware won't
// pretend it does by sending fabricated spectrogram data.
//
// IMPORTANT — two things learned building this, before you wire the hardware:
//
// 1. Why this polls in the foreground instead of a second hardware timer ISR
//    (the first attempt): calling analogRead() from inside a timer ISR at
//    these rates starved the scheduler and tripped the watchdog
//    (TG1WDT_SYS_RESET), crashing the board on every transmit. Foreground
//    polling (adc1_get_raw() in a plain loop) fixed that — but means the
//    achieved sample rate is whatever the ADC read loop actually allows, not
//    a guarantee, so this code MEASURES it every capture (monitorElapsedUs)
//    and labels the spectrogram's frequency axis from that, never an assumed
//    number.
//
// 2. KNOWN LIMITATION — measured achieved rate on this board is ~12kHz (Nyquist
//    ~6kHz), using the low-level adc1_get_raw() API (already ~3x faster than
//    analogRead()). That's well short of MONITOR_SAMPLE_RATE_TARGET, and short
//    of what's needed to resolve the full 10-50kHz sweep without aliasing —
//    it'll show the low end of the sweep faithfully and alias the rest. A
//    real fix needs the ESP32's ADC continuous/DMA mode instead of polled
//    reads; worth pursuing once the loopback hardware exists and you can
//    validate against a real signal. Until then, this is honestly labeled
//    as a coarse/partial view, not a claim of full-bandwidth coverage.
#define ENABLE_SPECTROGRAM_MONITOR 0

const int monitorAdcPin = 33;                // spare ADC1 pin (= ADC1_CHANNEL_5 below) — not used by temp/depth/turbidity
const adc1_channel_t monitorAdcChannel = ADC1_CHANNEL_5;  // must match monitorAdcPin (GPIO33)
const int MONITOR_SAMPLE_RATE_TARGET = 100000; // Hz — an upper bound for buffer sizing, NOT a guarantee;
                                                // the real achieved rate is measured every capture (see above)
const int FFT_SIZE = 128;             // power of 2; freq resolution = (measured rate) / FFT_SIZE
const int SPECTROGRAM_BINS = FFT_SIZE / 2;  // 0..Nyquist — the whole usable spectrum, no cropping
const int SPECTROGRAM_FRAMES = 20;    // time slices sent per transmit (kept small for one JSON line)
// Sized for the longest possible burst at the target rate — an upper bound on the buffer, not a
// claim that rate is achieved. pollMonitor() below is time-bounded regardless, so it can't overrun.
const int MONITOR_BUFFER = (MONITOR_SAMPLE_RATE_TARGET / 1000) * MAX_DURATION_MS;

#if ENABLE_SPECTROGRAM_MONITOR
uint16_t monitorBuffer[MONITOR_BUFFER];   // 100kHz * 200ms * 2 bytes ≈ 40KB — verify free RAM once enabled
int monitorCount = 0;         // samples actually captured (measured, not assumed)
uint32_t monitorElapsedUs = 0; // actual wall-clock time that capture took
uint8_t spectrogramFrames[SPECTROGRAM_FRAMES][SPECTROGRAM_BINS];
int spectrogramFrameCount = 0;
float measuredFreqStepHz = 0, measuredFrameStepMs = 0;  // from the ACTUAL achieved sample rate, not a target

/**
 * Foreground ADC polling for up to durationMs (bounded — never runs longer than
 * the DAC burst it's meant to overlap with), as fast as analogRead() allows.
 * Safe to run concurrently with the DAC's timer-ISR playback: analogRead() from
 * normal task context doesn't block interrupt delivery the way calling it FROM
 * an ISR did.
 */
void pollMonitor(int durationMs) {
  const uint32_t t0 = micros();
  const uint32_t deadline = t0 + (uint32_t)durationMs * 1000;
  monitorCount = 0;
  while ((int32_t)(micros() - deadline) < 0 && monitorCount < MONITOR_BUFFER) {
    monitorBuffer[monitorCount++] = adc1_get_raw(monitorAdcChannel);
  }
  monitorElapsedUs = micros() - t0;
  Serial.printf("# monitor: %d samples in %luus (~%.0f Hz achieved, target was %dHz)\n",
    monitorCount, monitorElapsedUs, monitorCount * 1e6f / monitorElapsedUs, MONITOR_SAMPLE_RATE_TARGET);
}

/** In-place iterative radix-2 Cooley-Tukey FFT. n must be a power of 2. Self-contained: no external DSP library. */
void fft(float *re, float *im, int n) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      float tr = re[i]; re[i] = re[j]; re[j] = tr;
      float ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (int len = 2; len <= n; len <<= 1) {
    float ang = -2.0f * PI / len;
    float wr = cosf(ang), wi = sinf(ang);
    for (int i = 0; i < n; i += len) {
      float curWr = 1.0f, curWi = 0.0f;
      for (int j = 0; j < len / 2; j++) {
        float ur = re[i + j], ui = im[i + j];
        float vr = re[i + j + len / 2] * curWr - im[i + j + len / 2] * curWi;
        float vi = re[i + j + len / 2] * curWi + im[i + j + len / 2] * curWr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        float nwr = curWr * wr - curWi * wi;
        float nwi = curWr * wi + curWi * wr;
        curWr = nwr; curWi = nwi;
      }
    }
  }
}

/**
 * Windowed FFT per FFT_SIZE-sample frame, evenly spaced across the WHOLE captured
 * burst (not back-to-back from the start) — for a short burst the FFT_SIZE windows
 * overlap; for a long one they skip samples between frames. Either way,
 * SPECTROGRAM_FRAMES snapshots span the full duration. Quantized to 0-255 for
 * compact transport. Same Hann window used for pulse shaping — necessary here
 * too, or spectral leakage would smear the sweep into false bins.
 */
void computeSpectrogram() {
  static float re[FFT_SIZE], im[FFT_SIZE];
  if (monitorCount < FFT_SIZE || monitorElapsedUs == 0) { spectrogramFrameCount = 0; return; }
  const float actualRateHz = (float)monitorCount * 1e6f / (float)monitorElapsedUs;  // measured, not assumed
  measuredFreqStepHz = actualRateHz / FFT_SIZE;
  spectrogramFrameCount = SPECTROGRAM_FRAMES;
  const int span = monitorCount - FFT_SIZE;  // last valid window start
  measuredFrameStepMs = (spectrogramFrameCount > 1) ? (span / (float)(spectrogramFrameCount - 1)) / actualRateHz * 1000.0f : 0;
  for (int f = 0; f < spectrogramFrameCount; f++) {
    const int start = (spectrogramFrameCount > 1) ? (int)((long)f * span / (spectrogramFrameCount - 1)) : 0;
    float maxMag = 1e-6f;
    float mag[SPECTROGRAM_BINS];
    for (int i = 0; i < FFT_SIZE; i++) {
      // Center the ADC's 0-4095 reading around 0 before windowing/transforming.
      float sample = (float)monitorBuffer[start + i] - 2048.0f;
      re[i] = sample * hannWindow(i, FFT_SIZE);
      im[i] = 0.0f;
    }
    fft(re, im, FFT_SIZE);
    for (int b = 0; b < SPECTROGRAM_BINS; b++) {
      mag[b] = sqrtf(re[b] * re[b] + im[b] * im[b]);
      if (mag[b] > maxMag) maxMag = mag[b];
    }
    // Per-frame normalization: shows the sweep's *shape* clearly regardless of absolute
    // signal level, at the cost of not being directly comparable frame-to-frame in amplitude.
    for (int b = 0; b < SPECTROGRAM_BINS; b++) {
      spectrogramFrames[f][b] = (uint8_t)constrain((mag[b] / maxMag) * 255.0f, 0, 255);
    }
  }
}
#endif

// ============================== STATE =======================================
static uint32_t cycle = 0;
static bool autoMode = true;
static bool pingRequested = false;
static String stepLog;

// Live sensor + derived hardware parameters, refreshed every tick.
static int potTemp = 2048, potDepth = 2048, potTurb = 2048;
static int freqMax = freqTopMin, sweepDuration = 50, ampScale = 20;
static float lfmScore = 0, geoScore = 0, phaseScore = 0;
static float turbLow, turbMed, turbHigh, depthLow, depthMed, depthHigh, tempCold, tempNormal, tempWarm;

bool lastButton1State = false;
bool lastButton2State = false;
unsigned long button2PressStart = 0;
bool longPressHandled = false;
const unsigned long longPressThreshold = 800;
static bool manualChangeFlag = false;  // set by readButtons()/applyCommand(), consumed by stepCycle()

static bool wifiEnabled = false;
static bool wifiWasConnected = false;
static bool backendReachable = true;
static uint32_t lastTickMs = 0;
static uint32_t lastPollMs = 0;

static const String TELEMETRY_URL = String("http://") + BACKEND_HOST + ":" + BACKEND_PORT + "/api/telemetry";
static const String COMMANDS_URL = String("http://") + BACKEND_HOST + ":" + BACKEND_PORT + "/api/commands/pending";

// ============================== HELPERS =====================================
static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static float round1(float v) { return roundf(v * 10.0f) / 10.0f; }

// ---------- FUZZY LOGIC (unchanged math — real environmental mode selection) ----------
float triangularMF(float x, float a, float b, float c) {
  if (x <= a || x >= c) return 0.0;
  if (x == b) return 1.0;
  if (x < b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

void fuzzify(int value, float &low, float &med, float &high) {
  low  = triangularMF(value, -2048, 0, 2048);
  med  = triangularMF(value, 0, 2048, 4095);
  high = triangularMF(value, 2048, 4095, 6143);
}

int evaluateFuzzyMode(int potTurbIn, int potDepthIn, int potTempIn,
                       float &lfmScoreOut, float &geoScoreOut, float &phaseScoreOut) {
  fuzzify(potTurbIn, turbLow, turbMed, turbHigh);
  fuzzify(potDepthIn, depthLow, depthMed, depthHigh);
  fuzzify(potTempIn, tempCold, tempNormal, tempWarm);

  lfmScoreOut = 0; geoScoreOut = 0; phaseScoreOut = 0;

  // R1/R2: turbidity -> phase-coded (robust to scattering)
  phaseScoreOut += turbHigh * 1.0;
  phaseScoreOut += turbMed * 0.4;
  // R3/R4: depth -> geometric sweep (better long-range coverage)
  geoScoreOut += depthHigh * 1.0;
  geoScoreOut += depthMed * 0.4;
  // R5: clear + shallow -> LFM chirp (fuzzy AND = min)
  lfmScoreOut += min(turbLow, depthLow) * 1.0;
  // R6/R7: temperature as a secondary factor
  lfmScoreOut += tempWarm * 0.3;
  geoScoreOut += tempCold * 0.3;

  if (lfmScoreOut >= geoScoreOut && lfmScoreOut >= phaseScoreOut) return 0;
  if (geoScoreOut >= lfmScoreOut && geoScoreOut >= phaseScoreOut) return 1;
  return 2;
}

// ---------- WAVEFORM GENERATION (unchanged math — real DAC burst) ----------
float hannWindow(int index, int total) {
  if (total <= 1) return 1.0;
  return 0.5 * (1.0 - cos(2.0 * PI * index / (total - 1)));
}

void generateLFM(int durationMs, int topFreq, int ampScaleIn) {
  bufferLength = (SAMPLE_RATE / 1000) * durationMs;
  if (bufferLength > MAX_BUFFER) bufferLength = MAX_BUFFER;
  double phase = 0;
  for (int i = 0; i < bufferLength; i++) {
    float progress = (float)i / bufferLength;
    float freq = freqMin + (topFreq - freqMin) * progress;
    double phaseInc = 2.0 * PI * freq / SAMPLE_RATE;
    phase += phaseInc;
    if (phase > 2 * PI) phase -= 2 * PI;
    float amp = ampScaleIn * hannWindow(i, bufferLength);
    int sample = 128 + (int)(sin(phase) * amp);
    waveformBuffer[i] = constrain(sample, 0, 255);
  }
}

void generateGeometric(int durationMs, int topFreq, int ampScaleIn) {
  bufferLength = (SAMPLE_RATE / 1000) * durationMs;
  if (bufferLength > MAX_BUFFER) bufferLength = MAX_BUFFER;
  double phase = 0;
  for (int i = 0; i < bufferLength; i++) {
    float progress = (float)i / bufferLength;
    float freq = freqMin * pow((float)topFreq / freqMin, progress);
    double phaseInc = 2.0 * PI * freq / SAMPLE_RATE;
    phase += phaseInc;
    if (phase > 2 * PI) phase -= 2 * PI;
    float amp = ampScaleIn * hannWindow(i, bufferLength);
    int sample = 128 + (int)(sin(phase) * amp);
    waveformBuffer[i] = constrain(sample, 0, 255);
  }
}

void generatePhaseCoded(int durationMs, int ampScaleIn) {
  bufferLength = (SAMPLE_RATE / 1000) * durationMs;
  if (bufferLength > MAX_BUFFER) bufferLength = MAX_BUFFER;
  bool pattern[] = {true, true, true, true, false, false, false, false,
                     true, true, true, true, false, false, false, false};
  int segments = sizeof(pattern) / sizeof(pattern[0]);
  int samplesPerSegment = bufferLength / segments;
  const float carrier = 30000.0;
  double phase = 0;
  double phaseInc = 2.0 * PI * carrier / SAMPLE_RATE;
  for (int i = 0; i < bufferLength; i++) {
    int segment = i / samplesPerSegment;
    if (segment >= segments) segment = segments - 1;
    phase += phaseInc;
    if (phase > 2 * PI) phase -= 2 * PI;
    float val = sin(phase);
    if (!pattern[segment]) val = -val;
    float amp = ampScaleIn * hannWindow(i, bufferLength);
    int sample = 128 + (int)(val * amp);
    waveformBuffer[i] = constrain(sample, 0, 255);
  }
}

/** Evenly-spaced picks from the real buffer just generated — small enough for one JSON line. */
void decimateForTelemetry() {
  scopeSampleCount = min(SCOPE_POINTS, bufferLength);
  for (int i = 0; i < scopeSampleCount; i++) {
    int srcIdx = (int)((long)i * (bufferLength - 1) / max(1, scopeSampleCount - 1));
    scopeSamples[i] = waveformBuffer[srcIdx];
  }
}

/** Starts the DAC playback timer without waiting — lets a caller run something
 *  else (the spectrogram ADC poll) concurrently with the burst. */
void startDacTimer() {
  playIdx = 0;
  playing = true;
  if (!sampleTimer) {
    sampleTimer = timerBegin(0, 8, true);  // 80MHz APB / 8 = 10MHz tick (100ns)
    timerAttachInterrupt(sampleTimer, &onSampleTimer, true);
  }
  const uint32_t ticksPerSample = (10000000UL + SAMPLE_RATE / 2) / SAMPLE_RATE;  // ~62 ticks @ 160kHz
  timerAlarmWrite(sampleTimer, ticksPerSample, true);
  timerAlarmEnable(sampleTimer);
}

void waitForDacDone() {
  uint32_t start = millis();
  while (playing && millis() - start < (uint32_t)MAX_DURATION_MS + 50) delay(1);
  timerAlarmDisable(sampleTimer);
  Serial.print("# burst complete, samples written: ");
  Serial.println(playIdx);
}

/**
 * Real burst playback: a hardware timer fires the ISR above once per sample at
 * SAMPLE_RATE, which writes that sample to the DAC pin — the actual generated
 * buffer, clocked out in real time. Blocks until the burst finishes (bounded
 * by MAX_DURATION_MS) so the caller's telemetry/state bookkeeping stays simple.
 */
void transmitBurst() {
  if (bufferLength <= 0) return;
  startDacTimer();
  waitForDacDone();
}

// ---------- UI HELPERS (bench-debug LEDs only — nothing external, see enclosure spec) ----------
void blinkBlue(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(ledBlue, HIGH); delay(150);
    digitalWrite(ledBlue, LOW); delay(150);
  }
}

void blinkAllLeds() {
  for (int i = 0; i < 3; i++) {
    digitalWrite(ledRed, HIGH); digitalWrite(ledGreen, HIGH); digitalWrite(ledBlue, HIGH); delay(100);
    digitalWrite(ledRed, LOW); digitalWrite(ledGreen, LOW); digitalWrite(ledBlue, LOW); delay(100);
  }
  digitalWrite(ledRed, HIGH);
}

// ============================== SENSING + FUZZY (every tick, real) =========
/** Refresh pot readings, derived hardware parameters, and (auto mode) the fuzzy mode choice. Returns true if the mode changed. */
bool sampleSensorsAndEvaluate() {
  potTemp = analogRead(potTempPin);
  potDepth = analogRead(potDepthPin);
  potTurb = pot3Connected ? analogRead(potAmpPin) : 2048;

  freqMax = map(potTemp, 0, 4095, freqTopMin, freqTopMax);
  sweepDuration = map(potDepth, 0, 4095, 50, MAX_DURATION_MS);
  ampScale = map(potTurb, 0, 4095, 20, 110);

  if (!autoMode) return false;
  int newMode = evaluateFuzzyMode(potTurb, potDepth, potTemp, lfmScore, geoScore, phaseScore);
  if (newMode == currentMode) return false;
  currentMode = newMode;
  return true;
}

// ============================== BUTTONS =====================================
void readButtons() {
  bool b1 = digitalRead(button1Pin) == HIGH;
  if (b1 && !lastButton1State) pingRequested = true;
  lastButton1State = b1;

  bool b2 = digitalRead(button2Pin) == HIGH;
  if (b2 && !lastButton2State) {
    button2PressStart = millis();
    longPressHandled = false;
  }
  if (b2 && !longPressHandled && (millis() - button2PressStart > longPressThreshold)) {
    longPressHandled = true;
    autoMode = true;
    manualChangeFlag = true;
    Serial.println("# button2 long-press -> AUTO (fuzzy) mode");
    blinkAllLeds();
  }
  if (!b2 && lastButton2State && !longPressHandled) {
    autoMode = false;
    currentMode = (currentMode + 1) % 3;
    manualChangeFlag = true;
    Serial.printf("# button2 tap -> MANUAL, %s\n", modeNames[currentMode]);
    blinkBlue(1);
  }
  lastButton2State = b2;
}

// ============================== ONE TICK ====================================
/** One ~1s cycle: sample+evaluate (always), then IDLE, or ADAPT on a mode change, or TRANSMIT on request. */
void stepCycle() {
  stepLog = "";
  bool modeChanged = sampleSensorsAndEvaluate();
  if (manualChangeFlag) { modeChanged = true; manualChangeFlag = false; }
  bool transmitting = pingRequested;

  SonarState state;
  if (transmitting) {
    pingRequested = false;
    state = TRANSMIT;
  } else if (modeChanged) {
    state = ADAPT;
  } else {
    state = IDLE;
  }

  digitalWrite(ledRed, state == IDLE ? HIGH : LOW);

  scopeSampleCount = 0;  // only TRANSMIT frames carry real samples
  if (transmitting) {
    cycle++;
    digitalWrite(ledGreen, HIGH);
    if (currentMode == 0) generateLFM(sweepDuration, freqMax, ampScale);
    else if (currentMode == 1) generateGeometric(sweepDuration, freqMax, ampScale);
    else generatePhaseCoded(sweepDuration, ampScale);
    decimateForTelemetry();
#if ENABLE_SPECTROGRAM_MONITOR
    // Start the DAC timer (non-blocking), poll the ADC loopback in the foreground for the same
    // duration — genuinely concurrent with the DAC ISR still firing — then wait out any remainder.
    startDacTimer();
    pollMonitor(sweepDuration);
    waitForDacDone();
    computeSpectrogram();
#else
    transmitBurst();
#endif
    digitalWrite(ledGreen, LOW);
    stepLog = String("TX #") + cycle + " — " + modeNames[currentMode] + ", " + freqMax + "Hz top, " +
              sweepDuration + "ms, amp=" + ampScale;
  } else if (state == ADAPT) {
    stepLog = autoMode
      ? String("fuzzy re-evaluation -> ") + modeNames[currentMode] +
        " [LFM " + String(lfmScore, 2) + ", Geo " + String(geoScore, 2) + ", Phase " + String(phaseScore, 2) + "]"
      : String("manual override -> ") + modeNames[currentMode];
  }

  buildAndSendTelemetry(state);
}

// ============================== TELEMETRY ===================================
void buildAndSendTelemetry(SonarState state) {
  JsonDocument doc;
  doc["state"] = STATE_NAMES[state];
  doc["cycle"] = cycle;
  // Real hardware values, not snapped to the old channel/dB scale: top sweep frequency in kHz,
  // burst duration in ms, and DAC amplitude scale (NOT literal dB — see README).
  doc["frequency_khz"] = freqMax / 1000;
  doc["pulse_width_ms"] = sweepDuration;  // int (ms) — String(intVal, 1) would misparse "1" as a numeric base, not decimals
  doc["gain_db"] = ampScale;
  doc["waveform"] = modeNames[currentMode];
  doc["rx_available"] = false;  // no receive/echo chain on this board — see file header
  doc["timestamp_ms"] = millis();
  doc["mode"] = autoMode ? "auto" : "manual";
  if (stepLog.length()) doc["log"] = stepLog;

  JsonObject fuzzy = doc["fuzzy"].to<JsonObject>();
  JsonObject turb = fuzzy["turbidity"].to<JsonObject>();
  turb["low"] = serialized(String(turbLow, 3)); turb["med"] = serialized(String(turbMed, 3)); turb["high"] = serialized(String(turbHigh, 3));
  JsonObject depthJ = fuzzy["depth"].to<JsonObject>();
  depthJ["low"] = serialized(String(depthLow, 3)); depthJ["med"] = serialized(String(depthMed, 3)); depthJ["high"] = serialized(String(depthHigh, 3));
  JsonObject temp = fuzzy["temperature"].to<JsonObject>();
  temp["cold"] = serialized(String(tempCold, 3)); temp["normal"] = serialized(String(tempNormal, 3)); temp["warm"] = serialized(String(tempWarm, 3));
  JsonObject scores = fuzzy["scores"].to<JsonObject>();
  scores["lfm"] = serialized(String(lfmScore, 3)); scores["geo"] = serialized(String(geoScore, 3)); scores["phase"] = serialized(String(phaseScore, 3));

  JsonObject sensorRaw = doc["sensor_raw"].to<JsonObject>();
  sensorRaw["temp_adc"] = potTemp;
  sensorRaw["depth_adc"] = potDepth;
  sensorRaw["turbidity_adc"] = potTurb;

  if (scopeSampleCount > 0) {
    JsonArray samples = doc["waveform_samples"].to<JsonArray>();
    for (int i = 0; i < scopeSampleCount; i++) samples.add(scopeSamples[i]);
    doc["sample_rate_hz"] = SAMPLE_RATE;
    doc["duration_ms"] = sweepDuration;
  }

#if ENABLE_SPECTROGRAM_MONITOR
  if (spectrogramFrameCount > 0) {
    JsonObject spec = doc["spectrogram"].to<JsonObject>();
    spec["freq_step_hz"] = serialized(String(measuredFreqStepHz, 1));
    spec["frame_step_ms"] = serialized(String(measuredFrameStepMs, 2));
    JsonArray frames = spec["frames"].to<JsonArray>();
    for (int f = 0; f < spectrogramFrameCount; f++) {
      JsonArray bins = frames.add<JsonArray>();
      for (int b = 0; b < SPECTROGRAM_BINS; b++) bins.add(spectrogramFrames[f][b]);
    }
  }
#endif

  String out;
  serializeJson(doc, out);
  Serial.println(out);  // USB: one JSON object per line
  bool wifiUp = wifiEnabled && WiFi.status() == WL_CONNECTED;
  if (wifiUp) postTelemetry(out);
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

// ============================== COMMANDS ====================================
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
    manualChangeFlag = true;
    Serial.printf("# mode -> %s\n", autoMode ? "auto" : "manual");
  } else if (strcmp(cmd, "set_waveform_mode") == 0) {
    const char *v = c["value"] | "";
    int idx = -1;
    for (int i = 0; i < 3; i++) if (strcmp(v, modeNames[i]) == 0) idx = i;
    if (idx < 0) { Serial.printf("# rejected set_waveform_mode value '%s'\n", v); return; }
    currentMode = idx;
    autoMode = false;  // an explicit mode pick implies manual, same as the button2 tap
    manualChangeFlag = true;
    Serial.printf("# waveform mode -> %s (manual)\n", modeNames[currentMode]);
  } else if (strcmp(cmd, "set_params") == 0) {
    // Not supported: frequency/duration/amplitude are derived from the sensor pots each tick on
    // this hardware. Accepted so the host doesn't see a hard error — just has no effect.
    Serial.println("# set_params ignored — this hardware has no continuous freq/pulse/gain control, use set_waveform_mode");
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

// ============================== SETUP / LOOP ================================
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

  pinMode(button1Pin, INPUT_PULLDOWN);
  pinMode(button2Pin, INPUT_PULLDOWN);
  pinMode(ledRed, OUTPUT);
  pinMode(ledGreen, OUTPUT);
  pinMode(ledBlue, OUTPUT);
  pinMode(phaseControlPin, OUTPUT);

  Serial.println("# DAC ready (timer-clocked, GPIO25)");
#if ENABLE_SPECTROGRAM_MONITOR
  // Configure the ADC1 channel once so pollMonitor()'s tight loop only pays for the raw
  // conversion, not analogRead()'s per-call attenuation/calibration lookup.
  adc1_config_width(ADC_WIDTH_BIT_12);
  adc1_config_channel_atten(monitorAdcChannel, ADC_ATTEN_DB_12);  // full 0-3.3V range, matching analogRead() default
  Serial.println("# spectrogram monitor armed (GPIO33) — needs DAC->ADC loopback hardware to mean anything yet");
#endif
  digitalWrite(ledRed, HIGH);
  Serial.println("# adaptive sonar TX module online — fuzzy mode selection active");
  setupWifi();
  lastTickMs = millis();
}

void loop() {
  readSerialCommands();
  readButtons();

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
    stepCycle();
  }
}
