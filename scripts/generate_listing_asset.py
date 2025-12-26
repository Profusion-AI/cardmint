#!/usr/bin/env python3
"""
Listing Asset Generator - Stage 3 of CardMint image pipeline

Generates production-ready listing images suitable for e-commerce platforms.

Pipeline:
  Input: Processed image (Stage 2 output - already rotated, 1024px height)
  1. Detect card boundaries using card_detection module
  2. Crop to card with 1.5% padding
  3. Resize to max 2000px long edge (preserve aspect ratio)
  4. Apply auto white balance + mild contrast enhancement
  5. Save as JPEG Q85 sRGB

Requirements:
  - OpenCV (cv2)
  - NumPy
  - card_detection module

Usage:
  python generate_listing_asset.py INPUT OUTPUT [--padding 1.5] [--max-size 2000] [--quality 85] \
    [--clahe-clip 1.5] [--clahe-tiles 8] [--no-awb] [--debug]
"""

import cv2
import numpy as np
import sys
import os
from pathlib import Path
from typing import Optional

# Import card detection module
import card_detection


class ListingAssetGenerator:
    """Generates e-commerce listing assets from processed images."""

    def __init__(
        self,
        max_size: int = 2000,
        padding_pct: float = 1.5,
        jpeg_quality: int = 85,
        clahe_clip: float = 1.5,
        clahe_tiles: int = 8,
        awb_enable: bool = True,
        debug: bool = False
    ):
        """
        Initialize listing asset generator.

        Args:
            max_size: Maximum dimension (width or height) in pixels
            padding_pct: Padding percentage around detected card
            jpeg_quality: JPEG compression quality (0-100)
            clahe_clip: CLAHE clipLimit for contrast enhancement (default: 1.5)
            clahe_tiles: CLAHE tile grid size NxN (default: 8)
            awb_enable: Enable auto white balance (gray world assumption)
            debug: Enable verbose logging
        """
        self.max_size = max_size
        self.padding_pct = padding_pct
        self.jpeg_quality = jpeg_quality
        self.clahe_clip = clahe_clip
        self.clahe_tiles = clahe_tiles
        self.awb_enable = awb_enable
        self.debug = debug
        self.detector = card_detection.CardDetector(debug=debug)

    def generate(self, input_path: str, output_path: str) -> bool:
        """
        Generate listing asset from processed image.

        Args:
            input_path: Path to processed (Stage 2) image
            output_path: Path to save listing asset

        Returns:
            True if successful, False otherwise
        """
        # Step 1: Detect card boundaries
        if self.debug:
            print(f"[Stage 3] Detecting card in {input_path}")

        quad = self.detector.detect_card_quad(input_path)
        if quad is None:
            print(f"Error: Card detection failed for {input_path}", file=sys.stderr)
            return False

        if quad.confidence < card_detection.CardDetector.MIN_CONFIDENCE:
            print(
                f"Error: Low confidence detection ({quad.confidence:.2f}) for {input_path}",
                file=sys.stderr
            )
            return False

        if self.debug:
            print(f"  Card detected: ({quad.x},{quad.y}) {quad.width}x{quad.height}")
            print(f"  Confidence: {quad.confidence:.3f}")
            print(f"  Aspect ratio: {quad.aspect_ratio:.3f}")

        # Step 2: Load and crop image
        img = cv2.imread(input_path)
        if img is None:
            print(f"Error: Could not load image {input_path}", file=sys.stderr)
            return False

        img_height, img_width = img.shape[:2]

        # Calculate padding in pixels
        pad_x = int(quad.width * (self.padding_pct / 100))
        pad_y = int(quad.height * (self.padding_pct / 100))

        # Apply padding with bounds checking
        x1 = max(0, quad.x - pad_x)
        y1 = max(0, quad.y - pad_y)
        x2 = min(img_width, quad.x + quad.width + pad_x)
        y2 = min(img_height, quad.y + quad.height + pad_y)

        # Crop to card with padding
        cropped = img[y1:y2, x1:x2]

        if self.debug:
            print(f"  Cropped: {cropped.shape[1]}x{cropped.shape[0]} (from {img_width}x{img_height})")

        # Step 3: Resize to target dimensions
        resized = self._resize_to_max(cropped)

        if self.debug:
            print(f"  Resized: {resized.shape[1]}x{resized.shape[0]}")

        # Step 4: Color correction (auto white balance + contrast)
        corrected = self._apply_color_correction(resized)

        if self.debug:
            print(f"  Color corrected")

        # Step 5: Save as JPEG Q85 sRGB
        # Ensure output directory exists
        output_dir = Path(output_path).parent
        output_dir.mkdir(parents=True, exist_ok=True)

        # Convert to sRGB color space (OpenCV uses BGR, JPEG expects RGB)
        # Actually OpenCV imwrite handles BGR→RGB conversion internally for JPEG
        success = cv2.imwrite(
            output_path,
            corrected,
            [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality]
        )

        if success and self.debug:
            file_size = Path(output_path).stat().st_size
            print(f"  Saved: {output_path} ({file_size/1024:.1f} KB)")

        return success

    def _resize_to_max(self, img: np.ndarray) -> np.ndarray:
        """
        Resize image so longest edge is <= max_size, preserving aspect ratio.

        Args:
            img: Input image

        Returns:
            Resized image
        """
        height, width = img.shape[:2]
        max_dim = max(width, height)

        if max_dim <= self.max_size:
            return img  # Already small enough

        # Calculate scale factor
        scale = self.max_size / max_dim
        new_width = int(width * scale)
        new_height = int(height * scale)

        # Use LANCZOS interpolation for high-quality downscaling
        resized = cv2.resize(
            img,
            (new_width, new_height),
            interpolation=cv2.INTER_LANCZOS4
        )

        return resized

    def _apply_color_correction(self, img: np.ndarray) -> np.ndarray:
        """
        Apply CLAHE contrast enhancement and optional auto white balance.

        Args:
            img: Input image (BGR)

        Returns:
            Color-corrected image (BGR)
        """
        # Convert to LAB color space for better processing
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l_channel, a_channel, b_channel = cv2.split(lab)

        # Apply CLAHE (Contrast Limited Adaptive Histogram Equalization) to L channel
        # This provides mild contrast enhancement without over-amplifying noise
        # Uses operator-tunable clipLimit and tileGridSize
        clahe = cv2.createCLAHE(
            clipLimit=self.clahe_clip,
            tileGridSize=(self.clahe_tiles, self.clahe_tiles)
        )
        l_enhanced = clahe.apply(l_channel)

        if self.debug:
            print(f"  CLAHE: clipLimit={self.clahe_clip}, tiles={self.clahe_tiles}x{self.clahe_tiles}")

        # Merge channels back
        lab_enhanced = cv2.merge([l_enhanced, a_channel, b_channel])

        # Convert back to BGR
        enhanced = cv2.cvtColor(lab_enhanced, cv2.COLOR_LAB2BGR)

        # Auto white balance using gray world assumption (if enabled)
        if not self.awb_enable:
            if self.debug:
                print(f"  Auto white balance: disabled")
            return enhanced

        # Calculate mean of each channel
        b_mean = np.mean(enhanced[:, :, 0])
        g_mean = np.mean(enhanced[:, :, 1])
        r_mean = np.mean(enhanced[:, :, 2])

        # Calculate gray (should be equal for all channels in neutral image)
        gray = (b_mean + g_mean + r_mean) / 3

        # Adjust each channel to match gray
        b_factor = gray / b_mean if b_mean > 0 else 1.0
        g_factor = gray / g_mean if g_mean > 0 else 1.0
        r_factor = gray / r_mean if r_mean > 0 else 1.0

        if self.debug:
            print(f"  Auto white balance: R={r_factor:.3f}, G={g_factor:.3f}, B={b_factor:.3f}")

        # Apply white balance (clamped to avoid overflow)
        balanced = enhanced.copy().astype(np.float32)
        balanced[:, :, 0] = np.clip(balanced[:, :, 0] * b_factor, 0, 255)
        balanced[:, :, 1] = np.clip(balanced[:, :, 1] * g_factor, 0, 255)
        balanced[:, :, 2] = np.clip(balanced[:, :, 2] * r_factor, 0, 255)

        return balanced.astype(np.uint8)


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Generate e-commerce listing asset from processed image (Stage 3)"
    )
    parser.add_argument("input", help="Input image path (Stage 2 output)")
    parser.add_argument("output", help="Output image path (listing asset)")
    parser.add_argument(
        "--padding",
        type=float,
        default=1.5,
        help="Padding percentage around card (default: 1.5)"
    )
    parser.add_argument(
        "--max-size",
        type=int,
        default=2000,
        help="Maximum dimension in pixels (default: 2000)"
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=85,
        help="JPEG quality 0-100 (default: 85)"
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug output")
    parser.add_argument(
        "--clahe-clip",
        type=float,
        default=1.5,
        help="CLAHE clip limit for contrast enhancement (default: 1.5)"
    )
    parser.add_argument(
        "--clahe-tiles",
        type=int,
        default=8,
        help="CLAHE tile grid size NxN (default: 8)"
    )
    parser.add_argument(
        "--no-awb",
        action="store_true",
        help="Disable auto white balance (gray world assumption)"
    )

    args = parser.parse_args()

    # Validate inputs
    if not Path(args.input).exists():
        print(f"Error: Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    if args.quality < 1 or args.quality > 100:
        print(f"Error: Quality must be 1-100, got {args.quality}", file=sys.stderr)
        sys.exit(1)

    # Generate listing asset
    generator = ListingAssetGenerator(
        max_size=args.max_size,
        padding_pct=args.padding,
        jpeg_quality=args.quality,
        clahe_clip=args.clahe_clip,
        clahe_tiles=args.clahe_tiles,
        awb_enable=not args.no_awb,
        debug=args.debug
    )

    success = generator.generate(args.input, args.output)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
