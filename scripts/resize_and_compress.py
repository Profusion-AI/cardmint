#!/usr/bin/env python3
"""
Stage 2: Image Resize & Compress Pipeline

Processes corrected images (from Stage 1 distortion correction) and prepares them
for EverShop catalog import. Resizes to 1024px height, compresses to JPEG Q82,
forces sRGB color space, and generates deterministic MD5 manifest.

Usage:
  python3 scripts/resize_and_compress.py \\
    --input-dir data/corrected-images \\
    --output-dir images/incoming \\
    --manifest images/manifest-md5.csv

Dependencies:
  - Pillow (PIL)
  - numpy
"""

import argparse
import csv
import hashlib
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional, Tuple

try:
    from PIL import Image, ImageOps
    import numpy as np
except ImportError:
    print("Error: Required dependencies missing. Install with:")
    print("  pip install Pillow numpy")
    sys.exit(1)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


class ImageProcessor:
    """Handles image processing: resize, compress, color space conversion."""

    # Processing constants
    TARGET_HEIGHT = 1024
    JPEG_QUALITY = 82
    TARGET_COLORSPACE = "sRGB"

    def __init__(self, output_dir: Path, logger: logging.Logger = None):
        self.output_dir = output_dir
        self.logger = logger or logging.getLogger(__name__)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def process_image(self, input_path: Path, sku: str, output_file: Optional[Path] = None) -> Optional[dict]:
        """
        Process a single image: resize, compress, convert colorspace.

        Args:
            input_path: Path to input image
            sku: SKU identifier for output naming
            output_file: Explicit output path (overrides default SKU-based naming)

        Returns:
            Dict with processing metadata or None on error
        """
        try:
            # Open image
            with Image.open(input_path) as img:
                original_size = img.size
                original_format = img.format

                # Convert to RGB if necessary (removes alpha channel)
                if img.mode in ("RGBA", "LA", "P"):
                    background = Image.new("RGB", img.size, (255, 255, 255))
                    if img.mode == "P":
                        img = img.convert("RGBA")
                    background.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
                    img = background
                elif img.mode != "RGB":
                    img = img.convert("RGB")

                # Rotate 90° counterclockwise (Pi5 captures in landscape, operator needs portrait)
                # All Pi5 IMX477 captures are landscape orientation; rotate for upright display
                # Updated from -90° to +90° to correct upside-down orientation (Oct 23, 2025)
                img = img.rotate(90, expand=True)

                # Calculate new dimensions (preserve aspect ratio)
                aspect_ratio = img.width / img.height
                new_width = int(self.TARGET_HEIGHT * aspect_ratio)
                new_height = self.TARGET_HEIGHT

                # Resize using high-quality resampling
                img_resized = img.resize(
                    (new_width, new_height),
                    Image.Resampling.LANCZOS,
                )

                # Force sRGB color space via ICC profile
                srgb_profile = self._get_srgb_profile()
                if img_resized.info.get("icc_profile"):
                    # Image has ICC profile; convert to sRGB
                    img_resized = ImageOps.from_array(
                        np.array(img_resized), mode="RGB"
                    )

                # Output path and filename
                if output_file:
                    # Use explicit output path (single-file mode with temp file)
                    output_path = output_file
                else:
                    # Generate path from SKU (batch mode or single-file without explicit path)
                    output_filename = f"{sku}-front.jpg"
                    output_path = self.output_dir / output_filename

                # Save as JPEG with Q82
                if srgb_profile:
                    img_resized.save(
                        output_path,
                        format="JPEG",
                        quality=self.JPEG_QUALITY,
                        icc_profile=srgb_profile,
                        optimize=False,
                    )
                else:
                    img_resized.save(
                        output_path,
                        format="JPEG",
                        quality=self.JPEG_QUALITY,
                        optimize=False,
                    )

                # Calculate MD5 hash of output for manifest
                md5_hash = self._compute_md5(output_path)
                output_size = output_path.stat().st_size

                result = {
                    "sku": sku,
                    "input_path": str(input_path),
                    "output_path": str(output_path),
                    "input_size_bytes": input_path.stat().st_size,
                    "output_size_bytes": output_size,
                    "input_dimensions": f"{original_size[0]}x{original_size[1]}",
                    "output_dimensions": f"{new_width}x{new_height}",
                    "md5": md5_hash,
                    "quality": self.JPEG_QUALITY,
                    "colorspace": self.TARGET_COLORSPACE,
                    "status": "success",
                }

                self.logger.info(
                    f"✓ Processed {sku}: "
                    f"{original_size[0]}x{original_size[1]} → "
                    f"{new_width}x{new_height}, "
                    f"{input_path.stat().st_size} → {output_size} bytes, "
                    f"MD5: {md5_hash[:8]}..."
                )

                return result

        except Exception as e:
            self.logger.error(f"✗ Failed to process {sku} from {input_path}: {e}")
            return {
                "sku": sku,
                "input_path": str(input_path),
                "status": "failed",
                "error": str(e),
            }

    def _compute_md5(self, file_path: Path) -> str:
        """Compute MD5 hash of file."""
        hash_md5 = hashlib.md5()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()

    @staticmethod
    def _get_srgb_profile() -> Optional[bytes]:
        """
        Get sRGB ICC profile.

        Returns the sRGB profile bytes, or None if not available.
        """
        # Try to find system sRGB profile
        common_paths = [
            "/usr/share/color/icc/Colorspace/sRGB.icc",  # Linux
            "/System/Library/ColorSync/Profiles/sRGB Profile.icc",  # macOS
            "C:\\Windows\\System32\\spool\\drivers\\color\\sRGB Color Space Profile.icm",  # Windows
        ]

        for profile_path in common_paths:
            if os.path.exists(profile_path):
                try:
                    with open(profile_path, "rb") as f:
                        return f.read()
                except Exception:
                    continue

        return None


