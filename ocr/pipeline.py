"""
#CodexGuidance: Whole-image OCR pipeline prototype using PaddleOCR 3.x (PP-OCRv5)

Exposes: run(image_path: str) -> dict (CardMintJSON)
Config: configs/ocr.yaml

Backends:
- native (PaddleOCR built-in)
- paddlex_openvino (ultra-infer via PaddleX)
- onnxruntime (via exported ONNX; prototype path)

Constraints:
- CPU, threads pinned (default 4, aligned with system_guard.py)
- Max input width 1600 px, optional grayscale
"""
from __future__ import annotations

import json
import os
import time
import signal
import threading
from dataclasses import dataclass
from importlib import metadata as importlib_metadata
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import yaml
from PIL import Image, ImageOps

# PaddleOCR import moved to _load_paddleocr() to run after guards
PaddleOCR = None  # Lazy import placeholder

# Import backends
try:
    from .backends import infer_paddlex_openvino, infer_onnxruntime
except ImportError:
    # Fallback for missing backends
    def infer_paddlex_openvino(*args, **kwargs):  # type: ignore
        raise ImportError("PaddleX backend not available")
    def infer_onnxruntime(*args, **kwargs):  # type: ignore
        raise ImportError("ONNX Runtime backend not available")


# Local parsers
from pathlib import Path
import sys

THIS_DIR = Path(__file__).resolve().parent
ROOT = THIS_DIR.parent
sys.path.insert(0, str(ROOT))

from .system_guard import (
    ensure_native_backend_or_die,
    apply_cpu_threading_defaults,
    collect_host_facts,
    neuter_paddlex_calls,
    env_truth,
)
from .version_gate import is_paddleocr_v3, get_paddleocr_version, get_paddlex_version

# Module-level OCR instance cache with concurrency safety
_OCR_CACHE: Dict[str, Any] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_STATS = {"hits": 0, "misses": 0}

# Early guard: neuter PaddleX before any imports if native-only requested
if env_truth("OCR_FORCE_NATIVE", False):
    neuter_paddlex_calls()
try:
    # Robust extractor used for PaddleX also tolerates PaddleOCR tuple format
    from .backends import _extract_text_conf_box, _normalize_result_container  # type: ignore
except Exception:  # pragma: no cover
    _extract_text_conf_box = None  # type: ignore
    _normalize_result_container = lambda x: x if isinstance(x, list) else [x] if x is not None else []  # type: ignore

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
    threads: int = 4  # Align with system_guard.py defaults
    openvino_precision: str = "int8"  # int8|fp16|fp32 for OpenVINO backend
    openvino_version: str = "v5"  # Target PP-OCR version for PaddleX (v5 preferred)
    openvino_det_model: Optional[str] = None  # Optional override for det model dir
    openvino_rec_model: Optional[str] = None  # Optional override for rec model dir
    thresholds: Tuple[float, float] = (0.94, 0.70)
    deskew_threshold: float = 0.80  # #Claude-CLI: Apply deskew only when confidence below this
    timeout_seconds: int = 2  # #CTO-Codex: Soft timeout (hard ceiling: 30s)
    drop_score: float = 0.4  # #CTO-Codex: PaddleOCR drop_score threshold
    # #CTO-Codex: PaddleOCR detection parameters (placeholders for Phase 2+)
    det_db_thresh: float = 0.3
    det_db_box_thresh: float = 0.6
    det_db_unclip_ratio: float = 1.5
    # PaddleOCR 3.x PaddleX config support
    paddlex_config: Optional[str] = None  # Path to PaddleX config file for 3.x


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
        threads=int(backend.get("threads", 4)),  # Align with system_guard.py
        openvino_precision=backend.get("openvino", {}).get("precision", "int8"),
        openvino_version=backend.get("openvino", {}).get("version", "v5"),
        openvino_det_model=backend.get("openvino", {}).get("det_model", models.get("det_model")),
        openvino_rec_model=backend.get("openvino", {}).get("rec_model", models.get("rec_model")),
        thresholds=(float(thresholds.get("tau_accept", 0.94)), float(thresholds.get("tau_low", 0.70))),
        deskew_threshold=float(pipeline.get("deskew_threshold", 0.80)),  # #Claude-CLI
        timeout_seconds=int(pipeline.get("timeout_seconds", 2)),  # #CTO-Codex: Updated default
        drop_score=float(pipeline.get("drop_score", 0.4)),  # #CTO-Codex
        det_db_thresh=float(pipeline.get("det_db_thresh", 0.3)),  # #CTO-Codex
        det_db_box_thresh=float(pipeline.get("det_db_box_thresh", 0.6)),  # #CTO-Codex
        det_db_unclip_ratio=float(pipeline.get("det_db_unclip_ratio", 1.5)),  # #CTO-Codex
        paddlex_config=pipeline.get("paddlex_config")  # PaddleX config for 3.x
    )
    # Optional low-threshold tuning profile for debugging card text detection
    if os.environ.get("OCR_LOW_THRESHOLDS", "").strip() in ("1", "true", "TRUE", "yes", "on"):
        oc.drop_score = min(oc.drop_score, 0.15)
        oc.det_db_thresh = min(oc.det_db_thresh, 0.15)
        oc.det_db_box_thresh = min(oc.det_db_box_thresh, 0.35)
        oc.det_db_unclip_ratio = max(oc.det_db_unclip_ratio, 1.8)

    # Quick backend override for CLI smoke tests
    override = os.environ.get("OCR_BACKEND_OVERRIDE")
    if override:
        oc.backend_type = override
    # Safety valve: force native backend to fully avoid PaddleX when debugging
    if os.environ.get("OCR_FORCE_NATIVE", "").strip() in ("1", "true", "TRUE", "yes", "on"):
        oc.backend_type = "native"
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


