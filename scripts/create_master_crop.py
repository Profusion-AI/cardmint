#!/usr/bin/env python3
"""
Create Master Crop

Generates a high-quality "master" crop of a Pokemon card from a raw/distorted image.
Uses homography to rectify the image to a standard size (2048x1432 or 1432x2048).
Auto-rotates to upright orientation.

Usage:
    python3 create_master_crop.py --input <path> --output <path> [--side front|back] [--debug]
"""

import cv2
import numpy as np
import sys
import argparse
import json
from pathlib import Path
from PIL import Image
from PIL.ExifTags import TAGS

# Standard Pokemon card dimensions (approx 2.5 x 3.5 inches)
# We'll use a high-res target size
TARGET_WIDTH = 1432
TARGET_HEIGHT = 2048
CROPS_DIR = Path(__file__).parent / "crops"
CONFIDENCE_THRESHOLD = 0.7
CROP_MARGIN_PCT = 0.06  # Expand detected corners by 6% to keep full border
MIN_MARGIN_PX = 12     # Never crop tighter than this absolute padding

# Orientation configuration per side so we can tune without rewriting the scorer
ORIENTATION_CONFIG = {
    "front": {
        "weights": {
            "edge": 0.35,
            "text": 0.35,
            "brightness": 0.15,
            "frame": 0.15,
        },
        "thresholds": {
            "edge_ratio": 1.08,
            "text_ratio": 1.08,
            "brightness_ratio": 0.9,
            "frame_ratio": 1.05,
        },
    },
    "back": {
        # Pokemon back is more symmetric; lean slightly more on frame/border contrast
        "weights": {
            "edge": 0.25,
            "text": 0.20,
            "brightness": 0.20,
            "frame": 0.35,
        },
        "thresholds": {
            "edge_ratio": 1.05,
            "text_ratio": 1.05,
            "brightness_ratio": 0.9,
            "frame_ratio": 1.02,
        },
    },
}

# EXIF Orientation tag values -> rotation needed
# See: https://exiftool.org/TagNames/EXIF.html
EXIF_ORIENTATION_MAP = {
    1: 0,    # Normal
    2: 0,    # Mirrored (ignore mirror, just don't rotate)
    3: 180,  # Rotated 180
    4: 180,  # Mirrored + 180
    5: 90,   # Mirrored + 90 CCW
    6: 90,   # Rotated 90 CW (camera held vertically, top on right)
    7: 270,  # Mirrored + 90 CW
    8: 270,  # Rotated 90 CCW (camera held vertically, top on left)
}


def get_exif_orientation(image_path, debug=False):
    """
    Read EXIF orientation tag from image file.
    Returns rotation in degrees (0, 90, 180, 270) or None if not available.
    """
    try:
        with Image.open(image_path) as pil_img:
            exif_data = pil_img._getexif()
            if exif_data is None:
                if debug:
                    print("No EXIF data found")
                return None

            # Find orientation tag (tag ID 274)
            for tag_id, value in exif_data.items():
                tag_name = TAGS.get(tag_id, tag_id)
                if tag_name == "Orientation":
                    rotation = EXIF_ORIENTATION_MAP.get(value, 0)
                    if debug:
                        print(f"EXIF Orientation: {value} -> {rotation}° rotation")
                    return rotation

            if debug:
                print("No Orientation tag in EXIF")
            return None
    except Exception as e:
        if debug:
            print(f"EXIF read failed: {e}")
        return None

def order_points(pts):
    """
    Order points in top-left, top-right, bottom-right, bottom-left order.
    """
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def expand_corners(pts, image_shape, margin_pct=0.02, min_margin_px=0):
    """
    Expand corner points outward by a percentage margin.
    This loosens the crop to ensure full card border is captured.

    Args:
        pts: 4 corner points
        image_shape: (height, width) of image for bounds checking
        margin_pct: percentage to expand (0.02 = 2%)
        min_margin_px: absolute minimum pixels to expand each direction
    """
    rect = order_points(pts.astype(np.float32))
    (tl, tr, br, bl) = rect

    # Calculate center of the quadrilateral
    center = np.mean(rect, axis=0)

    # Ensure we always expand by at least a small absolute padding
    h, w = image_shape[:2]
    min_dim = max(1, min(h, w))
    effective_margin = max(margin_pct, float(min_margin_px) / float(min_dim))

    # Expand each corner away from center
    expanded = np.zeros_like(rect)
    for i, pt in enumerate(rect):
        direction = pt - center
        expanded[i] = pt + direction * effective_margin

    # Clamp to image bounds
    expanded[:, 0] = np.clip(expanded[:, 0], 0, w - 1)
    expanded[:, 1] = np.clip(expanded[:, 1], 0, h - 1)

    return expanded.astype(np.float32)

