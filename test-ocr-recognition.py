#!/usr/bin/env python3
"""
Test the improved OCR recognition system
"""

import requests
import json
import sys
from pathlib import Path
import time

def test_recognition(image_path):
    """Test card recognition with an image file"""
    
    # Check if file exists
    if not Path(image_path).exists():
        print(f"Error: File not found: {image_path}")
        return
    
    # API endpoint
    url = "http://localhost:8000/api/recognize/lightweight"
    
    # Prepare the file
    with open(image_path, 'rb') as f:
        files = {'file': (Path(image_path).name, f, 'image/jpeg')}
        
        print(f"Testing recognition with: {image_path}")
        print("-" * 50)
        
        # Send request
        start_time = time.time()
        response = requests.post(url, files=files)
        request_time = (time.time() - start_time) * 1000
        
        if response.status_code == 200:
            result = response.json()
            
            print(f"✅ Recognition Successful!")
            print(f"\nCard Name: {result.get('card_name', 'Unknown')}")
            print(f"Set Name: {result.get('set_name', 'Unknown')}")
            print(f"Card Number: {result.get('card_number', 'Unknown')}")
            print(f"Rarity: {result.get('rarity', 'Unknown')}")
            print(f"\nConfidence: {result.get('confidence', 0) * 100:.1f}%")
            print(f"Ensemble Confidence: {result.get('ensemble_confidence', 0) * 100:.1f}%")
            print(f"\nInference Time: {result.get('inference_time_ms', 0):.0f}ms")
            print(f"Request Time: {request_time:.0f}ms")
            print(f"\nModels Used: {', '.join(result.get('models_used', []))}")
            
            # Check for metadata
            if 'metadata' in result:
                metadata = result['metadata']
                if metadata:
                    print(f"\nAdditional Info:")
                    if 'hp' in metadata:
                        print(f"  HP: {metadata['hp']}")
                    if 'card_type' in metadata:
                        print(f"  Type: {metadata['card_type']}")
                    if 'extracted_text' in metadata:
                        print(f"  Extracted Text (first 5):")
                        for text in metadata['extracted_text'][:5]:
                            print(f"    - {text}")
        else:
            print(f"❌ Error: {response.status_code}")
            print(response.text)

if __name__ == "__main__":
    # Default test image or use provided path
    if len(sys.argv) > 1:
        test_recognition(sys.argv[1])
    else:
        # Look for any test images
        test_images = list(Path("/home/profusionai/CardMint").glob("*.jpg")) + \
                     list(Path("/home/profusionai/CardMint").glob("*.png"))
        
        if test_images:
            print(f"Found {len(test_images)} test image(s)")
            for img in test_images[:1]:  # Test first image
                test_recognition(str(img))
        else:
            print("Usage: python test-ocr-recognition.py <image_path>")
            print("No test images found in CardMint directory")