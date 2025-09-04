"""
#CodexGuidance: Whole-image OCR pipeline prototype using PaddleOCR 3.x (PP-OCRv5)

Exposes: run(image_path: str) -> dict (CardMintJSON)
Config: configs/ocr.yaml

Backends:
- native (PaddleOCR built-in)
- paddlex_openvino (ultra-infer via PaddleX)
- onnxruntime (via exported ONNX; prototype path)

Constraints:
- CPU, threads pinned (default 6)
- Max input width 1600 px, optional grayscale
"""
from __future__ import annotations

import json
import os
import time
import signal
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import yaml
from PIL import Image, ImageOps

try:
    from paddleocr import PaddleOCR
except Exception:  # pragma: no cover - allow envs without paddle installed
    PaddleOCR = None  # type: ignore


# Local parsers
from pathlib import Path
import sys

THIS_DIR = Path(__file__).resolve().parent
ROOT = THIS_DIR.parent
sys.path.insert(0, str(ROOT))

try:
    from parsers.ner import parse_card_fields
    from parsers.canonicalize import canonicalize_payload
except Exception:
    # Fallback no-op parsers
    def parse_card_fields(text_lines: List[str]) -> Dict[str, Any]:  # type: ignore
        return {"name": None, "set_name": None, "card_number": None, "rarity_text": None, "variant_text": None}

    def canonicalize_payload(obj: Dict[str, Any]) -> Dict[str, Any]:  # type: ignore
        return obj


@dataclass
class OCRConfig:
    flavor: str = "mobile"  # server|mobile
    enable_detection: bool = True
    enable_recognition: bool = True
    enable_orientation: bool = True
    enable_unwarp: bool = False
    max_width: int = 1600
    grayscale: bool = True
    backend_type: str = "native"  # native|paddlex_openvino|onnxruntime
    threads: int = 6
    thresholds: Tuple[float, float] = (0.94, 0.70)
    deskew_threshold: float = 0.80  # #Claude-CLI: Apply deskew only when confidence below this
    timeout_seconds: int = 2  # #CTO-Codex: Soft timeout (hard ceiling: 30s)
    drop_score: float = 0.4  # #CTO-Codex: PaddleOCR drop_score threshold
    # #CTO-Codex: PaddleOCR detection parameters (placeholders for Phase 2+)
    det_db_thresh: float = 0.3
    det_db_box_thresh: float = 0.6
    det_db_unclip_ratio: float = 1.5


def load_config(path: str = str(ROOT / "configs/ocr.yaml")) -> OCRConfig:
    with open(path, "r") as f:
        cfg = yaml.safe_load(f)

    models = cfg.get("models", {})
    pipeline = cfg.get("pipeline", {})
    backend = cfg.get("backend", {})
    thresholds = cfg.get("thresholds", {})

    oc = OCRConfig(
        flavor=models.get("flavor", "mobile"),
        enable_detection=pipeline.get("enable_detection", True),
        enable_recognition=pipeline.get("enable_recognition", True),
        enable_orientation=pipeline.get("enable_orientation", True),
        enable_unwarp=pipeline.get("enable_unwarp", False),
        max_width=int(pipeline.get("max_width", 1600)),
        grayscale=bool(pipeline.get("grayscale", True)),
        backend_type=backend.get("type", "native"),
        threads=int(backend.get("threads", 6)),
        thresholds=(float(thresholds.get("tau_accept", 0.94)), float(thresholds.get("tau_low", 0.70))),
        deskew_threshold=float(pipeline.get("deskew_threshold", 0.80)),  # #Claude-CLI
        timeout_seconds=int(pipeline.get("timeout_seconds", 2)),  # #CTO-Codex: Updated default
        drop_score=float(pipeline.get("drop_score", 0.4)),  # #CTO-Codex
        det_db_thresh=float(pipeline.get("det_db_thresh", 0.3)),  # #CTO-Codex
        det_db_box_thresh=float(pipeline.get("det_db_box_thresh", 0.6)),  # #CTO-Codex
        det_db_unclip_ratio=float(pipeline.get("det_db_unclip_ratio", 1.5)),  # #CTO-Codex
    )
    return oc


def set_runtime_threads(threads: int) -> None:
    os.environ.setdefault("OMP_NUM_THREADS", str(threads))
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")


