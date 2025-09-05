#!/usr/bin/env python3
"""
Quick OCR smoke test for CardMint OCR pipeline.

Validates:
- Backend execution (native/paddlex_openvino/onnxruntime)
- Payload shape and stage timings
- Confidence stats and deterministic outputs across two runs
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# Apply guards before importing pipeline
from ocr.system_guard import apply_cpu_threading_defaults, neuter_paddlex_calls, env_truth
apply_cpu_threading_defaults()
if env_truth("OCR_FORCE_NATIVE", False):
    neuter_paddlex_calls()

from ocr.pipeline import run  # type: ignore
from ocr.system_guard import collect_host_facts  # type: ignore


def resolve_image_path(path: str) -> str:
    """Resolve common dataset path variations to help avoid path typos.
    - If path exists, return as-is.
    - Otherwise try CardMint/data_unzipped/data swap.
    - Finally, search a few known roots for the basename.
    """
    import os
    import glob

    if os.path.isfile(path):
        return path

    # Try swapping data → data_unzipped/data
    alt = path.replace("/CardMint/data/", "/CardMint/data_unzipped/data/")
    if alt != path and os.path.isfile(alt):
        return alt

    # Try swapping data_unzipped/data → data (opposite direction)
    alt2 = path.replace("/CardMint/data_unzipped/data/", "/CardMint/data/")
    if alt2 != path and os.path.isfile(alt2):
        return alt2

    # Search by basename in likely roots
    basename = os.path.basename(path)
    roots = [
        os.path.join(ROOT, "data"),
        os.path.join(ROOT, "data_unzipped", "data"),
        os.path.join(ROOT, "data_unzipped"),
    ]
    for r in roots:
        patt = os.path.join(r, "**", basename)
        matches = glob.glob(patt, recursive=True)
        if matches:
            return matches[0]

    return path  # Fall back; pipeline will report file_not_found


def _suggest_examples() -> List[str]:
    import glob, os
    roots = [
        os.path.join(ROOT, "data", "pokemon_dataset", "sample_images"),
        os.path.join(ROOT, "data_unzipped", "data", "pokemon_dataset", "sample_images"),
    ]
    found: List[str] = []
    for r in roots:
        patt = os.path.join(r, "*.png")
        found.extend(glob.glob(patt))
        if len(found) >= 5:
            break
    return found[:5]


def _create_sample_image() -> str:
    """Create a built-in test image with readable text for OCR validation."""
    import tempfile
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    
    # Create a simple test image with text
    img = Image.new('RGB', (400, 200), color='white')
    draw = ImageDraw.Draw(img)
    
    # Use default font
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None
    
    # Add some test text
    text_lines = [
        "CardMint OCR Test",
        "Pokemon Card #123",
        "HP: 120",
        "Type: Electric"
    ]
    
    y_pos = 20
    for line in text_lines:
        draw.text((20, y_pos), line, fill='black', font=font)
        y_pos += 30
    
    # Save to temporary file
    temp_file = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
    img.save(temp_file.name)
    temp_file.close()
    
    return temp_file.name


def main() -> None:
    p = argparse.ArgumentParser(description="CardMint OCR smoke test")
    p.add_argument("image", nargs='?', help="Path to input image")
    p.add_argument("--backend", default=None, choices=[None, "native", "paddlex_openvino", "onnxruntime"], help="Override backend type")
    p.add_argument("--config", default=None, help="Config path (defaults to configs/ocr.yaml)")
    p.add_argument("--use-sample", action="store_true", help="Use built-in test image when path is missing")
    p.add_argument("--force-native", action="store_true", help="Force pure PaddleOCR backend (disable PaddleX)")
    args = p.parse_args()

    # Optionally override backend via env if provided
    if args.backend:
        os.environ["OCR_BACKEND_OVERRIDE"] = args.backend
    if args.force_native:
        os.environ["OCR_FORCE_NATIVE"] = "1"

    # Allow a simple one-off backend override by dynamically patching config file
    cfg_path = args.config
    if args.backend and not cfg_path:
        # Use default config but override backend at runtime by a small shim in memory
        pass

    # Handle --use-sample or missing image path
    image_path = args.image
    if args.use_sample or not image_path or not os.path.isfile(resolve_image_path(image_path)):
        image_path = _create_sample_image()
        print(f"Using built-in sample image: {image_path}", file=sys.stderr)
    else:
        image_path = resolve_image_path(args.image)
    res1: Dict[str, Any] = run(image_path, cfg_path)
    res2: Dict[str, Any] = run(image_path, cfg_path)

    def short(v: Any) -> Any:
        try:
            return round(float(v), 3)
        except Exception:
            return v

    summary = {
        "success": res1.get("success"),
        "fail_reason": res1.get("fail_reason"),
        "resolved_image_path": image_path,
        "python_executable": sys.executable,
        "line_count": res1.get("line_count"),
        "overall_conf": short(res1.get("overall_conf")),
        "line_p50_conf": short(res1.get("line_p50_conf")),
        "line_p95_conf": short(res1.get("line_p95_conf")),
        "timings_ms": res1.get("timings_ms"),
        "deterministic": res1.get("lines") == res2.get("lines") and res1.get("confs") == res2.get("confs"),
        "sample_lines": res1.get("lines", [])[:5],
        "backend_used": res1.get("diagnostics", {}).get("backend_used") or res1.get("backend_used"),
        "schema_type": res1.get("diagnostics", {}).get("schema_type"),
        "schema_detected": res1.get("diagnostics", {}).get("schema_detected"),
        "versions": res1.get("versions"),
        "host": collect_host_facts(),
        "suggested_examples": _suggest_examples(),
    }

    print(json.dumps({"summary": summary, "payload": res1}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