def four_point_transform(image, pts):
    """
    Apply perspective transform to obtain a top-down view.
    """
    rect = order_points(pts)
    (tl, tr, br, bl) = rect

    # Compute width of the new image
    widthA = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
    widthB = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
    maxWidth = max(int(widthA), int(widthB))

    # Compute height of the new image
    heightA = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
    heightB = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
    maxHeight = max(int(heightA), int(heightB))

    # Construct set of destination points
    dst = np.array([
        [0, 0],
        [maxWidth - 1, 0],
        [maxWidth - 1, maxHeight - 1],
        [0, maxHeight - 1]], dtype="float32")

    # Compute the perspective transform matrix and then apply it
    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))

    return warped

def auto_canny_thresholds(gray):
    # Use the median to derive Canny thresholds that adapt to lighting.
    v = np.median(gray)
    lower = int(max(0, (1.0 - 0.33) * v))
    upper = int(min(255, (1.0 + 0.33) * v))
    return lower, upper

def detect_card_corners(image, debug=False):
    """
    Detect the 4 corners of the card using multiple strategies.
    Handles yellow or silver borders on various backgrounds.
    """
    image_area = image.shape[0] * image.shape[1]

    # Strategy 1: Edge-based detection with adaptive thresholds
    corners = _detect_corners_edge_based(image, image_area, debug)
    if corners is not None:
        if debug: print("Found corners via edge detection")
        return corners

    # Strategy 2: Fixed Canny thresholds (works better for low-contrast)
    corners = _detect_corners_fixed_canny(image, image_area, debug)
    if corners is not None:
        if debug: print("Found corners via fixed Canny")
        return corners

    # Strategy 3: Saturation-based detection (card vs mat color difference)
    corners = _detect_corners_saturation(image, image_area, debug)
    if corners is not None:
        if debug: print("Found corners via saturation analysis")
        return corners

    if debug: print("All corner detection strategies failed")
    return None


def _detect_corners_edge_based(image, image_area, debug=False):
    """Edge-based detection with adaptive thresholds."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    lower, upper = auto_canny_thresholds(gray)
    edges = cv2.Canny(gray, lower, upper, apertureSize=3, L2gradient=True)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    edges = cv2.dilate(edges, kernel, iterations=2)
    edges = cv2.erode(edges, kernel, iterations=1)

    return _find_card_contour(edges, image_area, debug)


def _detect_corners_fixed_canny(image, image_area, debug=False):
    """Edge detection with fixed thresholds for low-contrast scenarios."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    # Try multiple fixed threshold combinations
    for (lower, upper) in [(30, 100), (50, 150), (20, 80)]:
        edges = cv2.Canny(gray, lower, upper, apertureSize=3, L2gradient=True)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        edges = cv2.dilate(edges, kernel, iterations=1)

        corners = _find_card_contour(edges, image_area, debug)
        if corners is not None:
            return corners

    return None