def _load_paddleocr(flavor: str, enable_angle: bool, cfg: OCRConfig) -> Any:
    # Lazy import PaddleOCR after guards have run
    global PaddleOCR
    if PaddleOCR is None:
        try:
            from paddleocr import PaddleOCR
        except Exception:
            raise RuntimeError("PaddleOCR not available in this environment")
    # PaddleOCR 3.x initialization with CPU optimizations
    # Try to pass detection thresholds when supported; fall back gracefully.
    init_kwargs: Dict[str, Any] = {
        "use_angle_cls": enable_angle,
        "lang": "en",
        "enable_mkldnn": True,  # CPU optimization (default since 3.0.1)
        "cpu_threads": cfg.threads,  # Explicit CPU thread control
    }
    # Prefer explicit thresholds to help with small card text; ignore if unsupported
    maybe_thresholds = {
        "drop_score": cfg.drop_score,
        "det_db_thresh": cfg.det_db_thresh,
        "det_db_box_thresh": cfg.det_db_box_thresh,
        "det_db_unclip_ratio": cfg.det_db_unclip_ratio,
    }
    init_kwargs.update(maybe_thresholds)
    try:
        return PaddleOCR(**init_kwargs)
    except Exception:
        # Remove threshold keys not accepted by this PaddleOCR version (catch all exceptions)
        for k in list(maybe_thresholds.keys()):
            init_kwargs.pop(k, None)
        return PaddleOCR(**init_kwargs)


def _load_paddleocr_cached(flavor: str, enable_angle: bool, cfg: OCRConfig) -> Any:
    """Cached version of _load_paddleocr with deterministic cache keys.
    
    Uses JSON-based deterministic keys (not Python hash which is process-randomized).
    Only includes fields that affect model initialization, not runtime thresholds.
    """
    # Deterministic cache key including only model-affecting parameters
    cache_key_dict = {
        'flavor': flavor,
        'enable_angle': enable_angle,
        'threads': cfg.threads,
        'det_model': cfg.openvino_det_model,
        'rec_model': cfg.openvino_rec_model,
        'lang': 'en',
        'paddleocr_version': get_paddleocr_version(),
        # Include PaddleX version if available (affects model behavior in 3.x)
        'paddlex_version': get_paddlex_version(),
    }
    cache_key = json.dumps(cache_key_dict, sort_keys=True)
    
    # Check cache first (with stats tracking)
    with _CACHE_LOCK:
        if cache_key in _OCR_CACHE:
            _CACHE_STATS["hits"] += 1
            return _OCR_CACHE[cache_key]
        
        # Cache miss - create new instance
        _CACHE_STATS["misses"] += 1
        ocr_instance = _load_paddleocr(flavor, enable_angle, cfg)
        _OCR_CACHE[cache_key] = ocr_instance
        
        # Log cache creation for debugging
        if env_truth("OCR_DEBUG_SCHEMA", False):
            cache_size = len(_OCR_CACHE)
            print(f"OCR cache miss: created new instance (cache size: {cache_size})")
        
        return ocr_instance


