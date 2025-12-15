#!/usr/bin/env python3
"""
Apply barrel distortion correction to Pi5 camera captures.

Wraps fedora_image_processor.py with local profile support for integration
with Node.js backend. Loads calibration profile from local filesystem,
applies distortion correction, and outputs corrected image.

Usage:
  python apply_distortion_correction.py --image <path> --output <dir> [--profile <name>]

Arguments:
  --image       Path to input JPEG image
  --output      Output directory for corrected image
  --profile     Profile name (default: imx477_tuned_6mm_20251010_133159)

Output:
  - Writes corrected image to: <output>/corrected_<filename>
  - Returns JSON status to stdout
"""

import json
import sys
import os
import argparse
from pathlib import Path
from typing import Optional, Dict, Any
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def apply_distortion_correction(
    image_path: str,
    output_dir: str,
    profile_name: str = "imx477_tuned_6mm_20251010_133159"
) -> Dict[str, Any]:
    """
    Apply distortion correction to an image using local calibration profile.

    Args:
        image_path: Path to input image
        output_dir: Directory for output corrected image
        profile_name: Name of calibration profile to use

    Returns:
        Dict with status, output_path, and metadata
    """
    try:
        import cv2
        import numpy as np
    except ImportError as e:
        return {
            "status": "error",
            "error": "MISSING_DEPENDENCY",
            "message": f"Missing required package: {e}",
            "details": "Install with: pip install opencv-python numpy"
        }

    try:
        # Validate inputs
        img_path = Path(image_path)
        if not img_path.exists():
            return {
                "status": "error",
                "error": "FILE_NOT_FOUND",
                "message": f"Image not found: {image_path}"
            }

        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        # Load calibration profile from workspace
        workspace_root = Path(__file__).parent.parent
        profile_path = workspace_root / "data" / "calibration-profiles" / f"{profile_name}.json"

        if not profile_path.exists():
            return {
                "status": "error",
                "error": "PROFILE_NOT_FOUND",
                "message": f"Calibration profile not found: {profile_path}",
                "available_profiles": list((workspace_root / "data" / "calibration-profiles").glob("*.json"))
            }

        # Load profile
        with open(profile_path) as f:
            profile = json.load(f)

        logger.info(f"Loaded calibration profile: {profile_name}")
        logger.info(f"Processing image: {img_path}")

        # Load image
        image = cv2.imread(str(img_path))
        if image is None:
            return {
                "status": "error",
                "error": "IMAGE_READ_FAILED",
                "message": f"Could not read image: {image_path}"
            }

        h, w = image.shape[:2]
        logger.info(f"Image dimensions: {w}x{h}")

        # Extract calibration matrices from profile
        K_raw = np.array(profile["opencv_model"]["K"], dtype=np.float64)
        D_raw = np.array(profile["opencv_model"]["D"], dtype=np.float64)
        calib_res = profile["opencv_model"]["calibration_resolution"]

        # Scale camera matrix to runtime resolution
        scale_x = w / calib_res[0]
        scale_y = h / calib_res[1]

        K = K_raw.copy()
        K[0, 0] *= scale_x  # fx
        K[1, 1] *= scale_y  # fy
        K[0, 2] *= scale_x  # cx
        K[1, 2] *= scale_y  # cy

        logger.info(f"Scaled K matrix for {w}x{h}")

        # Build undistortion maps with caching
        map_x, map_y = cv2.initUndistortRectifyMap(
            K, D_raw, None, K, (w, h), cv2.CV_32F
        )

        logger.info("Built undistortion maps")

        # Apply correction
        corrected = cv2.remap(image, map_x, map_y, cv2.INTER_LINEAR)

        # Save corrected image
        output_filename = f"corrected_{img_path.name}"
        output_path = out_dir / output_filename

        success = cv2.imwrite(str(output_path), corrected)
        if not success:
            return {
                "status": "error",
                "error": "WRITE_FAILED",
                "message": f"Could not write output image: {output_path}"
            }

        # Set file permissions to 664 (rw-rw-r--)  for backend access
        os.chmod(output_path, 0o664)

        logger.info(f"Saved corrected image: {output_path}")

        return {
            "status": "success",
            "input_image": str(img_path),
            "output_image": str(output_path),
            "profile": profile_name,
            "profile_hash": profile.get("profile_hash"),
            "input_resolution": f"{w}x{h}",
            "calibration_resolution": f"{calib_res[0]}x{calib_res[1]}",
            "rms_error_px": profile["rms_error_px"],
            "processing_time_ms": None  # Would require timing instrumentation
        }

    except Exception as e:
        logger.exception("Unexpected error during distortion correction")
        return {
            "status": "error",
            "error": "PROCESSING_FAILED",
            "message": str(e)
        }


def main():
    parser = argparse.ArgumentParser(
        description="Apply barrel distortion correction to Pi5 camera captures"
    )
    parser.add_argument("--image", required=True, help="Path to input JPEG image")
    parser.add_argument("--output", required=True, help="Output directory for corrected image")
    parser.add_argument(
        "--profile",
        default="imx477_tuned_6mm_20251010_133159",
        help="Calibration profile name (default: imx477_tuned_6mm_20251010_133159)"
    )

    args = parser.parse_args()

    result = apply_distortion_correction(
        args.image,
        args.output,
        args.profile
    )

    # Output JSON result
    print(json.dumps(result))
    sys.exit(0 if result["status"] == "success" else 1)


if __name__ == "__main__":
    main()
