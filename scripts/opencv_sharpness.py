#!/usr/bin/env python3
"""
OpenCV Sharpness Measurement Helper
Calculates image sharpness using Laplacian variance method.
"""

import sys
import cv2
import numpy as np

def calculate_sharpness(image_path: str) -> float:
    """Calculate image sharpness using Laplacian variance method"""
    try:
        # Read image
        img = cv2.imread(image_path)
        if img is None:
            print("error: unreadable_image", file=sys.stderr)
            sys.exit(1)
        
        # Convert to grayscale for sharpness calculation
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Apply Laplacian operator
        laplacian = cv2.Laplacian(gray, cv2.CV_64F)
        
        # Calculate variance (higher variance = sharper image)
        variance = laplacian.var()
        
        # Normalize to 0-100 scale based on typical card image variance ranges
        # Typical ranges: 0-50 (blurry), 50-150 (acceptable), 150+ (sharp)
        # Map to 0-100 scale where 100+ variance = 85+ score
        normalized_score = min(100, max(0, (variance / 150) * 85))
        
        print(f"{normalized_score:.1f}")
        return normalized_score
        
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(10)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: opencv_sharpness.py <image_path>", file=sys.stderr)
        sys.exit(1)
        
    image_path = sys.argv[1]
    calculate_sharpness(image_path)