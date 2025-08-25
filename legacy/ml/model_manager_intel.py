#!/usr/bin/env python3
"""
⚠️  QUARANTINED CODE - DO NOT IMPORT FROM src/
This file has been moved to legacy/ during architecture cleanup.
Import from this file will cause CI to fail.

ORIGINAL: Intel-optimized Model Manager for VLM Pipeline
Implements IPEX optimizations and hot model loading for Intel i5 10th Gen

QUARANTINED: August 25, 2025
REASON: Experimental optimization code that needs proper ports/adapters pattern
REPLACEMENT: Will be reimplemented through InferencePort interface
DROP BY: September 15, 2025
"""

# Prevent accidental imports
__DO_NOT_USE__ = True

import os
import sys
import torch
import intel_extension_for_pytorch as ipex
from typing import Dict, Any, Optional, Tuple
import logging
from pathlib import Path
import psutil
import cpuinfo
from transformers import AutoModelForVision2Seq, AutoProcessor
import time
import gc

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class IntelModelManager:
    """
    Manages ML models with Intel-specific optimizations.
    Keeps models HOT in memory to avoid 6-7s loading delays.
    """
    
    def __init__(self, 
                 enable_ipex: bool = True,
                 num_threads: int = 4,  # Intel i5 10th Gen has 4 physical cores
                 memory_limit_gb: float = 5.0):
        """
        Initialize Intel-optimized model manager.
        
        Args:
            enable_ipex: Enable Intel Extension for PyTorch optimizations
            num_threads: Number of threads for inference (avoid hyperthreading)
            memory_limit_gb: Maximum memory usage in GB
        """
        self.enable_ipex = enable_ipex
        self.num_threads = num_threads
        self.memory_limit_gb = memory_limit_gb
        self.models: Dict[str, Any] = {}
        self.processors: Dict[str, Any] = {}
        
        # Configure Intel optimizations
        self._configure_intel_optimizations()
        
        # Log system info
        self._log_system_info()
        
    def _configure_intel_optimizations(self):
        """Configure Intel-specific optimizations."""
        # Set thread count for optimal performance on physical cores
        torch.set_num_threads(self.num_threads)
        
        # Enable Intel MKL-DNN optimizations
        if self.enable_ipex:
            logger.info(f"IPEX enabled with {self.num_threads} threads")
            
        # Set memory allocator settings for Intel
        os.environ['MALLOC_CONF'] = 'oversize_threshold:1,background_thread:true,metadata_thp:auto'
        
        # Disable debug mode for performance
        torch.autograd.set_grad_enabled(False)
        
        logger.info("Intel optimizations configured")
        
    def _log_system_info(self):
        """Log system information for debugging."""
        cpu_info = cpuinfo.get_cpu_info()
        logger.info(f"CPU: {cpu_info.get('brand_raw', 'Unknown')}")
        logger.info(f"CPU Cores: {psutil.cpu_count(logical=False)} physical, {psutil.cpu_count()} logical")
        logger.info(f"Memory: {psutil.virtual_memory().total / (1024**3):.1f} GB total")
        logger.info(f"PyTorch: {torch.__version__}")
        logger.info(f"IPEX: {ipex.__version__ if self.enable_ipex else 'Disabled'}")
        
    def load_vlm_model(self, 
                       model_name: str = "HuggingFaceTB/SmolVLM-500M-Instruct",
                       optimize: bool = True) -> Tuple[Any, Any]:
        """
        Load VLM model with Intel optimizations.
        Keeps model HOT in memory to avoid loading delays.
        
        Args:
            model_name: HuggingFace model identifier
            optimize: Apply IPEX optimizations
            
        Returns:
            Tuple of (model, processor)
        """
        # Check if model already loaded (hot loading)
        if model_name in self.models:
            logger.info(f"Model {model_name} already HOT in memory")
            return self.models[model_name], self.processors[model_name]
            
        # Check memory before loading
        if not self._check_memory_available(1.0):  # VLM needs ~1GB
            logger.warning("Insufficient memory for VLM model")
            self._evict_oldest_model()
            
        logger.info(f"Loading VLM model: {model_name}")
        start_time = time.time()
        
        try:
            # Load processor
            processor = AutoProcessor.from_pretrained(model_name)
            
            # Load model with FP32 for Intel CPU
            model = AutoModelForVision2Seq.from_pretrained(
                model_name,
                torch_dtype=torch.float32,  # FP32 for Intel CPU
                low_cpu_mem_usage=True
            )
            
            # Set to evaluation mode
            model.eval()
            
            # Apply IPEX optimizations
            if optimize and self.enable_ipex:
                logger.info("Applying IPEX optimizations...")
                model = ipex.optimize(
                    model,
                    dtype=torch.float32,
                    level="O1",  # O1 optimization level
                    auto_kernel_selection=True
                )
                
            # Compile with torch.compile for additional speedup
            if hasattr(torch, 'compile'):
                logger.info("Compiling model with torch.compile...")
                model = torch.compile(model, backend="ipex" if self.enable_ipex else "inductor")
                
            # Store in cache
            self.models[model_name] = model
            self.processors[model_name] = processor
            
            load_time = time.time() - start_time
            logger.info(f"Model loaded in {load_time:.2f}s")
            
            # Warm up the model
            self._warmup_model(model, processor)
            
            return model, processor
            
        except Exception as e:
            logger.error(f"Failed to load VLM model: {e}")
            raise
            
    def load_ocr_model(self, 
                      model_type: str = "mobile",
                      optimize: bool = True) -> Any:
        """
        Load OCR model (placeholder for PaddleOCR integration).
        
        Args:
            model_type: "mobile" for PP-OCRv4 mobile or "server" for full
            optimize: Apply optimizations
            
        Returns:
            OCR model instance
        """
        model_key = f"ocr_{model_type}"
        
        if model_key in self.models:
            logger.info(f"OCR model ({model_type}) already HOT in memory")
            return self.models[model_key]
            
        logger.info(f"Loading OCR model: {model_type}")
        
        # Placeholder for actual OCR model loading
        # In production, this would load PP-OCRv4 mobile models
        ocr_model = {"type": model_type, "ready": True}
        
        self.models[model_key] = ocr_model
        return ocr_model
        
    def _warmup_model(self, model: Any, processor: Any):
        """
        Warm up model with dummy input to ensure JIT compilation.
        
        Args:
            model: The model to warm up
            processor: The processor for the model
        """
        logger.info("Warming up model...")
        try:
            # Create dummy image (small for warmup)
            import numpy as np
            from PIL import Image
            
            dummy_image = Image.fromarray(np.zeros((224, 224, 3), dtype=np.uint8))
            dummy_text = "What is in this image?"
            
            # Process dummy input
            with torch.no_grad():
                inputs = processor(dummy_text, dummy_image, return_tensors="pt")
                # Just run forward pass, ignore output
                _ = model.generate(**inputs, max_new_tokens=10)
                
            logger.info("Model warmup complete")
        except Exception as e:
            logger.warning(f"Warmup failed (non-critical): {e}")
            
    def _check_memory_available(self, required_gb: float) -> bool:
        """
        Check if enough memory is available.
        
        Args:
            required_gb: Required memory in GB
            
        Returns:
            True if memory available
        """
        mem = psutil.virtual_memory()
        available_gb = mem.available / (1024**3)
        used_gb = (mem.total - mem.available) / (1024**3)
        
        # Check against limit
        if used_gb + required_gb > self.memory_limit_gb:
            logger.warning(f"Memory limit would be exceeded: {used_gb:.1f} + {required_gb:.1f} > {self.memory_limit_gb:.1f} GB")
            return False
            
        return available_gb >= required_gb
        
    def _evict_oldest_model(self):
        """Evict the least recently used model to free memory."""
        if not self.models:
            return
            
        # For now, evict first model (implement LRU later)
        model_name = list(self.models.keys())[0]
        logger.info(f"Evicting model: {model_name}")
        
        del self.models[model_name]
        if model_name in self.processors:
            del self.processors[model_name]
            
        # Force garbage collection
        gc.collect()
        torch.cuda.empty_cache() if torch.cuda.is_available() else None
        
    def inference_vlm(self, 
                     image_path: str, 
                     prompt: str = "What Pokemon card is this? Just give the name.",
                     max_new_tokens: int = 50) -> Dict[str, Any]:
        """
        Run VLM inference on an image.
        
        Args:
            image_path: Path to the image
            prompt: Text prompt for the model
            max_new_tokens: Maximum tokens to generate
            
        Returns:
            Dict with inference results and timing
        """
        from PIL import Image
        
        # Ensure model is loaded
        model, processor = self.load_vlm_model()
        
        start_time = time.time()
        
        try:
            # Load and preprocess image
            image = Image.open(image_path).convert("RGB")
            
            # Prepare inputs
            inputs = processor(prompt, image, return_tensors="pt")
            
            # Run inference
            with torch.no_grad():
                outputs = model.generate(
                    **inputs,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,  # Deterministic for consistency
                    temperature=1.0
                )
                
            # Decode output
            generated_text = processor.decode(outputs[0], skip_special_tokens=True)
            
            # Extract just the answer (remove the prompt)
            answer = generated_text.replace(prompt, "").strip()
            
            inference_time = time.time() - start_time
            
            return {
                "success": True,
                "card_name": answer,
                "inference_time_ms": inference_time * 1000,
                "prompt": prompt,
                "full_response": generated_text
            }
            
        except Exception as e:
            logger.error(f"VLM inference failed: {e}")
            return {
                "success": False,
                "error": str(e),
                "inference_time_ms": (time.time() - start_time) * 1000
            }
            
    def get_memory_usage(self) -> Dict[str, float]:
        """Get current memory usage statistics."""
        mem = psutil.virtual_memory()
        process = psutil.Process()
        
        return {
            "system_total_gb": mem.total / (1024**3),
            "system_used_gb": (mem.total - mem.available) / (1024**3),
            "system_available_gb": mem.available / (1024**3),
            "process_rss_gb": process.memory_info().rss / (1024**3),
            "models_loaded": len(self.models)
        }
        
    def cleanup(self):
        """Clean up resources and free memory."""
        logger.info("Cleaning up model manager...")
        
        # Clear all models
        self.models.clear()
        self.processors.clear()
        
        # Force garbage collection
        gc.collect()
        
        logger.info("Cleanup complete")


# Example usage and testing
if __name__ == "__main__":
    # Initialize manager
    manager = IntelModelManager(
        enable_ipex=True,
        num_threads=4,  # Physical cores only
        memory_limit_gb=5.0
    )
    
    # Test VLM loading
    print("\n=== Testing VLM Model Loading ===")
    model, processor = manager.load_vlm_model()
    print(f"Model loaded: {model is not None}")
    print(f"Processor loaded: {processor is not None}")
    
    # Check memory usage
    print("\n=== Memory Usage ===")
    mem_stats = manager.get_memory_usage()
    for key, value in mem_stats.items():
        print(f"{key}: {value:.2f}")
    
    # Test inference if image exists
    test_image = "/home/profusionai/CardMint/test-images/test-card.jpg"
    if os.path.exists(test_image):
        print(f"\n=== Testing VLM Inference on {test_image} ===")
        result = manager.inference_vlm(test_image)
        if result["success"]:
            print(f"Card detected: {result['card_name']}")
            print(f"Inference time: {result['inference_time_ms']:.1f}ms")
        else:
            print(f"Inference failed: {result['error']}")
    
    # Cleanup
    manager.cleanup()
    print("\n=== Manager cleaned up ===")