/**
 * CardMint Orders Dashboard V2
 *
 * ESP32-2432S028R firmware for displaying real-time order metrics.
 * Shows combined Stripe + marketplace orders with tap-to-cycle interactions.
 *
 * Hardware: ESP32-2432S028R (Cheap Yellow Display)
 * Display: ILI9341 320x240 TFT
 * Touch: XPT2046 capacitive touch for region interactions
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>
#include <time.h>

// ============================================================================
// Configuration - Load from config.h or use build-time defines
// ============================================================================

#if __has_include("config.h")
  #include "config.h"
#else
  #ifndef WIFI_SSID
    #define WIFI_SSID "your_wifi_ssid"
  #endif
  #ifndef WIFI_PASSWORD
    #define WIFI_PASSWORD "your_wifi_password"
  #endif
  #ifndef API_URL
    #define API_URL "https://cardmintshop.com/api/orders-summary/compact"
  #endif
  #ifndef REFRESH_INTERVAL_MS
    #define REFRESH_INTERVAL_MS 30000
  #endif
  #ifndef DISPLAY_TOKEN
    #define DISPLAY_TOKEN ""
  #endif
#endif

const char* wifi_ssid = WIFI_SSID;
const char* wifi_password = WIFI_PASSWORD;
const char* api_url = API_URL;
const char* display_token = DISPLAY_TOKEN;
const uint32_t refresh_interval_ms = REFRESH_INTERVAL_MS;

// Stale threshold: 2 minutes (120 seconds)
const uint32_t STALE_THRESHOLD_SEC = 120;

// NTP configuration (Central Time with DST)
const char* NTP_SERVER = "pool.ntp.org";
const char* TIMEZONE = "CST6CDT,M3.2.0/2,M11.1.0/2";

// ============================================================================
// Color Palette (RGB565)
// ============================================================================

#define COLOR_BG             0x0841  // Near-black (#080808)
#define COLOR_HEADER         0x1926  // Deep blue-gray (#1C2430)
#define COLOR_SURFACE        0x2104  // Elevated surface (#202020)
#define COLOR_BORDER         0x3186  // Subtle borders (#303030)
#define COLOR_DIVIDER        0x2945  // Divider lines (#282828)

#define COLOR_TEXT           0xFFFF  // Primary text (white)
#define COLOR_TEXT_SECONDARY 0xB596  // Labels - warm gray
#define COLOR_TEXT_MUTED     0x6B4D  // Footer - muted

#define COLOR_MINT           0x2E8B  // CardMint brand teal
#define COLOR_GOLD           0xFEA0  // Value/money
#define COLOR_CORAL          0xFB08  // Alerts/late
#define COLOR_SKY            0x5D9F  // Info
#define COLOR_SUCCESS        0x2DC6  // WiFi OK

// Semantic aliases
#define COLOR_ORDERS         COLOR_MINT
#define COLOR_VALUE          COLOR_GOLD
#define COLOR_TOSHIP         COLOR_SKY
#define COLOR_LATE           COLOR_CORAL
#define COLOR_STALE          COLOR_CORAL

// ============================================================================
// Layout Constants (320x240 display)
// ============================================================================

#define HEADER_HEIGHT    28
#define BOX_HEIGHT       70
#define BOX_WIDTH        155
#define BOX_GAP          5
#define BOX_START_X      2
#define BOX_START_Y      30
#define INFO_ROW_Y       172
#define INFO_ROW_HEIGHT  44
#define FOOTER_Y         218
#define FOOTER_HEIGHT    22

// ============================================================================
// Touch SPI Pins (CYD uses separate SPI bus)
// ============================================================================
#define TOUCH_SPI_MOSI  32
#define TOUCH_SPI_MISO  39
#define TOUCH_SPI_SCK   25

// Touch calibration
#define TOUCH_X_MIN   200
#define TOUCH_X_MAX  3800
#define TOUCH_Y_MIN   280
#define TOUCH_Y_MAX  3850

// ============================================================================
// Global Objects
// ============================================================================

TFT_eSPI tft = TFT_eSPI();
SPIClass touchSPI(HSPI);
XPT2046_Touchscreen touch(TOUCH_CS, TOUCH_IRQ);

uint32_t lastRefresh = 0;
uint32_t lastClockUpdate = 0;
uint32_t lastSuccessfulFetch = 0;
bool wifiConnected = false;
bool timeConfigured = false;
int lastHttpError = 0;

// Time window mode for orders (0=All, 1=24h, 2=72h)
uint8_t ordersTimeWindow = 0;

// Top-right toggle (0=Visits, 1=Support)
uint8_t topRightMode = 0;

// Info row: which of last 3 orders to show (0, 1, 2)
uint8_t lastOrderIndex = 0;

uint32_t lastTouchTime = 0;

// Orders data structure
struct OrdersData {
    uint32_t orders[3];      // [all, 24h, 72h]
    uint32_t values[3];      // [all, 24h, 72h] in cents
    uint32_t visits24h;      // Stubbed
    uint32_t supportOpen;    // Stubbed
    uint32_t toShip;
    uint32_t lateOver24h;
    char lastOrders[3][32];  // "FirstName LastName"
    uint32_t lastOrderValues[3]; // cents
    uint32_t timestamp;
    bool valid;
} ordersData = {{0}, {0}, 0, 0, 0, 0, {""}, {0}, 0, false};

// ============================================================================
// Display Functions
// ============================================================================

void getCurrentTimeStr(char* buf, size_t len) {
    if (!timeConfigured) {
        snprintf(buf, len, "--:--:--");
        return;
    }
    struct tm timeinfo;
    if (!getLocalTime(&timeinfo, 100)) {
        snprintf(buf, len, "--:--:--");
        return;
    }
    strftime(buf, len, "%H:%M:%S", &timeinfo);
}

void getCurrentDateStr(char* buf, size_t len) {
    if (!timeConfigured) {
        snprintf(buf, len, "--- --");
        return;
    }
    struct tm timeinfo;
    if (!getLocalTime(&timeinfo, 100)) {
        snprintf(buf, len, "--- --");
        return;
    }
    strftime(buf, len, "%b %d", &timeinfo);
}

bool isDataStale() {
    if (!ordersData.valid || lastSuccessfulFetch == 0) return true;
    uint32_t now = millis();
    uint32_t elapsed = (now - lastSuccessfulFetch) / 1000;
    return elapsed > STALE_THRESHOLD_SEC;
}

uint32_t getStaleSeconds() {
    if (lastSuccessfulFetch == 0) return 999;
    uint32_t now = millis();
    return (now - lastSuccessfulFetch) / 1000;
}

void drawHeader() {
    tft.fillRect(0, 0, 320, HEADER_HEIGHT, COLOR_HEADER);
    tft.drawFastHLine(0, HEADER_HEIGHT - 1, 320, COLOR_BORDER);

    // Brand
    tft.setTextColor(COLOR_MINT, COLOR_HEADER);
    tft.setFreeFont(&FreeSansBold9pt7b);
    tft.setCursor(8, 19);
    tft.print("CardMint");

    // Clock
    char timeBuf[12];
    getCurrentTimeStr(timeBuf, sizeof(timeBuf));
    tft.setTextColor(COLOR_TEXT_SECONDARY, COLOR_HEADER);
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setCursor(200, 19);
    tft.print(timeBuf);

    // WiFi indicator
    uint16_t wifiColor = wifiConnected ? COLOR_SUCCESS : COLOR_CORAL;
    tft.fillCircle(300, 14, 5, wifiColor);
}

void drawStatBox(int x, int y, int w, int h, const char* label, uint32_t value,
                 uint16_t valueColor, bool isMonetary, const char* sublabel) {
    // Clear and draw box
    tft.fillRoundRect(x, y, w, h, 3, COLOR_SURFACE);
    tft.drawRoundRect(x, y, w, h, 3, COLOR_BORDER);

    // Label
    tft.setTextColor(COLOR_TEXT_SECONDARY, COLOR_SURFACE);
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setCursor(x + 6, y + 16);
    tft.print(label);

    // Value
    tft.setTextColor(valueColor, COLOR_SURFACE);
    tft.setFreeFont(&FreeSansBold18pt7b);
    tft.setCursor(x + 6, y + h - 18);

    if (isMonetary) {
        uint32_t dollars = value / 100;
        if (dollars >= 1000) {
            tft.printf("$%u,%03u", dollars / 1000, dollars % 1000);
        } else {
            tft.printf("$%u", dollars);
        }
    } else {
        tft.print(value);
    }

    // Sublabel (time window indicator)
    if (sublabel && strlen(sublabel) > 0) {
        tft.setTextColor(COLOR_TEXT_MUTED, COLOR_SURFACE);
        tft.setFreeFont(&FreeSans9pt7b);
        tft.setCursor(x + 6, y + h - 4);
        tft.print(sublabel);
    }
}

const char* getTimeWindowLabel() {
    switch (ordersTimeWindow) {
        case 1: return "(24h)";
        case 2: return "(72h)";
        default: return "(All)";
    }
}

void drawOrdersDisplay() {
    // Clear content area
    tft.fillRect(0, BOX_START_Y, 320, INFO_ROW_Y - BOX_START_Y, COLOR_BG);

    if (!ordersData.valid) {
        tft.setTextColor(COLOR_CORAL, COLOR_BG);
        tft.setFreeFont(&FreeSans12pt7b);
        tft.setCursor(60, 100);
        tft.print("No data available");
        return;
    }

    // Top-Left: Orders count (tappable for time window)
    drawStatBox(BOX_START_X, BOX_START_Y, BOX_WIDTH, BOX_HEIGHT,
                "ORDERS", ordersData.orders[ordersTimeWindow],
                COLOR_ORDERS, false, getTimeWindowLabel());

    // Top-Right: Visits or Support (tappable to toggle)
    const char* trLabel = topRightMode == 0 ? "Visits 24h" : "Support";
    uint32_t trValue = topRightMode == 0 ? ordersData.visits24h : ordersData.supportOpen;
    drawStatBox(BOX_START_X + BOX_WIDTH + BOX_GAP, BOX_START_Y, BOX_WIDTH, BOX_HEIGHT,
                trLabel, trValue, COLOR_TEXT_SECONDARY, false, "[stubbed]");

    // Bottom-Left: Order Value (synced with time window)
    drawStatBox(BOX_START_X, BOX_START_Y + BOX_HEIGHT + 2, BOX_WIDTH, BOX_HEIGHT,
                "Order Value", ordersData.values[ordersTimeWindow],
                COLOR_VALUE, true, getTimeWindowLabel());

    // Bottom-Right: To Ship with late count
    char toShipSublabel[16];
    if (ordersData.lateOver24h > 0) {
        snprintf(toShipSublabel, sizeof(toShipSublabel), "(%u!)", ordersData.lateOver24h);
    } else {
        toShipSublabel[0] = '\0';
    }
    uint16_t toShipColor = ordersData.lateOver24h > 0 ? COLOR_LATE : COLOR_TOSHIP;
    drawStatBox(BOX_START_X + BOX_WIDTH + BOX_GAP, BOX_START_Y + BOX_HEIGHT + 2, BOX_WIDTH, BOX_HEIGHT,
                "To Ship", ordersData.toShip, toShipColor, false, toShipSublabel);
}

void drawInfoRow() {
    tft.fillRect(0, INFO_ROW_Y, 320, INFO_ROW_HEIGHT, COLOR_BG);
    tft.drawFastHLine(0, INFO_ROW_Y, 320, COLOR_DIVIDER);

    if (!ordersData.valid) return;

    // Check if we have any orders to show
    bool hasOrders = strlen(ordersData.lastOrders[0]) > 0;

    tft.setFreeFont(&FreeSans9pt7b);
    tft.setCursor(10, INFO_ROW_Y + 18);
    tft.setTextColor(COLOR_TEXT_SECONDARY, COLOR_BG);
    tft.print("Last: ");

    if (hasOrders && lastOrderIndex < 3 && strlen(ordersData.lastOrders[lastOrderIndex]) > 0) {
        tft.setTextColor(COLOR_TEXT, COLOR_BG);
        tft.print(ordersData.lastOrders[lastOrderIndex]);

        // Value
        uint32_t val = ordersData.lastOrderValues[lastOrderIndex];
        if (val > 0) {
            tft.setTextColor(COLOR_VALUE, COLOR_BG);
            tft.printf(" $%u.%02u", val / 100, val % 100);
        }
    } else {
        tft.setTextColor(COLOR_TEXT_MUTED, COLOR_BG);
        tft.print("--");
    }

    // Order index indicator (dots)
    int dotX = 280;
    int dotY = INFO_ROW_Y + INFO_ROW_HEIGHT / 2;
    for (int i = 0; i < 3; i++) {
        uint16_t dotColor = (i == lastOrderIndex) ? COLOR_MINT : COLOR_BORDER;
        tft.fillCircle(dotX + i * 10, dotY, 3, dotColor);
    }

    // Touch hint
    tft.fillCircle(3, INFO_ROW_Y + INFO_ROW_HEIGHT / 2, 2, COLOR_BORDER);
    tft.fillCircle(317, INFO_ROW_Y + INFO_ROW_HEIGHT / 2, 2, COLOR_BORDER);
}

void drawFooter() {
    tft.fillRect(0, FOOTER_Y, 320, FOOTER_HEIGHT, COLOR_BG);
    tft.drawFastHLine(0, FOOTER_Y, 320, COLOR_DIVIDER);

    tft.setFreeFont(&FreeSans9pt7b);

    // Time and date
    char timeBuf[12], dateBuf[12];
    getCurrentTimeStr(timeBuf, sizeof(timeBuf));
    getCurrentDateStr(dateBuf, sizeof(dateBuf));

    tft.setTextColor(COLOR_TEXT_MUTED, COLOR_BG);
    tft.setCursor(10, FOOTER_Y + 15);
    tft.printf("%s CST   %s", timeBuf, dateBuf);

    // Stale indicator
    if (isDataStale()) {
        uint32_t staleSec = getStaleSeconds();
        tft.setTextColor(COLOR_STALE, COLOR_BG);
        tft.setCursor(230, FOOTER_Y + 15);
        tft.printf("STALE %u", staleSec);
    }
}

void drawConnecting() {
    tft.fillScreen(COLOR_BG);
    drawHeader();

    tft.setTextColor(COLOR_ORDERS, COLOR_BG);
    tft.setFreeFont(&FreeSans12pt7b);
    tft.setCursor(60, 110);
    tft.print("Connecting...");

    tft.setTextColor(COLOR_TEXT_SECONDARY, COLOR_BG);
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setCursor(100, 140);
    tft.print(wifi_ssid);
}

void drawError(const char* message, int httpCode) {
    tft.fillRect(0, BOX_START_Y, 320, INFO_ROW_Y - BOX_START_Y, COLOR_BG);

    tft.setTextColor(COLOR_CORAL, COLOR_BG);
    tft.setFreeFont(&FreeSans12pt7b);
    tft.setCursor(20, 60);
    tft.print("Error:");

    tft.setTextColor(COLOR_TEXT_SECONDARY, COLOR_BG);
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setCursor(20, 85);
    tft.print(message);

    if (httpCode != 0) {
        tft.setCursor(20, 110);
        tft.printf("HTTP: %d", httpCode);
    }

    if (WiFi.status() == WL_CONNECTED) {
        tft.setCursor(20, 135);
        tft.print("IP: ");
        tft.print(WiFi.localIP().toString());
    }
}

// ============================================================================
// Network Functions
// ============================================================================

bool connectWiFi() {
    Serial.println("Connecting to WiFi...");
    WiFi.begin(wifi_ssid, wifi_password);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        attempts++;

        int dotX = 160 + (attempts % 3) * 15;
        tft.fillCircle(dotX, 160, 5, COLOR_ORDERS);
        if (attempts > 0) {
            tft.fillCircle(dotX - 15, 160, 5, COLOR_BG);
        }
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi connected!");
        Serial.print("IP: ");
        Serial.println(WiFi.localIP());
        wifiConnected = true;

        configTzTime(TIMEZONE, NTP_SERVER);
        Serial.println("NTP configured for Central Time");
        timeConfigured = true;

        return true;
    }

    Serial.println("\nWiFi failed!");
    wifiConnected = false;
    return false;
}

bool fetchOrdersData() {
    if (WiFi.status() != WL_CONNECTED) {
        wifiConnected = false;
        return false;
    }

    wifiConnected = true;

    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;

    Serial.print("Fetching: ");
    Serial.println(api_url);

    http.begin(client, api_url);
    http.setTimeout(10000);

    if (strlen(display_token) > 0) {
        http.addHeader("X-CardMint-Display-Token", display_token);
    }

    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String payload = http.getString();
        Serial.println("Response: " + payload);

        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, payload);

        if (error) {
            Serial.print("JSON error: ");
            Serial.println(error.c_str());
            http.end();
            return false;
        }

        if (doc["e"].is<int>()) {
            Serial.println("API error response");
            http.end();
            return false;
        }

        // Parse orders array: o[all, 24h, 72h]
        JsonArray oArr = doc["o"].as<JsonArray>();
        if (oArr) {
            ordersData.orders[0] = oArr[0] | 0;
            ordersData.orders[1] = oArr[1] | 0;
            ordersData.orders[2] = oArr[2] | 0;
        }

        // Parse values array: v[all, 24h, 72h]
        JsonArray vArr = doc["v"].as<JsonArray>();
        if (vArr) {
            ordersData.values[0] = vArr[0] | 0;
            ordersData.values[1] = vArr[1] | 0;
            ordersData.values[2] = vArr[2] | 0;
        }

        // Parse top-right: tr[visits, support]
        JsonArray trArr = doc["tr"].as<JsonArray>();
        if (trArr) {
            ordersData.visits24h = trArr[0] | 0;
            ordersData.supportOpen = trArr[1] | 0;
        }

        // Parse bottom-right: br[toShip, late]
        JsonArray brArr = doc["br"].as<JsonArray>();
        if (brArr) {
            ordersData.toShip = brArr[0] | 0;
            ordersData.lateOver24h = brArr[1] | 0;
        }

        // Parse last orders: l[[first, last, cents], ...]
        JsonArray lArr = doc["l"].as<JsonArray>();
        if (lArr) {
            for (int i = 0; i < 3 && i < lArr.size(); i++) {
                JsonArray order = lArr[i].as<JsonArray>();
                if (order && order.size() >= 3) {
                    const char* firstName = order[0] | "";
                    const char* lastName = order[1] | "";
                    snprintf(ordersData.lastOrders[i], sizeof(ordersData.lastOrders[i]),
                             "%s %s", firstName, lastName);
                    ordersData.lastOrderValues[i] = order[2] | 0;
                } else {
                    ordersData.lastOrders[i][0] = '\0';
                    ordersData.lastOrderValues[i] = 0;
                }
            }
        }

        ordersData.timestamp = doc["t"] | 0;
        ordersData.valid = true;
        lastSuccessfulFetch = millis();

        Serial.printf("Orders: %u/%u/%u, ToShip: %u, Late: %u\n",
                      ordersData.orders[0], ordersData.orders[1], ordersData.orders[2],
                      ordersData.toShip, ordersData.lateOver24h);

        http.end();
        return true;
    } else {
        Serial.printf("HTTP error: %d\n", httpCode);
        lastHttpError = httpCode;
        http.end();
        return false;
    }
}

// ============================================================================
// Touch Handling
// ============================================================================

void checkTouch() {
    if (!touch.touched()) return;

    uint32_t now = millis();
    if (now - lastTouchTime < 300) return;

    TS_Point p = touch.getPoint();

    int touchX = constrain(map(p.x, TOUCH_X_MIN, TOUCH_X_MAX, 0, 320), 0, 319);
    int touchY = constrain(map(p.y, TOUCH_Y_MIN, TOUCH_Y_MAX, 0, 240), 0, 239);

    Serial.printf("Touch: (%d, %d)\n", touchX, touchY);

    // Top-Left box: Cycle orders time window
    if (touchX < 160 && touchY >= BOX_START_Y && touchY < BOX_START_Y + BOX_HEIGHT) {
        ordersTimeWindow = (ordersTimeWindow + 1) % 3;
        drawOrdersDisplay();
        lastTouchTime = now;
        Serial.printf("Time window: %d\n", ordersTimeWindow);
        return;
    }

    // Top-Right box: Toggle visits/support
    if (touchX >= 160 && touchY >= BOX_START_Y && touchY < BOX_START_Y + BOX_HEIGHT) {
        topRightMode = (topRightMode + 1) % 2;
        drawOrdersDisplay();
        lastTouchTime = now;
        Serial.printf("Top-right mode: %d\n", topRightMode);
        return;
    }

    // Info row: Cycle through last orders
    if (touchY >= INFO_ROW_Y && touchY < INFO_ROW_Y + INFO_ROW_HEIGHT) {
        lastOrderIndex = (lastOrderIndex + 1) % 3;
        drawInfoRow();
        lastTouchTime = now;
        Serial.printf("Last order index: %d\n", lastOrderIndex);
        return;
    }
}

// ============================================================================
// Main Program
// ============================================================================

void setup() {
    Serial.begin(115200);
    delay(100);
    Serial.println("\n\n=== CardMint Orders Dashboard V2 ===");
    Serial.print("API URL: ");
    Serial.println(api_url);

    tft.init();
    pinMode(TFT_BL, OUTPUT);
    digitalWrite(TFT_BL, HIGH);
    tft.setRotation(1);
    Serial.printf("Display: %dx%d\n", tft.width(), tft.height());

    tft.fillScreen(COLOR_BG);

    // Initialize touch
    touchSPI.begin(TOUCH_SPI_SCK, TOUCH_SPI_MISO, TOUCH_SPI_MOSI, TOUCH_CS);
    touch.begin(touchSPI);
    touch.setRotation(1);
    Serial.println("Touch initialized");

    drawConnecting();

    if (connectWiFi()) {
        tft.fillScreen(COLOR_BG);
        drawHeader();

        if (fetchOrdersData()) {
            drawOrdersDisplay();
            drawInfoRow();
        } else {
            drawError("Failed to fetch data", lastHttpError);
        }
        drawFooter();
        lastRefresh = millis();
    } else {
        drawError("WiFi connection failed", 0);
        drawFooter();
    }
}

void loop() {
    uint32_t now = millis();

    checkTouch();

    // Refresh data periodically
    if (now - lastRefresh >= refresh_interval_ms) {
        Serial.println("Refreshing...");

        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("WiFi lost, reconnecting...");
            wifiConnected = false;
            drawHeader();

            if (!connectWiFi()) {
                drawError("WiFi reconnect failed", 0);
                drawFooter();
                lastRefresh = now;
                return;
            }
        }

        if (fetchOrdersData()) {
            drawOrdersDisplay();
            drawInfoRow();
        }
        // Keep old data visible on fetch failure

        drawHeader();
        drawFooter();
        lastRefresh = now;
    }

    // Update clock every 10 seconds
    if (now - lastClockUpdate >= 10000) {
        drawHeader();
        drawFooter();
        lastClockUpdate = now;
    }

    delay(50);
}
