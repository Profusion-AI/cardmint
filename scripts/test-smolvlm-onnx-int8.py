#!/usr/bin/env python3
"""
Test SmolVLM using pre-quantized INT8 ONNX models for optimal performance.
These models are already optimized by HuggingFace for edge deployment.
"""

import os
import sys
import time
import numpy as np
from PIL import Image
import onnxruntime as ort
import json
from transformers import AutoProcessor
import psutil

def test_onnx_int8():
    """Test INT8 ONNX models for fast inference."""
    
    print("=" * 60)
    print("SmolVLM INT8 ONNX Test")
    print("=" * 60)
    
    model_dir = "/home/profusionai/CardMint/models/smolvlm"
    onnx_dir = os.path.join(model_dir, "onnx")
    test_image = "/home/profusionai/CardMint/test-images/test-card.jpg"
    
    # System info
    print(f"\nSystem Information:")
    print(f"CPU: {psutil.cpu_count(logical=False)} physical cores")
    print(f"Memory: {psutil.virtual_memory().total / (1024**3):.1f} GB")
    
    # Check available ONNX models
    print(f"\nAvailable INT8 ONNX models:")
    int8_models = []
    for f in os.listdir(onnx_dir):
        if 'int8' in f or 'uint8' in f:
            size_mb = os.path.getsize(os.path.join(onnx_dir, f)) / (1024*1024)
            print(f"  {f}: {size_mb:.1f} MB")
            int8_models.append(f)
    
    # Load processor for preprocessing
    print(f"\nLoading processor...")
    processor = AutoProcessor.from_pretrained(
        model_dir,
        local_files_only=True
    )
    print("✓ Processor loaded")
    
    # Load and preprocess image
    print(f"\nProcessing test image...")
    image = Image.open(test_image).convert("RGB")
    
    # Create simple prompt
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": "What Pokemon card is this?"}
            ]
        }
    ]
    
    prompt = processor.apply_chat_template(messages, add_generation_prompt=True)
    inputs = processor(text=prompt, images=[image], return_tensors="np")
    
    print(f"✓ Image preprocessed")
    print(f"  Input shapes: {[(k, v.shape) for k, v in inputs.items() if isinstance(v, np.ndarray)][:3]}")
    
    # Test ONNX Runtime providers
    print(f"\nONNX Runtime providers:")
    providers = ort.get_available_providers()
    for p in providers:
        print(f"  - {p}")
    
    # Use CPU provider with optimization
    provider_options = [{
        'arena_extend_strategy': 'kSameAsRequested',
        'inter_op_num_threads': 4,
        'intra_op_num_threads': 4,
    }]
    
    # Try to load INT8 decoder model
    decoder_path = os.path.join(onnx_dir, "decoder_model_merged_int8.onnx")
    
    if os.path.exists(decoder_path):
        print(f"\nLoading INT8 decoder model...")
        print(f"  Path: {decoder_path}")
        print(f"  Size: {os.path.getsize(decoder_path) / (1024*1024):.1f} MB")
        
        try:
            # Create ONNX session with optimizations
            sess_options = ort.SessionOptions()
            sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            sess_options.intra_op_num_threads = 4
            sess_options.inter_op_num_threads = 4
            sess_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            
            # Load model
            session = ort.InferenceSession(
                decoder_path,
                sess_options=sess_options,
                providers=['CPUExecutionProvider']
            )
            
            print("✓ INT8 model loaded successfully")
            
            # Get model info
            print(f"\nModel information:")
            print(f"  Inputs: {[i.name for i in session.get_inputs()][:3]}...")
            print(f"  Outputs: {[o.name for o in session.get_outputs()][:3]}...")
            
            # Memory usage
            process = psutil.Process()
            mem_usage = process.memory_info().rss / (1024**3)
            print(f"  Memory usage: {mem_usage:.2f} GB")
            
            # Note about full implementation
            print("\n⚠️  Note: Full ONNX inference requires:")
            print("  1. Vision encoder (vision_encoder_int8.onnx)")
            print("  2. Embedding layer (embed_tokens_int8.onnx)")
            print("  3. Decoder (decoder_model_merged_int8.onnx)")
            print("  4. Proper tokenization and generation loop")
            print("\n  The INT8 models are ready but need integration.")
            print("  Expected performance: 2-3x faster than FP32")
            
        except Exception as e:
            print(f"❌ Error loading ONNX model: {e}")
            
    else:
        print(f"❌ INT8 decoder model not found at {decoder_path}")
    
    # Performance estimate
    print("\n" + "=" * 40)
    print("Performance Estimate")
    print("=" * 40)
    print("Based on model sizes and INT8 quantization:")
    print("  FP32 model: 969 MB → ~10-15s inference")
    print("  INT8 model: 349 MB → ~3-5s inference (3x speedup)")
    print("  With ONNX optimizations: ~2-3s possible")
    print("\nRecommendation: Use ONNX Runtime with INT8 models")
    print("or implement dynamic quantization with IPEX")

if __name__ == "__main__":
    # Check if onnxruntime is installed
    try:
        import onnxruntime
        test_onnx_int8()
    except ImportError:
        print("❌ ONNX Runtime not installed")
        print("To use INT8 ONNX models, install:")
        print("  pip install onnxruntime")
        print("\nAlternatively, we can use dynamic quantization with IPEX")
        print("on the PyTorch model for similar performance gains.")