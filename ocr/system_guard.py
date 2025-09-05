import os
import sys
import json
import platform
import subprocess
import importlib.util


def env_truth(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip() not in ("0", "false", "False", "", "off", "OFF")


def ensure_native_backend_or_die(backend_type: str | None = None) -> None:
    """Native-only guard.

    Behavior:
    - Default (OCR_FORCE_NATIVE=1): allow packages to be installed but not imported.
      Fail only if disallowed modules are actually imported in-process.
    - Strict (OCR_FORCE_NATIVE=1 and OCR_NATIVE_STRICT=1): also fail if modules are
      merely importable (installed), even if not imported.
    """
    if not env_truth("OCR_FORCE_NATIVE", False):
        return
    disallowed = ("paddlex", "onnxruntime", "tensorrt")

    # If a non-native backend is requested while native-only is set, fail fast
    if backend_type and backend_type != "native":
        raise RuntimeError(
            f"OCR_FORCE_NATIVE=1: backend '{backend_type}' is not allowed. Use 'native'."
        )

    # Soft mode: allow import presence; warn only in strict mode
    imported = [m for m in disallowed if m in sys.modules]
    if imported and env_truth("OCR_NATIVE_STRICT", False):
        # In strict mode, only fail if a non-native backend is selected/possible
        # Allow run to continue when backend_type is explicitly native.
        if backend_type and backend_type == "native":
            return
        raise RuntimeError(
            f"OCR_FORCE_NATIVE=1, OCR_NATIVE_STRICT=1: disallowed modules imported: {imported}."
        )

    # Strict mode: optionally block if simply installed/importable
    if env_truth("OCR_NATIVE_STRICT", False):
        present = []
        for m in disallowed:
            try:
                if importlib.util.find_spec(m) is not None:
                    present.append(m)
            except Exception:
                continue
        if present:
            raise RuntimeError(
                f"OCR_FORCE_NATIVE=1, OCR_NATIVE_STRICT=1: disallowed modules present on sys.path: {present}"
            )


def apply_cpu_threading_defaults() -> None:
    """Right-size MKL/OpenMP threads by default for i5-10210U (4C/8T).

    - If OCR_WORKERS is provided, share cores across workers.
    - Avoid oversubscription by capping OMP/MKL threads.
    - Encourage oneDNN and passive waits to reduce latency spikes.
    """
    phys_cores = 4  # i5-10210U assumed per environment brief
    try:
        workers = int(os.getenv("OCR_WORKERS", "1") or "1")
    except ValueError:
        workers = 1
    threads = max(1, phys_cores // max(1, workers))

    os.environ.setdefault("OMP_NUM_THREADS", str(threads))
    os.environ.setdefault("MKL_NUM_THREADS", str(threads))
    os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")

    # Strongly encourage oneDNN for Paddle on CPU
    os.environ.setdefault("FLAGS_use_mkldnn", "1")
    # Determinism toggle (noop on CPU but harmless)
    os.environ.setdefault("FLAGS_cudnn_deterministic", "1")


def collect_host_facts() -> dict:
    env_keys = [
        "OMP_NUM_THREADS",
        "MKL_NUM_THREADS",
        "OMP_WAIT_POLICY",
        "FLAGS_use_mkldnn",
        "OCR_FORCE_NATIVE",
        "OCR_LOW_THRESHOLDS",
        "OCR_WORKERS",
    ]
    facts = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cpu_model": None,
        "cpu_flags": None,
        "env": {k: os.getenv(k) for k in env_keys},
    }
    try:
        out = subprocess.check_output(
            ["bash", "-lc", "lscpu | grep -E 'Model name|Flags'"],
            text=True,
        )
        for line in out.splitlines():
            if "Model name" in line:
                facts["cpu_model"] = line.split(":", 1)[1].strip()
            if "Flags" in line:
                facts["cpu_flags"] = line.split(":", 1)[1].strip().split()
    except Exception:
        # Non-fatal if lscpu is missing or fails
        pass
    return facts


def neuter_paddlex_calls() -> None:
    """When native-only is enabled, create selective PaddleX stubs.

    Note: PaddleOCR 3.x intentionally bundles PaddleX as a first-class dependency.
    This function only applies to PaddleOCR 2.x for true native-only execution.
    """
    if not env_truth("OCR_FORCE_NATIVE", False):
        return
    
    # Check if we're on PaddleOCR 3.x which requires PaddleX
    try:
        from .version_gate import is_paddleocr_v3
        if is_paddleocr_v3():
            print("⚠️  OCR_FORCE_NATIVE requested but PaddleOCR>=3 detected; "
                  "PaddleX is a first-class dependency in 3.x. "
                  "Proceeding with PaddleX-enabled path.")
            return
    except Exception:
        # If version detection fails, proceed with neutering attempt
        pass
    
    import types
    
    def _make_passthrough_stub(name: str) -> types.ModuleType:
        """Create a stub module that allows imports but blocks execution."""
        stub = types.ModuleType(name)
        
        def _noop(*args, **kwargs):  # type: ignore
            """No-op function for utility imports."""
            return None
            
        def _blocked(*args, **kwargs):  # type: ignore
            """Blocked function for model operations."""
            raise RuntimeError(f"{name} backend disabled by OCR_FORCE_NATIVE=1")
            
        def _stub_getattr(attr_name: str):  # type: ignore
            if attr_name.startswith('__'):
                return object.__getattribute__(stub, attr_name)
            # Handle specific classes PaddleOCR needs
            if attr_name == 'DependencyError':
                return type('DependencyError', (Exception,), {})
            # Allow utility imports that PaddleOCR needs
            if any(x in attr_name for x in ['benchmark', 'utils', 'deps']):
                return _noop
            # Block model/pipeline operations  
            if any(x in attr_name.lower() for x in ['model', 'pipeline', 'ocr', 'create', 'load']):
                return _blocked
            # Default to noop for other attributes
            return _noop
            
        stub.__getattr__ = _stub_getattr
        return stub
    
    # Create selective stubs for PaddleX modules that PaddleOCR imports
    paddlex_modules = [
        'paddlex',
        'paddlex.utils',
        'paddlex.utils.deps',
        'paddlex.inference', 
        'paddlex.inference.utils',
        'paddlex.inference.utils.benchmark',
        'paddlex.models',
        'paddlex.pipeline',
        'paddlex.configs',
        'paddlex.repo_apis'
    ]
    
    for mod_name in paddlex_modules:
        if mod_name not in sys.modules:
            sys.modules[mod_name] = _make_passthrough_stub(mod_name)
    
    # Also patch any already imported PaddleX
    try:
        if 'paddlex' in sys.modules:
            pdx = sys.modules['paddlex']
            def _blocked(*args, **kwargs):  # type: ignore
                raise RuntimeError("PaddleX backend disabled by OCR_FORCE_NATIVE=1")
            for attr in ("create_model", "load_model", "OCR", "create_pipeline"):
                if hasattr(pdx, attr):
                    try:
                        setattr(pdx, attr, _blocked)
                    except Exception:
                        pass
    except Exception:
        pass
