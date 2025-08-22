#!/usr/bin/env python3
"""
CardMint Scanner for Fedora
Main scanning application that interfaces with Mac's Qwen2.5-VL server
"""

import os
import sys
import json
import time
import requests
import base64
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from PIL import Image
import logging
from io import BytesIO

# Configuration
MAC_SERVER = "http://10.0.24.174:1234"  # LM Studio with Qwen2.5-VL
CARDMINT_API = "http://10.0.24.174:5001"  # CardMint FastAPI (optional)
USE_DIRECT_LM_STUDIO = True  # Direct to Qwen vs through CardMint API

# Paths
SCAN_DIR = Path.home() / "CardMint" / "scans"
PROCESSED_DIR = Path.home() / "CardMint" / "processed"
INVENTORY_FILE = Path.home() / "CardMint" / "inventory.json"
LOG_FILE = Path.home() / "CardMint" / "logs" / "scanner.log"

# Create directories
SCAN_DIR.mkdir(parents=True, exist_ok=True)
PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class CardMintScanner:
    """Main scanner class for Pokemon card identification."""
    
    def __init__(self):
        self.mac_server = MAC_SERVER
        self.cardmint_api = CARDMINT_API
        self.use_direct = USE_DIRECT_LM_STUDIO
        self.inventory = self.load_inventory()
        self.session = requests.Session()
        
        # Load optimized prompts
        self.system_prompt = self.load_system_prompt()
        
        # Test connection on startup
        self.test_connection()
    
    def load_system_prompt(self) -> str:
        """Load the optimized CardMint prompt."""
        return """You are CardMint-Identifier, a specialized Pokemon TCG card recognition system.

CRITICAL RULES:
1. Output ONLY valid JSON - no explanations, no markdown, no prose
2. Use EXACTLY this structure - all fields required
3. Set null for unknown values, never guess or hallucinate
4. Use false for uncertain variant flags, never assume

OUTPUT FORMAT:
{
  "name": "exact card name or Unknown",
  "set_name": "set name/code or Unknown",
  "number": "collector number or Unknown",
  "rarity": "Common|Uncommon|Rare|Rare Holo|Ultra Rare|Secret Rare|Promo|GX|EX|V|VMAX|VSTAR|Unknown",
  "hp": "number as string or null",
  "type": "Fire|Water|Grass|Electric|Psychic|Fighting|Dark|Metal|Fairy|Dragon|Colorless|null",
  "stage": "Basic|Stage 1|Stage 2|MEGA|BREAK|LEGEND|null",
  "variant_flags": {
    "first_edition": false,
    "shadowless": false,
    "reverse_holo": false,
    "promo_stamp": false,
    "stamped": false,
    "misprint": false
  },
  "language": "English|Japanese|French|German|Spanish|Italian|Korean|Chinese|null",
  "year": "YYYY format or null",
  "confidence": 0.0,
  "errors": []
}

Return JSON only. No other text."""
    
    def load_inventory(self) -> List[Dict]:
        """Load existing inventory from file."""
        if INVENTORY_FILE.exists():
            try:
                with open(INVENTORY_FILE, 'r') as f:
                    return json.load(f)
            except:
                return []
        return []
    
    def save_inventory(self):
        """Save inventory to file."""
        with open(INVENTORY_FILE, 'w') as f:
            json.dump(self.inventory, f, indent=2)
    
    def test_connection(self) -> bool:
        """Test connection to Mac server."""
        try:
            response = self.session.get(f"{self.mac_server}/v1/models", timeout=3)
            if response.status_code == 200:
                models = response.json()
                logger.info(f"✅ Connected to Mac server. Models: {[m['id'] for m in models['data']]}")
                return True
        except Exception as e:
            logger.error(f"❌ Cannot connect to Mac server: {e}")
            logger.error(f"   Ensure LM Studio is running on Mac at {self.mac_server}")
            return False
        return False
    
    def preprocess_image(self, image_path: Path) -> Tuple[Image.Image, str]:
        """Preprocess image for optimal recognition."""
        img = Image.open(image_path)
        
        # Convert to RGB
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        # Resize to optimal dimensions (1280px max)
        max_dim = 1280
        if img.width > max_dim or img.height > max_dim:
            img.thumbnail((max_dim, max_dim), Image.LANCZOS)
        
        # Convert to base64
        buffer = BytesIO()
        img.save(buffer, format='JPEG', quality=90)
        buffer.seek(0)
        img_base64 = base64.b64encode(buffer.read()).decode('utf-8')
        
        return img, img_base64
    
    def identify_card_direct(self, image_path: Path) -> Dict:
        """Identify card using direct LM Studio connection."""
        logger.info(f"Processing: {image_path.name}")
        
        # Preprocess image
        img, img_base64 = self.preprocess_image(image_path)
        
        # Prepare request
        request_data = {
            "model": "qwen2.5-vl-7b-instruct",
            "messages": [
                {
                    "role": "system",
                    "content": self.system_prompt
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Identify this Pokemon card. Use the complete schema. JSON only."},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_base64}"}}
                    ]
                }
            ],
            "temperature": 0.1,
            "top_p": 0.9,
            "max_tokens": 256
        }
        
        # Send request
        try:
            response = self.session.post(
                f"{self.mac_server}/v1/chat/completions",
                json=request_data,
                timeout=30
            )
            
            if response.status_code == 200:
                result = response.json()
                content = result['choices'][0]['message']['content']
                
                # Parse JSON response
                try:
                    card_data = json.loads(content)
                    card_data['source_file'] = str(image_path.name)
                    card_data['processed_at'] = datetime.now().isoformat()
                    card_data['image_size'] = f"{img.width}x{img.height}"
                    return card_data
                except json.JSONDecodeError as e:
                    logger.error(f"Invalid JSON response: {e}")
                    return {"error": "Invalid JSON", "raw": content}
            else:
                logger.error(f"Server error: {response.status_code}")
                return {"error": f"Server error: {response.status_code}"}
                
        except Exception as e:
            logger.error(f"Request failed: {e}")
            return {"error": str(e)}
    
    def identify_card_api(self, image_path: Path) -> Dict:
        """Identify card using CardMint API."""
        with open(image_path, 'rb') as f:
            files = {'image': (image_path.name, f, 'image/jpeg')}
            response = self.session.post(
                f"{self.cardmint_api}/identify",
                files=files,
                timeout=30
            )
        
        if response.status_code == 200:
            return response.json()
        else:
            return {"error": f"API error: {response.status_code}"}
    
    def scan_single_card(self, image_path: Path) -> Dict:
        """Scan a single card image."""
        if self.use_direct:
            result = self.identify_card_direct(image_path)
        else:
            result = self.identify_card_api(image_path)
        
        # Add to inventory if successful
        if not result.get('error'):
            self.inventory.append(result)
            self.save_inventory()
            
            # Move to processed
            processed_path = PROCESSED_DIR / image_path.name
            image_path.rename(processed_path)
            logger.info(f"✅ Processed: {image_path.name}")
            
        return result
    
    def scan_directory(self, watch: bool = False):
        """Scan directory for new card images."""
        logger.info(f"Scanning directory: {SCAN_DIR}")
        
        while True:
            # Find unprocessed images
            image_files = list(SCAN_DIR.glob("*.jpg")) + \
                         list(SCAN_DIR.glob("*.jpeg")) + \
                         list(SCAN_DIR.glob("*.png"))
            
            for image_path in image_files:
                result = self.scan_single_card(image_path)
                
                if not result.get('error'):
                    self.display_result(result)
                else:
                    logger.error(f"Failed to process {image_path.name}: {result['error']}")
            
            if not watch:
                break
            
            # Wait before next scan
            time.sleep(2)
    
    def display_result(self, card_data: Dict):
        """Display card identification result."""
        print("\n" + "=" * 60)
        print("CARD IDENTIFIED")
        print("=" * 60)
        print(f"Name: {card_data.get('name', 'Unknown')}")
        print(f"Set: {card_data.get('set_name', 'Unknown')}")
        print(f"Number: {card_data.get('number', 'N/A')}")
        print(f"Rarity: {card_data.get('rarity', 'Unknown')}")
        print(f"Confidence: {card_data.get('confidence', 0):.1%}")
        
        if card_data.get('hp'):
            print(f"HP: {card_data['hp']}")
        if card_data.get('type'):
            print(f"Type: {card_data['type']}")
        
        # Check for variants
        variants = card_data.get('variant_flags', {})
        if any(variants.values()):
            print("\nSpecial Variants:")
            for variant, value in variants.items():
                if value:
                    print(f"  ✓ {variant.replace('_', ' ').title()}")
        
        print("=" * 60)
    
    def batch_process(self, image_list: List[Path]) -> List[Dict]:
        """Process multiple cards in batch."""
        results = []
        total = len(image_list)
        
        for i, image_path in enumerate(image_list, 1):
            print(f"\nProcessing {i}/{total}: {image_path.name}")
            result = self.scan_single_card(image_path)
            results.append(result)
            
            # Brief delay between requests
            if i < total:
                time.sleep(0.5)
        
        return results
    
    def export_inventory(self, format: str = "csv"):
        """Export inventory to different formats."""
        if format == "csv":
            import csv
            csv_file = Path.home() / "CardMint" / "inventory.csv"
            
            with open(csv_file, 'w', newline='') as f:
                if self.inventory:
                    writer = csv.DictWriter(f, fieldnames=self.inventory[0].keys())
                    writer.writeheader()
                    writer.writerows(self.inventory)
            
            logger.info(f"Exported to {csv_file}")
            return csv_file
        
        elif format == "html":
            html_file = Path.home() / "CardMint" / "inventory.html"
            
            html_content = """
<!DOCTYPE html>
<html>
<head>
    <title>CardMint Inventory</title>
    <style>
        body { font-family: Arial, sans-serif; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #4CAF50; color: white; }
        tr:nth-child(even) { background-color: #f2f2f2; }
        .high-confidence { color: green; font-weight: bold; }
        .low-confidence { color: orange; }
        .variant { background-color: gold; }
    </style>
</head>
<body>
    <h1>CardMint Pokemon Card Inventory</h1>
    <p>Total Cards: """ + str(len(self.inventory)) + """</p>
    <table>
        <tr>
            <th>Name</th>
            <th>Set</th>
            <th>Number</th>
            <th>Rarity</th>
            <th>Type</th>
            <th>HP</th>
            <th>Variants</th>
            <th>Confidence</th>
        </tr>
"""
            
            for card in self.inventory:
                confidence_class = "high-confidence" if card.get('confidence', 0) > 0.8 else "low-confidence"
                variants = card.get('variant_flags', {})
                variant_list = [k.replace('_', ' ').title() for k, v in variants.items() if v]
                variant_str = ", ".join(variant_list) if variant_list else "-"
                
                html_content += f"""
        <tr class='{"variant" if variant_list else ""}'>
            <td>{card.get('name', 'Unknown')}</td>
            <td>{card.get('set_name', '')}</td>
            <td>{card.get('number', '')}</td>
            <td>{card.get('rarity', '')}</td>
            <td>{card.get('type', '')}</td>
            <td>{card.get('hp', '')}</td>
            <td>{variant_str}</td>
            <td class='{confidence_class}'>{card.get('confidence', 0):.1%}</td>
        </tr>
"""
            
            html_content += """
    </table>
</body>
</html>
"""
            
            with open(html_file, 'w') as f:
                f.write(html_content)
            
            logger.info(f"Exported to {html_file}")
            return html_file

