#!/usr/bin/env python3
"""
Test trained SmolVLM model basic functionality
Quick smoke test to verify model loads and performs inference
"""

import sys
import os
import time
import argparse
from pathlib import Path
from PIL import Image
import logging

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def test_model_loading(model_path):
    """Test if model loads without errors."""
    logger.info("Testing model loading...")
    
    try:
        from src.ml.smolvlm_optimized_service import OptimizedSmolVLMService
        
        start_time = time.time()
        service = OptimizedSmolVLMService(model_path=model_path)
        load_time = time.time() - start_time
        
        logger.info(f"✅ Model loaded successfully in {load_time:.2f}s")
        return service, load_time
        
    except Exception as e:
        logger.error(f"❌ Model loading failed: {e}")
        return None, None

def test_inference(service, image_path, expected_name=None):
    """Test basic inference functionality."""
    logger.info(f"Testing inference with image: {image_path}")
    
    if not os.path.exists(image_path):
        logger.error(f"❌ Test image not found: {image_path}")
        return None
        
    try:
        start_time = time.time()
        result = service.process_image(image_path)
        inference_time = time.time() - start_time
        
        logger.info(f"✅ Inference completed in {inference_time:.2f}s")
        logger.info(f"   Result: {result.get('card_name', 'Unknown')}")
        logger.info(f"   Confidence: {result.get('confidence', 0):.2f}")
        
        # Check expected result
        if expected_name:
            card_name = result.get('card_name', '').lower()
            expected = expected_name.lower()
            
            if expected in card_name or card_name in expected:
                logger.info(f"✅ Expected card name match: {expected_name}")
                accuracy = True
            else:
                logger.warning(f"⚠️  Expected '{expected_name}', got '{result.get('card_name')}'")
                accuracy = False
        else:
            accuracy = True
            
        return {
            'inference_time': inference_time,
            'result': result,
            'accuracy': accuracy
        }
        
    except Exception as e:
        logger.error(f"❌ Inference failed: {e}")
        return None

def run_smoke_test(model_path, test_image, expected_name):
    """Run complete smoke test."""
    logger.info("="*60)
    logger.info("SMOLVLM TRAINED MODEL SMOKE TEST")
    logger.info("="*60)
    
    # Test model loading
    service, load_time = test_model_loading(model_path)
    if not service:
        return False
        
    # Test inference
    result = test_inference(service, test_image, expected_name)
    if not result:
        service.close()
        return False
        
    # Get service stats
    stats = service.get_stats()
    
    # Print summary
    print("\n" + "="*60)
    print("SMOKE TEST SUMMARY")
    print("="*60)
    print(f"Model Path: {model_path}")
    print(f"Load Time: {load_time:.2f}s")
    print(f"Inference Time: {result['inference_time']:.2f}s")
    print(f"Memory Usage: {stats.get('cache_size', 0)} cached items")
    print(f"Accuracy: {'✅ PASS' if result['accuracy'] else '❌ FAIL'}")
    
    # Success criteria
    success = (
        load_time < 60 and  # Model loads in under 1 minute
        result['inference_time'] < 10 and  # Inference under 10 seconds
        result['accuracy']  # Correct identification
    )
    
    print(f"\nOverall Result: {'✅ PASS' if success else '❌ FAIL'}")
    
    service.close()
    return success

def main():
    parser = argparse.ArgumentParser(description="Test trained SmolVLM model")
    parser.add_argument("--model", default="/home/profusionai/CardMint/models/smolvlm", 
                       help="Path to trained model")
    parser.add_argument("--image", required=True, help="Test image path")
    parser.add_argument("--expected", help="Expected card name")
    
    args = parser.parse_args()
    
    success = run_smoke_test(args.model, args.image, args.expected)
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()