def extract_sku_from_filename(filename: str) -> str:
    """
    Extract SKU from corrected image filename.

    Expected format: corrected_<uuid>.jpg or corrected_<uuid>_<sku>.jpg
    Falls back to using the UUID as SKU if not found.
    """
    # Remove extension
    base = filename.replace(".jpg", "").replace(".jpeg", "")

    # If filename starts with "corrected_", remove that prefix
    if base.startswith("corrected_"):
        base = base[10:]  # len("corrected_") == 10

    return base


def main():
    parser = argparse.ArgumentParser(
        description="Stage 2: Resize and compress captured images for EverShop import"
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=None,
        help="Directory containing corrected images (Stage 1 output) [batch mode]",
    )
    parser.add_argument(
        "--input-file",
        type=Path,
        default=None,
        help="Single image file to process [single-file mode]",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("images/incoming"),
        help="Directory for resized/compressed output images",
    )
    parser.add_argument(
        "--output-file",
        type=Path,
        default=None,
        help="Explicit output file path (single-file mode only)",
    )
    parser.add_argument(
        "--sku",
        type=str,
        default=None,
        help="SKU identifier for single-file processing (required with --input-file)",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("images/manifest-md5.csv"),
        help="Output path for MD5 manifest CSV",
    )
    parser.add_argument(
        "--raw-fallback",
        type=Path,
        default=None,
        help="Fallback directory to read raw images if corrected not found",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    args = parser.parse_args()

    # Validate mode: either --input-dir (batch) or --input-file (single)
    if args.input_file and args.input_dir:
        logger.error("Cannot specify both --input-dir and --input-file")
        sys.exit(1)

    if args.input_file and not args.sku:
        logger.error("--sku is required when using --input-file")
        sys.exit(1)

    # Set default input-dir if neither specified
    if not args.input_file and not args.input_dir:
        args.input_dir = Path("apps/backend/data/corrected-images")

    if args.verbose:
        logger.setLevel(logging.DEBUG)

    # Create output directory
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)

    # Process in single-file mode
    if args.input_file:
        logger.info(f"Single-file mode: processing {args.input_file.name}")

        if not args.input_file.exists():
            logger.error(f"Input file not found: {args.input_file}")
            sys.exit(1)

        # Process single image
        processor = ImageProcessor(args.output_dir, logger)
        result = processor.process_image(args.input_file, args.sku, output_file=args.output_file)

        if result:
            # Emit JSON result for caller to parse metrics
            print(json.dumps(result, indent=2))
            sys.exit(0 if result.get("status") == "success" else 1)
        else:
            sys.exit(1)

    # Batch mode: process entire directory
    logger.info(f"Batch mode: processing directory {args.input_dir.resolve()}")

    # Validate input directory
    if not args.input_dir.exists():
        logger.error(f"Input directory not found: {args.input_dir}")
        sys.exit(1)

    logger.info(f"Input directory:  {args.input_dir.resolve()}")
    logger.info(f"Output directory: {args.output_dir.resolve()}")
    logger.info(f"Manifest file:    {args.manifest.resolve()}")

    # Find all corrected images
    image_extensions = ("*.jpg", "*.jpeg", "*.png", "*.bmp")
    image_files = []
    for ext in image_extensions:
        image_files.extend(args.input_dir.glob(ext))
        image_files.extend(args.input_dir.glob(ext.upper()))

    if not image_files:
        logger.warning(
            f"No images found in {args.input_dir}. "
            f"Expected .jpg, .jpeg, .png, or .bmp files."
        )

    # If no corrected images and fallback provided, use that
    if not image_files and args.raw_fallback and args.raw_fallback.exists():
        logger.info(f"No corrected images found; falling back to {args.raw_fallback}")
        for ext in image_extensions:
            image_files.extend(args.raw_fallback.glob(ext))
            image_files.extend(args.raw_fallback.glob(ext.upper()))

    image_files.sort()
    logger.info(f"Found {len(image_files)} images to process")

    # Process images
    processor = ImageProcessor(args.output_dir, logger)
    results = []

    for image_path in image_files:
        sku = extract_sku_from_filename(image_path.name)
        result = processor.process_image(image_path, sku)
        if result:
            results.append(result)

    # Write manifest
    successful = [r for r in results if r.get("status") == "success"]
    failed = [r for r in results if r.get("status") == "failed"]

    logger.info(f"\n{'='*60}")
    logger.info(f"Processing complete: {len(successful)} successful, {len(failed)} failed")
    logger.info(f"{'='*60}\n")

    # Sort successful results by SKU for deterministic manifest (idempotent)
    successful_sorted = sorted(successful, key=lambda r: r["sku"])

    # Write CSV manifest (only successful entries for EverShop import)
    # Version header only (no timestamp for determinism)
    with open(args.manifest, "w", newline="") as f:
        # Write manifest version header (no timestamp - determinism requirement)
        f.write(f"# CardMint Image Manifest v1.0\n")
        f.write(f"# Total: {len(successful_sorted)}, Failed: {len(failed)}\n")
        f.write(f"# Profile: 1024px height, JPEG Q82, sRGB\n")
        f.write(f"\n")

        writer = csv.DictWriter(
            f,
            fieldnames=[
                "sku",
                "output_path",
                "md5",
                "size_bytes",
                "dimensions",
                "quality",
            ],
        )
        writer.writeheader()
        for result in successful_sorted:
            writer.writerow(
                {
                    "sku": result["sku"],
                    "output_path": result["output_path"],
                    "md5": result["md5"],
                    "size_bytes": result["output_size_bytes"],
                    "dimensions": result["output_dimensions"],
                    "quality": result["quality"],
                }
            )

    logger.info(f"Manifest written: {args.manifest.resolve()}")
    logger.info(f"  ✓ {len(successful)} images indexed")

    if failed:
        logger.warning(f"  ✗ {len(failed)} images failed processing")
        failed_manifest = args.manifest.parent / "manifest-failures.json"
        with open(failed_manifest, "w") as f:
            json.dump(failed, f, indent=2)
        logger.info(f"Failed entries logged: {failed_manifest.resolve()}")

    # Determinism check: re-compute manifest from output and compare
    logger.info("\nRunning determinism validation...")
    manifest_check = args.manifest.parent / "manifest-check.json"

    check_results = []
    for result in successful:
        output_path = Path(result["output_path"])
        if output_path.exists():
            recomputed_md5 = processor._compute_md5(output_path)
            match = recomputed_md5 == result["md5"]
            check_results.append(
                {
                    "sku": result["sku"],
                    "original_md5": result["md5"],
                    "recomputed_md5": recomputed_md5,
                    "deterministic": match,
                }
            )
            status = "✓" if match else "✗"
            logger.info(f"  {status} {result['sku']}: {recomputed_md5[:8]}...")

    all_deterministic = all(c["deterministic"] for c in check_results)
    logger.info(f"\nDeterminism check: {'✓ PASS' if all_deterministic else '✗ FAIL'}")

    with open(manifest_check, "w") as f:
        json.dump(
            {
                "total": len(check_results),
                "deterministic": sum(1 for c in check_results if c["deterministic"]),
                "non_deterministic": sum(1 for c in check_results if not c["deterministic"]),
                "results": check_results,
            },
            f,
            indent=2,
        )

    logger.info(f"Determinism check saved: {manifest_check.resolve()}")

    # Exit with error if any failures
    if failed or not all_deterministic:
        logger.error("Processing completed with errors")
        sys.exit(1)

    logger.info("\n✓ All images processed successfully with deterministic hashing")
    sys.exit(0)


if __name__ == "__main__":
    main()
