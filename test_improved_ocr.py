#!/usr/bin/env python3
"""Test the improved OCR service with debugging"""

import sys
import json
import cv2
import numpy as np
from pathlib import Path

sys.path.insert(0, '/home/profusionai/CardMint/src/ocr')

from paddleocr_service_improved import ImprovedCardOCRService

def test_ocr_with_debug():
    """Test OCR with detailed debugging"""
    
    # First, let's create a very clear test image
    img = np.ones((600, 400, 3), dtype=np.uint8) * 255
    
    # Add clear black text on white background
    font = cv2.FONT_HERSHEY_SIMPLEX
    
    # Card name - large and clear
    cv2.putText(img, "Blissey", (50, 80), font, 2.0, (0, 0, 0), 3)
    
    # HP value
    cv2.putText(img, "HP 120", (280, 80), font, 1.0, (0, 0, 0), 2)
    
    # Stage
    cv2.putText(img, "Stage 1", (50, 130), font, 0.8, (0, 0, 0), 2)
    
    # Attack
    cv2.putText(img, "Double Edge", (50, 300), font, 1.0, (0, 0, 0), 2)
    cv2.putText(img, "120", (320, 300), font, 1.0, (0, 0, 0), 2)
    
    # Card number
    cv2.putText(img, "2/64", (50, 550), font, 0.8, (0, 0, 0), 2)
    
    # Save test image
    test_path = "/home/profusionai/CardMint/test_clear_blissey.jpg"
    cv2.imwrite(test_path, img)
    print(f"Created test image: {test_path}")
    
    # Test with improved service
    print("\n=== Testing Improved OCR Service ===")
    service = ImprovedCardOCRService()
    
    # Test the clear image
    print("\nProcessing clear test image...")
    result = service.process_card(test_path)
    
    if result['success']:
        print(f"✓ Success!")
        print(f"  Regions found: {result['total_regions']}")
        print(f"  Average confidence: {result['avg_confidence']:.2%}")
        
        if result.get('extracted_card_info'):
            info = result['extracted_card_info']
            print("\n=== Extracted Card Info ===")
            print(f"  Card Name: {info.get('card_name', 'NOT FOUND')}")
            print(f"  Name Confidence: {info.get('name_confidence', 0):.2%}")
            print(f"  HP: {info.get('hp', 'NOT FOUND')}")
            print(f"  Stage: {info.get('stage', 'NOT FOUND')}")
            print(f"  Card Number: {info.get('card_number', 'NOT FOUND')}")
            
            if info.get('attacks'):
                print(f"  Attacks: {', '.join(info['attacks'])}")
        
        if result.get('regions'):
            print("\n=== Text Regions ===")
            for r in result['regions'][:10]:  # Show first 10
                print(f"  [{r['type']:8}] '{r['text']}' (conf: {r['confidence']:.2%})")
    else:
        print(f"✗ Failed: {result.get('error')}")
    
    # Also test with the synthetic cards
    print("\n" + "="*60)
    
    test_images = [
        "/home/profusionai/CardMint/blissey_synthetic.jpg",
        "/home/profusionai/CardMint/test-card.jpg"
    ]
    
    for img_path in test_images:
        if Path(img_path).exists():
            print(f"\nTesting: {img_path}")
            result = service.process_card(img_path)
            
            if result['success']:
                info = result.get('extracted_card_info', {})
                print(f"  ✓ Card Name: {info.get('card_name', 'NOT FOUND')}")
                print(f"  ✓ Regions: {result['total_regions']}")
                print(f"  ✓ Confidence: {result['avg_confidence']:.2%}")
            else:
                print(f"  ✗ Failed: {result.get('error')}")

if __name__ == "__main__":
    test_ocr_with_debug()