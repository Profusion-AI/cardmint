#!/usr/bin/env python3
"""
OpenCV Image Validation Helper
Performs quick validation checks for Pokemon card images.
"""

import sys
import cv2

def validate_image(image_path: str):
    """Validate image for Pokemon card processing"""
    try:
        # Read image
        img = cv2.imread(image_path)
        if img is None:
            print("unreadable_image", file=sys.stderr)
            sys.exit(1)
            
        h, w = img.shape[:2]
        
        # Check minimum resolution (Pokemon cards should be reasonably high-res for OCR)
        if h < 400 or w < 300:
            print("resolution_too_low", file=sys.stderr)
            sys.exit(2)
            
        # Check aspect ratio (Pokemon cards are roughly 63:88 = ~0.716)
        # Allow reasonable tolerance for different scanning angles/crops
        ratio = w / h
        if ratio < 0.5 or ratio > 1.2:
            print("bad_aspect_ratio", file=sys.stderr)
            sys.exit(3)
            
        # Check if image is not completely dark or oversaturated
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        mean_brightness = gray.mean()
        
        if mean_brightness < 20:  # Too dark
            print("image_too_dark", file=sys.stderr)
            sys.exit(4)
            
        if mean_brightness > 240:  # Too bright/washed out
            print("image_too_bright", file=sys.stderr)
            sys.exit(5)
            
        # Check if image has reasonable contrast
        _, std = cv2.meanStdDev(gray)
        if std[0][0] < 15:  # Very low standard deviation = low contrast
            print("low_contrast", file=sys.stderr)
            sys.exit(6)
            
        # All checks passed
        print(f"valid: {w}x{h}, ratio={ratio:.3f}, brightness={mean_brightness:.1f}")
        sys.exit(0)
        
    except Exception as e:
        print(f"validation_error: {e}", file=sys.stderr)
        sys.exit(10)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: opencv_validate.py <image_path>", file=sys.stderr)
        sys.exit(1)
        
    image_path = sys.argv[1]
    validate_image(image_path)