# CardMint Stock Display - Hardware Notes

ESP32-2432S028R (Cheap Yellow Display / CYD) configuration guide.

## Quick Reference

| Setting | Value |
|---------|-------|
| Board | ESP32-2432S028R (CYD) |
| Display | ILI9341 320x240 TFT |
| Touch | XPT2046 resistive |
| Driver | `ILI9341_2_DRIVER` (not ILI9341_DRIVER) |
| Rotation | `setRotation(1)` for landscape |
| API Endpoint | `https://cardmintshop.com/api/stock-summary/compact` |

---

## Display Configuration

### The 20% Blank Screen Problem

**Symptom:** Display only uses ~80% of the physical panel, with a blank strip on one edge.

**Root Cause:** The CYD board uses a variant ILI9341 panel that requires:
1. The `ILI9341_2_DRIVER` driver (not the standard `ILI9341_DRIVER`)
2. Native portrait dimensions (240x320), with rotation handling orientation
3. Color inversion and BGR color order flags

**Solution in `platformio.ini`:**
```ini
build_flags =
    -DUSER_SETUP_LOADED=1
    -DILI9341_2_DRIVER=1          ; CYD-specific driver variant
    -DTFT_WIDTH=240               ; Native portrait width
    -DTFT_HEIGHT=320              ; Native portrait height
    -DTFT_INVERSION_ON            ; CYD color fix
    '-DTFT_RGB_ORDER=TFT_BGR'     ; CYD color fix
```

**In code:**
```cpp
tft.setRotation(1);  // Landscape with USB port on left
```

### CYD Board Variants

There are TWO versions of the ESP32-2432S028R:

| Variant | USB Ports | Display Driver |
|---------|-----------|----------------|
| CYD | 1 | `ILI9341_2_DRIVER` |
| 2USBCYD | 2 | `ST7789_DRIVER` |

If colors are inverted or display doesn't work, check your USB port count and switch drivers accordingly.

---

## Touch Controller Configuration

### The Touch Not Responding Problem

**Symptom:** Touch returns constant values (8191, 8191) or doesn't respond.

**Root Cause:** The CYD board has the XPT2046 touch controller on a **separate SPI bus** from the display. The display uses VSPI, touch uses HSPI.

### Pin Mapping

| Function | Display (VSPI) | Touch (HSPI) |
|----------|----------------|--------------|
| MOSI | GPIO 13 | GPIO 32 |
| MISO | GPIO 12 | GPIO 39 |
| SCK | GPIO 14 | GPIO 25 |
| CS | GPIO 15 | GPIO 33 |
| IRQ | - | GPIO 36 |

### Solution

Create a separate SPI instance for touch:

```cpp
#include <SPI.h>

// Touch SPI pins
#define TOUCH_SPI_MOSI  32
#define TOUCH_SPI_MISO  39
#define TOUCH_SPI_SCK   25
#define TOUCH_CS        33
#define TOUCH_IRQ       36

// Separate SPI bus for touch
SPIClass touchSPI(HSPI);
XPT2046_Touchscreen touch(TOUCH_CS, TOUCH_IRQ);

void setup() {
    // Initialize touch on HSPI
    touchSPI.begin(TOUCH_SPI_SCK, TOUCH_SPI_MISO, TOUCH_SPI_MOSI, TOUCH_CS);
    touch.begin(touchSPI);
    touch.setRotation(1);  // Match display rotation
}
```

---

## Timezone Configuration

### The Wrong Time Problem

**Symptom:** Clock shows UTC instead of local time.

**Root Cause:** Using `setenv()`/`tzset()`/`configTime()` separately can have ordering issues on ESP32.

**Solution:** Use `configTzTime()` which handles everything atomically:

```cpp
// POSIX timezone string for US Central (auto DST)
const char* TIMEZONE = "CST6CDT,M3.2.0/2,M11.1.0/2";
const char* NTP_SERVER = "pool.ntp.org";

// In setup after WiFi connects:
configTzTime(TIMEZONE, NTP_SERVER);
```

### Common Timezone Strings

| Zone | POSIX String |
|------|--------------|
| US Eastern | `EST5EDT,M3.2.0/2,M11.1.0/2` |
| US Central | `CST6CDT,M3.2.0/2,M11.1.0/2` |
| US Mountain | `MST7MDT,M3.2.0/2,M11.1.0/2` |
| US Pacific | `PST8PDT,M3.2.0/2,M11.1.0/2` |
| UTC | `UTC0` |

---

## API Configuration

### Changing the Data Source

The display fetches JSON from a configurable endpoint. Modify in one of two ways:

**Option 1: Edit `src/config.h`** (recommended for secrets)
```cpp
#define WIFI_SSID "your_wifi"
#define WIFI_PASSWORD "your_password"
#define API_URL "https://your-domain.com/api/endpoint"
#define REFRESH_INTERVAL_MS 60000  // 1 minute
```

