#include <SPI.h>
#include <MFRC522.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

// Configure these values before flashing. Do not commit real credentials.
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *API_BASE_URL = "https://antende.onrender.com";
const char *DEVICE_API_KEY = "REPLACE_WITH_RENDER_DEVICE_API_KEY";
const char *DEVICE_ID = "esp32-01";
const char *ROOT_CA_CERT = "";

constexpr uint8_t RFID_SS_PIN = 5;
constexpr uint8_t RFID_RST_PIN = 22;
constexpr uint8_t GREEN_LED_PIN = 26;
constexpr uint8_t RED_LED_PIN = 27;
constexpr uint8_t BUZZER_PIN = 25;
constexpr unsigned long SCAN_COOLDOWN_MS = 2000;
constexpr unsigned long COMMAND_POLL_MS = 5000;

MFRC522 reader(RFID_SS_PIN, RFID_RST_PIN);
String registrationRequestId;
unsigned long lastScanAt = 0;
unsigned long lastCommandPollAt = 0;
bool hasScanned = false;

String makeUrl(const String &path) {
  String base = API_BASE_URL;
  while (base.endsWith("/")) base.remove(base.length() - 1);
  return base + path;
}

bool beginRequest(HTTPClient &http, WiFiClient &plainClient, WiFiClientSecure &secureClient,
                 const String &url) {
  if (url.startsWith("https://")) {
    if (strlen(ROOT_CA_CERT) == 0) {
      Serial.println("HTTPS requires ROOT_CA_CERT; refusing an unverified connection.");
      return false;
    }
    secureClient.setCACert(ROOT_CA_CERT);
    return http.begin(secureClient, url);
  }
  return http.begin(plainClient, url);
}

int sendRequest(const String &path, const String &method, const String &body,
                String &responseBody) {
  HTTPClient http;
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  if (!beginRequest(http, plainClient, secureClient, makeUrl(path))) return -1;
  http.setTimeout(5000);
  http.setConnectTimeout(5000);
  http.setReuse(false);
  http.addHeader("Authorization", String("Bearer ") + DEVICE_API_KEY);
  if (method == "POST") http.addHeader("Content-Type", "application/json");

  int statusCode;
  if (method == "POST") {
    statusCode = http.POST(body);
  } else {
    statusCode = http.GET();
  }
  responseBody = statusCode > 0 ? http.getString() : "";
  if (statusCode <= 0) Serial.printf("HTTP request failed: %s\n", http.errorToString(statusCode).c_str());
  http.end();
  return statusCode;
}

String readCardUid() {
  String uid;
  for (byte index = 0; index < reader.uid.size; index++) {
    if (reader.uid.uidByte[index] < 0x10) uid += "0";
    uid += String(reader.uid.uidByte[index], HEX);
  }
  uid.toUpperCase();
  return uid;
}

void beep(uint8_t times, uint16_t onMs, uint16_t offMs) {
  for (uint8_t index = 0; index < times; index++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(onMs);
    digitalWrite(BUZZER_PIN, LOW);
    if (index + 1 < times) delay(offMs);
  }
}

void clearIndicators() {
  digitalWrite(GREEN_LED_PIN, LOW);
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);
}

void signalAccepted() {
  digitalWrite(GREEN_LED_PIN, HIGH);
  beep(1, 120, 0);
  delay(220);
  clearIndicators();
}

void signalUnknown() {
  digitalWrite(RED_LED_PIN, HIGH);
  beep(2, 100, 110);
  delay(180);
  clearIndicators();
}

void signalDuplicate() {
  digitalWrite(RED_LED_PIN, HIGH);
  beep(1, 300, 0);
  delay(180);
  clearIndicators();
}

void signalNetworkError() {
  for (uint8_t index = 0; index < 3; index++) {
    digitalWrite(RED_LED_PIN, HIGH);
    digitalWrite(BUZZER_PIN, HIGH);
    delay(80);
    clearIndicators();
    delay(90);
  }
}

void pollRegistrationCommand() {
  if (WiFi.status() != WL_CONNECTED || millis() - lastCommandPollAt < COMMAND_POLL_MS) return;
  lastCommandPollAt = millis();
  String response;
  const String path = String("/api/device/commands?deviceId=") + DEVICE_ID;
  Serial.println("Polling registration command...");
  const int statusCode = sendRequest(path, "GET", "", response);
  Serial.printf("Registration command HTTP status: %d\n", statusCode);
  if (statusCode != 200) return;

  DynamicJsonDocument document(256);
  if (deserializeJson(document, response)) {
    Serial.println("Could not parse device command response.");
    return;
  }
  const char *requestId = document["registrationRequestId"];
  registrationRequestId = requestId ? String(requestId) : "";
}

void processCard(const String &uid) {
  Serial.printf("Card UID: %s\n", uid.c_str());
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi unavailable; attendance was not confirmed.");
    signalNetworkError();
    return;
  }

  String response;
  int statusCode;
  if (registrationRequestId.length()) {
    DynamicJsonDocument request(256);
    request["requestId"] = registrationRequestId;
    request["uid"] = uid;
    String body;
    serializeJson(request, body);
    statusCode = sendRequest("/api/device/registration-scans", "POST", body, response);
    if (statusCode == 200) {
      registrationRequestId = "";
      Serial.println("Card UID captured for student registration.");
      digitalWrite(GREEN_LED_PIN, HIGH);
      beep(1, 100, 0);
      delay(180);
      clearIndicators();
    } else {
      signalNetworkError();
    }
    return;
  }

  DynamicJsonDocument request(256);
  request["uid"] = uid;
  String body;
  serializeJson(request, body);
  statusCode = sendRequest("/api/attendance/scan", "POST", body, response);
  if (statusCode < 200 || statusCode >= 300) {
    Serial.println("Server did not confirm attendance; no success signal sent.");
    signalNetworkError();
    return;
  }

  DynamicJsonDocument result(512);
  if (deserializeJson(result, response)) {
    Serial.println("Invalid server response; no success signal sent.");
    signalNetworkError();
    return;
  }
  const char *status = result["status"] | "";
  if (strcmp(status, "accepted") == 0) {
    Serial.printf("Attendance saved for %s.\n", result["student"]["full_name"] | "student");
    signalAccepted();
  } else if (strcmp(status, "duplicate") == 0) {
    Serial.println("Duplicate attendance; no additional record was created.");
    signalDuplicate();
  } else if (strcmp(status, "unknown") == 0) {
    Serial.println("Unknown or inactive card.");
    signalUnknown();
  } else {
    Serial.println("Unexpected server response; no success signal sent.");
    signalNetworkError();
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  clearIndicators();

  SPI.begin();
  reader.PCD_Init();
  Serial.println("RC522 initialized.");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  const unsigned long connectStarted = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - connectStarted < 20000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nConnected. ESP32 IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWi-Fi not connected. The device will retry.");
  }
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastReconnectAt = 0;
    if (millis() - lastReconnectAt > 10000) {
      lastReconnectAt = millis();
      WiFi.reconnect();
    }
  }
  pollRegistrationCommand();

  if (!reader.PICC_IsNewCardPresent() || !reader.PICC_ReadCardSerial()) {
    delay(10);
    return;
  }

  const String uid = readCardUid();
  reader.PICC_HaltA();
  reader.PCD_StopCrypto1();
  const unsigned long now = millis();
  if (!hasScanned || now - lastScanAt >= SCAN_COOLDOWN_MS) {
    hasScanned = true;
    lastScanAt = now;
    processCard(uid);
  }
  delay(120);
}