def main():
    """Main entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(description="CardMint Scanner for Pokemon Cards")
    parser.add_argument('--scan', action='store_true', help='Scan directory for new cards')
    parser.add_argument('--watch', action='store_true', help='Watch directory continuously')
    parser.add_argument('--file', type=str, help='Process single image file')
    parser.add_argument('--batch', type=str, nargs='+', help='Process multiple files')
    parser.add_argument('--export', choices=['csv', 'html'], help='Export inventory')
    parser.add_argument('--stats', action='store_true', help='Show inventory statistics')
    parser.add_argument('--test', action='store_true', help='Test connection to Mac server')
    
    args = parser.parse_args()
    
    # Initialize scanner
    scanner = CardMintScanner()
    
    if args.test:
        if scanner.test_connection():
            print("✅ Connection successful!")
        else:
            print("❌ Connection failed!")
        sys.exit(0)
    
    if args.file:
        # Process single file
        result = scanner.scan_single_card(Path(args.file))
        scanner.display_result(result)
    
    elif args.batch:
        # Process batch
        files = [Path(f) for f in args.batch]
        results = scanner.batch_process(files)
        print(f"\nProcessed {len(results)} cards")
    
    elif args.scan:
        # Scan directory
        scanner.scan_directory(watch=args.watch)
    
    elif args.export:
        # Export inventory
        output_file = scanner.export_inventory(args.export)
        print(f"Exported to: {output_file}")
    
    elif args.stats:
        # Show statistics
        print(f"Total cards in inventory: {len(scanner.inventory)}")
        if scanner.inventory:
            rarities = {}
            for card in scanner.inventory:
                r = card.get('rarity', 'Unknown')
                rarities[r] = rarities.get(r, 0) + 1
            
            print("\nRarity breakdown:")
            for rarity, count in sorted(rarities.items()):
                print(f"  {rarity}: {count}")
    
    else:
        # Default: scan once
        scanner.scan_directory(watch=False)

if __name__ == "__main__":
    main()