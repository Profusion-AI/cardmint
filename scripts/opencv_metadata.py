#!/usr/bin/env python3
"""
OpenCV Metadata Extraction Helper
Extracts basic image metadata as JSON.
"""

import sys
import cv2
import json
import os

def get_metadata(image_path: str):
    """Extract image metadata and return as JSON"""
    try:
        # Read image
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Cannot read image: {image_path}")
            
        h, w, channels = img.shape
        
        # Determine format from file extension
        _, ext = os.path.splitext(image_path.lower())
        format_map = {
            '.jpg': 'JPEG',
            '.jpeg': 'JPEG', 
            '.png': 'PNG',
            '.gif': 'GIF',
            '.bmp': 'BMP',
            '.webp': 'WebP'
        }
        format_name = format_map.get(ext, 'Unknown')
        
        metadata = {
            'width': w,
            'height': h,
            'channels': channels,
            'format': format_name,
            'aspect_ratio': w / h,
            'file_extension': ext
        }
        
        print(json.dumps(metadata))
        
    except Exception as e:
        error_data = {
            'error': str(e),
            'width': 0,
            'height': 0,
            'format': 'Unknown'
        }
        print(json.dumps(error_data))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: opencv_metadata.py <image_path>", file=sys.stderr)
        sys.exit(1)
        
    image_path = sys.argv[1]
    get_metadata(image_path)