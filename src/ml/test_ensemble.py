#!/usr/bin/env python3
"""
Test the CardMint ensemble with a sample image
"""

import sys
import json
import tempfile
import numpy as np
from PIL import Image
from pathlib import Path

# Add parent directory to path
sys.path.append(str(Path(__file__).parent))

from ensemble import AdaptiveCardEnsemble

def create_test_image():
    """Create a simple test image"""
    # Create a 224x224 RGB image with random Pokemon card-like colors
    img_array = np.zeros((224, 224, 3), dtype=np.uint8)
    
    # Add some color gradients to simulate a card
    for i in range(224):
        for j in range(224):
            img_array[i, j] = [
                min(255, i + 50),  # Red channel
                min(255, j + 50),  # Green channel
                min(255, 100)      # Blue channel
            ]
    
    img = Image.fromarray(img_array)
    
    # Save to temp file
    with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
        img.save(tmp.name)
        return tmp.name

def main():
    print("=" * 60)
    print("CardMint Ensemble Test")
    print("=" * 60)
    
    # Initialize ensemble
    print("\nInitializing ensemble...")
    ensemble = AdaptiveCardEnsemble()
    
    # Print status
    status = ensemble.get_status()
    print(f"\nActive Models: {', '.join(status['active_models'])}")
    print(f"Device: {status['resource_usage']['device_type']}")
    print(f"Intel Extension: {'✅ Enabled' if status['resource_usage']['has_ipex'] else '❌ Disabled'}")
    
    # Create test image
    print("\nCreating test image...")
    test_image_path = create_test_image()
    print(f"Test image saved to: {test_image_path}")
    
    # Run prediction
    print("\nRunning ensemble prediction...")
    try:
        result = ensemble.predict(test_image_path)
        
        print("\n" + "=" * 40)
        print("Prediction Results:")
        print("=" * 40)
        
        if result.final_prediction:
            print(f"Card Name: {result.final_prediction.card_name}")
            print(f"Set: {result.final_prediction.set_name}")
            print(f"Confidence: {result.final_prediction.confidence:.2%}")
        
        print(f"\nActive Models Used: {', '.join(result.active_models)}")
        print(f"Total Inference Time: {result.total_time_ms:.2f}ms")
        
        print("\nModel Predictions:")
        for model_name, prediction in result.model_predictions.items():
            print(f"  {model_name}:")
            print(f"    - Confidence: {prediction.confidence:.2%}")
            print(f"    - Time: {prediction.inference_time_ms:.2f}ms")
        
        print(f"\nEnsemble Confidence: {result.ensemble_confidence:.2%}")
        
    except Exception as e:
        print(f"Error during prediction: {e}")
        import traceback
        traceback.print_exc()
    
    # Clean up
    Path(test_image_path).unlink(missing_ok=True)
    
    print("\n" + "=" * 60)
    print("Test Complete!")
    print("=" * 60)

if __name__ == "__main__":
    main()