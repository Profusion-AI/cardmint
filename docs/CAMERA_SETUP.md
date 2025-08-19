# Sony ZV-E10M2 Camera Setup for CardMint

## Critical Camera Menu Settings

Before using CardMint, you MUST configure these settings on your camera:

### 1. PC Remote Settings (REQUIRED)
Navigate to: **Menu → Network → PC Remote Function → PC Remote**

Set the following:
- **Still Img. Save Dest.**: `PC Only` (recommended) or `PC+Camera`
  - `PC Only`: Images save only to computer (faster, no SD card required)
  - `PC+Camera`: Images save to both computer and SD card
  - ❌ `Camera Only`: Will NOT work with CardMint

- **PC Save Image Size**: `Original` (for full quality)
- **RAW+J PC Save Img**: Configure based on your needs
  - `RAW & JPEG`: Both files transfer
  - `RAW Only`: Only RAW files transfer
  - `JPEG Only`: Only JPEG files transfer

### 2. USB Connection Settings
Navigate to: **Menu → Setup → USB**

- **USB Connection Mode**: `PC Remote`
  - NOT Mass Storage, MTP, or USB Streaming
- **USB LUN Setting**: `Multi` (default)
  - Only change to `Single` if connection issues occur

### 3. Disable Conflicting Features
- **Smartphone Control**: OFF (Menu → Network → Smartphone Connect)
- **Release w/o Card**: ON if using `PC Only` mode (Menu → Setup → Release w/o Card)

## Connection Sequence

1. **Configure camera BEFORE connecting USB**
   - Set all menu options above
   - Camera should be in shooting mode (not playback)

2. **Connect USB cable**
   - Use USB 3.0+ cable for best performance
   - Connect directly to computer (avoid hubs)

3. **Verify PC Remote mode**
   - Camera LCD should show "PC Remote" icon
   - If not, disconnect and check USB Connection Mode

4. **Run CardMint**
   ```bash
   # Test connection
   ./test-capture-card.ts
   
   # Should see:
   # ✅ Connected to Sony ZV-E10M2
   # ✅ Image saved to: /tmp/cardmint_[timestamp].jpg
   ```

## Troubleshooting

### Images not saving to computer
1. Check `Still Img. Save Dest.` is NOT set to `Camera Only`
2. Verify camera is in PC Remote mode (not Mass Storage)
3. Ensure camera menu is closed during capture

### Connection fails
1. Try USB LUN Setting = `Single` instead of `Multi`
2. Disable smartphone control completely
3. Restart camera and reconnect

### Shutter won't fire
- With `PC+Camera` mode: SD card must be inserted
- With `PC Only` mode: Enable "Release w/o Card"

### Performance optimization
- Use `PC Only` mode (no SD card write delay)
- Set image quality to JPEG Fine (not Extra Fine) for speed
- Disable RAW if not needed

## Expected Performance

With proper configuration:
- **Connection**: 1-2 seconds
- **Capture trigger**: 35ms
- **Full image transfer**: 200-500ms (JPEG)
- **Total capture → file ready**: <1 second

## Validation Script

Run this to verify your setup:
```bash
./scripts/validate-camera-setup.ts
```

This will:
1. Check camera connection
2. Verify PC Remote mode
3. Test image capture and transfer
4. Measure actual performance
5. Report any configuration issues