/**
 * CardMint Stock Display
 *
 * ESP32-2432S028R firmware for displaying real-time inventory stats.
 * Connects to WiFi, polls CardMint backend, renders on 320x240 TFT.
 *
 * Hardware: ESP32-2432S028R (Cheap Yellow Display)
 * Display: ILI9341 320x240 TFT
 * Touch: XPT2046 capacitive touch for info row toggle
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

// Check for config.h (copy config.h.template and customize)
#if __has_include("config.h")
  #include "config.h"
#else
  // Fallback defaults - override via platformio.ini build_flags:
  // -DWIFI_SSID=\"your_ssid\" -DWIFI_PASSWORD=\"your_password\"
  #ifndef WIFI_SSID
    #define WIFI_SSID "your_wifi_ssid"
  #endif
  #ifndef WIFI_PASSWORD
    #define WIFI_PASSWORD "your_wifi_password"
  #endif
  #ifndef API_URL
    #define API_URL "https://cardmintshop.com/api/stock-summary/compact"
  #endif
  #ifndef REFRESH_INTERVAL_MS
    #define REFRESH_INTERVAL_MS 60000
  #endif
#endif

// Convert defines to const char* for compatibility
const char* wifi_ssid = WIFI_SSID;
const char* wifi_password = WIFI_PASSWORD;
const char* api_url = API_URL;
const unsigned long refresh_interval_ms = REFRESH_INTERVAL_MS;

// NTP time configuration (Central Time with automatic DST)
// POSIX TZ string: CST6CDT,M3.2.0/2,M11.1.0/2
// - CST6 = Central Standard Time, UTC-6
// - CDT = Central Daylight Time
// - M3.2.0/2 = DST starts 2nd Sunday of March at 2:00 AM
// - M11.1.0/2 = DST ends 1st Sunday of November at 2:00 AM
const char* NTP_SERVER = "pool.ntp.org";
const char* TIMEZONE = "CST6CDT,M3.2.0/2,M11.1.0/2";

// ============================================================================
// Premium Dashboard Color Palette (RGB565)
// ============================================================================

// Base tones - sophisticated dark theme
#define COLOR_BG             0x0841  // Near-black (#080808)
#define COLOR_HEADER         0x1926  // Deep blue-gray (#1C2430)
#define COLOR_SURFACE        0x2104  // Elevated surface for boxes (#202020)
#define COLOR_BORDER         0x3186  // Subtle borders (#303030)
#define COLOR_DIVIDER        0x2945  // Divider lines (#282828)

// Text hierarchy
#define COLOR_TEXT           0xFFFF  // Primary text (white)
#define COLOR_TEXT_SECONDARY 0xB596  // Labels - warm gray (#B0A890)
#define COLOR_TEXT_MUTED     0x6B4D  // Footer - muted (#686860)

// Semantic accent colors
#define COLOR_MINT           0x2E8B  // CardMint brand teal (#2DD4B8)
#define COLOR_GOLD           0xFEA0  // Value/money (#FFD400)
#define COLOR_CORAL          0xFB08  // Alerts/today (#FF6040)
#define COLOR_SKY            0x5D9F  // Reserved (#5EBFFF)
#define COLOR_SUCCESS        0x2DC6  // WiFi OK (#2DD46B)

// Semantic aliases
#define COLOR_VALUE          COLOR_MINT
#define COLOR_RESERVED       COLOR_SKY
#define COLOR_SOLD           COLOR_GOLD
#define COLOR_ERROR          COLOR_CORAL

// ============================================================================
// Layout Constants (optimized for 320x240 display)
// ============================================================================

#define HEADER_HEIGHT    32
#define BOX_HEIGHT       80
#define BOX_WIDTH        150
#define BOX_GAP          10
#define BOX_START_X      5
#define BOX_START_Y      32
#define INFO_ROW_Y       192
#define INFO_ROW_HEIGHT  28
#define FOOTER_Y         220
#define FOOTER_HEIGHT    20

// ============================================================================
// Touch SPI Pins (CYD uses separate SPI bus for touch)
// ============================================================================
#define TOUCH_SPI_MOSI  32
#define TOUCH_SPI_MISO  39
#define TOUCH_SPI_SCK   25

// ============================================================================
// Global Objects
// ============================================================================

TFT_eSPI tft = TFT_eSPI();

// CYD touch controller is on HSPI (separate from display VSPI)
SPIClass touchSPI(HSPI);
XPT2046_Touchscreen touch(TOUCH_CS, TOUCH_IRQ);

unsigned long lastRefresh = 0;
unsigned long lastClockUpdate = 0;
bool wifiConnected = false;
bool timeConfigured = false;
int lastHttpError = 0;
bool showAddedMode = false;  // Toggle state for info row (false=Last Sale, true=Added)
unsigned long lastTouchTime = 0;  // Debounce

// Stock data with enhanced fields
struct StockData {
    int inStock;
    int reserved;
    int sold;
    int soldToday;
    int addedToday;        // Items added today
    int valueCents;        // Total inventory value in cents
    unsigned long lastSale; // Last sale timestamp (unix epoch)
    unsigned long timestamp;
    bool valid;
} stockData = {0, 0, 0, 0, 0, 0, 0, 0, false};

// ============================================================================
// Display Functions
// ============================================================================

String getCurrentTimeStr() {
    if (!timeConfigured) return "--:--";
    struct tm timeinfo;
    if (!getLocalTime(&timeinfo, 100)) return "--:--";
    char buf[6];
    strftime(buf, sizeof(buf), "%H:%M", &timeinfo);
    return String(buf);
}

void drawHeader() {
    tft.fillRect(0, 0, 320, HEADER_HEIGHT, COLOR_HEADER);
    tft.drawFastHLine(0, HEADER_HEIGHT - 1, 320, COLOR_BORDER);

    // Brand text in mint accent
    tft.setTextColor(COLOR_MINT, COLOR_HEADER);
    tft.setTextSize(1);
    tft.setFreeFont(&FreeSansBold12pt7b);
    tft.setCursor(10, 23);
    tft.print("CardMint");

    // Clock in secondary color
    tft.setTextColor(COLOR_TEXT_SECONDARY, COLOR_HEADER);
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setCursor(200, 21);
    tft.print(getCurrentTimeStr());
}

void drawWifiStatus() {
    int x = 295;  // Shifted right to make room for clock
    int y = 14;
    uint16_t color = wifiConnected ? COLOR_SUCCESS : COLOR_CORAL;
    tft.fillCircle(x, y, 6, color);
    // Subtle outer ring for depth
    tft.drawCircle(x, y, 8, wifiConnected ? 0x1664 : 0x6000);
}

void drawStatBox(int x, int y, int w, int h, const char* label, int value, uint16_t valueColor) {
    // Elevated surface with subtle border
    tft.fillRoundRect(x, y, w, h, 4, COLOR_SURFACE);
    tft.drawRoundRect(x, y, w, h, 4, COLOR_BORDER);

    // Label in muted secondary color
    tft.setTextColor(COLOR_TEXT_SECONDARY, COLOR_SURFACE);
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setCursor(x + 8, y + 18);
    tft.print(label);

    // Value in bold accent color
    tft.setTextColor(valueColor, COLOR_SURFACE);
    tft.setFreeFont(&FreeSansBold24pt7b);
    tft.setCursor(x + 8, y + h - 12);
    tft.print(value);
}

void drawStockDisplay() {
    // Clear content area (from header to info row)
    tft.fillRect(0, HEADER_HEIGHT, 320, INFO_ROW_Y - HEADER_HEIGHT, COLOR_BG);

    if (!stockData.valid) {
        tft.setTextColor(COLOR_ERROR, COLOR_BG);
        tft.setFreeFont(&FreeSans12pt7b);
        tft.setCursor(60, 120);
        tft.print("No data available");
        return;
    }

    // Main stats grid (2x2) with optimized dimensions
    // Row 1: y=32 to y=112 (80px)
    // Row 2: y=112 to y=192 (80px)
    drawStatBox(BOX_START_X, BOX_START_Y, BOX_WIDTH, BOX_HEIGHT,
                "IN STOCK", stockData.inStock, COLOR_VALUE);

    drawStatBox(BOX_START_X + BOX_WIDTH + BOX_GAP, BOX_START_Y, BOX_WIDTH, BOX_HEIGHT,
                "RESERVED", stockData.reserved, COLOR_RESERVED);

    drawStatBox(BOX_START_X, BOX_START_Y + BOX_HEIGHT, BOX_WIDTH, BOX_HEIGHT,
                "TOTAL SOLD", stockData.sold, COLOR_SOLD);

    drawStatBox(BOX_START_X + BOX_WIDTH + BOX_GAP, BOX_START_Y + BOX_HEIGHT, BOX_WIDTH, BOX_HEIGHT,
                "TODAY", stockData.soldToday, COLOR_CORAL);
}

void drawInfoRow() {
    // Info row background (touchable area)
    tft.fillRect(0, INFO_ROW_Y, 320, INFO_ROW_HEIGHT, COLOR_BG);
    tft.drawFastHLine(0, INFO_ROW_Y, 320, COLOR_DIVIDER);

    if (!stockData.valid) return;

    tft.setFreeFont(&FreeSans9pt7b);

    // Left side: Inventory Value in gold (money association)
    tft.setTextColor(COLOR_GOLD, COLOR_BG);
    tft.setCursor(10, INFO_ROW_Y + 20);

    // Format value as $X,XXX (dollars from cents)
    int dollars = stockData.valueCents / 100;
    if (dollars >= 1000) {
        tft.printf("Value: $%d,%03d", dollars / 1000, dollars % 1000);
    } else {
        tft.printf("Value: $%d", dollars);
    }

    // Mode indicator dot
    tft.fillCircle(180, INFO_ROW_Y + INFO_ROW_HEIGHT/2, 3,
                   showAddedMode ? COLOR_MINT : COLOR_TEXT_MUTED);

    // Right side: Toggle between Last Sale and Added Today
    tft.setCursor(195, INFO_ROW_Y + 20);

    if (showAddedMode) {
        // Show "Added: XXX" (3 digits, capped at 999)
        tft.setTextColor(COLOR_MINT, COLOR_BG);
        tft.printf("Added: %03d", min(stockData.addedToday, 999));
    } else {
        // Show "Last: Xh ago" or similar
        tft.setTextColor(COLOR_TEXT_SECONDARY, COLOR_BG);
        if (stockData.lastSale == 0) {
            tft.print("Last: --");
        } else {
            unsigned long now = stockData.timestamp;
            unsigned long diff = now - stockData.lastSale;
            if (diff < 60) {
                tft.printf("Last: %lus", diff);
            } else if (diff < 3600) {
                tft.printf("Last: %lum", diff / 60);
            } else if (diff < 86400) {
                tft.printf("Last: %luh", diff / 3600);
            } else {
                tft.printf("Last: %lud", diff / 86400);
            }
        }
    }

    // Subtle touch indicator (small dots at edges)
    tft.fillCircle(3, INFO_ROW_Y + INFO_ROW_HEIGHT/2, 2, COLOR_BORDER);
    tft.fillCircle(317, INFO_ROW_Y + INFO_ROW_HEIGHT/2, 2, COLOR_BORDER);
}

void drawFooter() {
    tft.fillRect(0, FOOTER_Y, 320, FOOTER_HEIGHT, COLOR_BG);
    tft.drawFastHLine(0, FOOTER_Y, 320, COLOR_DIVIDER);

    tft.setTextColor(COLOR_TEXT_MUTED, COLOR_BG);
    tft.setFreeFont(&FreeSans9pt7b);

    // Last update timestamp (HH:MM DD MMM YYYY)
    tft.setCursor(10, FOOTER_Y + 15);
    if (stockData.valid && timeConfigured) {
        struct tm timeinfo;
        if (getLocalTime(&timeinfo, 100)) {
            char buf[20];
            strftime(buf, sizeof(buf), "%H:%M %d %b %Y", &timeinfo);
            tft.print(buf);
        } else {
            tft.print("--:-- -- --- ----");
        }
    } else {
        tft.print("Waiting for data...");
    }

    // WiFi indicator text
    tft.setCursor(230, FOOTER_Y + 15);
    tft.print(wifiConnected ? "WiFi OK" : "No WiFi");
}

void drawConnecting() {
    tft.fillScreen(COLOR_BG);
    drawHeader();

    tft.setTextColor(COLOR_VALUE, COLOR_BG);
    tft.setFreeFont(&FreeSans12pt7b);
    tft.setCursor(60, 110);
    tft.print("Connecting to WiFi...");

    tft.setTextColor(COLOR_TEXT_SECONDARY, COLOR_BG);
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setCursor(100, 140);
    tft.print(wifi_ssid);
}

void drawError(const char* message, int httpCode = 0) {
    tft.fillRect(0, HEADER_HEIGHT, 320, INFO_ROW_Y - HEADER_HEIGHT, COLOR_BG);

    tft.setTextColor(COLOR_ERROR, COLOR_BG);
    tft.setFreeFont(&FreeSans12pt7b);
    tft.setCursor(20, 70);
    tft.print("Error:");

    tft.setTextColor(COLOR_TEXT_SECONDARY, COLOR_BG);
    tft.setFreeFont(&FreeSans9pt7b);
    tft.setCursor(20, 95);
    tft.print(message);

    // Show HTTP code if available
    if (httpCode != 0) {
        tft.setCursor(20, 120);
        tft.print("HTTP: ");
        tft.print(httpCode);
    }

    // Show ESP32 IP for debugging
    if (WiFi.status() == WL_CONNECTED) {
        tft.setCursor(20, 145);
        tft.print("IP: ");
        tft.print(WiFi.localIP().toString());
    }

    // Show target URL (truncated if needed)
    tft.setTextColor(COLOR_TEXT_MUTED, COLOR_BG);
    tft.setCursor(20, 170);
    tft.print("-> ");
    tft.print(api_url);
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

        // Animate connection indicator
        int dotX = 160 + (attempts % 3) * 15;
        tft.fillCircle(dotX, 160, 5, COLOR_VALUE);
        if (attempts > 0) {
            tft.fillCircle(dotX - 15, 160, 5, COLOR_BG);
        }
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi connected!");
        Serial.print("IP: ");
        Serial.println(WiFi.localIP());
        wifiConnected = true;

        // Configure NTP time with timezone - use configTzTime for reliable TZ handling
        configTzTime(TIMEZONE, NTP_SERVER);
        Serial.println("NTP time configured for Central timezone (DST-aware)");
        timeConfigured = true;

        return true;
    }

    Serial.println("\nWiFi connection failed!");
    wifiConnected = false;
    return false;
}

bool fetchStockData() {
    if (WiFi.status() != WL_CONNECTED) {
        wifiConnected = false;
        return false;
    }

    wifiConnected = true;

    // Use WiFiClientSecure for HTTPS
    WiFiClientSecure client;
    client.setInsecure();  // Skip certificate verification (embedded device)

    HTTPClient http;

    Serial.print("Fetching: ");
    Serial.println(api_url);

    http.begin(client, api_url);
    http.setTimeout(10000);  // 10 second timeout

    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String payload = http.getString();
        Serial.println("Response: " + payload);

        // Parse compact JSON: {s, r, d, td, at, v, ls, t}
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, payload);

        if (error) {
            Serial.print("JSON parse error: ");
            Serial.println(error.c_str());
            http.end();
            return false;
        }

        // Check for error response
        if (doc["e"].is<int>()) {
            Serial.println("API returned error");
            http.end();
            return false;
        }

        stockData.inStock = doc["s"] | 0;
        stockData.reserved = doc["r"] | 0;
        stockData.sold = doc["d"] | 0;
        stockData.soldToday = doc["td"] | 0;
        stockData.addedToday = doc["at"] | 0;
        stockData.valueCents = doc["v"] | 0;
        stockData.lastSale = doc["ls"] | 0;
        stockData.timestamp = doc["t"] | 0;
        stockData.valid = true;

        Serial.printf("Stock: %d, Reserved: %d, Sold: %d, Today: %d, Added: %d, Value: $%.2f\n",
                      stockData.inStock, stockData.reserved,
                      stockData.sold, stockData.soldToday,
                      stockData.addedToday, stockData.valueCents / 100.0);

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

// Touch calibration for ESP32-2432S028R (CYD) with XPT2046
// These values map the raw touch coordinates to screen pixels.
// Calibrate by touching corners and reading raw values from serial output.
// Format: map(raw, RAW_MIN, RAW_MAX, SCREEN_MIN, SCREEN_MAX)
#define TOUCH_X_MIN   200   // Raw X at left edge
#define TOUCH_X_MAX  3800   // Raw X at right edge
#define TOUCH_Y_MIN   280   // Raw Y at top edge
#define TOUCH_Y_MAX  3850   // Raw Y at bottom edge

void checkTouch() {
    if (!touch.touched()) return;

    // Debounce: ignore touches within 300ms of last touch
    unsigned long now = millis();
    if (now - lastTouchTime < 300) return;

    TS_Point p = touch.getPoint();

    // Map raw touch coordinates to screen coordinates
    // Clamp to screen bounds to handle edge touches
    int touchX = constrain(map(p.x, TOUCH_X_MIN, TOUCH_X_MAX, 0, 320), 0, 319);
    int touchY = constrain(map(p.y, TOUCH_Y_MIN, TOUCH_Y_MAX, 0, 240), 0, 239);

    Serial.printf("Touch raw(%d,%d) -> screen(%d,%d)\n", p.x, p.y, touchX, touchY);

    // Check if touch is in info row area (y=192-220)
    if (touchY >= INFO_ROW_Y && touchY < INFO_ROW_Y + INFO_ROW_HEIGHT) {
        showAddedMode = !showAddedMode;
        drawInfoRow();
        lastTouchTime = now;
        Serial.printf("Toggle info row mode: %s\n", showAddedMode ? "Added" : "Last Sale");
    }
}

// ============================================================================
// Main Program
// ============================================================================

void setup() {
    Serial.begin(115200);
    delay(100);
    Serial.println("\n\n=== CardMint Stock Display v2 ===");
    Serial.print("API URL: ");
    Serial.println(api_url);

    // Initialize display
    tft.init();

    // Turn on backlight first
    pinMode(TFT_BL, OUTPUT);
    digitalWrite(TFT_BL, HIGH);

    // Set rotation for landscape mode (R=1 confirmed working for CYD)
    tft.setRotation(1);
    Serial.printf("Display: %dx%d (rotation 1)\n", tft.width(), tft.height());

    tft.fillScreen(COLOR_BG);

    // Initialize touch controller on separate SPI bus (HSPI)
    // CYD has XPT2046 on different pins than the display
    touchSPI.begin(TOUCH_SPI_SCK, TOUCH_SPI_MISO, TOUCH_SPI_MOSI, TOUCH_CS);
    touch.begin(touchSPI);
    touch.setRotation(1);  // Match display rotation (landscape)
    Serial.println("Touch controller initialized on HSPI");

    // Show connecting screen
    drawConnecting();

    // Connect to WiFi (also configures NTP)
    if (connectWiFi()) {
        tft.fillScreen(COLOR_BG);
        drawHeader();
        drawWifiStatus();

        // Initial data fetch
        if (fetchStockData()) {
            drawStockDisplay();
            drawInfoRow();
        } else {
            drawError("Failed to fetch data", lastHttpError);
        }
        drawFooter();
        lastRefresh = millis();
    } else {
        drawError("WiFi connection failed");
        drawFooter();
    }
}

void loop() {
    unsigned long now = millis();

    // Check for touch input
    checkTouch();

    // Refresh data periodically
    if (now - lastRefresh >= refresh_interval_ms) {
        Serial.println("Refreshing data...");

        // Check WiFi connection
        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("WiFi disconnected, reconnecting...");
            wifiConnected = false;
            drawWifiStatus();

            if (!connectWiFi()) {
                drawError("WiFi reconnection failed");
                drawFooter();
                lastRefresh = now;
                return;
            }
        }

        // Fetch and display data
        if (fetchStockData()) {
            drawStockDisplay();
            drawInfoRow();
        } else {
            // Keep showing old data but update footer
            Serial.println("Fetch failed, keeping old data");
        }

        drawWifiStatus();
        drawFooter();
        lastRefresh = now;
    }

    // Update clock every minute
    if (now - lastClockUpdate >= 60000) {
        drawHeader();
        drawWifiStatus();
        lastClockUpdate = now;
    }

    // Update footer every minute (shows timestamp, not relative time)
    static unsigned long lastFooterUpdate = 0;
    if (now - lastFooterUpdate >= 60000) {
        drawFooter();
        lastFooterUpdate = now;
    }

    delay(50);  // Small delay, faster for touch responsiveness
}
