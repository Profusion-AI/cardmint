# CardMint Stock Display

ESP32-based real-time inventory display for CardMint operator/admin dashboard.

**Created:** December 2025
**Status:** Production-ready

## Overview

A dedicated hardware display showing live CardMint inventory statistics. Provides operators with at-a-glance visibility into stock levels without needing to check the admin panel.

## Hardware

| Component | Specification |
|-----------|--------------|
| **Board** | ESP32-2432S028R (Cheap Yellow Display / CYD) |
| **MCU** | ESP32-WROOM-32 (Dual-core, 240MHz) |
| **Display** | ILI9341 2.8" TFT (320x240, SPI) |
| **Touch** | XPT2046 (available but not used in v1) |
| **USB-Serial** | CH340 |
| **Power** | 5V via USB |

## Display Layout

```
┌────────────────────────────────┐
│  CardMint Inventory        [●] │  <- Green = WiFi OK
├────────────────┬───────────────┤
│   IN STOCK     │   RESERVED    │
│      69        │       0       │
├────────────────┼───────────────┤
│  TOTAL SOLD    │    TODAY      │
│       1        │       0       │
├────────────────┴───────────────┤
│ Updated 15s ago       WiFi OK  │
└────────────────────────────────┘
```

## Setup

### 1. Install PlatformIO

```bash
pip install platformio
```

### 2. Configure WiFi

Edit `src/main.cpp` and update these values:

```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
```

### 3. Configure API Endpoint

The default is production:

```cpp
// Production (recommended)
const char* API_URL = "https://cardmintshop.com/api/stock-summary/compact";

// Local development (requires backend on same network)
// const char* API_URL = "http://192.168.x.x:4000/api/stock-summary/compact";
```

### 4. Build and Flash

```bash
cd hardware/stock-display

# Build firmware
pio run

# Flash to ESP32 (connect via USB data cable)
pio run --target upload

# Optional: Monitor serial output for debugging
pio device monitor
```

### 5. USB Troubleshooting

If the device isn't detected:

```bash
# Check for USB serial device
ls /dev/ttyUSB*

# Verify it's the CH340 chip
lsusb | grep "1a86:7523"
```

Common issues:
- **Charge-only cable**: Use a data-capable USB cable
- **Wrong port**: ESP32-2432S028R has two USB ports; use the CH340/PROG port

## API Endpoints

### Compact (for display)

```
GET /api/stock-summary/compact
```

Response:
```json
{
  "s": 69,    // In stock
  "r": 0,     // Reserved
  "d": 1,     // Sold (done)
  "td": 0,    // Sold today
  "t": 1766496782  // Unix timestamp
}
```

### Full (for debugging/admin)

```
GET /api/stock-summary
```

Response includes inventory values, top sets, and last sale timestamp.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `REFRESH_INTERVAL_MS` | 30000 | How often to poll API (30 seconds) |
| `API_URL` | Production | Endpoint to fetch stock data |

## Architecture

```
ESP32-2432S028R                    CardMint Production
┌──────────────────┐               ┌─────────────────────┐
│  WiFi Connect    │               │ nginx (443)         │
│        ↓         │               │   ↓                 │
│  HTTPS GET       │──────────────▶│ /api/stock-summary  │
│        ↓         │               │   ↓                 │
│  Parse JSON      │◀──────────────│ Backend (4000)      │
│        ↓         │               │   ↓                 │
│  Render TFT      │               │ cardmint_prod.db    │
│        ↓         │               └─────────────────────┘
│  Sleep 30s       │
│        ↓         │
│  [Repeat]        │
└──────────────────┘
```

## Files

```
hardware/stock-display/
├── platformio.ini          # PlatformIO build configuration
├── src/
│   └── main.cpp            # Main firmware (WiFi, HTTP, TFT)
├── README.md               # This file
└── .gitignore              # Ignore build artifacts
```

## Backend Route

The stock display endpoint is defined in:

```
apps/backend/src/routes/stockDisplay.ts
```

Registered in `apps/backend/src/app/http.ts`.

Nginx routing configured in `/etc/nginx/conf.d/cardmint.conf` on production.

## Troubleshooting

### "Connecting to WiFi..." stays on screen
- Verify SSID and password in `main.cpp`
- Ensure ESP32 is in range of the WiFi network
- Check that the network allows new device connections

### "Failed to fetch data" with HTTP: -1
- Network connectivity issue between ESP32 and server
- Check WiFi isn't using client isolation
- Verify the API URL is correct

### "Failed to fetch data" with HTTP: 404
- Endpoint not deployed or nginx not routing correctly
- Test: `curl https://cardmintshop.com/api/stock-summary/compact`

### Display shows garbage/old content
- Press RESET button on the board
- The display clears on boot; residual content indicates incomplete initialization

### Device not detected on USB
- Use a **data-capable** USB cable (not charge-only)
- Try a different USB port
- Check `lsusb` for "QinHeng Electronics CH340"

## Future Enhancements

- [ ] Touch support for manual refresh
- [ ] Multiple display pages (sales, trending, alerts)
- [ ] Low stock alerts with LED/buzzer
- [ ] OTA firmware updates
- [ ] Display brightness control via ambient light sensor
