#!/usr/bin/env python3
"""
OpenCV Edge Quality Assessment Helper
Measures card edge integrity using Canny edge detection.
"""

import sys
import cv2
import numpy as np

def calculate_edge_quality(image_path: str) -> float:
    """Calculate edge quality using Canny edge detection and contour analysis"""
    try:
        # Read image
        img = cv2.imread(image_path)
        if img is None:
            print("error: unreadable_image", file=sys.stderr)
            sys.exit(1)
        
        # Convert to grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape
        
        # Apply Gaussian blur to reduce noise
        blurred = cv2.GaussianBlur(gray, (5, 5), 1.4)
        
        # Apply Canny edge detection
        edges = cv2.Canny(blurred, 50, 150)
        
        # Find contours
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        if not contours:
            print("15.0")  # Low score if no edges detected
            return 15.0
        
        # Find the largest contour (should be the card boundary)
        largest_contour = max(contours, key=cv2.contourArea)
        
        # Calculate contour properties
        area = cv2.contourArea(largest_contour)
        perimeter = cv2.arcLength(largest_contour, True)
        
        if area == 0 or perimeter == 0:
            print("20.0")  # Low score for invalid contour
            return 20.0
        
        # Calculate circularity/rectangularity
        # For a perfect rectangle: 4*π*area/perimeter² should be close to π/4
        circularity = 4 * np.pi * area / (perimeter * perimeter)
        
        # Approximate the contour to a polygon
        epsilon = 0.02 * perimeter
        approx = cv2.approxPolyDP(largest_contour, epsilon, True)
        
        # Score based on how close to 4 corners (rectangular card)
        corner_score = 100 - abs(len(approx) - 4) * 10  # Penalty for not being 4-sided
        corner_score = max(0, min(100, corner_score))
        
        # Score based on contour area relative to image
        area_ratio = area / (w * h)
        area_score = min(100, area_ratio * 200)  # Good if contour covers reasonable portion
        
        # Score based on edge smoothness (fewer small contours = smoother edges)
        edge_smoothness = max(0, 100 - len(contours) * 2)  # Penalty for many small contours
        
        # Combine scores with weights
        edge_quality = (corner_score * 0.4 + area_score * 0.3 + edge_smoothness * 0.3)
        
        # Ensure score is in reasonable range
        edge_quality = max(10, min(100, edge_quality))
        
        print(f"{edge_quality:.1f}")
        return edge_quality
        
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(10)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: opencv_edge_quality.py <image_path>", file=sys.stderr)
        sys.exit(1)
        
    image_path = sys.argv[1]
    calculate_edge_quality(image_path)