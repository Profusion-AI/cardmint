#!/usr/bin/env python3
"""Debug OCR to understand why card names aren't being extracted"""

import sys
import json
from pathlib import Path

# Add src/ocr to path
sys.path.insert(0, '/home/profusionai/CardMint/src/ocr')

from paddleocr_service import CardOCRService

def test_card_ocr(image_path: str):
    """Test OCR on a card and debug the extraction process"""
    
    print(f"Testing OCR on: {image_path}")
    print("-" * 60)
    
    # Initialize service
    service = CardOCRService()
    
    # Process card
    result = service.process_card(image_path, high_accuracy=False)
    
    if result.get('success'):
        print(f"✓ OCR Success")
        print(f"  Average Confidence: {result.get('avg_confidence', 0):.2%}")
        print(f"  Total Regions: {result.get('total_regions', 0)}")
        print(f"  Requires Review: {result.get('requires_review', False)}")
        
        # Debug regions
        print("\n=== Text Regions Detected ===")
        if result.get('regions'):
            # Group by type
            title_regions = []
            body_regions = []
            metadata_regions = []
            
            for region in result['regions']:
                text = region['text']
                conf = region['confidence']
                rtype = region['type']
                y_pos = region['center']['y']
                
                print(f"[{rtype:8}] Y:{y_pos:4.0f} Conf:{conf:.2%} Text: '{text}'")
                
                if rtype == 'title':
                    title_regions.append(region)
                elif rtype == 'body':
                    body_regions.append(region)
                else:
                    metadata_regions.append(region)
            
            # Analyze title regions for card name
            print("\n=== Title Region Analysis ===")
            if title_regions:
                print(f"Found {len(title_regions)} title regions:")
                for r in title_regions:
                    print(f"  - '{r['text']}' (conf: {r['confidence']:.2%}, y: {r['center']['y']:.0f})")
                    
                # Find longest text that's not HP or stage
                potential_names = []
                for r in title_regions:
                    text = r['text'].strip()
                    # Skip HP indicators and pure numbers
                    if not text.lower().startswith('hp') and not text.isdigit():
                        # Skip exact stage matches
                        stages = ['basic', 'stage 1', 'stage 2', 'ex', 'gx', 'v', 'vmax', 'vstar']
                        if text.lower() not in stages:
                            potential_names.append((text, len(text), r['confidence']))
                
                if potential_names:
                    print("\nPotential card names:")
                    for name, length, conf in sorted(potential_names, key=lambda x: x[1], reverse=True):
                        print(f"  - '{name}' (length: {length}, conf: {conf:.2%})")
                else:
                    print("\nNo potential card names found in title regions!")
            else:
                print("No title regions detected!")
                
                # Check if card name might be in body regions
                print("\n=== Checking Body Regions for Card Name ===")
                for r in body_regions[:5]:  # Check first 5 body regions
                    if r['center']['y'] < 200:  # Near top
                        print(f"  Near-top text: '{r['text']}' (y: {r['center']['y']:.0f})")
        
        # Show extracted card info
        print("\n=== Extracted Card Information ===")
        if result.get('extracted_card_info'):
            info = result['extracted_card_info']
            print(f"Card Name: {info.get('card_name', 'Not found')}")
            print(f"HP: {info.get('hp', 'Not found')}")
            print(f"Stage: {info.get('stage', 'Not found')}")
            print(f"Card Number: {info.get('card_number', 'Not found')}")
            print(f"Rarity: {info.get('rarity', 'Not found')}")
            
            if info.get('attacks'):
                print(f"Attacks: {', '.join([a['name'] for a in info['attacks']])}")
        else:
            print("No card information extracted!")
            
    else:
        print(f"✗ OCR Failed: {result.get('error', 'Unknown error')}")
    
    return result

if __name__ == "__main__":
    # Test with synthetic Blissey cards
    test_images = [
        ("/home/profusionai/CardMint/blissey_simple.jpg", "Simple Blissey"),
        ("/home/profusionai/CardMint/blissey_synthetic.jpg", "Synthetic Blissey"),
        ("/home/profusionai/CardMint/test-card.jpg", "Generic Test Card")
    ]
    
    for image_path, description in test_images:
        if Path(image_path).exists():
            print(f"\nTesting with {description}...")
            print("=" * 60)
            test_card_ocr(image_path)
        else:
            print(f"{description} not found at {image_path}")