def get_ocr_cache_stats() -> Dict[str, Any]:
    """Get current OCR cache statistics."""
    with _CACHE_LOCK:
        return {
            "hits": _CACHE_STATS["hits"],
            "misses": _CACHE_STATS["misses"], 
            "size": len(_OCR_CACHE),
            "hit_rate": _CACHE_STATS["hits"] / max(1, _CACHE_STATS["hits"] + _CACHE_STATS["misses"])
        }


# #Claude-CLI: Timeout exception for OCR operations  
class OCRTimeoutError(Exception):
    pass


def _timeout_handler(signum: int, frame: Any) -> None:
    """#Claude-CLI: Signal handler for OCR timeout"""
    raise OCRTimeoutError("OCR operation timed out")


def _schema_summary(x: Any, depth: int = 0, max_depth: int = 3) -> Any:
    try:
        if depth >= max_depth:
            return str(type(x).__name__)
        if x is None:
            return None
        if isinstance(x, (str, int, float, bool)):
            return type(x).__name__
        if isinstance(x, dict):
            keys = list(x.keys())[:10]
            return {"type": "dict", "keys": keys}
        if isinstance(x, (list, tuple)):
            n = len(x)
            first = _schema_summary(x[0], depth + 1, max_depth) if n > 0 else None
            return {"type": type(x).__name__, "len": n, "first": first}
        try:
            import numpy as _np  # local import guard
            if isinstance(x, _np.ndarray):
                return {"type": "ndarray", "shape": list(x.shape), "dtype": str(x.dtype)}
        except Exception:
            pass
        return str(type(x).__name__)
    except Exception:
        return "unavailable"


def _has(obj: Any, key: str) -> bool:
    """Check if object has key/attribute (dict-like or object attribute access)."""
    return (isinstance(obj, dict) and key in obj) or hasattr(obj, key)

def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Get value by key/attribute (dict-like or object attribute access)."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)

