#!/usr/bin/env python3
"""
Simple direct OCR benchmark to test configurations
"""

import time
import psutil
import cv2
import numpy as np
import os

# Suppress PaddleOCR logging
os.environ['PADDLEOCR_LOGLEVEL'] = 'ERROR'

def create_test_image():
    """Create test Pokemon card image"""
    img = np.ones((800, 600, 3), dtype=np.uint8) * 255
    cv2.putText(img, "Charizard", (50, 100), cv2.FONT_HERSHEY_DUPLEX, 2, (0, 0, 0), 3)
    cv2.putText(img, "HP 120", (450, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 0), 2)
    cv2.putText(img, "Stage 2 Pokemon", (50, 150), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
    cv2.putText(img, "Fire Blast", (50, 400), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)
    cv2.putText(img, "120", (450, 400), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)
    cv2.putText(img, "4/102", (50, 750), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 1)
    
    path = "/tmp/bench_card.jpg"
    cv2.imwrite(path, img)
    return path

def benchmark_config(name, init_func):
    """Benchmark a configuration"""
    print(f"\n{'='*50}")
    print(f"Testing: {name}")
    print('='*50)
    
    process = psutil.Process()
    
    # Initialize
    print("Initializing OCR...")
    start_mem = process.memory_info().rss / 1024 / 1024
    init_start = time.time()
    
    try:
        ocr = init_func()
        init_time = time.time() - init_start
        print(f"✓ Initialized in {init_time:.2f}s")
        
        # Test OCR
        test_img = create_test_image()
        
        print("Running OCR...")
        ocr_start = time.time()
        result = ocr.ocr(test_img)
        ocr_time = time.time() - ocr_start
        
        # Check results
        regions = len(result[0]) if result and result[0] else 0
        
        # Memory
        end_mem = process.memory_info().rss / 1024 / 1024
        mem_used = end_mem - start_mem
        
        print(f"\n📊 Results:")
        print(f"  Init Time: {init_time:.2f}s")
        print(f"  OCR Time: {ocr_time:.2f}s")
        print(f"  Total Time: {init_time + ocr_time:.2f}s")
        print(f"  Regions Detected: {regions}")
        print(f"  Memory Used: {mem_used:.0f} MB")
        
        return {
            'name': name,
            'init_time': init_time,
            'ocr_time': ocr_time,
            'total_time': init_time + ocr_time,
            'regions': regions,
            'memory_mb': mem_used
        }
        
    except Exception as e:
        print(f"✗ Error: {e}")
        return {
            'name': name,
            'error': str(e)
        }

def main():
    print("🚀 OCR CONFIGURATION BENCHMARK")
    print("Testing different PaddleOCR configurations...\n")
    
    from paddleocr import PaddleOCR
    
    configs = [
        ("Default (Server Models)", 
         lambda: PaddleOCR(lang='en')),
        
        ("Mobile Models (Lightweight)",
         lambda: PaddleOCR(
             lang='en',
             ocr_version='PP-OCRv4',  # Latest mobile version
             use_gpu=False
         )),
        
        ("CPU Optimized (MKL-DNN)",
         lambda: PaddleOCR(
             lang='en',
             use_gpu=False,
             enable_mkldnn=True
         )),
         
        ("Minimal Detection Threshold",
         lambda: PaddleOCR(
             lang='en',
             det_db_thresh=0.5,  # Higher = faster but less accurate
             det_db_box_thresh=0.6
         )),
    ]
    
    results = []
    for name, init_func in configs:
        result = benchmark_config(name, init_func)
        results.append(result)
        
        # Clean up memory between tests
        import gc
        gc.collect()
        time.sleep(2)
    
    # Summary
    print("\n" + "="*60)
    print("📈 BENCHMARK SUMMARY")
    print("="*60)
    
    valid = [r for r in results if 'error' not in r]
    if valid:
        sorted_results = sorted(valid, key=lambda x: x['total_time'])
        
        print("\n🏆 Performance Ranking:")
        for i, r in enumerate(sorted_results, 1):
            print(f"\n{i}. {r['name']}")
            print(f"   Total: {r['total_time']:.2f}s")
            print(f"   OCR: {r['ocr_time']:.2f}s")
            print(f"   Init: {r['init_time']:.2f}s")
            print(f"   Accuracy: {r['regions']} regions")
            
            if i == 1:
                print("   ⚡ FASTEST")
            else:
                diff = r['total_time'] - sorted_results[0]['total_time']
                slowdown = r['total_time'] / sorted_results[0]['total_time']
                print(f"   {slowdown:.1f}x slower (+{diff:.1f}s)")
    
    # Recommendations
    print("\n" + "="*60)
    print("💡 RECOMMENDATIONS")
    print("="*60)
    
    if sorted_results:
        fastest = sorted_results[0]
        print(f"\n✅ Best Configuration: {fastest['name']}")
        print(f"   - Processes in {fastest['total_time']:.1f}s")
        print(f"   - Detects {fastest['regions']} text regions")
        
        default = next((r for r in results if 'Default' in r['name']), None)
        if default and default != fastest:
            speedup = default['total_time'] / fastest['total_time']
            print(f"   - {speedup:.1f}x faster than default")

if __name__ == "__main__":
    main()