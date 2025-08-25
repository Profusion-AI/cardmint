#!/usr/bin/env python3
"""
OpenCV Image Enhancement Helper
Performs CLAHE, denoising, and basic enhancement operations.
"""

import sys
import cv2
import numpy as np

def enhance_image(input_path: str, output_path: str):
    """Apply image enhancement using OpenCV"""
    try:
        # Read image
        img = cv2.imread(input_path, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError(f"Cannot read image: {input_path}")
        
        # Convert to LAB color space for better CLAHE
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        
        # Apply CLAHE (Contrast Limited Adaptive Histogram Equalization) to L channel
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        
        # Merge channels back
        enhanced_lab = cv2.merge((cl, a, b))
        enhanced_img = cv2.cvtColor(enhanced_lab, cv2.COLOR_LAB2BGR)
        
        # Apply light denoising
        denoised = cv2.fastNlMeansDenoisingColored(enhanced_img, None, 3, 3, 7, 21)
        
        # Optional: slight sharpening with unsharp mask
        gaussian = cv2.GaussianBlur(denoised, (0, 0), 1.0)
        sharpened = cv2.addWeighted(denoised, 1.5, gaussian, -0.5, 0)
        
        # Save result (may be same as input for in-place enhancement)
        success = cv2.imwrite(output_path, sharpened)
        if not success:
            raise ValueError(f"Failed to write enhanced image: {output_path}")
            
        print(f"Enhanced: {input_path} -> {output_path}")
        
    except Exception as e:
        print(f"Enhancement failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: opencv_enhance.py <input_path> <output_path>", file=sys.stderr)
        sys.exit(1)
        
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    
    enhance_image(input_path, output_path)