def _detect_corners_saturation(image, image_area, debug=False):
    """Use saturation channel to distinguish card from mat."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]

    # Card typically has different saturation than orange/yellow mat
    # Use Otsu's method to find optimal threshold
    _, thresh = cv2.threshold(sat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Try both the threshold and its inverse
    for img in [thresh, cv2.bitwise_not(thresh)]:
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        cleaned = cv2.morphologyEx(img, cv2.MORPH_CLOSE, kernel, iterations=2)
        cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, kernel, iterations=1)

        corners = _find_card_contour(cleaned, image_area, debug)
        if corners is not None:
            return corners

    return None


def _find_card_contour(binary_image, image_area, debug=False):
    """Find a card-shaped contour in a binary image."""
    contours, _ = cv2.findContours(binary_image, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    # Sort contours by area, largest first
    contours = sorted(contours, key=cv2.contourArea, reverse=True)

    # Card should occupy a large portion of frame; inner art is much smaller
    min_area_fraction = 0.20
    max_area_fraction = 0.90
    aspect_min = 1.15  # normalized (handles portrait/landscape)
    aspect_max = 1.7

    fallback_rect = None

    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area_fraction * image_area or area > max_area_fraction * image_area:
            continue

        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)

        if len(approx) == 4:
            (tl, tr, br, bl) = order_points(approx.reshape(4, 2))
            widthA = np.linalg.norm(br - bl)
            widthB = np.linalg.norm(tr - tl)
            heightA = np.linalg.norm(tr - br)
            heightB = np.linalg.norm(tl - bl)
            width = max(widthA, widthB)
            height = max(heightA, heightB)
            if width == 0 or height == 0:
                continue
            ratio = height / width
            normalized = ratio if ratio >= 1 else 1 / ratio
            if aspect_min <= normalized <= aspect_max:
                if debug: print(f"Found quad with ratio {ratio:.2f}, area {area/image_area:.1%}")
                return approx.reshape(4, 2)
            elif debug:
                print(f"Rejected quad with ratio {ratio:.2f} (normalized {normalized:.2f})")

        # Fallback to rotated rectangle if we at least have a reasonable aspect
        if len(approx) != 4 and area > min_area_fraction * image_area:
            rect = cv2.minAreaRect(c)
            box = cv2.boxPoints(rect)
            w, h = rect[1]
            if w > 0 and h > 0:
                normalized = max(w, h) / min(w, h)
                if aspect_min <= normalized <= aspect_max:
                    fallback_rect = np.intp(box)
                    if debug: print(f"Prepared fallback rotated rect with ratio {normalized:.2f}, area {area/image_area:.1%}")

    return fallback_rect

def _orientation_score(image):
    """
    Compute upright indicators for a portrait-oriented image.

    Returns a dict of ratios (top vs bottom) so callers can weight them.
    """
    h, w = image.shape[:2]

    # Divide into top and bottom bands
    top_region = image[0:int(h * 0.18), :]
    bottom_region = image[int(h * 0.82):, :]

    # Heuristic 1: Edge density - top should have more edges when upright
    top_edges = _compute_edge_density(top_region)
    bottom_edges = _compute_edge_density(bottom_region)

    # Heuristic 2: Text-like density
    top_text = _compute_text_density(top_region)
    bottom_text = _compute_text_density(bottom_region)

    # Heuristic 3: Brightness asymmetry
    top_left_brightness = _region_brightness(image[0:int(h*0.12), 0:int(w*0.25)])
    bottom_left_brightness = _region_brightness(image[int(h*0.88):, 0:int(w*0.25)])

    # Heuristic 4: Frame/border contrast (helps art-heavy layouts)
    top_frame, bottom_frame = _border_edge_strength(image)

    return {
        "edge_ratio": (top_edges + 1e-6) / (bottom_edges + 1e-6),
        "text_ratio": (top_text + 1e-6) / (bottom_text + 1e-6),
        "brightness_ratio": (top_left_brightness + 1e-6) / (bottom_left_brightness + 1e-6),
        "frame_ratio": (top_frame + 1e-6) / (bottom_frame + 1e-6),
    }


def _get_rotation_candidates(image):
    """
    Generate rotation candidates for scoring.
    Returns list of (rotated_image, label, cv2_rotation_code_or_none).

    For landscape: try both 90° CW and 90° CCW - the scoring function
    will naturally prefer whichever orientation looks "upright".
    (Note: 90° CW + 180° = 90° CCW, so we only need 2 candidates)

    For portrait: try 0° and 180° to detect upside-down.
    """
    h, w = image.shape[:2]
    is_landscape = w > h

    if is_landscape:
        # Two unique portrait orientations from landscape
        return [
            (cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE), "90°CW", cv2.ROTATE_90_CLOCKWISE),
            (cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE), "90°CCW", cv2.ROTATE_90_COUNTERCLOCKWISE),
        ]
    else:
        # Portrait: check current vs 180° flip
        return [
            (image, "0°", None),
            (cv2.rotate(image, cv2.ROTATE_180), "180°", cv2.ROTATE_180),
        ]


def _apply_rotation(image, angle):
    """Apply rotation in degrees (0, 90, 180, 270) to the image."""
    if angle == 90:
        return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    if angle == 180:
        return cv2.rotate(image, cv2.ROTATE_180)
    if angle == 270:
        return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return image


def _border_edge_strength(image):
    """Compute edge density in thin top/bottom bands to capture frame geometry."""
    h, w = image.shape[:2]
    band = max(4, int(h * 0.06))
    top_band = image[0:band, :]
    bottom_band = image[h - band:h, :]
    return _compute_edge_density(top_band), _compute_edge_density(bottom_band)


def _score_orientation(image, side):
    """Score rotation candidates and return metadata."""
    config = ORIENTATION_CONFIG.get(side, ORIENTATION_CONFIG["front"])
    weights = config["weights"]
    thresholds = config["thresholds"]

    candidates = _get_rotation_candidates(image)
    scored = []
    max_score = sum(weights.values())

    for rotated, label, _ in candidates:
        detail_ratios = _orientation_score(rotated)
        votes = []
        if detail_ratios["edge_ratio"] > thresholds["edge_ratio"]:
            votes.append(weights["edge"])
        if detail_ratios["text_ratio"] > thresholds["text_ratio"]:
            votes.append(weights["text"])
        if detail_ratios["brightness_ratio"] > thresholds["brightness_ratio"]:
            votes.append(weights["brightness"])
        if detail_ratios["frame_ratio"] > thresholds["frame_ratio"]:
            votes.append(weights["frame"])

        score = float(sum(votes))
        angle = 0
        if label == "180°":
            angle = 180
        elif label == "90°CW":
            angle = 90
        elif label == "90°CCW":
            angle = 270

        scored.append({
            "label": label,
            "angle": angle,
            "score": score,
            "max_score": max_score,
            "details": detail_ratios,
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    best = scored[0]
    runner = scored[1] if len(scored) > 1 else {"score": 0.0}
    margin = best["score"] - runner["score"]
    # Confidence combines absolute score and margin so art-heavy cards don't flip wildly
    confidence = min(
        1.0,
        max(best["score"] / max_score, 0.0) * 0.6 + max(margin, 0.0) / max_score * 0.4
    )

    return {
        "best": best,
        "runner_up_score": runner["score"],
        "margin": margin,
        "confidence": confidence,
        "candidates": scored,
    }


def auto_rotate_scored(image, exif_rotation=None, side="front", debug=False):
    """
    Rotate image to upright orientation.

    For CardMint's fixed capture rig (Pi5 camera, fixed mount, fixed card placement),
    we use a simple deterministic rotation instead of unreliable heuristics.

    Landscape images from the capture rig need 90° CCW rotation to be upright.
    Portrait images are checked for 180° flip using heuristics as a sanity check.

    Args:
        image: OpenCV BGR image
        exif_rotation: Rotation from EXIF (0, 90, 180, 270) or None (ignored for fixed rig)
        side: 'front' | 'back' (currently unused, kept for API compatibility)
        debug: Print rotation details

    Returns:
        Rotated image in portrait orientation and decision metadata
    """
    h, w = image.shape[:2]
    is_landscape = w > h

    if is_landscape:
        # Fixed capture rig: landscape images always need 90° CCW to be upright
        rotation = 270
        rotated_image = cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
        strategy = "fixed-rig-ccw"
        confidence = 1.0

        if debug:
            print(f"  Fixed rig rotation: 90° CCW (landscape input)")
    else:
        # Portrait input: use heuristics to check for 180° flip
        result = _score_orientation(image, side)
        best = result["best"]
        confidence = result["confidence"]

        if debug:
            print(f"  Heuristic best={best['label']} score={best['score']:.2f}/{best['max_score']:.2f} confidence={confidence:.2f}")

        if confidence >= CONFIDENCE_THRESHOLD and best["angle"] == 180:
            rotation = 180
            rotated_image = cv2.rotate(image, cv2.ROTATE_180)
            strategy = "heuristic-flip"
        else:
            rotation = 0
            rotated_image = image
            strategy = "no-rotate"

    # Final check: ensure portrait orientation
    h, w = rotated_image.shape[:2]
    if w > h:
        rotated_image = cv2.rotate(rotated_image, cv2.ROTATE_90_CLOCKWISE)
        rotation = (rotation + 90) % 360

    metadata = {
        "rotation": rotation,
        "confidence": confidence,
        "strategy": strategy,
        "side": side,
    }

    return rotated_image, metadata


# Legacy wrapper for backward compatibility
def auto_rotate(image, debug=False):
    """
    Legacy wrapper - calls auto_rotate_scored without EXIF.
    """
    rotated, _ = auto_rotate_scored(image, exif_rotation=None, side="front", debug=debug)
    return rotated


def _compute_edge_density(region):
    """Compute edge density in a region."""
    if region.size == 0:
        return 0
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    return np.sum(edges > 0) / edges.size


def _compute_text_density(region):
    """Estimate text-like feature density using morphological operations."""
    if region.size == 0:
        return 0
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    # Text appears as small, high-contrast regions
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Small kernel to detect text-sized features
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    text_features = cv2.morphologyEx(binary, cv2.MORPH_GRADIENT, kernel)
    return np.sum(text_features > 0) / text_features.size


def _region_brightness(region):
    """Compute average brightness of a region."""
    if region.size == 0:
        return 128
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    return np.mean(gray)

def resize_to_master(image):
    """
    Resize to standard master dimensions.
    """
    return cv2.resize(image, (TARGET_WIDTH, TARGET_HEIGHT), interpolation=cv2.INTER_LANCZOS4)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Input image path")
    parser.add_argument(
        "--output",
        help="Output image path; default: scripts/crops/<input_name>_crop.jpg",
    )
    parser.add_argument(
        "--side",
        choices=["front", "back"],
        default="front",
        help="Card side to process (front|back); defaults to front",
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug output")
    args = parser.parse_args()

    try:
        input_path = Path(args.input)

        # Read EXIF orientation before OpenCV loads (OpenCV strips EXIF)
        exif_rotation = get_exif_orientation(str(input_path), args.debug)

        img = cv2.imread(str(input_path))
        if img is None:
            raise ValueError(f"Could not load image: {args.input}")

        if args.output:
            output_path = Path(args.output)
        else:
            output_path = CROPS_DIR / f"{input_path.stem}_crop.jpg"
        if output_path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            output_path = output_path.with_suffix(".jpg")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # 1. Detect corners
        corners = detect_card_corners(img, args.debug)

        if corners is None:
            # Fallback: just center crop or use whole image if detection fails
            # For now, we'll just use the whole image but warn
            if args.debug: print("Corner detection failed, using full image")
            warped = img
        else:
            # 2. Expand corners slightly to avoid too-tight crop
            expanded = expand_corners(corners, img.shape, margin_pct=CROP_MARGIN_PCT, min_margin_px=MIN_MARGIN_PX)
            if args.debug:
                print(f"Expanded corners by {CROP_MARGIN_PCT*100:.1f}% (min {MIN_MARGIN_PX}px)")

            # 3. Perspective transform
            warped = four_point_transform(img, expanded)

        # 3. Auto-rotate to portrait using EXIF + scoring
        rotated, orientation_meta = auto_rotate_scored(warped, exif_rotation, args.side, args.debug)

        # 4. Resize to master dimensions
        final = resize_to_master(rotated)

        # 5. Save
        cv2.imwrite(str(output_path), final, [cv2.IMWRITE_JPEG_QUALITY, 95])
        
        # Print JSON result for parsing
        result = {
            "status": "success",
            "output": str(output_path),
            "rotation": orientation_meta.get("rotation"),
            "confidence": orientation_meta.get("confidence"),
            "strategy": orientation_meta.get("strategy"),
            "side": args.side,
        }
        print(json.dumps(result))
        sys.stderr.write(
            f'[master-crop] side={args.side} rotation={orientation_meta.get("rotation")} confidence={orientation_meta.get("confidence"):.2f} strategy={orientation_meta.get("strategy")}\n'
        )

    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
