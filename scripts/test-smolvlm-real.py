#!/usr/bin/env python3
"""
Test SmolVLM-500M with real model weights on Pokemon card images.
Measures performance and accuracy with Intel optimizations.
"""

import os
import sys
import time
import torch
import intel_extension_for_pytorch as ipex
from PIL import Image
from transformers import AutoProcessor, AutoModelForImageTextToText
import psutil

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

def test_smolvlm():
    """Test SmolVLM with downloaded weights."""
    
    print("=" * 60)
    print("SmolVLM-500M Real Model Test")
    print("=" * 60)
    
    # Model path
    model_path = "/home/profusionai/CardMint/models/smolvlm"
    test_image_path = "/home/profusionai/CardMint/test-images/test-card.jpg"
    
    # System info
    print(f"\nSystem Information:")
    print(f"CPU: {psutil.cpu_count(logical=False)} physical cores")
    print(f"Memory: {psutil.virtual_memory().total / (1024**3):.1f} GB")
    print(f"PyTorch: {torch.__version__}")
    print(f"IPEX: {ipex.__version__}")
    
    # Load model
    print(f"\nLoading SmolVLM-500M from {model_path}...")
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
    
    # Move to CPU and eval mode
    model = model.to("cpu")
    model.eval()
    
    load_time = time.time() - load_start
    print(f"✓ Model loaded in {load_time:.2f}s")
    
    # Apply IPEX optimizations
    print("\nApplying Intel optimizations...")
    torch.set_num_threads(4)  # Use 4 physical cores
    
    # IPEX optimization
    model = ipex.optimize(model, dtype=torch.float32, level="O1")
    print("✓ IPEX optimizations applied")
    
    # Memory usage
    process = psutil.Process()
    mem_before = process.memory_info().rss / (1024**3)
    print(f"✓ Memory usage: {mem_before:.2f} GB")
    
    # Load test image
    print(f"\nLoading test image: {test_image_path}")
    image = Image.open(test_image_path).convert("RGB")
    print(f"✓ Image size: {image.size}")
    
    # Test 1: Basic card recognition
    print("\n" + "=" * 40)
    print("Test 1: Basic Card Recognition")
    print("=" * 40)
    
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": "What Pokemon card is this? Provide the name, set, and number."}
            ]
        }
    ]
    
    # Process prompt
    prompt = processor.apply_chat_template(messages, add_generation_prompt=True)
    inputs = processor(text=prompt, images=[image], return_tensors="pt")
    
    # Warmup
    print("\nWarming up model...")
    with torch.no_grad():
        for _ in range(3):
            _ = model.generate(
                **inputs,
                max_new_tokens=10,
                do_sample=False
            )
    print("✓ Warmup complete")
    
    # Measure inference time
    print("\nRunning inference (5 iterations)...")
    times = []
    results = []
    
    for i in range(5):
        torch.cuda.synchronize() if torch.cuda.is_available() else None
        
        start = time.time()
        with torch.no_grad():
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=50,
                do_sample=False,
                temperature=1.0
            )
        
        torch.cuda.synchronize() if torch.cuda.is_available() else None
        inference_time = time.time() - start
        times.append(inference_time)
        
        # Decode result
        generated_text = processor.batch_decode(
            generated_ids,
            skip_special_tokens=True
        )[0]
        
        # Extract card info from response
        response = generated_text.split("Assistant:")[-1].strip() if "Assistant:" in generated_text else generated_text
        results.append(response)
        
        print(f"  Run {i+1}: {inference_time:.3f}s - {response[:50]}...")
    
    # Statistics
    avg_time = sum(times) / len(times)
    min_time = min(times)
    max_time = max(times)
    
    print(f"\n✓ Average inference time: {avg_time:.3f}s")
    print(f"✓ Min/Max: {min_time:.3f}s / {max_time:.3f}s")
    
    # Test 2: Detailed extraction
    print("\n" + "=" * 40)
    print("Test 2: Detailed Card Information")
    print("=" * 40)
    
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": "Extract: 1) Card name 2) HP 3) Card number 4) Rarity. Format: Name: [name], HP: [hp], Number: [number], Rarity: [rarity]"}
            ]
        }
    ]
    
    prompt = processor.apply_chat_template(messages, add_generation_prompt=True)
    inputs = processor(text=prompt, images=[image], return_tensors="pt")
    
    start = time.time()
    with torch.no_grad():
        generated_ids = model.generate(
            **inputs,
            max_new_tokens=100,
            do_sample=False
        )
    detailed_time = time.time() - start
    
    detailed_result = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
    response = detailed_result.split("Assistant:")[-1].strip() if "Assistant:" in detailed_result else detailed_result
    
    print(f"Response: {response}")
    print(f"✓ Inference time: {detailed_time:.3f}s")
    
    # Memory after inference
    mem_after = process.memory_info().rss / (1024**3)
    print(f"\n✓ Memory after inference: {mem_after:.2f} GB")
    print(f"✓ Memory increase: {mem_after - mem_before:.2f} GB")
    
    # Performance comparison
    print("\n" + "=" * 40)
    print("Performance Summary")
    print("=" * 40)
    print(f"Model size: 507.5M parameters")
    print(f"Load time: {load_time:.2f}s")
    print(f"Avg inference: {avg_time:.3f}s")
    print(f"Memory usage: {mem_after:.2f} GB")
    print(f"Target: <3s inference ✓" if avg_time < 3 else f"Target: <3s inference ✗ (current: {avg_time:.3f}s)")
    
    # Compare with OCR baseline
    ocr_baseline = 8.8  # seconds from our testing
    speedup = ocr_baseline / avg_time
    print(f"\nVs OCR baseline (8.8s):")
    print(f"  Speedup: {speedup:.2f}x")
    print(f"  Time saved: {ocr_baseline - avg_time:.1f}s per card")
    print(f"  Cards/minute: {60/avg_time:.1f} (vs {60/ocr_baseline:.1f} OCR)")
    
    return avg_time, results

if __name__ == "__main__":
    try:
        avg_time, results = test_smolvlm()
        
        # Check if we met the target
        if avg_time < 3.0:
            print("\n" + "🎉" * 20)
            print("SUCCESS! Sub-3s inference achieved!")
            print("🎉" * 20)
        else:
            print("\n⚠️  Performance target not met. Consider:")
            print("  - Enable INT8 quantization")
            print("  - Use ONNX Runtime with INT8 models")
            print("  - Further optimize with torch.compile()")
            
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()