def ocr_infer_native(ocr: Any, img: np.ndarray, cfg: OCRConfig, timeout_seconds: int = 30) -> Tuple[List[str], List[float], Dict[str, Any]]:
    """#Claude-CLI: OCR inference with timeout handling and deterministic sorting"""
    detections: List[Tuple[str, float, Tuple[float, float]]] = []  # (text, conf, centroid)
    
    # Set up timeout for OCR operation
    old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(timeout_seconds)
    
    debug_diag: Dict[str, Any] = {}
    try:
        # PaddleOCR v3.x .ocr() method - simplified API
        # 3.x uses PaddleX backend and returns OCRResult objects
        if env_truth("OCR_DEBUG_SCHEMA", False):
            debug_diag["ocr_call_start"] = True
        res = ocr.ocr(img)
        if env_truth("OCR_DEBUG_SCHEMA", False):
            debug_diag["ocr_call_success"] = True
        # Optional: capture compact schema for debugging structural drift
        if env_truth("OCR_DEBUG_SCHEMA", False):
            try:
                debug_diag["res_schema"] = _schema_summary(res)
                # Log PaddleX-style results when native-only is requested (informational only for 3.x)
                if env_truth("OCR_FORCE_NATIVE", False) and res is not None:
                    from .version_gate import is_paddleocr_v3
                    schema = debug_diag["res_schema"]
                    # Check for PaddleX-specific keys in result structure
                    if (isinstance(schema, dict) and schema.get("type") == "list" and 
                        isinstance(schema.get("first"), dict) and 
                        isinstance(schema.get("first", {}).get("keys"), list)):
                        first_keys = schema["first"]["keys"]
                        paddlex_keys = ["doc_preprocessor_res", "dt_polys", "rec_texts"]
                        if any(key in first_keys for key in paddlex_keys):
                            debug_diag["backend_detected"] = "paddlex_schema_found"
                            debug_diag["paddlex_keys"] = first_keys
                            # Only raise violation for PaddleOCR 2.x where native-only is possible
                            if not is_paddleocr_v3():
                                raise RuntimeError(f"PaddleX backend active despite OCR_FORCE_NATIVE=1. Schema keys: {first_keys}")
            except RuntimeError:
                raise  # Re-raise backend violations
            except Exception:
                pass
        # result format: PaddleOCR typically returns [[(box, (text, conf)), ...]]
        # Normalize and robustly extract items using tolerant helper
        max_boxes = int(os.getenv("OCR_MAX_BOXES", "300") or 300)
        used_paddlex_schema = False
        if res is not None:
            # Normalize container using backend helper to handle various result formats
            pages = _normalize_result_container(res)
            if env_truth("OCR_DEBUG_SCHEMA", False):
                debug_diag["pages_count"] = len(pages)
                debug_diag["page_types"] = [str(type(p)) for p in pages[:3]]
            for page in pages:
                if page is None:
                    continue
                # PaddleX-style page aggregator: dict-like object with dt_polys + rec_texts (+ optional scores)
                # Handle both dict instances and OCRResult objects with attribute access
                if _has(page, "dt_polys") and _has(page, "rec_texts"):
                    if env_truth("OCR_DEBUG_SCHEMA", False):
                        debug_diag[f"page_{len([k for k in debug_diag.keys() if k.startswith('page_')])}_type"] = str(type(page))
                        debug_diag[f"page_{len([k for k in debug_diag.keys() if k.startswith('page_')])}_triggered"] = True
                    try:
                        used_paddlex_schema = True
                        polys = _get(page, "dt_polys") or []
                        texts = _get(page, "rec_texts") or []
                        # Try multiple score key variations
                        scores = (
                            _get(page, "rec_scores")
                            or _get(page, "rec_text_scores")
                            or _get(page, "rec_confidences")
                            or _get(page, "scores")
                            or _get(page, "rec_prob")
                            or _get(page, "rec_probs")
                            or None
                        )
                        if env_truth("OCR_DEBUG_SCHEMA", False):
                            page_num = len([k for k in debug_diag.keys() if k.startswith('page_')])
                            debug_diag[f"page_{page_num}_len_polys"] = len(polys)
                            debug_diag[f"page_{page_num}_len_texts"] = len(texts)
                            debug_diag[f"page_{page_num}_len_scores"] = len(scores) if scores else 0
                        # Ensure alignment between polys, texts, and scores
                        n = min(len(polys), len(texts), len(scores) if scores else len(texts))
                        for i in range(n):
                            text = texts[i]
                            conf = float(scores[i]) if scores and i < len(scores) else 0.99
                            if not text or float(conf) < float(cfg.drop_score):
                                continue
                            try:
                                arr = np.array(polys[i])
                                if arr.ndim == 2 and arr.shape[1] >= 2:
                                    cy = float(np.mean(arr[:, 1]))
                                    cx = float(np.mean(arr[:, 0]))
                                else:
                                    cy, cx = 0.0, 0.0
                            except Exception:
                                cy, cx = 0.0, 0.0
                            detections.append((str(text), float(conf), (cy, cx)))
                            if len(detections) >= max_boxes:
                                break
                    except Exception as e:
                        if env_truth("OCR_DEBUG_SCHEMA", False):
                            debug_diag["paddlex_aggregator_error"] = str(e)
                        pass
                    # Aggregator handled; continue to next page
                    if len(detections) >= max_boxes:
                        break
                    continue
                else:
                    # Debug: log when aggregator didn't trigger on non-dict object with attributes
                    if env_truth("OCR_DEBUG_SCHEMA", False) and not isinstance(page, dict):
                        dir_keys = [k for k in ('dt_polys','rec_texts','rec_scores') if hasattr(page, k)]
                        if dir_keys:
                            debug_diag[f"page_{len([k for k in debug_diag.keys() if k.startswith('page_')])}_missed_attrs"] = dir_keys
                
                # Handle tuple-style results (PaddleOCR 2.x or fallback 3.x)
                # Some versions may return a single item directly
                items = page if isinstance(page, list) else [page]
                for item in items:
                    if item is None:
                        continue
                    try:
                        if _extract_text_conf_box is not None:
                            extracted = _extract_text_conf_box(item)
                        else:
                            extracted = None
                        if extracted is None:
                            # Fallback: try classic tuple layout - but only for actual tuples/lists
                            if isinstance(item, (list, tuple)) and len(item) >= 2:
                                box = item[0]
                                tc = item[1]
                                if isinstance(tc, (list, tuple)) and len(tc) >= 2:
                                    text, conf = tc[0], tc[1]
                                    centroid = None
                                    try:
                                        arr = np.array(box)
                                        if arr.ndim == 2 and arr.shape[1] >= 2:
                                            centroid = (float(np.mean(arr[:, 1])), float(np.mean(arr[:, 0])))
                                    except Exception:
                                        centroid = None
                                    if centroid is None:
                                        centroid = (0.0, 0.0)
                                    extracted = (str(text), float(conf), centroid)
                        if extracted:
                            text, conf, (cy, cx) = extracted
                            if text and float(conf) >= float(cfg.drop_score):
                                detections.append((text, float(conf), (cy, cx)))
                                if len(detections) >= max_boxes:
                                    break
                    except Exception:
                        # Skip malformed rows conservatively
                        continue
                if len(detections) >= max_boxes:
                    break
    finally:
        # Always restore the old handler and cancel the alarm
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)
    
    # #CTO-Codex: Sort deterministically by centroid (top-to-bottom, then left-to-right)
    detections.sort(key=lambda x: x[2])  # Sort by (y, x) tuple
    
    # Extract sorted lines and confidences
    lines = [det[0] for det in detections]
    confs = [round(det[1], 3) for det in detections]  # #CTO-Codex: Round to 3 decimals for stability
    
    if used_paddlex_schema:
        debug_diag["paddlex_schema"] = True
    return lines, confs, debug_diag


