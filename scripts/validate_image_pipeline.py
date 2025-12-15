#!/usr/bin/env python3
"""
Image Pipeline Performance Validation (Gate B Stage 2)

Validates the full image processing pipeline (distortion correction + resize/compress)
against performance and quality thresholds required for 1,000-card sweep.

Usage:
  python3 scripts/validate_image_pipeline.py \\
    --corrected-dir apps/backend/data/corrected-images \\
    --sample-size 10 \\
    --output image-pipeline-benchmark.json

Performance targets (Pi5):
- <500ms per image (budget: 12-15 sec for 1,000 cards)
- <80% CPU peak
- 1024px height preserved (aspect ratio maintained)
- No double-scaling artifacts (output quality consistent)
"""

import argparse
import json
import logging
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


class ImagePipelineBenchmark:
    """Runs end-to-end image pipeline benchmarks."""

    # Performance thresholds
    LATENCY_THRESHOLD_MS = 500  # 500ms per image on Pi5
    CPU_THRESHOLD_PCT = 80  # Peak CPU <80%
    TARGET_HEIGHT = 1024

    def __init__(self, corrected_dir: Path, output_dir: Path = Path("images/incoming")):
        self.corrected_dir = corrected_dir
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def get_image_dimensions(self, image_path: Path) -> Tuple[int, int]:
        """Get image dimensions using PIL."""
        try:
            from PIL import Image

            with Image.open(image_path) as img:
                return img.size  # Returns (width, height)
        except Exception as e:
            logger.error(f"Failed to get dimensions for {image_path}: {e}")
            return (0, 0)

    def run_pipeline_test(self, sample_size: int = 10) -> Dict:
        """
        Run the image processing pipeline on a sample of corrected images.

        Returns:
            Benchmark results dictionary
        """
        logger.info(f"Image Pipeline Validation: {sample_size}-card sample")
        logger.info(f"Corrected images: {self.corrected_dir}")
        logger.info(f"Output dir: {self.output_dir}")

        # Find corrected images
        image_files = list(self.corrected_dir.glob("corrected_*.jpg"))
        if not image_files:
            logger.error(f"No corrected images found in {self.corrected_dir}")
            return {
                "status": "failed",
                "error": "No corrected images found",
                "sample_size": 0,
            }

        # Use first N images
        sample_images = sorted(image_files)[:sample_size]
        logger.info(f"Found {len(image_files)} corrected images, testing {len(sample_images)}")

        # Prepare test data
        test_results: List[Dict] = []
        timings: List[float] = []
        aspects: List[float] = []

        # Run resize/compress script on sample
        logger.info("Running resize/compress pipeline...")
        temp_manifest = self.output_dir.parent / "temp-manifest.csv"

        try:
            start_time = time.time()
            result = subprocess.run(
                [
                    "python3",
                    "scripts/resize_and_compress.py",
                    "--input-dir",
                    str(self.corrected_dir),
                    "--output-dir",
                    str(self.output_dir),
                    "--manifest",
                    str(temp_manifest),
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            total_time = time.time() - start_time

            if result.returncode != 0:
                logger.error(f"Pipeline failed:\n{result.stderr}")
                return {
                    "status": "failed",
                    "error": "Pipeline execution failed",
                    "stderr": result.stderr,
                }

            # Parse output for individual image timings
            for image_path in sample_images:
                sku = image_path.stem.replace("corrected_", "")

                # Check if output exists
                output_path = self.output_dir / f"{sku}-front.jpg"
                if not output_path.exists():
                    logger.warning(f"Output not found for {sku}")
                    continue

                # Measure original and output dimensions
                orig_w, orig_h = self.get_image_dimensions(image_path)
                out_w, out_h = self.get_image_dimensions(output_path)

                # Check aspect ratio preservation
                if orig_h > 0 and out_h > 0:
                    orig_aspect = orig_w / orig_h
                    out_aspect = out_w / out_h
                    aspect_preserved = abs(orig_aspect - out_aspect) < 0.01  # ±1% tolerance

                    aspects.append(out_aspect)
                else:
                    aspect_preserved = False

                # Check height
                height_correct = out_h == self.TARGET_HEIGHT

                test_results.append(
                    {
                        "sku": sku,
                        "orig_dims": f"{orig_w}x{orig_h}",
                        "output_dims": f"{out_w}x{out_h}",
                        "height_correct": height_correct,
                        "aspect_preserved": aspect_preserved,
                    }
                )

            # Calculate statistics
            avg_latency_ms = (total_time / len(sample_images)) * 1000 if sample_images else 0
            timings.append(avg_latency_ms)

            # Validate thresholds
            latency_ok = avg_latency_ms < self.LATENCY_THRESHOLD_MS
            aspect_ok = all(r["aspect_preserved"] for r in test_results)
            height_ok = all(r["height_correct"] for r in test_results)

            logger.info(f"\n{'='*60}")
            logger.info(f"Pipeline Performance Results")
            logger.info(f"{'='*60}")
            logger.info(f"Sample size: {len(sample_images)} images")
            logger.info(f"Total time: {total_time:.2f}s")
            logger.info(f"Avg latency: {avg_latency_ms:.1f}ms per image")
            logger.info(f"  ✓ Target: <{self.LATENCY_THRESHOLD_MS}ms {'PASS' if latency_ok else 'FAIL'}")
            logger.info(f"Height (1024px): {'✓ PASS' if height_ok else '✗ FAIL'}")
            logger.info(f"Aspect ratio: {'✓ PASS' if aspect_ok else '✗ FAIL'}")

            if timings:
                logger.info(
                    f"\n1,000-card sweep estimate: {(avg_latency_ms * 1000 / 1000):.0f}s "
                    f"({(avg_latency_ms * 1000 / 60):.1f}min)"
                )

            # Return results
            return {
                "status": "success",
                "sample_size": len(sample_images),
                "total_time_sec": round(total_time, 2),
                "avg_latency_ms": round(avg_latency_ms, 1),
                "latency_threshold_ms": self.LATENCY_THRESHOLD_MS,
                "latency_ok": latency_ok,
                "height_correct": height_ok,
                "aspect_ratio_preserved": aspect_ok,
                "cpu_peak_pct": None,  # Would require system monitoring
                "estimated_1000_cards_sec": round((avg_latency_ms * 1000 / 1000), 1),
                "results": test_results,
                "pass": latency_ok and height_ok and aspect_ok,
            }

        except subprocess.TimeoutExpired:
            logger.error("Pipeline test timed out (>60s)")
            return {
                "status": "failed",
                "error": "Pipeline test timeout",
            }
        except Exception as e:
            logger.error(f"Benchmark failed: {e}")
            return {
                "status": "failed",
                "error": str(e),
            }

    def validate_determinism(self, test_image_count: int = 3) -> Dict:
        """
        Test determinism by processing same images twice and comparing hashes.
        Runs the full pipeline on each pass, not just hashing existing files.

        Returns:
            Determinism validation result
        """
        logger.info(f"\nValidating determinism with {test_image_count} images...")

        image_files = list(self.corrected_dir.glob("corrected_*.jpg"))
        if not image_files:
            return {"status": "no_images", "deterministic": None}

        sample_images = sorted(image_files)[:test_image_count]
        if not sample_images:
            return {"status": "no_sample", "deterministic": None}

        hashes_run1 = {}
        hashes_run2 = {}

        # First pass: run full pipeline on sample
        logger.info("First determinism pass: running pipeline...")
        temp_manifest_1 = self.output_dir.parent / "temp-manifest-run1.csv"
        try:
            result = subprocess.run(
                [
                    "python3",
                    "scripts/resize_and_compress.py",
                    "--input-dir",
                    str(self.corrected_dir),
                    "--output-dir",
                    str(self.output_dir),
                    "--manifest",
                    str(temp_manifest_1),
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode == 0:
                # Hash the output files from first run
                for image_path in sample_images:
                    sku = image_path.stem.replace("corrected_", "")
                    output_path = self.output_dir / f"{sku}-front.jpg"
                    if output_path.exists():
                        hash1 = self._compute_md5(output_path)
                        hashes_run1[sku] = hash1
                        logger.debug(f"  Run 1: {sku}: {hash1[:8]}...")
        except Exception as e:
            logger.error(f"First determinism pass failed: {e}")
            return {"status": "failed", "error": str(e), "deterministic": False}

        # Clean output between runs to ensure fresh processing
        for image_path in sample_images:
            sku = image_path.stem.replace("corrected_", "")
            output_path = self.output_dir / f"{sku}-front.jpg"
            if output_path.exists():
                try:
                    output_path.unlink()
                except:
                    pass

        # Second pass: run pipeline again on same images
        logger.info("Second determinism pass: running pipeline again...")
        temp_manifest_2 = self.output_dir.parent / "temp-manifest-run2.csv"
        try:
            result = subprocess.run(
                [
                    "python3",
                    "scripts/resize_and_compress.py",
                    "--input-dir",
                    str(self.corrected_dir),
                    "--output-dir",
                    str(self.output_dir),
                    "--manifest",
                    str(temp_manifest_2),
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode == 0:
                # Hash the output files from second run
                for image_path in sample_images:
                    sku = image_path.stem.replace("corrected_", "")
                    output_path = self.output_dir / f"{sku}-front.jpg"
                    if output_path.exists():
                        hash2 = self._compute_md5(output_path)
                        hashes_run2[sku] = hash2
                        logger.debug(f"  Run 2: {sku}: {hash2[:8]}...")
        except Exception as e:
            logger.error(f"Second determinism pass failed: {e}")
            return {"status": "failed", "error": str(e), "deterministic": False}

        # Compare hashes from both runs
        mismatches = 0
        for sku in hashes_run1:
            if sku in hashes_run2:
                if hashes_run1[sku] != hashes_run2[sku]:
                    mismatches += 1
                    logger.warning(
                        f"Mismatch on {sku}: Run1 ({hashes_run1[sku][:8]}...) vs Run2 ({hashes_run2[sku][:8]}...)"
                    )
            else:
                logger.warning(f"File missing in run 2: {sku}")
                mismatches += 1

        deterministic = mismatches == 0
        logger.info(f"Determinism: {'✓ PASS' if deterministic else '✗ FAIL'} ({mismatches} mismatches)")

        return {
            "status": "success",
            "tested": len(hashes_run1),
            "deterministic": deterministic,
            "mismatches": mismatches,
        }

    @staticmethod
    def _compute_md5(file_path: Path) -> str:
        """Compute MD5 hash of file."""
        import hashlib

        hash_md5 = hashlib.md5()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()


def main():
    parser = argparse.ArgumentParser(
        description="Validate Image Pipeline Performance (Gate B)"
    )
    parser.add_argument(
        "--corrected-dir",
        type=Path,
        default=Path("apps/backend/data/corrected-images"),
        help="Directory with corrected images (Stage 1 output)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("images/incoming"),
        help="Output directory for resized images",
    )
    parser.add_argument(
        "--sample-size",
        type=int,
        default=10,
        help="Number of images to test",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("image-pipeline-benchmark.json"),
        help="Output benchmark results to JSON file",
    )

    args = parser.parse_args()

    # Validate input directory
    if not args.corrected_dir.exists():
        logger.error(f"Corrected images directory not found: {args.corrected_dir}")
        sys.exit(1)

    # Run benchmark
    benchmark = ImagePipelineBenchmark(args.corrected_dir, args.output_dir)
    results = benchmark.run_pipeline_test(args.sample_size)

    # Check determinism
    determinism = benchmark.validate_determinism()
    results["determinism"] = determinism

    # Write results
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2)
    logger.info(f"\nBenchmark results: {args.output}")

    # Exit based on pass/fail
    if results.get("pass", False) and determinism.get("deterministic", False):
        logger.info("\n✓ Gate B VALIDATION PASS")
        sys.exit(0)
    else:
        logger.error("\n✗ Gate B VALIDATION FAIL")
        sys.exit(1)


if __name__ == "__main__":
    main()