**Option 2: Build flags in `platformio.ini`**
```ini
build_flags =
    ...
    '-DAPI_URL="https://your-domain.com/api/endpoint"'
    -DREFRESH_INTERVAL_MS=60000
```

### Expected JSON Format

The display expects this compact JSON structure:

```json
{
  "s": 69,      // inStock - items available
  "r": 0,       // reserved - items in carts
  "d": 1,       // sold (done) - total sold
  "td": 0,      // soldToday - sold today
  "at": 5,      // addedToday - added today
  "v": 125000,  // valueCents - inventory value in cents
  "ls": 1703350000,  // lastSale - unix timestamp
  "t": 1703350500    // timestamp - server time
}
```

### Dashboard Field Mapping

| Display Box | JSON Field | Description |
|-------------|------------|-------------|
| IN STOCK | `s` | Available inventory count |
| RESERVED | `r` | Items in customer carts |
| TOTAL SOLD | `d` | Lifetime sales count |
| TODAY | `td` | Sales today |
| Value (info row) | `v` | Total value in cents (displayed as $X,XXX) |
| Added (info row) | `at` | Items added today (toggle with touch) |
| Last Sale (info row) | `ls` | Unix timestamp of last sale |

### Backend Endpoint

The CardMint backend serves this at:
- **Production:** `https://cardmintshop.com/api/stock-summary/compact`
- **Local dev:** `http://localhost:4000/api/stock-summary/compact`

Source: `apps/backend/src/routes/stockDisplay.ts`

---

## Troubleshooting

| Problem | Check |
|---------|-------|
| Blank/partial display | Verify `ILI9341_2_DRIVER` and native 240x320 dims |
| Wrong colors | Add `TFT_INVERSION_ON` and `TFT_RGB_ORDER=TFT_BGR` |
| Touch not working | Ensure HSPI setup with correct pins (32/39/25) |
| Wrong timezone | Use `configTzTime()` not separate `setenv`/`configTime` |
| No data | Check WiFi credentials, API URL, and backend health |

---

## Future Enhancement: Sale Alert LED

### Planned Feature

Flash the onboard RGB LED green when a new sale is detected, dismissed by touch.

### CYD RGB LED Pins

| Color | GPIO |
|-------|------|
| Red | GPIO 4 |
| Green | GPIO 16 |
| Blue | GPIO 17 |

Note: accent LEDs at board edge.

### Implementation Sketch

```cpp
// LED pins (accent LED accent on CYD board edge)
#define LED_RED   4
#define LED_GREEN 16
#define LED_BLUE  17

// State tracking
int lastKnownSold = 0;
bool saleAlertActive = false;
unsigned long lastLedToggle = 0;
bool ledState = false;

void setup() {
    pinMode(LED_RED, OUTPUT);
    pinMode(LED_GREEN, OUTPUT);
    pinMode(LED_BLUE, OUTPUT);

    // LEDs off (active LOW on some CYD variants, check yours)
    digitalWrite(LED_RED, HIGH);
    digitalWrite(LED_GREEN, HIGH);
    digitalWrite(LED_BLUE, HIGH);
}

void checkForNewSale() {
    // Compare current sold count to last known
    if (stockData.sold > lastKnownSold && lastKnownSold > 0) {
        saleAlertActive = true;
        Serial.println("NEW SALE DETECTED!");
    }
    lastKnownSold = stockData.sold;
}

void updateSaleAlertLED() {
    if (!saleAlertActive) {
        digitalWrite(LED_GREEN, HIGH);  // Off
        return;
    }

    // Flash at 2Hz (250ms on/off)
    if (millis() - lastLedToggle >= 250) {
        ledState = !ledState;
        digitalWrite(LED_GREEN, ledState ? LOW : HIGH);
        lastLedToggle = millis();
    }
}

void checkTouch() {
    if (!touch.touched()) return;

    // ... existing touch handling ...

    // Dismiss sale alert on any touch
    if (saleAlertActive) {
        saleAlertActive = false;
        digitalWrite(LED_GREEN, HIGH);  // Off
        Serial.println("Sale alert dismissed");
    }
}

void loop() {
    checkTouch();
    updateSaleAlertLED();
    // ... rest of loop ...
}
```

### Logic Flow

1. On each API fetch, compare `stockData.sold` to `lastKnownSold`
2. If sold count increased → set `saleAlertActive = true`
3. While active → flash green LED at 2Hz
4. On any touch → set `saleAlertActive = false`, turn off LED
5. Update `lastKnownSold` after each comparison

### Notes

- Some CYD boards have active-LOW LEDs (LOW = on), others active-HIGH — test yours
- Consider adding a short buzzer beep option (if speaker connected)
- The `lastKnownSold` should be initialized from first successful API fetch to avoid false alert on boot

---

## References

- [TFT_eSPI CYD Discussion](https://github.com/Bodmer/TFT_eSPI/discussions/3018)
- [Random Nerd Tutorials - CYD Setup](https://randomnerdtutorials.com/programming-esp32-cyd-cheap-yellow-display-vs-code/)
- [ESP32 Time Functions](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/system/system_time.html)