def _infer_with_timeout(infer_func: callable, *args, timeout_seconds: int = 30, **kwargs) -> Tuple[List[str], List[float]]:
    """#Claude-CLI: Generic timeout wrapper for backend inference functions"""
    # Set up timeout for inference operation
    old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(timeout_seconds)
    
    try:
        result = infer_func(*args, **kwargs)
        return result
    finally:
        # Always restore the previous signal handler and cancel alarm
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)


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
            "det_rec_combined": 0,  # #CTO-Codex: Combined detection+recognition timing
            "parse": 0,
            "ocr": 0,  # Legacy field
            "total": 0,
            "deskew": 0,
            # Deprecated: separate det/rec times not available in PaddleX 3.x
            "det": 0,  # Deprecated: same as det_rec_combined
            "rec": 0,  # Deprecated: same as det_rec_combined
        },
        "versions": _collect_versions(),
        "host": collect_host_facts(),
    }


def _pkg_version(name: str) -> Optional[str]:
    try:
        return importlib_metadata.version(name)
    except Exception:
        return None


def _collect_versions() -> Dict[str, Any]:
    return {
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "numpy": _pkg_version("numpy"),
        "opencv-python": _pkg_version("opencv-python"),
        "paddleocr": _pkg_version("paddleocr"),
        "paddlepaddle": _pkg_version("paddlepaddle"),
        "paddlex": _pkg_version("paddlex"),
        "openvino": _pkg_version("openvino"),
        "pillow": _pkg_version("Pillow"),
        "pyyaml": _pkg_version("PyYAML"),
    }


