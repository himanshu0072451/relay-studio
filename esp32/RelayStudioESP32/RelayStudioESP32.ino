
/*
  Relay Studio - ESP32 Firmware
  -----------------------------------------------
  Features:
  - Four active-LOW relay inputs
  - Wi-Fi connection and Node.js server polling
  - Command masks for independent relay control
  - Optional timed pulses with automatic OFF
  - Minimum transition gap to reduce relay chatter
  - Safe OFF state on Wi-Fi/server loss
  - Diagnostic logs for commands, GPIO and safety events

  Libraries:
  - ArduinoJson (install using Arduino Library Manager)

  SAFETY:
  - Keep relay contacts disconnected from mains during testing.
  - Verify the relay module's required supply voltage/current.
  - Never connect a relay coil directly to an ESP32 GPIO.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// =====================================================
// CONFIGURATION
// =====================================================

const char* WIFI_SSID = "PI";
const char* WIFI_PASSWORD = "12345678";

const char* SERVER_IP = "192.168.137.1";
const uint16_t SERVER_PORT = 8787;

// Must match ESP_TOKEN used by server.js.
const char* ESP_TOKEN = "20766f660aba93b0c6d1f5228b0c67a3dff0fbf256138b8c38a5b7774aade5db";

// GPIO mapping: Relay 1, 2, 3, 4
const uint8_t RELAY_PINS[4] = {16, 17, 18, 19};
const uint8_t RELAY_COUNT = 4;

// Most 4-channel relay modules are active-LOW.
// Change to false if your module is active-HIGH.
const bool RELAY_ACTIVE_LOW = true;

// Timing
const uint32_t POLL_INTERVAL_MS = 100;
const uint32_t REPORT_INTERVAL_MS = 600;
const uint32_t SERVER_LOSS_MS = 3000;
const uint32_t MIN_TRANSITION_GAP_MS = 55;
const uint32_t HTTP_TIMEOUT_MS = 500;

// Maximum supported pulse duration
const uint32_t MAX_PULSE_MS = 500;

// =====================================================
// STATE
// =====================================================

uint8_t activeMask = 0;
uint8_t pendingMask = 0;

bool pendingCommand = false;
bool pulseActive = false;
bool serverTimeoutHandled = false;

uint32_t lastPollAt = 0;
uint32_t lastReportAt = 0;
uint32_t lastSuccessfulServerAt = 0;
uint32_t lastTransitionAt[4] = {0, 0, 0, 0};
uint32_t pulseDeadline = 0;
uint32_t lastHeartbeatAt = 0;

// =====================================================
// RELAY HELPERS
// =====================================================

uint8_t levelFor(bool on) {
  if (RELAY_ACTIVE_LOW) {
    return on ? LOW : HIGH;
  }

  return on ? HIGH : LOW;
}

void writeRelay(uint8_t index, bool on) {
  if (index >= RELAY_COUNT) return;

  digitalWrite(RELAY_PINS[index], levelFor(on));
}

void allOff(const char* reason) {
  bool hadState =
    activeMask != 0 ||
    pendingCommand ||
    pendingMask != 0 ||
    pulseActive;

  // Always force all physical outputs OFF.
  for (uint8_t i = 0; i < RELAY_COUNT; i++) {
    writeRelay(i, false);
  }

  activeMask = 0;
  pendingMask = 0;
  pendingCommand = false;
  pulseActive = false;
  pulseDeadline = 0;

  if (hadState) {
    Serial.printf("[SAFETY] All relays OFF: %s\n", reason);
  }
}

void setMaskImmediate(uint8_t newMask) {
  newMask &= 0x0F;

  uint32_t transitionTime = millis();

  for (uint8_t i = 0; i < RELAY_COUNT; i++) {
    bool wasOn = (activeMask & (1U << i)) != 0;
    bool wantsOn = (newMask & (1U << i)) != 0;

    if (wasOn == wantsOn) {
      continue;
    }

    // Pace normal transitions, but do not delay emergency OFF.
    if (lastTransitionAt[i] != 0 &&
        transitionTime - lastTransitionAt[i] <
          MIN_TRANSITION_GAP_MS) {
      continue;
    }

    writeRelay(i, wantsOn);

    Serial.printf(
      "[GPIO] Relay %u | pin=%u | state=%s | level=%s\n",
      i + 1,
      RELAY_PINS[i],
      wantsOn ? "ON" : "OFF",
      wantsOn
        ? (RELAY_ACTIVE_LOW ? "LOW" : "HIGH")
        : (RELAY_ACTIVE_LOW ? "HIGH" : "LOW")
    );

    lastTransitionAt[i] = transitionTime;

    if (wantsOn) {
      activeMask |= (1U << i);
    } else {
      activeMask &= ~(1U << i);
    }
  }
}

bool canApplyMask(uint8_t mask, uint32_t currentTime) {
  for (uint8_t i = 0; i < RELAY_COUNT; i++) {
    bool differs =
      ((activeMask ^ mask) & (1U << i)) != 0;

    if (
      differs &&
      lastTransitionAt[i] != 0 &&
      currentTime - lastTransitionAt[i] <
        MIN_TRANSITION_GAP_MS
    ) {
      return false;
    }
  }

  return true;
}

// =====================================================
// SERVER URLS
// =====================================================

String nextCommandUrl() {
  return String("http://") +
    SERVER_IP + ":" +
    String(SERVER_PORT) +
    "/api/esp/next?token=" + ESP_TOKEN;
}

String reportUrl() {
  return String("http://") +
    SERVER_IP + ":" +
    String(SERVER_PORT) +
    "/api/esp/report?token=" + ESP_TOKEN;
}

// =====================================================
// POLL SERVER
// =====================================================

void pollServer() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);

  if (!http.begin(nextCommandUrl())) {
    Serial.println("[HTTP ERROR] Could not initialize command request");
    return;
  }

  int code = http.GET();

  if (code == HTTP_CODE_OK) {
    // IMPORTANT: record the time of the successful response.
    lastSuccessfulServerAt = millis();
    serverTimeoutHandled = false;

    String body = http.getString();

    StaticJsonDocument<192> doc;
    DeserializationError err = deserializeJson(doc, body);

    if (err) {
      Serial.printf("[JSON ERROR] %s\n", err.c_str());
      http.end();
      return;
    }

    if (!doc["mask"].is<int>()) {
      http.end();
      return;
    }

    int mask = doc["mask"].as<int>();

    // Server uses -1 when no command is queued.
    if (mask >= 0 && mask <= 15) {
      uint32_t duration = doc["durationMs"] | 0U;

      Serial.printf(
        "[COMMAND] Received mask=%d duration=%lu ms\n",
        mask,
        (unsigned long)duration
      );

      pendingMask = (uint8_t)mask;
      pendingCommand = true;

      Serial.printf(
        "[DEBUG] Pending mask=%u command=%d\n",
        pendingMask,
        pendingCommand
      );

      if (duration > 0 && duration <= MAX_PULSE_MS) {
        pulseActive = true;
        pulseDeadline = millis() + duration;

        Serial.printf(
          "[PULSE] Automatic OFF scheduled in %lu ms\n",
          (unsigned long)duration
        );
      } else {
        pulseActive = false;
        pulseDeadline = 0;
      }
    }
  } else {
    Serial.printf(
      "[HTTP ERROR] Command poll returned %d\n",
      code
    );
  }

  http.end();
}

// =====================================================
// REPORT RELAY STATE
// =====================================================

void reportState() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);

  if (!http.begin(reportUrl())) {
    Serial.println("[HTTP ERROR] Could not initialize state report");
    return;
  }

  http.addHeader("Content-Type", "application/json");

  String payload =
    String("{\"mask\":") +
    String(activeMask) +
    "}";

  int code = http.POST(payload);

  if (code < 0) {
    Serial.printf(
      "[HTTP ERROR] State report failed: %s\n",
      http.errorToString(code).c_str()
    );
  }

  http.end();
}

// =====================================================
// WIFI
// =====================================================

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.println("[WIFI] Connecting...");

  uint32_t startedAt = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - startedAt < 15000
  ) {
    delay(250);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.printf(
      "[WIFI] Connected. ESP32 IP: %s\n",
      WiFi.localIP().toString().c_str()
    );

    Serial.printf(
      "[SERVER] %s\n",
      nextCommandUrl().c_str()
    );
  } else {
    Serial.println();
    Serial.println("[WIFI] Connection failed; will retry.");
  }
}

// =====================================================
// SETUP
// =====================================================

void setup() {
  Serial.begin(115200);
  delay(300);

  // Configure safe OFF levels before enabling outputs.
  for (uint8_t i = 0; i < RELAY_COUNT; i++) {
    digitalWrite(RELAY_PINS[i], levelFor(false));
    pinMode(RELAY_PINS[i], OUTPUT);
    writeRelay(i, false);
  }

  activeMask = 0;
  pendingMask = 0;
  pendingCommand = false;

  Serial.println();
  Serial.println("================================");
  Serial.println("       RELAY STUDIO ESP32       ");
  Serial.println("================================");
  Serial.println("[BOOT] All relay outputs OFF");

  connectWiFi();
}

// =====================================================
// MAIN LOOP
// =====================================================

void loop() {
  uint32_t now = millis();

  // Heartbeat for diagnostics.
  if (now - lastHeartbeatAt >= 1000) {
    lastHeartbeatAt = now;

    Serial.printf(
      "[HEARTBEAT] active=%u pending=%u command=%d wifi=%d\n",
      activeMask,
      pendingMask,
      pendingCommand,
      WiFi.status() == WL_CONNECTED
    );
  }

  // Network safety.
  if (WiFi.status() != WL_CONNECTED) {
    allOff("Wi-Fi disconnected");

    static uint32_t lastReconnectAt = 0;

    if (millis() - lastReconnectAt >= 3000) {
      lastReconnectAt = millis();
      Serial.println("[WIFI] Attempting reconnection...");
      WiFi.reconnect();
    }

    delay(10);
    return;
  }

  // Poll the server.
  now = millis();

  if (now - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = now;
    pollServer();
  }

  // Report current state.
  now = millis();

  if (now - lastReportAt >= REPORT_INTERVAL_MS) {
    lastReportAt = now;
    reportState();
  }

  // Check pulse expiry using a fresh timestamp.
  now = millis();

  if (
    pulseActive &&
    (int32_t)(now - pulseDeadline) >= 0
  ) {
    pulseActive = false;
    pulseDeadline = 0;

    pendingMask = 0;
    pendingCommand = true;

    Serial.println("[PULSE] Expired; scheduling all relays OFF");
  }

  /*
    CRITICAL FIX:
    Use a fresh millis() value here.

    Do not subtract lastSuccessfulServerAt from the
    timestamp captured before pollServer(). A successful
    poll can update lastSuccessfulServerAt to a newer
    value, causing unsigned subtraction to underflow.
  */
  now = millis();

  if (
    lastSuccessfulServerAt != 0 &&
    now - lastSuccessfulServerAt > SERVER_LOSS_MS
  ) {
    if (!serverTimeoutHandled) {
      allOff("Server communication timeout");
      serverTimeoutHandled = true;
    }

    delay(2);
    return;
  }

  // Apply a queued command.
  if (pendingCommand) {
    now = millis();

    if (canApplyMask(pendingMask, now)) {
      uint8_t targetMask = pendingMask;

      Serial.printf(
        "[APPLY] target=%u current=%u\n",
        targetMask,
        activeMask
      );

      setMaskImmediate(targetMask);

      // If the target was reached, clear the queued command.
      if (activeMask == targetMask) {
        pendingCommand = false;

        Serial.printf(
          "[APPLY] Complete. activeMask=%u\n",
          activeMask
        );
      } else {
        Serial.printf(
          "[APPLY] Incomplete. activeMask=%u target=%u\n",
          activeMask,
          targetMask
        );
      }
    }
  }

  delay(2);
}
