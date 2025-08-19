#!/usr/bin/env python3
"""
Test PyTorch installation and device detection
Verifies the unified architecture support for Intel UHD Graphics
"""

import torch
import sys
import platform

def test_pytorch_installation():
    """Test PyTorch installation and device capabilities"""
    
    print("=" * 60)
    print("PyTorch Installation Test")
    print("=" * 60)
    
    # Basic info
    print(f"\nSystem Information:")
    print(f"  Python Version: {sys.version}")
    print(f"  Platform: {platform.platform()}")
    print(f"  Processor: {platform.processor()}")
    
    # PyTorch info
    print(f"\nPyTorch Information:")
    print(f"  PyTorch Version: {torch.__version__}")
    print(f"  CUDA Available: {torch.cuda.is_available()}")
    
    # Check for Intel Extension for PyTorch
    has_ipex = False
    ipex_version = None
    try:
        import intel_extension_for_pytorch as ipex
        has_ipex = True
        ipex_version = ipex.__version__
        print(f"  Intel Extension for PyTorch: ✅ Installed (v{ipex_version})")
    except ImportError:
        print(f"  Intel Extension for PyTorch: ❌ Not installed")
    
    # Check for Intel GPU support (XPU)
    has_xpu = hasattr(torch, 'xpu') or (has_ipex and hasattr(ipex, 'xpu'))
    print(f"  XPU Support (Intel GPU): {has_xpu}")
    if has_xpu:
        try:
            if has_ipex:
                print(f"  XPU Available: {ipex.xpu.is_available() if hasattr(ipex.xpu, 'is_available') else False}")
                if hasattr(ipex.xpu, 'device_count'):
                    print(f"  XPU Device Count: {ipex.xpu.device_count()}")
                if hasattr(ipex.xpu, 'get_device_name'):
                    print(f"  XPU Device Name: {ipex.xpu.get_device_name(0)}")
            elif hasattr(torch, 'xpu'):
                print(f"  XPU Available: {torch.xpu.is_available()}")
                if torch.xpu.is_available():
                    print(f"  XPU Device Count: {torch.xpu.device_count()}")
                    print(f"  XPU Device Name: {torch.xpu.get_device_name(0)}")
        except Exception as e:
            print(f"  XPU Check Error: {e}")
    
    # Check for MPS (Apple Silicon)
    print(f"  MPS Available: {torch.backends.mps.is_available() if hasattr(torch.backends, 'mps') else False}")
    
    # Check for MKL-DNN (Intel optimizations)
    print(f"  MKL-DNN Available: {torch.backends.mkldnn.is_available()}")
    
    # Determine best device
    print(f"\nDevice Selection:")
    if torch.cuda.is_available():
        device = torch.device("cuda")
        device_name = torch.cuda.get_device_name(0)
        device_type = "NVIDIA GPU"
    elif hasattr(torch, 'xpu') and torch.xpu.is_available():
        device = torch.device("xpu")
        device_name = "Intel GPU"
        device_type = "Intel XPU"
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        device = torch.device("mps")
        device_name = "Apple Silicon"
        device_type = "Apple MPS"
    else:
        device = torch.device("cpu")
        device_name = "CPU"
        device_type = "CPU (with optimizations)" if torch.backends.mkldnn.is_available() else "CPU"
    
    print(f"  Selected Device: {device}")
    print(f"  Device Type: {device_type}")
    print(f"  Device Name: {device_name}")
    
    # Test tensor operations
    print(f"\nTensor Operations Test:")
    try:
        # Create a small tensor
        x = torch.randn(3, 3).to(device)
        y = torch.randn(3, 3).to(device)
        
        # Perform operation
        z = torch.matmul(x, y)
        
        print(f"  Matrix multiplication: SUCCESS")
        print(f"  Tensor device: {z.device}")
        print(f"  Result shape: {z.shape}")
        
        # Test convolution (for CNN models)
        conv = torch.nn.Conv2d(3, 64, kernel_size=3).to(device)
        
        # Apply IPEX optimization if available
        if 'ipex' in locals() or 'ipex' in globals():
            try:
                import intel_extension_for_pytorch as ipex
                conv = ipex.optimize(conv)
                print(f"  Model optimization: IPEX applied")
            except:
                pass
        
        input_tensor = torch.randn(1, 3, 224, 224).to(device)
        
        with torch.no_grad():
            output = conv(input_tensor)
        
        print(f"  Convolution test: SUCCESS")
        print(f"  Output shape: {output.shape}")
        
    except Exception as e:
        print(f"  Tensor operations FAILED: {e}")
    
    # Memory info
    print(f"\nMemory Information:")
    if device.type == "cuda":
        print(f"  GPU Memory Allocated: {torch.cuda.memory_allocated(0) / 1024**2:.2f} MB")
        print(f"  GPU Memory Reserved: {torch.cuda.memory_reserved(0) / 1024**2:.2f} MB")
        props = torch.cuda.get_device_properties(0)
        print(f"  Total GPU Memory: {props.total_memory / 1024**2:.2f} MB")
    else:
        import psutil
        mem = psutil.virtual_memory()
        print(f"  System RAM Available: {mem.available / 1024**2:.2f} MB")
        print(f"  System RAM Total: {mem.total / 1024**2:.2f} MB")
    
    # Optimization hints
    print(f"\nOptimization Recommendations:")
    if device.type == "cpu":
        print("  - Your system is using CPU for computations")
        if not torch.backends.mkldnn.is_available():
            print("  - Consider installing Intel MKL for better CPU performance")
        if has_xpu:
            print("  - Intel GPU detected but not available")
            print("  - Consider installing Intel Extension for PyTorch:")
            print("    pip install intel-extension-for-pytorch")
        print("  - The lightweight MobileNetV3 model is optimal for your setup")
    else:
        print(f"  - Your system has {device_type} acceleration available")
        print("  - Both lightweight and heavy models can be used efficiently")
    
    print("\n" + "=" * 60)
    print("Test Complete!")
    print("=" * 60)


if __name__ == "__main__":
    test_pytorch_installation()