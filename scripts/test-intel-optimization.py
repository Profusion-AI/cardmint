#!/usr/bin/env python3
"""
Test Intel optimizations for VLM pipeline
Verifies IPEX setup and basic performance improvements
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import torch
import intel_extension_for_pytorch as ipex
import time
import psutil
import json
from datetime import datetime

def test_ipex_availability():
    """Test if IPEX is properly installed and configured."""
    print("\n=== Intel Extension for PyTorch (IPEX) Test ===")
    print(f"PyTorch version: {torch.__version__}")
    print(f"IPEX version: {ipex.__version__}")
    print(f"IPEX available: {hasattr(torch, 'xpu') or hasattr(ipex, 'optimize')}")
    
    # Test IPEX optimization
    try:
        # Create simple model
        model = torch.nn.Linear(10, 10)
        model.eval()
        
        # Optimize with IPEX
        optimized_model = ipex.optimize(model, dtype=torch.float32)
        
        # Test inference
        with torch.no_grad():
            input_tensor = torch.randn(1, 10)
            output = optimized_model(input_tensor)
            
        print("✅ IPEX optimization successful")
        return True
    except Exception as e:
        print(f"❌ IPEX optimization failed: {e}")
        return False

def test_thread_configuration():
    """Test optimal thread configuration for Intel CPU."""
    print("\n=== Thread Configuration Test ===")
    
    # Get CPU info
    cpu_count_physical = psutil.cpu_count(logical=False)
    cpu_count_logical = psutil.cpu_count(logical=True)
    
    print(f"Physical cores: {cpu_count_physical}")
    print(f"Logical cores: {cpu_count_logical}")
    print(f"Hyperthreading: {'Enabled' if cpu_count_logical > cpu_count_physical else 'Disabled'}")
    
    # Test different thread counts
    thread_counts = [1, 2, 4, cpu_count_physical]
    results = []
    
    for num_threads in thread_counts:
        torch.set_num_threads(num_threads)
        
        # Simple benchmark
        start_time = time.time()
        for _ in range(100):
            a = torch.randn(1000, 1000)
            b = torch.randn(1000, 1000)
            c = torch.matmul(a, b)
        elapsed = time.time() - start_time
        
        results.append({
            "threads": num_threads,
            "time_ms": elapsed * 1000,
            "ops_per_sec": 100 / elapsed
        })
        
        print(f"Threads: {num_threads:2d} | Time: {elapsed*1000:7.1f}ms | Ops/sec: {100/elapsed:6.1f}")
    
    # Find optimal
    best = min(results, key=lambda x: x["time_ms"])
    print(f"\n✅ Optimal thread count: {best['threads']} threads")
    
    return best["threads"]

def test_memory_optimization():
    """Test memory optimization settings."""
    print("\n=== Memory Optimization Test ===")
    
    mem = psutil.virtual_memory()
    print(f"Total memory: {mem.total / (1024**3):.1f} GB")
    print(f"Available memory: {mem.available / (1024**3):.1f} GB")
    print(f"Used memory: {(mem.total - mem.available) / (1024**3):.1f} GB")
    
    # Test memory allocator settings
    os.environ['MALLOC_CONF'] = 'oversize_threshold:1,background_thread:true,metadata_thp:auto'
    
    # Create and delete large tensors to test memory management
    print("\nTesting memory allocation/deallocation...")
    initial_mem = psutil.Process().memory_info().rss / (1024**3)
    
    # Allocate
    tensors = []
    for i in range(5):
        t = torch.randn(1000, 1000, 100)  # ~400MB each
        tensors.append(t)
        current_mem = psutil.Process().memory_info().rss / (1024**3)
        print(f"  Allocated tensor {i+1}: {current_mem:.2f} GB used")
    
    # Deallocate
    tensors.clear()
    import gc
    gc.collect()
    
    final_mem = psutil.Process().memory_info().rss / (1024**3)
    print(f"\nMemory after cleanup: {final_mem:.2f} GB")
    print(f"Memory freed: {max(0, current_mem - final_mem):.2f} GB")
    
    return True

def benchmark_basic_operations():
    """Benchmark basic operations with and without IPEX."""
    print("\n=== Basic Operations Benchmark ===")
    
    # Create test model
    class SimpleModel(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.conv1 = torch.nn.Conv2d(3, 64, 3)
            self.conv2 = torch.nn.Conv2d(64, 128, 3)
            self.fc = torch.nn.Linear(128 * 28 * 28, 10)
            
        def forward(self, x):
            x = torch.relu(self.conv1(x))
            x = torch.relu(self.conv2(x))
            x = x.view(x.size(0), -1)
            x = self.fc(x)
            return x
    
    # Test input
    input_tensor = torch.randn(1, 3, 32, 32)
    
    # Without IPEX
    model = SimpleModel()
    model.eval()
    
    with torch.no_grad():
        # Warmup
        for _ in range(10):
            _ = model(input_tensor)
        
        # Benchmark
        start = time.time()
        for _ in range(100):
            _ = model(input_tensor)
        baseline_time = (time.time() - start) * 1000
    
    print(f"Baseline (no IPEX): {baseline_time:.1f}ms for 100 iterations")
    
    # With IPEX
    model_ipex = SimpleModel()
    model_ipex.eval()
    model_ipex = ipex.optimize(model_ipex, dtype=torch.float32)
    
    with torch.no_grad():
        # Warmup
        for _ in range(10):
            _ = model_ipex(input_tensor)
        
        # Benchmark
        start = time.time()
        for _ in range(100):
            _ = model_ipex(input_tensor)
        ipex_time = (time.time() - start) * 1000
    
    print(f"With IPEX: {ipex_time:.1f}ms for 100 iterations")
    
    speedup = baseline_time / ipex_time
    print(f"\n✅ IPEX Speedup: {speedup:.2f}x")
    
    return {
        "baseline_ms": baseline_time,
        "ipex_ms": ipex_time,
        "speedup": speedup
    }

def save_results(results):
    """Save test results to file."""
    output_file = "baselines/intel-optimization-test.json"
    os.makedirs("baselines", exist_ok=True)
    
    with open(output_file, "w") as f:
        json.dump(results, f, indent=2)
    
    print(f"\n✅ Results saved to {output_file}")

def main():
    """Run all Intel optimization tests."""
    print("=" * 60)
    print("Intel Optimization Test Suite")
    print("=" * 60)
    
    results = {
        "timestamp": datetime.now().isoformat(),
        "system": {
            "cpu_physical": psutil.cpu_count(logical=False),
            "cpu_logical": psutil.cpu_count(logical=True),
            "memory_gb": psutil.virtual_memory().total / (1024**3),
            "torch_version": torch.__version__,
            "ipex_version": ipex.__version__
        },
        "tests": {}
    }
    
    # Run tests
    results["tests"]["ipex_available"] = test_ipex_availability()
    results["tests"]["optimal_threads"] = test_thread_configuration()
    results["tests"]["memory_optimization"] = test_memory_optimization()
    results["tests"]["benchmark"] = benchmark_basic_operations()
    
    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    print(f"IPEX Available: {'✅' if results['tests']['ipex_available'] else '❌'}")
    print(f"Optimal Threads: {results['tests']['optimal_threads']}")
    if "benchmark" in results["tests"] and results["tests"]["benchmark"]:
        print(f"IPEX Speedup: {results['tests']['benchmark']['speedup']:.2f}x")
    
    # Save results
    save_results(results)
    
    print("\n✅ All tests complete!")

if __name__ == "__main__":
    main()