"""
#CodexGuidance: Backend wiring stubs for PaddleX ultra-infer and ONNX Runtime
This file documents the planned integration points. The initial prototype
uses native PaddleOCR; high-performance backends will be added incrementally.
"""
from __future__ import annotations

from typing import Any, List, Optional, Tuple

import numpy as np


def _first_non_none(values: List[Optional[Any]]) -> Optional[Any]:
    for v in values:
        if v is not None:
            return v
    return None


def _get(obj: Any, key: str) -> Optional[Any]:
    # Try attribute, then mapping key
    val = getattr(obj, key, None)
    if val is None and isinstance(obj, dict):
        val = obj.get(key)
    return val


def _extract_centroid_from_box(box: Any) -> Optional[Tuple[float, float]]:
    """Accepts multiple shapes:
    - [x1, y1, x2, y2]
    - [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
    - {x, y, w, h}
    - numpy arrays in any of the above forms
    Returns (cy, cx) or None.
    """
    if box is None:
        return None
    try:
        # Dict rect
        if isinstance(box, dict):
            if all(k in box for k in ("x", "y", "w", "h")):
                x = float(box["x"]) ; y = float(box["y"]) ; w = float(box["w"]) ; h = float(box["h"]) 
                return (y + h / 2.0, x + w / 2.0)
            # Some APIs use left/top/width/height
            if all(k in box for k in ("left", "top", "width", "height")):
                x = float(box["left"]) ; y = float(box["top"]) ; w = float(box["width"]) ; h = float(box["height"]) 
                return (y + h / 2.0, x + w / 2.0)

        arr = np.array(box)
        if arr.ndim == 1 and arr.size >= 4:
            x1, y1, x2, y2 = [float(arr[i]) for i in range(4)]
            return ((y1 + y2) / 2.0, (x1 + x2) / 2.0)
        if arr.ndim == 2 and arr.shape[1] >= 2:
            cy = float(np.mean(arr[:, 1]))
            cx = float(np.mean(arr[:, 0]))
            return (cy, cx)
    except Exception:
        return None
    return None


def _extract_text_conf_box(item: Any) -> Optional[Tuple[str, float, Tuple[float, float]]]:
    """Schema-tolerant extraction from PaddleX OCR results.
    Tries attributes and dict keys, accommodating different field names.
    Returns (text, conf, (cy, cx)) or None if not extractable.
    """
    # Handle PaddleOCR-like tuple: (box, (text, conf))
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        box = item[0]
        tc = item[1]
        if isinstance(tc, (list, tuple)) and len(tc) >= 2:
            text = str(tc[0]) if tc[0] is not None else ""
            try:
                conf = float(tc[1])
            except Exception:
                conf = 0.0
            centroid = _extract_centroid_from_box(box)
            if text and centroid is not None:
                return text, conf, centroid

    # Common text/conf aliases
    text = _first_non_none([
        _get(item, k) for k in ("text", "transcription", "label", "rec_text", "ocr_text")
    ])
    conf = _first_non_none([
        _get(item, k) for k in ("confidence", "score", "rec_score", "prob")
    ])
    # Common box aliases
    box = _first_non_none([
        _get(item, k) for k in ("bbox", "box", "points", "poly", "polygon", "quadrilateral")
    ])

    centroid = _extract_centroid_from_box(box)

    if text is not None and centroid is not None:
        try:
            t = str(text)
            c = float(conf) if conf is not None else 0.0
            return t, c, centroid
        except Exception:
            return None
    return None


def _normalize_result_container(result: Any) -> List[Any]:
    """Normalize various container shapes into a flat list of items."""
    if result is None:
        return []
    # PaddleX may return list, or dict with nested list
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        for k in ("result", "results", "data", "items", "preds", "predictions", "ocr_result"):
            v = result.get(k)
            if isinstance(v, list):
                return v
    # Single item
    return [result]


def infer_paddlex_openvino(
    img: np.ndarray,
    flavor: str,
    precision: str = "int8",
    threads: int = 6,
    version: str = "v5",
    det_model_dir: Optional[str] = None,
    rec_model_dir: Optional[str] = None,
) -> Tuple[List[str], List[float]]:
    """PaddleX ultra-infer (OpenVINO CPU) backend implementation.
    
    Args:
        img: Input image as numpy array (BGR format)
        flavor: Model flavor ('mobile' or 'server')
        precision: OpenVINO precision ('int8', 'fp16', 'fp32') 
        threads: Number of CPU threads to use
        
    Returns:
        Tuple of (lines, confs) where:
        - lines: List of detected text strings, sorted by centroid (y, x)
        - confs: List of confidence scores (0-1), rounded to 3 decimals
        
    Raises:
        ImportError: If PaddleX is not available
        RuntimeError: If OpenVINO backend initialization fails
    """
    # Respect native-only valve to avoid accidental non-native use
    try:
        from .system_guard import env_truth  # local import to avoid cycles
        if env_truth("OCR_FORCE_NATIVE", False) and not env_truth("OCR_ALLOW_PADDLEX_FALLBACK", False):
            raise RuntimeError("OCR_FORCE_NATIVE=1: PaddleX backend disabled")
    except Exception:
        pass

    try:
        import paddlex as pdx
    except ImportError:
        raise ImportError("PaddleX not available. Install with: pip install paddlex")
    
    try:
        # Resolve model identifiers for PaddleOCR 3.x unified naming
        ver = (version or "v5").lower()
        arch = "PP-OCRv5" if ver.endswith("v5") else "PP-OCRv4"
        # PaddleX 3.x uses standardized model names with .json configs
        det_dir = det_model_dir or f"{arch}_{flavor}_det"
        rec_dir = rec_model_dir or f"en_{arch}_{flavor}_rec"  # English-specific model

        model_config = {
            "model_dir": det_dir,
            "rec_model_dir": rec_dir,
            "device": "cpu",
            "backend": "openvino",
            "precision": precision,
            "cpu_threads": threads,
            "enable_benchmark": False,
        }

        # Create PaddleX OCR engine; if requested v5 is not available, gracefully try v4
        try:
            ocr_engine = pdx.create_model(arch, **model_config)
        except Exception:
            if arch == "PP-OCRv5":
                fallback_arch = "PP-OCRv4"
                det_dir_fb = det_model_dir or f"{fallback_arch}_{flavor}_det"
                rec_dir_fb = rec_model_dir or f"{fallback_arch}_{flavor}_rec"
                model_config_fb = {**model_config, "model_dir": det_dir_fb, "rec_model_dir": rec_dir_fb}
                ocr_engine = pdx.create_model(fallback_arch, **model_config_fb)
            else:
                raise
        
        # Run inference on image
        result = ocr_engine.predict(img)

        # Normalize container and extract items robustly
        items = _normalize_result_container(result)
        detections: List[Tuple[str, float, Tuple[float, float]]] = []
        for item in items:
            extracted = _extract_text_conf_box(item)
            if extracted:
                detections.append(extracted)
        
        # Sort deterministically by centroid (top-to-bottom, then left-to-right)
        detections.sort(key=lambda x: x[2])
        
        # Extract sorted lines and confidences with 3-decimal rounding
        lines = [det[0] for det in detections]
        confs = [round(det[1], 3) for det in detections]
        
        return lines, confs
        
    except Exception as e:
        raise RuntimeError(f"PaddleX OpenVINO backend failed: {e}")


def infer_onnxruntime(img: np.ndarray, flavor: str) -> Tuple[List[str], List[float]]:
    """Placeholder for ONNX Runtime path using exported det/rec models.
    Returns (lines, confs).
    """
    raise NotImplementedError("ONNX Runtime path pending integration")