def _apply_exif_orientation(image_path: str, img: np.ndarray) -> np.ndarray:
    """#Claude-CLI: Apply EXIF orientation correction to ensure proper image orientation"""
    try:
        with Image.open(image_path) as pil_img:
            # Use ImageOps.exif_transpose which handles all EXIF orientation cases
            oriented_img = ImageOps.exif_transpose(pil_img)
            
            # Convert back to OpenCV format if orientation was applied
            if oriented_img is not pil_img:  # Only convert if orientation was changed
                # Convert PIL to numpy array (RGB)
                img_array = np.array(oriented_img)
                # Convert RGB to BGR for OpenCV
                if img_array.ndim == 3 and img_array.shape[2] == 3:
                    img_array = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
                return img_array
    except Exception:
        # On any error, return original image
        pass
    return img


def _detect_skew_angle(img: np.ndarray) -> float:
    """#Claude-CLI: Detect skew angle using Hough line transform"""
    # Convert to grayscale if needed
    if img.ndim == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img
    
    # Apply edge detection
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    
    # Use HoughLines to detect lines
    lines = cv2.HoughLines(edges, 1, np.pi/180, threshold=100)
    
    if lines is None:
        return 0.0
    
    # Calculate angles and find dominant angle
    angles = []
    for rho, theta in lines[:min(20, len(lines)), 0]:  # Limit to first 20 lines
        angle = theta * 180 / np.pi
        # Convert to -90 to 90 range
        if angle > 90:
            angle -= 180
        angles.append(angle)
    
    if not angles:
        return 0.0
    
    # Find most common angle (within tolerance)
    angle_hist = {}
    for angle in angles:
        key = round(angle / 2) * 2  # Group angles by 2-degree buckets
        angle_hist[key] = angle_hist.get(key, 0) + 1
    
    # Return most frequent angle if it's significant enough
    if angle_hist:
        dominant_angle = max(angle_hist.keys(), key=lambda k: angle_hist[k])
        if abs(dominant_angle) > 1.0:  # Only return if > 1 degree
            return dominant_angle
    
    return 0.0


