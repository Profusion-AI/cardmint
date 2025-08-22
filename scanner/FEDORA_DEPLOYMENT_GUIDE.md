# CardMint Fedora Deployment Guide

## 🚀 Complete Setup Instructions for Fedora Workstation

This guide covers the complete deployment of CardMint scanner on Fedora, leveraging the Qwen2.5-VL model running on Mac M4.

## Prerequisites

### On Mac (Server)
- ✅ LM Studio running with Qwen2.5-VL-7B-Instruct model
- ✅ Model served at `http://10.0.24.174:1234`
- ✅ CORS enabled for network access
- ✅ CardMint API running (optional) at port 5001

### On Fedora (Client)
- Python 3.8+ installed
- Network access to Mac server (10.0.24.174)
- Camera or scanner for card images (optional)

## 📦 File Transfer

Transfer these files from Mac to Fedora:

```bash
# On Mac - Create deployment package
cd /Users/kylegreenwell/Documents/DevMaster/CardMint_VLM_Training_M4
tar -czf cardmint_fedora.tar.gz fedora/

# Transfer to Fedora (choose one method):
# Method 1: SCP
scp cardmint_fedora.tar.gz user@fedora-ip:~/

# Method 2: USB drive
cp cardmint_fedora.tar.gz /Volumes/USB/

# Method 3: Network share
cp cardmint_fedora.tar.gz /path/to/shared/folder/
```

## 🔧 Installation Steps

### 1. Extract Files on Fedora

```bash
# On Fedora
cd ~
tar -xzf cardmint_fedora.tar.gz
cd fedora
```

### 2. Run Setup Script

```bash
# Make executable and run
chmod +x setup_fedora.sh
./setup_fedora.sh
```

