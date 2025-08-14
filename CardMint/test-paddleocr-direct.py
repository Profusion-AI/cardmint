#!/usr/bin/env python3
"""Test PaddleOCR directly to understand the result format"""

from paddleocr import PaddleOCR
import cv2
import numpy as np
import json

# Create a synthetic test image with text
img = np.ones((600, 400, 3), dtype=np.uint8) * 255

# Add test text
cv2.putText(img, "Lightning Dragon", (50, 80), cv2.FONT_HERSHEY_DUPLEX, 1.2, (0, 0, 0), 2)
cv2.putText(img, "Legendary Creature", (50, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (50, 50, 50), 1)
cv2.putText(img, "Flying, Haste", (30, 280), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1)
cv2.putText(img, "5/5", (320, 500), cv2.FONT_HERSHEY_DUPLEX, 1, (0, 0, 0), 2)
cv2.putText(img, "123/350", (30, 550), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
cv2.putText(img, "Mythic Rare", (250, 550), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 100, 0), 1)

# Save test image
cv2.imwrite('/tmp/test_card.jpg', img)
print("Test image created at /tmp/test_card.jpg")

# Initialize OCR
print("\nInitializing PaddleOCR...")
ocr = PaddleOCR(lang='en')

# Run OCR
print("Running OCR...")
result = ocr.ocr('/tmp/test_card.jpg')

print(f"\nResult type: {type(result)}")
print(f"Result length: {len(result) if result else 0}")

if result:
    print(f"First element type: {type(result[0]) if result[0] else 'None'}")
    print(f"First element length: {len(result[0]) if result[0] else 0}")
    
    if result[0]:
        print("\nDetected text regions:")
        for i, item in enumerate(result[0][:3]):  # Show first 3
            print(f"\nRegion {i}:")
            print(f"  Type: {type(item)}")
            print(f"  Length: {len(item) if hasattr(item, '__len__') else 'N/A'}")
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                print(f"  BBox: {item[0][:2] if len(item[0]) > 2 else item[0]}")  # First 2 points
                print(f"  Text data: {item[1]}")
                if isinstance(item[1], (list, tuple)) and len(item[1]) >= 2:
                    print(f"    Text: '{item[1][0]}'")
                    print(f"    Confidence: {item[1][1]:.3f}")
    else:
        print("No text detected!")
        
    # Try to extract all text
    print("\n=== All detected text ===")
    if result[0]:
        for item in result[0]:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                text_data = item[1]
                if isinstance(text_data, (list, tuple)) and len(text_data) >= 1:
                    text = text_data[0]
                    conf = text_data[1] if len(text_data) > 1 else 0
                    print(f"'{text}' (confidence: {conf:.2f})")