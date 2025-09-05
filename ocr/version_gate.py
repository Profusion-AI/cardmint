"""Version detection utilities for PaddleOCR schema handling."""
from importlib.metadata import version, PackageNotFoundError


def paddleocr_major() -> int:
    """Get PaddleOCR major version number."""
    try:
        v = version("paddleocr")
    except PackageNotFoundError:
        return 0
    try:
        return int(v.split(".")[0])
    except Exception:
        return 0


def is_paddleocr_v3() -> bool:
    """Check if PaddleOCR 3.x is installed (which bundles PaddleX)."""
    return paddleocr_major() >= 3


def get_paddleocr_version() -> str:
    """Get full PaddleOCR version string."""
    try:
        return version("paddleocr")
    except PackageNotFoundError:
        return "unknown"


def get_paddlex_version() -> str:
    """Get PaddleX version string if available."""
    try:
        return version("paddlex")
    except PackageNotFoundError:
        return "not_installed"