The setup script will:
- Install Python dependencies (pillow, requests, numpy)
- Create directory structure (~/CardMint/*)
- Set up configuration files
- Create shell aliases
- Test connection to Mac server

### 3. Verify Installation

```bash
# Reload shell for aliases
source ~/.bashrc

# Test connection to Mac
cardmint --test

# Expected output:
# ✅ Connected to Mac server. Models: ['qwen2.5-vl-7b-instruct']
```

## 📸 Usage Guide

### Quick Start

```bash
# 1. Place card images in scan directory
cp /path/to/card.jpg ~/CardMint/scans/

# 2. Process single card
cardmint --file ~/CardMint/scans/card.jpg

# 3. Process all cards in scan directory
cardmint --scan

# 4. Watch directory for new cards (continuous mode)
cardmint-watch
```

### Command Reference

#### Using Python Script Directly

```bash
# Process single card
python3 ~/CardMint/cardmint_scanner.py --file image.jpg

# Scan directory once
python3 ~/CardMint/cardmint_scanner.py --scan

# Watch directory continuously
python3 ~/CardMint/cardmint_scanner.py --watch

# Process multiple specific files
python3 ~/CardMint/cardmint_scanner.py --batch card1.jpg card2.jpg card3.jpg

# Export inventory
python3 ~/CardMint/cardmint_scanner.py --export html
python3 ~/CardMint/cardmint_scanner.py --export csv

# View statistics
python3 ~/CardMint/cardmint_scanner.py --stats
```

#### Using Shell Aliases (After setup)

```bash
cardmint                  # Default scan
cardmint-watch           # Watch mode
cardmint-batch           # Batch processing
cardmint-stats           # View statistics  
cardmint-export          # Export HTML report
```

#### Using Batch Script

```bash
# Process all images once
bash ~/CardMint/batch_scanner.sh scan

# Watch mode - continuously process new images
bash ~/CardMint/batch_scanner.sh watch
```

### 📊 Monitor Scanner Activity

```bash
# Run monitoring dashboard
python3 ~/CardMint/monitor_scanner.py

# Features:
# - Real-time statistics
# - Rarity distribution graph
# - Recent card list
# - High-value card tracking
# - Processing metrics
```

If you have `rich` installed, you'll get an enhanced UI:
```bash
pip3 install --user rich
python3 ~/CardMint/monitor_scanner.py
```

## 📁 Directory Structure

After setup, your CardMint directory will look like:

```
~/CardMint/
├── scans/                 # Place new card images here
├── processed/             # Successfully processed cards moved here
├── logs/                  # Scanner logs
│   ├── scanner.log       # Main log file
│   └── batch_*.log       # Batch processing logs
├── config/
│   └── settings.json     # Configuration (Mac IP, etc.)
├── inventory.json        # Complete card database
├── inventory.csv         # CSV export (if generated)
├── inventory.html        # HTML report (if generated)
├── cardmint_scanner.py   # Main scanner script
├── batch_scanner.sh      # Batch processing script
└── monitor_scanner.py    # Monitoring dashboard
```

## ⚙️ Configuration

### Update Mac Server IP

If the Mac's IP changes, update the configuration:

```bash
# Edit configuration file
nano ~/CardMint/config/settings.json
```

Change the IP addresses:
```json
{
    "mac_server": "http://NEW_IP:1234",
    "cardmint_api": "http://NEW_IP:5001",
    ...
}
```

### Modify Scanner Settings

```json
{
    "batch_delay": 0.5,          // Delay between batch cards (seconds)
    "max_image_size": 1280,      // Maximum image dimension
    "jpeg_quality": 90,          // JPEG compression quality
    "log_level": "INFO"          // Logging verbosity
}
```

## 🎯 Workflow Examples

### Example 1: Bulk Scanning Session

```bash
# 1. Place 50 card images in scan directory
cp /media/camera/DCIM/*.jpg ~/CardMint/scans/

# 2. Run batch processor
cardmint-batch

# 3. View results
cardmint-stats

# 4. Export to HTML for review
cardmint-export
firefox ~/CardMint/inventory.html
```

### Example 2: Continuous Scanner Station

```bash
# Terminal 1: Run scanner in watch mode
cardmint-watch

# Terminal 2: Run monitor
python3 ~/CardMint/monitor_scanner.py

# Now just drop images into ~/CardMint/scans/
# They'll be automatically processed
```

### Example 3: Quality Control Review

```bash
# Export current inventory
cardmint --export html

# Review in browser
firefox ~/CardMint/inventory.html

# Check low-confidence cards (< 60%)
grep '"confidence": 0\.[0-5]' ~/CardMint/inventory.json
```

## 🔍 Output Format

Each identified card creates a JSON entry:

```json
{
  "name": "Pikachu",
  "set_name": "Base Set",
  "number": "58/102",
  "rarity": "Common",
  "hp": "60",
  "type": "Electric",
  "stage": "Basic",
  "variant_flags": {
    "first_edition": false,
    "shadowless": true,
    "reverse_holo": false,
    "promo_stamp": false,
    "stamped": false,
    "misprint": false
  },
  "language": "English",
  "year": "1999",
  "confidence": 0.85,
  "source_file": "pikachu_001.jpg",
  "processed_at": "2024-01-20T10:30:00",
  "image_size": "1280x960"
}
```

## 🚨 Troubleshooting

### Cannot Connect to Mac Server

```bash
# Test network connectivity
ping 10.0.24.174

# Test LM Studio API
curl http://10.0.24.174:1234/v1/models

# Check firewall on Mac
# System Preferences > Security & Privacy > Firewall
```

### Low Confidence Results

- Ensure good lighting when photographing cards
- Cards should be flat, not curved
- Avoid reflections on holofoil cards
- Image resolution should be at least 800x600
- Card should fill most of the frame

### Processing Errors

```bash
# Check logs for details
tail -f ~/CardMint/logs/scanner.log

# Common fixes:
# 1. Restart LM Studio on Mac
# 2. Check network connection
# 3. Verify image format (JPG/PNG)
# 4. Check disk space for processed folder
```

### Performance Issues

```bash
# Reduce image size for faster processing
# Edit ~/CardMint/config/settings.json
"max_image_size": 800,  # Reduce from 1280

# Increase batch delay to reduce server load
"batch_delay": 1.0,  # Increase from 0.5
```

## 📈 Performance Metrics

Expected performance with Qwen2.5-VL:

- **Accuracy**: 90-95% for clear images
- **Processing Speed**: 2-3 seconds per card
- **Batch Throughput**: 20-30 cards/minute
- **Network Latency**: < 100ms on local network
- **Confidence Scores**:
  - 0.8+ : High confidence, reliable identification
  - 0.6-0.8 : Good confidence, may need verification
  - < 0.6 : Low confidence, manual review recommended

## 🎉 Success Indicators

You'll know the system is working when:

1. ✅ Connection test shows "Connected to Mac server"
2. ✅ Cards move from `scans/` to `processed/` after identification
3. ✅ `inventory.json` grows with each processed card
4. ✅ Monitor shows real-time statistics
5. ✅ HTML export displays card gallery with details

## 📝 Advanced Features

### Custom Prompts

For specialized identification needs, modify the prompt in the scanner:

```python
# Edit ~/CardMint/cardmint_scanner.py
# Line 66-97: Modify system_prompt for different behavior
```

### API Integration

If you have the CardMint FastAPI running on Mac:

```python
# Edit ~/CardMint/cardmint_scanner.py
# Line 24: Set USE_DIRECT_LM_STUDIO = False
# This routes through the API for additional validation
```

### Database Sync

To sync with a central database:

```bash
# Copy inventory to Mac for database update
scp ~/CardMint/inventory.json user@10.0.24.174:~/cardmint_inventory.json
```

## 🔐 Security Notes

- The scanner only reads from local directories
- No data is sent outside your local network
- All processing happens between Fedora and Mac
- Images remain local after processing
- Consider network segmentation for production use

## 📞 Support

For issues or questions:

1. Check the troubleshooting section above
2. Review logs in `~/CardMint/logs/`
3. Verify Mac server is running and accessible
4. Ensure all dependencies are installed

## 🎯 Quick Reference Card

```bash
# Essential Commands
cardmint --test              # Test connection
cardmint --scan              # Process all cards
cardmint-watch              # Continuous mode
cardmint-stats              # View statistics
cardmint-export             # Generate HTML report

# Directories
~/CardMint/scans/           # Input cards
~/CardMint/processed/       # Completed cards
~/CardMint/inventory.json   # Card database

# Configuration
~/CardMint/config/settings.json  # Edit Mac IP here

# Monitoring
python3 ~/CardMint/monitor_scanner.py  # Live dashboard
```

---

**CardMint Fedora Scanner** - Powered by Qwen2.5-VL on Mac M4