def run(image_path: str, config_path: Optional[str] = None) -> Dict[str, Any]:
    """#Claude-CLI: Main OCR pipeline with enhanced error handling and confidence metrics"""
    # Apply system-level safeguards and sane defaults before touching Paddle
    apply_cpu_threading_defaults()
    try:
        cfg = load_config(config_path or str(ROOT / "configs/ocr.yaml"))
    except Exception as e:
        return _create_error_response("config_error", image_path, f"Failed to load config: {e}")
    # Enforce native-only policy with awareness of selected backend
    try:
        ensure_native_backend_or_die(getattr(cfg, "backend_type", None))
    except Exception as e:
        return _create_error_response("config_error", image_path, f"Native-only policy violation: {e}")
    
    set_runtime_threads(cfg.threads)

    t0 = time.perf_counter()
    
    # #Claude-CLI: Enhanced input handling with EXIF and conditional deskew
    try:
        # Early file existence check for clearer error context
        if not os.path.isfile(image_path):
            return _create_error_response("file_not_found", image_path, "Input image path does not exist")
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

    # Backend dispatch - native, PaddleX OpenVINO, and ONNX Runtime
    try:
        if cfg.backend_type == "native":
            ocr = _load_paddleocr_cached(cfg.flavor, cfg.enable_orientation, cfg)
            # #CTO-Codex: Enforce hard timeout ceiling of 30s
            timeout_seconds = min(cfg.timeout_seconds, 30)
            lines, confs, native_diag = ocr_infer_native(ocr, img, cfg, timeout_seconds)
        elif cfg.backend_type == "paddlex_openvino":
            # #Claude-CLI: PaddleX ultra-infer with OpenVINO backend
            # #CTO-Codex: Enforce hard timeout ceiling of 30s
            timeout_seconds = min(cfg.timeout_seconds, 30)
            try:
                lines, confs = _infer_with_timeout(
                    infer_paddlex_openvino,
                    img, cfg.flavor, cfg.openvino_precision, cfg.threads,
                    cfg.openvino_version, cfg.openvino_det_model, cfg.openvino_rec_model,
                    timeout_seconds=timeout_seconds
                )
            except ImportError:
                # Fallback to native PaddleOCR if PaddleX/OpenVINO is unavailable
                ocr = _load_paddleocr_cached(cfg.flavor, cfg.enable_orientation, cfg)
                lines, confs, native_diag = ocr_infer_native(ocr, img, cfg, timeout_seconds)
        elif cfg.backend_type == "onnxruntime":
            # Placeholder: ONNX Runtime path for Phase 3
            # #CTO-Codex: Enforce hard timeout ceiling of 30s  
            timeout_seconds = min(cfg.timeout_seconds, 30)
            lines, confs = _infer_with_timeout(
                infer_onnxruntime,
                img, cfg.flavor,
                timeout_seconds=timeout_seconds
            )
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
                # Use the same backend used above for consistency
                hard_timeout = min(cfg.timeout_seconds, 30)
                if cfg.backend_type == "native":
                    # Reuse the cached PaddleOCR instance
                    ocr = _load_paddleocr_cached(cfg.flavor, cfg.enable_orientation, cfg)
                    deskewed_lines, deskewed_confs, _deskew_diag = ocr_infer_native(ocr, deskewed_img, cfg, hard_timeout)
                elif cfg.backend_type == "paddlex_openvino":
                    deskewed_lines, deskewed_confs = _infer_with_timeout(
                        infer_paddlex_openvino,
                        deskewed_img, cfg.flavor, cfg.openvino_precision, cfg.threads,
                        cfg.openvino_version, cfg.openvino_det_model, cfg.openvino_rec_model,
                        timeout_seconds=hard_timeout
                    )
                elif cfg.backend_type == "onnxruntime":
                    deskewed_lines, deskewed_confs = _infer_with_timeout(
                        infer_onnxruntime,
                        deskewed_img, cfg.flavor,
                        timeout_seconds=hard_timeout
                    )
                else:
                    deskewed_lines, deskewed_confs = lines, confs
                deskewed_conf = float(np.mean(deskewed_confs)) if deskewed_confs else 0.0
            except OCRTimeoutError:
                # If deskew OCR times out, just use original results
                deskewed_lines, deskewed_confs = lines, confs
                deskewed_conf = overall_conf
            except ImportError:
                # If high-performance backend is unavailable during deskew, fallback to native
                try:
                    ocr = _load_paddleocr_cached(cfg.flavor, cfg.enable_orientation, cfg)
                    deskewed_lines, deskewed_confs, _deskew_diag = ocr_infer_native(ocr, deskewed_img, cfg, hard_timeout)
                    deskewed_conf = float(np.mean(deskewed_confs)) if deskewed_confs else 0.0
                except Exception:
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
        err = _create_error_response("no_text", image_path, "No text detected in image")
        # Add diagnostics to help field-debug issues like PaddleX/threshold confusion
        err["diagnostics"] = {
            "backend_used": "paddleocr+paddlex" if is_paddleocr_v3() else "native",
            "schema_type": "paddlex_json" if is_paddleocr_v3() else "tuple_2x",
            "flavor": cfg.flavor,
            "box_count": 0,
            "thresholds": {
                "drop_score": cfg.drop_score,
                "det_db_thresh": cfg.det_db_thresh,
                "det_db_box_thresh": cfg.det_db_box_thresh,
                "det_db_unclip_ratio": cfg.det_db_unclip_ratio,
            },
        }
        # Attach schema snapshot when debugging is enabled
        try:
            if cfg.backend_type == "native":
                # native_diag may not exist in this branch if exception earlier; guard fetch
                diag_schema = locals().get("native_diag", {}).get("res_schema")  # type: ignore
                if diag_schema is not None:
                    err["diagnostics"]["res_schema"] = diag_schema
        except Exception:
            pass
        return err

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
    try:
        # Defensive access to thresholds (should be tuple with accept, low)
        accept_threshold = cfg.thresholds[0] if len(cfg.thresholds) > 0 else 0.94
        low_threshold = cfg.thresholds[1] if len(cfg.thresholds) > 1 else 0.70
        
        if overall_conf < low_threshold:  # Below low threshold
            quality_flags.append("low_confidence")
        if overall_conf >= accept_threshold:  # Above accept threshold
            quality_flags.append("high_confidence")
    except (IndexError, TypeError, AttributeError):
        # Fallback if thresholds are malformed
        if overall_conf < 0.70:
            quality_flags.append("low_confidence")
        if overall_conf >= 0.94:
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
        "backend_used": ("paddlex_like" if locals().get("native_diag", {}).get("paddlex_schema") else cfg.backend_type),
        "model_flavor": cfg.flavor,
        "thresholds": {
            "drop_score": cfg.drop_score,
            "det_db_thresh": cfg.det_db_thresh,
            "det_db_box_thresh": cfg.det_db_box_thresh,
            "det_db_unclip_ratio": cfg.det_db_unclip_ratio,
        },
        "diagnostics": {
            "backend_used": "paddleocr+paddlex" if is_paddleocr_v3() else "native",
            "schema_type": "paddlex_json" if is_paddleocr_v3() else "tuple_2x",
            "box_count": len(lines),
        },
        "timings_ms": {
            "preproc": preproc_time,  # #CTO-Codex: Preprocessing stage timing
            "det_rec_combined": det_time,  # #CTO-Codex: Combined detection+recognition timing (PaddleX doesn't expose split)
            "parse": parse_time,  # #CTO-Codex: Parsing stage timing
            "ocr": det_time,  # Legacy field for compatibility
            "total": int((t1 - t0) * 1000),
            "deskew": deskew_time,
            # Deprecated: separate det/rec times not available in PaddleX 3.x
            "det": det_time,  # Deprecated: same as det_rec_combined
            "rec": det_time,  # Deprecated: same as det_rec_combined
        },
        "versions": _collect_versions(),
        "host": collect_host_facts(),
    }

    # Include schema diagnostics from native inference
    try:
        if cfg.backend_type == "native":
            native_diag = locals().get("native_diag", {})  # type: ignore
            if native_diag:
                diagnostics = payload.setdefault("diagnostics", {})
                if "res_schema" in native_diag:
                    diagnostics["res_schema"] = native_diag["res_schema"]
                if "schema_detected" in native_diag:
                    diagnostics["schema_detected"] = native_diag["schema_detected"]
    except Exception:
        pass

    # Add OCR cache telemetry to diagnostics
    try:
        cache_stats = get_ocr_cache_stats()
        payload.setdefault("diagnostics", {})["ocr_cache"] = cache_stats
        # Add per-request cache hit flag for this specific request
        payload["diagnostics"]["cache_hit"] = cache_stats["hits"] > 0 and cache_stats.get("hit_rate", 0) > 0
    except Exception:
        pass

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
