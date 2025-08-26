#!/usr/bin/env python3
"""
OpenCV Glare Detection Helper
Measures glare percentage by counting oversaturated pixels.
"""

import sys
import cv2
import numpy as np

def calculate_glare_percentage(image_path: str) -> float:
    """Calculate glare percentage by counting oversaturated pixels"""
    try:
        # Read image
        img = cv2.imread(image_path)
        if img is None:
            print("error: unreadable_image", file=sys.stderr)
            sys.exit(1)
        
        # Get image dimensions
        h, w = img.shape[:2]
        total_pixels = h * w
        
        # Convert to HSV to better detect oversaturated areas
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        
        # Define oversaturation thresholds:
        # - Very high brightness (V > 250)
        # - Low saturation (washed out areas)
        v_channel = hsv[:, :, 2]  # Value channel
        s_channel = hsv[:, :, 1]  # Saturation channel
        
        # Count pixels that are oversaturated (bright but not colorful)
        oversaturated_mask = (v_channel > 250) & (s_channel < 30)
        oversaturated_pixels = np.sum(oversaturated_mask)
        
        # Also count pixels that are just too bright in RGB
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        too_bright_mask = gray > 250
        too_bright_pixels = np.sum(too_bright_mask)
        
        # Take the maximum of both methods
        glare_pixels = max(oversaturated_pixels, too_bright_pixels)
        
        # Calculate percentage
        glare_percentage = (glare_pixels / total_pixels) * 100
        
        print(f"{glare_percentage:.1f}")
        return glare_percentage
        
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(10)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: opencv_glare.py <image_path>", file=sys.stderr)
        sys.exit(1)
        
    image_path = sys.argv[1]
    calculate_glare_percentage(image_path)