#!/usr/bin/env python3
import sys
import cv2
import numpy as np
import os

"""
Generate simple ROI crops for Pokemon TCG cards:
- deskew: perspective correction and contrast enhancement
- name: top bar (name area)
- number: bottom-right area (card number)
- symbol: bottom-right wider area (set symbol vicinity)

Usage: opencv_rois.py <input_path> <output_prefix>
Creates files:
  <output_prefix>.deskew.jpg
  <output_prefix>.name.jpg
  <output_prefix>.number.jpg
  <output_prefix>.symbol.jpg
"""

def enhance(img):
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
    l2 = clahe.apply(l)
    lab2 = cv2.merge((l2, a, b))
    return cv2.cvtColor(lab2, cv2.COLOR_LAB2BGR)

def enhance_number_roi(img):
    """Enhanced preprocessing specifically for card number region"""
    if img is None or img.size == 0:
        return img
    
    # Convert to grayscale for text processing
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Denoise while preserving edges
    denoised = cv2.fastNlMeansDenoising(gray, h=10, templateWindowSize=7, searchWindowSize=21)
    
    # Adaptive thresholding for better text contrast
    adaptive_thresh = cv2.adaptiveThreshold(denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)
    
    # CLAHE for improved contrast
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4,4))
    clahe_applied = clahe.apply(adaptive_thresh)
    
    # Gentle sharpening kernel for text clarity
    sharpen_kernel = np.array([[-1,-1,-1], [-1,9,-1], [-1,-1,-1]])
    sharpened = cv2.filter2D(clahe_applied, -1, sharpen_kernel)
    
    # Convert back to BGR for consistent output
    result = cv2.cvtColor(sharpened, cv2.COLOR_GRAY2BGR)
    
    return result

def find_card_quad(gray):
    # Canny + contour to find largest 4-point contour (card)
    edges = cv2.Canny(gray, 50, 150)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)
    for cnt in contours[:10]:
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02*peri, True)
        if len(approx) == 4:
            return approx.reshape(4,2)
    return None

def order_points(pts):
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect

def four_point_transform(image, pts):
    rect = order_points(pts)
    (tl, tr, br, bl) = rect
    widthA = np.linalg.norm(br - bl)
    widthB = np.linalg.norm(tr - tl)
    maxWidth = int(max(widthA, widthB))
    heightA = np.linalg.norm(tr - br)
    heightB = np.linalg.norm(tl - bl)
    maxHeight = int(max(heightA, heightB))
    dst = np.array([
        [0, 0],
        [maxWidth - 1, 0],
        [maxWidth - 1, maxHeight - 1],
        [0, maxHeight - 1]], dtype = "float32")
    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))
    return warped

def main():
    if len(sys.argv) < 3:
        print("Usage: opencv_rois.py <input_path> <output_prefix>")
        sys.exit(2)
    inp = sys.argv[1]
    outp = sys.argv[2]
    img = cv2.imread(inp)
    if img is None:
        print("Failed to read input image", file=sys.stderr)
        sys.exit(1)

    # Resize if gigantic to keep reasonable processing
    h, w = img.shape[:2]
    scale = 1200 / max(h, w)
    if scale < 1.0:
        img_small = cv2.resize(img, (int(w*scale), int(h*scale)))
    else:
        img_small = img.copy()

    gray = cv2.cvtColor(img_small, cv2.COLOR_BGR2GRAY)
    quad = find_card_quad(gray)
    if quad is not None:
        warped = four_point_transform(img_small, quad)
    else:
        warped = img_small

    warped = enhance(warped)
    wh, ww = warped.shape[:2]

    # Save deskew
    deskew_path = f"{outp}.deskew.jpg"
    cv2.imwrite(deskew_path, warped)

    # Heuristic ROIs relative to warped card
    # Name bar: top 14% height, centered horizontally with small margins
    nh = int(0.14 * wh)
    nx0 = int(0.06 * ww)
    nx1 = int(0.94 * ww)
    name_crop = warped[0:nh, nx0:nx1]
    cv2.imwrite(f"{outp}.name.jpg", name_crop)

    # Number block: bottom 12% height, right 40% width
    y0 = int(0.88 * wh)
    x0 = int(0.60 * ww)
    number_crop = warped[y0:wh, x0:ww]
    
    # Enhanced preprocessing for number region
    number_enhanced = enhance_number_roi(number_crop)
    cv2.imwrite(f"{outp}.number.jpg", number_enhanced)

    # Symbol area: bottom 14% height, right 55% width (wider)
    y1 = int(0.86 * wh)
    x1 = int(0.45 * ww)
    symbol_crop = warped[y1:wh, x1:ww]
    cv2.imwrite(f"{outp}.symbol.jpg", symbol_crop)

if __name__ == '__main__':
    main()

