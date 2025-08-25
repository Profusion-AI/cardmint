#!/usr/bin/env python3
"""
OpenCV Thumbnail Generation Helper
Creates optimized thumbnails for web display.
"""

import sys
import cv2

def generate_thumbnail(input_path: str, output_path: str, width: int, height: int):
    """Generate thumbnail with OpenCV"""
    try:
        # Read image
        img = cv2.imread(input_path)
        if img is None:
            raise ValueError(f"Cannot read image: {input_path}")
            
        # Calculate resize dimensions maintaining aspect ratio
        h, w = img.shape[:2]
        aspect_ratio = w / h
        target_ratio = width / height
        
        if aspect_ratio > target_ratio:
            # Image is wider, fit to width
            new_width = width
            new_height = int(width / aspect_ratio)
        else:
            # Image is taller, fit to height  
            new_height = height
            new_width = int(height * aspect_ratio)
        
        # Resize with high-quality interpolation
        resized = cv2.resize(img, (new_width, new_height), interpolation=cv2.INTER_AREA)
        
        # If we need exact dimensions, pad with border
        if new_width != width or new_height != height:
            # Calculate padding
            pad_x = (width - new_width) // 2
            pad_y = (height - new_height) // 2
            
            # Add border with average color
            mean_color = img.mean(axis=(0, 1)).astype(int)
            thumbnail = cv2.copyMakeBorder(
                resized, 
                pad_y, height - new_height - pad_y,
                pad_x, width - new_width - pad_x,
                cv2.BORDER_CONSTANT, 
                value=mean_color.tolist()
            )
        else:
            thumbnail = resized
            
        # Optimize for file size (adjust JPEG quality)
        encode_params = [cv2.IMWRITE_JPEG_QUALITY, 85]
        
        success = cv2.imwrite(output_path, thumbnail, encode_params)
        if not success:
            raise ValueError(f"Failed to write thumbnail: {output_path}")
            
        print(f"Thumbnail created: {output_path} ({width}x{height})")
        
    except Exception as e:
        print(f"Thumbnail generation failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 5:
        print("Usage: opencv_thumbnail.py <input_path> <output_path> <width> <height>", file=sys.stderr)
        sys.exit(1)
        
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    width = int(sys.argv[3])
    height = int(sys.argv[4])
    
    generate_thumbnail(input_path, output_path, width, height)