def _apply_deskew(img: np.ndarray, angle: float) -> np.ndarray:
    """#Claude-CLI: Apply rotation to correct skew"""
    if abs(angle) < 1.0:  # Skip for tiny angles
        return img
        
    h, w = img.shape[:2]
    center = (w // 2, h // 2)
    
    # Create rotation matrix
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    
    # Calculate new bounding dimensions
    cos_a = abs(M[0, 0])
    sin_a = abs(M[0, 1])
    new_w = int((h * sin_a) + (w * cos_a))
    new_h = int((h * cos_a) + (w * sin_a))
    
    # Adjust translation
    M[0, 2] += (new_w / 2) - center[0]
    M[1, 2] += (new_h / 2) - center[1]
    
    # Apply rotation
    rotated = cv2.warpAffine(img, M, (new_w, new_h), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    return rotated


def _preprocess(image: np.ndarray, max_width: int, grayscale: bool) -> np.ndarray:
    h, w = image.shape[:2]
    if w > max_width:
        scale = max_width / float(w)
        image = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    if grayscale and image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        image = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    return image


def _load_paddleocr(flavor: str, enable_angle: bool) -> Any:
    if PaddleOCR is None:
        raise RuntimeError("PaddleOCR not available in this environment")
    det_model_dir = None
    rec_model_dir = None
    use_gpu = False
    # Prefer English recognition; real deployments can plug custom dicts
    ocr = PaddleOCR(
        use_angle_cls=enable_angle,
        lang="en",
        det=True,
        rec=True,
        rec_algorithm="SVTR_LCNet" if flavor == "mobile" else "SVTR_LCNet",  # default ok
        use_gpu=use_gpu,
        det_model_dir=det_model_dir,
        rec_model_dir=rec_model_dir,
        show_log=False,
    )
    return ocr


# #Claude-CLI: Timeout exception for OCR operations  
class OCRTimeoutError(Exception):
    pass


def _timeout_handler(signum: int, frame: Any) -> None:
    """#Claude-CLI: Signal handler for OCR timeout"""
    raise OCRTimeoutError("OCR operation timed out")


def ocr_infer_native(ocr: Any, img: np.ndarray, timeout_seconds: int = 30) -> Tuple[List[str], List[float]]:
    """#Claude-CLI: OCR inference with timeout handling and deterministic sorting"""
    detections: List[Tuple[str, float, Tuple[float, float]]] = []  # (text, conf, centroid)
    
    # Set up timeout for OCR operation
    old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(timeout_seconds)
    
    try:
        # PaddleOCR v2/v3 all support .ocr(img) returning list of lines
        res = ocr.ocr(img)
        # result format: [ [ [[box], (text, conf)], ... ] ] or simplified
        if res is not None:
            for page in res:
                if page is not None:
                    for det in page:
                        if det is not None and len(det) >= 2 and isinstance(det[1], (tuple, list)):
                            box, (text, conf) = det[0], det[1]
                            if text:  # Only add non-empty text
                                # Calculate centroid for deterministic sorting
                                box_points = np.array(box) if isinstance(box, list) else box
                                centroid_y = float(np.mean(box_points[:, 1]))  # Average Y coordinate
                                centroid_x = float(np.mean(box_points[:, 0]))  # Average X coordinate
                                
                                detections.append((text, float(conf), (centroid_y, centroid_x)))
    finally:
        # Always restore the old handler and cancel the alarm
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)
    
    # #CTO-Codex: Sort deterministically by centroid (top-to-bottom, then left-to-right)
    detections.sort(key=lambda x: x[2])  # Sort by (y, x) tuple
    
    # Extract sorted lines and confidences
    lines = [det[0] for det in detections]
    confs = [round(det[1], 3) for det in detections]  # #CTO-Codex: Round to 3 decimals for stability
    
    return lines, confs


def _create_error_response(fail_reason: str, image_path: str, error_context: Optional[str] = None) -> Dict[str, Any]:
    """#Claude-CLI: Create standardized error response with enhanced fields"""
    return {
        "success": False,
        "fail_reason": fail_reason,  # #Claude-CLI: Canonical error codes
        "error_context": error_context,  # #Claude-CLI: Additional context for debugging
        "image_path": image_path,
        "lines": [],
        "confs": [],
        "parsed": {"name": None, "set_name": None, "card_number": None, "rarity_text": None, "variant_text": None},
        "overall_conf": 0.0,
        "ocr_conf": 0.0,  # #CTO-Codex: Router compatibility field
        "line_p50_conf": 0.0,  # #CTO-Codex: P50 confidence for error cases
        "line_p95_conf": 0.0,  # #CTO-Codex: P95 confidence for error cases
        "line_count": 0,
        "quality_flags": [],
        "deskew_applied": False,  # #CTO-Codex: Deskew status for error cases
        "timings_ms": {
            "preproc": 0,  # #CTO-Codex: Stage timings for error cases
            "det": 0,
            "rec": 0,
            "parse": 0,
            "ocr": 0,  # Legacy field
            "total": 0,
            "deskew": 0
        },
    }


def run(image_path: str, config_path: Optional[str] = None) -> Dict[str, Any]:
    """#Claude-CLI: Main OCR pipeline with enhanced error handling and confidence metrics"""
    try:
        cfg = load_config(config_path or str(ROOT / "configs/ocr.yaml"))
    except Exception as e:
        return _create_error_response("config_error", image_path, f"Failed to load config: {e}")
    
    set_runtime_threads(cfg.threads)

    t0 = time.perf_counter()
    
    # #Claude-CLI: Enhanced input handling with EXIF and conditional deskew
    try:
        img = cv2.imread(image_path, cv2.IMREAD_COLOR)
        if img is None:
            return _create_error_response("file_read_error", image_path, "cv2.imread returned None")
    except Exception as e:
        return _create_error_response("file_read_error", image_path, f"Exception reading file: {e}")
    
    # Apply EXIF orientation correction
    img = _apply_exif_orientation(image_path, img)
    
    # #CTO-Codex: Stage timing - preprocessing
    t_preproc_start = time.perf_counter()
    # Preprocess (resize, grayscale)
    img = _preprocess(img, cfg.max_width, cfg.grayscale)
    t_preproc_end = time.perf_counter()
    
    # #CTO-Codex: Stage timing - detection and recognition 
    t_det_start = time.perf_counter()

    # Backend dispatch (prototype: native-only implemented; hooks for others)
    try:
        if cfg.backend_type == "native":
            ocr = _load_paddleocr(cfg.flavor, cfg.enable_orientation)
            # #CTO-Codex: Enforce hard timeout ceiling of 30s
            timeout_seconds = min(cfg.timeout_seconds, 30)
            lines, confs = ocr_infer_native(ocr, img, timeout_seconds)
        elif cfg.backend_type in ("paddlex_openvino", "onnxruntime"):
            # Placeholder: wire ultra-infer and ORT in subsequent patch
            ocr = _load_paddleocr(cfg.flavor, cfg.enable_orientation)
            # #CTO-Codex: Enforce hard timeout ceiling of 30s
            timeout_seconds = min(cfg.timeout_seconds, 30)
            lines, confs = ocr_infer_native(ocr, img, timeout_seconds)
        else:
            return _create_error_response("unsupported_backend", image_path, f"Backend '{cfg.backend_type}' not supported")
    except OCRTimeoutError:
        return _create_error_response("timeout", image_path, f"OCR timed out after {cfg.timeout_seconds} seconds")
    except Exception as e:
        return _create_error_response("ocr_error", image_path, f"OCR processing failed: {e}")

    t_det_end = time.perf_counter()  # #CTO-Codex: Combined det+rec timing
    
    # #Claude-CLI: Check if we should apply deskew based on confidence
    overall_conf = float(np.mean(confs)) if confs else 0.0
    deskew_applied = False
    
    if overall_conf < cfg.deskew_threshold and lines:  # Only deskew if we got some text but low confidence
        skew_angle = _detect_skew_angle(img)
        if abs(skew_angle) > 1.0:
            # Re-run OCR on deskewed image
            t_deskew_start = time.perf_counter()
            deskewed_img = _apply_deskew(img, skew_angle)
            
            # Re-run OCR
            try:
                deskewed_lines, deskewed_confs = ocr_infer_native(ocr, deskewed_img, cfg.timeout_seconds)
                deskewed_conf = float(np.mean(deskewed_confs)) if deskewed_confs else 0.0
            except OCRTimeoutError:
                # If deskew OCR times out, just use original results
                deskewed_lines, deskewed_confs = lines, confs
                deskewed_conf = overall_conf
            
            # Use deskewed results if they're better
            if deskewed_conf > overall_conf + 0.05:  # Require meaningful improvement
                lines, confs = deskewed_lines, deskewed_confs
                overall_conf = deskewed_conf
                deskew_applied = True
            
            t_deskew_end = time.perf_counter()
            deskew_time = int((t_deskew_end - t_deskew_start) * 1000)
        else:
            deskew_time = 0
    else:
        deskew_time = 0

    t1 = time.perf_counter()
    
    # #Claude-CLI: Handle no text detected case
    if not lines:
        return _create_error_response("no_text", image_path, "No text detected in image")

    # #CTO-Codex: Stage timing - parsing
    t_parse_start = time.perf_counter()
    parsed = parse_card_fields(lines)
    t_parse_end = time.perf_counter()
    
    # #Claude-CLI: Calculate confidence statistics (p50/p95) with rounding
    overall_conf = round(float(np.mean(confs)), 3) if confs else 0.0  # #CTO-Codex: Round for stability
    line_p50_conf = round(float(np.percentile(confs, 50)), 3) if confs else 0.0
    line_p95_conf = round(float(np.percentile(confs, 95)), 3) if confs else 0.0
    
    # Quality flags based on confidence thresholds
    quality_flags = []
    if overall_conf < cfg.thresholds[1]:  # Below low threshold
        quality_flags.append("low_confidence")
    if overall_conf >= cfg.thresholds[0]:  # Above accept threshold
        quality_flags.append("high_confidence")
    if line_p95_conf - line_p50_conf > 0.3:  # High confidence variance
        quality_flags.append("uneven_confidence")
    
    # #CTO-Codex: Calculate stage timings
    preproc_time = int((t_preproc_end - t_preproc_start) * 1000)
    det_time = int((t_det_end - t_det_start) * 1000)  # Combined det+rec for now
    parse_time = int((t_parse_end - t_parse_start) * 1000)
    
    # #Claude-CLI: Enhanced payload with comprehensive confidence metrics
    payload = {
        "success": True,
        "image_path": image_path,
        "lines": lines,
        "confs": confs,
        "parsed": parsed,
        "overall_conf": overall_conf,  # #Claude-CLI: Mean confidence across all lines
        "ocr_conf": overall_conf,  # #CTO-Codex: Router compatibility field
        "line_p50_conf": line_p50_conf,  # #Claude-CLI: 50th percentile confidence 
        "line_p95_conf": line_p95_conf,  # #Claude-CLI: 95th percentile confidence
        "line_count": len(lines),  # #Claude-CLI: Number of detected lines
        "quality_flags": quality_flags,  # #Claude-CLI: Quality assessment flags
        "deskew_applied": deskew_applied,  # #Claude-CLI: Whether deskew was applied
        "timings_ms": {
            "preproc": preproc_time,  # #CTO-Codex: Preprocessing stage timing
            "det": det_time,  # #CTO-Codex: Detection stage timing (combined det+rec)
            "rec": det_time,  # #CTO-Codex: Recognition stage timing (same as det for now)
            "parse": parse_time,  # #CTO-Codex: Parsing stage timing
            "ocr": det_time,  # Legacy field for compatibility
            "total": int((t1 - t0) * 1000),
            "deskew": deskew_time,
        },
    }

    payload = canonicalize_payload(payload)
    return payload


def _cli() -> None:
    import argparse

    p = argparse.ArgumentParser(description="CardMint OCR pipeline (PP-OCRv5)")
    p.add_argument("image", help="Path to input image")
    p.add_argument("--config", dest="config", default=None, help="Path to ocr.yaml")
    args = p.parse_args()

    result = run(args.image, args.config)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    _cli()

