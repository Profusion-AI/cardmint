#!/usr/bin/env python3
"""
Test SmolVLM with dynamic INT8 quantization using IPEX.
This applies quantization at runtime for faster inference.
"""

import os
import sys
import time
import torch
import intel_extension_for_pytorch as ipex
from PIL import Image
from transformers import AutoProcessor, AutoModelForImageTextToText
import psutil
import gc

# Add parent directory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
from ml.quantization_service import QuantizationService, QuantizationConfig, QuantizationType

def test_dynamic_quantization():
    """Test SmolVLM with dynamic INT8 quantization."""
    
    print("=" * 60)
    print("SmolVLM Dynamic INT8 Quantization Test")
    print("=" * 60)
    
    model_path = "/home/profusionai/CardMint/models/smolvlm"
    test_image = "/home/profusionai/CardMint/test-images/test-card.jpg"
    
    # System info
    print(f"\nSystem Information:")
    print(f"CPU: {psutil.cpu_count(logical=False)} physical cores")
    print(f"Memory: {psutil.virtual_memory().total / (1024**3):.1f} GB")
    
    # Load model
    print(f"\nLoading SmolVLM-500M...")
    load_start = time.time()
    
    processor = AutoProcessor.from_pretrained(
        model_path,
        local_files_only=True
    )
    
    model = AutoModelForImageTextToText.from_pretrained(
        model_path,
        torch_dtype=torch.float32,
        low_cpu_mem_usage=True,
        local_files_only=True
    )
    
    model.eval()
    load_time = time.time() - load_start
    print(f"✓ Model loaded in {load_time:.2f}s")
    
    # Get original model size
    def get_model_size_mb(model):
        param_size = sum(p.nelement() * p.element_size() for p in model.parameters())
        buffer_size = sum(b.nelement() * b.element_size() for b in model.buffers())
        return (param_size + buffer_size) / (1024 * 1024)
    
    original_size = get_model_size_mb(model)
    print(f"✓ Original model size: {original_size:.1f} MB")
    
    # Apply dynamic quantization
    print("\nApplying dynamic INT8 quantization...")
    quant_start = time.time()
    
    # Method 1: PyTorch native dynamic quantization
    quantized_model = torch.quantization.quantize_dynamic(
        model,
        qconfig_spec={
            torch.nn.Linear: torch.quantization.default_dynamic_qconfig,
            torch.nn.Conv2d: torch.quantization.default_dynamic_qconfig,
        },
        dtype=torch.qint8
    )
    
    quant_time = time.time() - quant_start
    quantized_size = get_model_size_mb(quantized_model)
    
    print(f"✓ Quantization complete in {quant_time:.2f}s")
    print(f"✓ Quantized model size: {quantized_size:.1f} MB")
    print(f"✓ Compression ratio: {original_size/quantized_size:.2f}x")
    
    # Apply IPEX optimizations
    print("\nApplying IPEX optimizations...")
    torch.set_num_threads(4)
    
    # IPEX optimization on quantized model
    quantized_model = ipex.optimize(
        quantized_model, 
        dtype=torch.float32,
        level="O1",
        auto_kernel_selection=True
    )
    print("✓ IPEX optimizations applied")
    
    # Memory usage
    process = psutil.Process()
    mem_before = process.memory_info().rss / (1024**3)
    print(f"✓ Memory usage: {mem_before:.2f} GB")
    
    # Load test image
    print(f"\nLoading test image...")
    image = Image.open(test_image).convert("RGB")
    
    # Prepare input
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": "Identify this Pokemon card. Name: [name], Number: [number]"}
            ]
        }
    ]
    
    prompt = processor.apply_chat_template(messages, add_generation_prompt=True)
    inputs = processor(text=prompt, images=[image], return_tensors="pt")
    
    # Warmup
    print("\nWarming up model...")
    with torch.no_grad():
        for _ in range(2):
            _ = quantized_model.generate(
                **inputs,
                max_new_tokens=10,
                do_sample=False
            )
    print("✓ Warmup complete")
    
    # Benchmark inference
    print("\nBenchmarking inference (5 runs)...")
    times = []
    results = []
    
    for i in range(5):
        # Clear cache
        gc.collect()
        torch.cuda.empty_cache() if torch.cuda.is_available() else None
        
        start = time.time()
        with torch.no_grad():
            generated_ids = quantized_model.generate(
                **inputs,
                max_new_tokens=50,
                do_sample=False,
                num_beams=1,  # Greedy decoding for speed
                early_stopping=True
            )
        inference_time = time.time() - start
        times.append(inference_time)
        
        # Decode
        result = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
        response = result.split("Assistant:")[-1].strip() if "Assistant:" in result else result
        results.append(response)
        
        print(f"  Run {i+1}: {inference_time:.2f}s - {response[:50]}...")
    
    # Statistics
    avg_time = sum(times) / len(times)
    min_time = min(times)
    max_time = max(times)
    
    print(f"\n✓ Average inference: {avg_time:.2f}s")
    print(f"✓ Min/Max: {min_time:.2f}s / {max_time:.2f}s")
    
    # Memory after
    mem_after = process.memory_info().rss / (1024**3)
    print(f"✓ Memory after: {mem_after:.2f} GB (Δ {mem_after-mem_before:.2f} GB)")
    
    # Performance comparison
    print("\n" + "=" * 40)
    print("Performance Summary")
    print("=" * 40)
    print(f"Quantization method: Dynamic INT8")
    print(f"Model compression: {original_size/quantized_size:.2f}x")
    print(f"Average inference: {avg_time:.2f}s")
    print(f"Target (<3s): {'✓ ACHIEVED' if avg_time < 3 else f'✗ ({avg_time:.2f}s)'}")
    
    # OCR comparison
    ocr_baseline = 8.8
    speedup = ocr_baseline / avg_time
    print(f"\nVs OCR baseline (8.8s):")
    print(f"  Speedup: {speedup:.2f}x")
    print(f"  Time saved: {ocr_baseline - avg_time:.1f}s per card")
    print(f"  Throughput: {60/avg_time:.1f} cards/min (vs {60/ocr_baseline:.1f} OCR)")
    
    # Final result
    print(f"\nBest result: {results[times.index(min_time)]}")
    
    return avg_time

if __name__ == "__main__":
    try:
        avg_time = test_dynamic_quantization()
        
        if avg_time < 3.0:
            print("\n" + "🎉" * 20)
            print("SUCCESS! Sub-3s target achieved with INT8!")
            print("🎉" * 20)
        elif avg_time < 5.0:
            print("\n⚡ Good performance! Consider:")
            print("  - Use ONNX Runtime for further optimization")
            print("  - Implement caching for repeated queries")
            print("  - Batch processing for multiple cards")
        else:
            print("\n⚠️  Further optimization needed:")
            print("  - Try 4-bit quantization")
            print("  - Use smaller SmolVLM-256M model")
            print("  - Implement hybrid CPU+GPU execution")
            
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()