#!/usr/bin/env python3
"""
Profile SmolVLM-500M to identify bottlenecks and optimization opportunities.
"""

import os
import sys
import time
import torch
import intel_extension_for_pytorch as ipex
from PIL import Image
from transformers import AutoProcessor, AutoModelForImageTextToText
import psutil
import cProfile
import pstats
from io import StringIO
import threading

def profile_model_components():
    """Profile different components of the model to find bottlenecks."""
    
    print("=" * 60)
    print("SmolVLM-500M Bottleneck Analysis")
    print("=" * 60)
    
    model_path = "/home/profusionai/CardMint/models/smolvlm"
    test_image = "/home/profusionai/CardMint/test-images/test-card.jpg"
    
    # Load model components
    print("\n1. MODEL LOADING ANALYSIS")
    print("-" * 40)
    
    # Processor loading
    t0 = time.time()
    processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
    print(f"Processor load time: {time.time()-t0:.2f}s")
    
    # Model loading with different strategies
    print("\nTesting load strategies:")
    
    # Strategy 1: Standard loading
    t0 = time.time()
    model = AutoModelForImageTextToText.from_pretrained(
        model_path,
        torch_dtype=torch.float32,
        low_cpu_mem_usage=True,
        local_files_only=True
    )
    model.eval()
    standard_load = time.time()-t0
    print(f"  Standard load: {standard_load:.2f}s")
    del model
    torch.cuda.empty_cache()
    
    # Strategy 2: With torch.jit.script attempt
    t0 = time.time()
    model = AutoModelForImageTextToText.from_pretrained(
        model_path,
        torch_dtype=torch.float32,
        low_cpu_mem_usage=True,
        local_files_only=True
    )
    model.eval()
    # Try to script model (may fail for complex models)
    try:
        with torch.no_grad():
            model = torch.jit.script(model)
        print(f"  JIT script load: {time.time()-t0:.2f}s ✓")
    except:
        print(f"  JIT script load: Failed (model too complex)")
    
    print("\n2. INFERENCE COMPONENT BREAKDOWN")
    print("-" * 40)
    
    # Load image
    image = Image.open(test_image).convert("RGB")
    
    # Prepare input
    messages = [{"role": "user", "content": [
        {"type": "image"},
        {"type": "text", "text": "What Pokemon card?"}
    ]}]
    
    prompt = processor.apply_chat_template(messages, add_generation_prompt=True)
    
    # Time each component
    components = {}
    
    # Image preprocessing
    t0 = time.time()
    inputs = processor(text=prompt, images=[image], return_tensors="pt")
    components['preprocessing'] = time.time()-t0
    
    # Vision encoding (first forward pass)
    t0 = time.time()
    with torch.no_grad():
        # Simulate vision encoding by running a partial forward
        output = model.generate(**inputs, max_new_tokens=1, do_sample=False)
    components['first_token'] = time.time()-t0
    
    # Full generation
    t0 = time.time()
    with torch.no_grad():
        output = model.generate(**inputs, max_new_tokens=50, do_sample=False)
    components['full_generation'] = time.time()-t0
    
    # Decoding
    t0 = time.time()
    result = processor.batch_decode(output, skip_special_tokens=True)
    components['decoding'] = time.time()-t0
    
    print("Component timings:")
    for name, timing in components.items():
        print(f"  {name}: {timing:.3f}s")
    
    print("\n3. OPTIMIZATION OPPORTUNITIES")
    print("-" * 40)
    
    # Test different thread counts
    print("\nThread optimization:")
    best_threads = 4
    best_time = float('inf')
    
    for num_threads in [1, 2, 4, 8]:
        torch.set_num_threads(num_threads)
        
        t0 = time.time()
        with torch.no_grad():
            _ = model.generate(**inputs, max_new_tokens=20, do_sample=False)
        elapsed = time.time()-t0
        
        print(f"  {num_threads} threads: {elapsed:.3f}s")
        if elapsed < best_time:
            best_time = elapsed
            best_threads = num_threads
    
    print(f"  Best: {best_threads} threads")
    
    # Memory analysis
    print("\nMemory usage:")
    process = psutil.Process()
    mem_info = process.memory_info()
    print(f"  RSS: {mem_info.rss / (1024**3):.2f} GB")
    print(f"  VMS: {mem_info.vms / (1024**3):.2f} GB")
    
    # CPU utilization
    print("\nCPU utilization during inference:")
    cpu_samples = []
    
    def monitor_cpu():
        while monitoring:
            cpu_samples.append(psutil.cpu_percent(interval=0.1))
    
    monitoring = True
    monitor_thread = threading.Thread(target=monitor_cpu)
    monitor_thread.start()
    
    with torch.no_grad():
        _ = model.generate(**inputs, max_new_tokens=30, do_sample=False)
    
    monitoring = False
    monitor_thread.join()
    
    if cpu_samples:
        avg_cpu = sum(cpu_samples) / len(cpu_samples)
        max_cpu = max(cpu_samples)
        print(f"  Average: {avg_cpu:.1f}%")
        print(f"  Peak: {max_cpu:.1f}%")
    
    print("\n4. SYSTEM-LEVEL OPTIMIZATIONS")
    print("-" * 40)
    
    optimizations = {
        "Model Caching": "Keep model in memory between requests",
        "Batch Processing": "Process multiple cards simultaneously",
        "KV Cache": "Reuse key-value pairs for similar prompts",
        "Flash Attention": "Use optimized attention implementation",
        "Operator Fusion": "Fuse operations with IPEX/ONNX",
        "Memory Mapping": "Use mmap for model weights",
        "CPU Affinity": "Pin process to specific CPU cores",
        "NUMA Optimization": "Optimize for NUMA architecture",
        "Prompt Caching": "Cache common prompt prefixes",
        "Response Caching": "Cache results for identical cards"
    }
    
    print("Recommended optimizations:")
    for opt, desc in optimizations.items():
        print(f"  • {opt}: {desc}")
    
    print("\n5. OPERATIONAL STRATEGIES")
    print("-" * 40)
    
    strategies = {
        "Hot Model Service": "Keep model loaded in background service",
        "Request Batching": "Batch multiple requests together",
        "Async Processing": "Non-blocking inference pipeline",
        "Result Caching": "Cache recent card recognitions",
        "Progressive Enhancement": "Quick preview, then detailed",
        "Hybrid Pipeline": "Use 256M for speed, 500M for accuracy",
        "Edge Caching": "Cache at network edge",
        "Predictive Loading": "Pre-process likely next cards",
        "Parallel Inference": "Run multiple model instances",
        "Dynamic Routing": "Route to fastest available model"
    }
    
    print("Operational improvements:")
    for strategy, desc in strategies.items():
        print(f"  • {strategy}: {desc}")
    
    return components

if __name__ == "__main__":
    try:
        components = profile_model_components()
        
        print("\n" + "=" * 60)
        print("BOTTLENECK SUMMARY")
        print("=" * 60)
        
        total_time = components.get('full_generation', 10)
        
        print(f"\nCurrent performance: {total_time:.1f}s")
        print(f"Target performance: <3s")
        print(f"Required speedup: {total_time/3:.1f}x")
        
        print("\nTop optimization priorities:")
        print("1. Use ONNX Runtime with INT8 models (2-3x speedup)")
        print("2. Implement model caching service (eliminate load time)")
        print("3. Batch processing for multiple cards (amortize cost)")
        print("4. Consider SmolVLM-256M for real-time (<1s possible)")
        print("5. Implement response caching for common cards")
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()