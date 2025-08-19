#!/usr/bin/env python3
"""
OCR Optimization Benchmark
Tests different PaddleOCR configurations to find the optimal settings
"""

import os
import sys
import time
import psutil
import json
import cv2
import numpy as np
from pathlib import Path

def create_test_card():
    """Create a realistic Pokemon card test image"""
    img = np.ones((800, 600, 3), dtype=np.uint8) * 255
    
    # Add various text elements
    cv2.putText(img, "Pikachu", (50, 100), cv2.FONT_HERSHEY_DUPLEX, 2, (0, 0, 0), 3)
    cv2.putText(img, "HP 60", (450, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 0), 2)
    cv2.putText(img, "Basic Pokemon", (50, 150), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
    cv2.putText(img, "Thunder Shock", (50, 400), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)
    cv2.putText(img, "30", (450, 400), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)
    cv2.putText(img, "Weakness: Fighting x2", (50, 600), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 1)
    cv2.putText(img, "25/150", (50, 750), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 1)
    
    test_path = "/tmp/benchmark_card.jpg"
    cv2.imwrite(test_path, img)
    return test_path

def benchmark_configuration(config_name, config_code):
    """Benchmark a specific OCR configuration"""
    
    print(f"\n📊 Testing: {config_name}")
    print("-" * 40)
    
    # Monitor resources
    process = psutil.Process()
    start_memory = process.memory_info().rss / 1024 / 1024
    
    # Write test script
    test_script = f"""
import time
import sys
import os
os.environ['PADDLEOCR_LOGLEVEL'] = 'ERROR'
from paddleocr import PaddleOCR

start_time = time.time()

# Configuration to test
{config_code}

# Initialization time
init_time = time.time() - start_time

# Run OCR
ocr_start = time.time()
result = ocr.ocr('/tmp/benchmark_card.jpg')
ocr_time = time.time() - ocr_start

total_time = time.time() - start_time

# Output results
if result and result[0]:
    print(f"REGIONS:{len(result[0])}")
print(f"INIT_TIME:{init_time:.2f}")
print(f"OCR_TIME:{ocr_time:.2f}")
print(f"TOTAL_TIME:{total_time:.2f}")
"""
    
    script_path = f"/tmp/ocr_test_{config_name.replace(' ', '_')}.py"
    with open(script_path, 'w') as f:
        f.write(test_script)
    
    # Run benchmark
    import subprocess
    start = time.time()
    
    try:
        proc_result = subprocess.run(
            [sys.executable, script_path],
            capture_output=True,
            text=True,
            timeout=60
        )
        
        elapsed = time.time() - start
        
        # Parse results
        output = proc_result.stdout + proc_result.stderr
        metrics = {}
        
        for line in output.split('\n'):
            if 'REGIONS:' in line:
                metrics['regions'] = int(line.split(':')[1])
            elif 'INIT_TIME:' in line:
                metrics['init_time'] = float(line.split(':')[1])
            elif 'OCR_TIME:' in line:
                metrics['ocr_time'] = float(line.split(':')[1])
            elif 'TOTAL_TIME:' in line:
                metrics['total_time'] = float(line.split(':')[1])
        
        # Memory usage
        end_memory = process.memory_info().rss / 1024 / 1024
        metrics['memory_delta_mb'] = end_memory - start_memory
        
        # CPU usage (rough estimate)
        metrics['cpu_percent'] = process.cpu_percent()
        
        return metrics
        
    except subprocess.TimeoutExpired:
        return {'error': 'Timeout', 'total_time': 60}
    except Exception as e:
        return {'error': str(e)}

def run_benchmark():
    """Run comprehensive benchmark of different OCR configurations"""
    
    print("="*60)
    print("OCR OPTIMIZATION BENCHMARK")
    print("="*60)
    
    # Create test image
    test_path = create_test_card()
    print(f"\n✅ Test image created: {test_path}")
    
    # Define configurations to test
    configurations = [
        ("Default (Full Models)", """
ocr = PaddleOCR(lang='en')
"""),
        
        ("Mobile Models (Lightweight)", """
ocr = PaddleOCR(
    lang='en',
    det_model_dir=None,  # Will use mobile model
    rec_model_dir=None,  # Will use mobile model  
    use_gpu=False,
    det_db_thresh=0.3,
    det_db_box_thresh=0.5
)
"""),
        
        ("CPU Optimized", """
ocr = PaddleOCR(
    lang='en',
    use_gpu=False,
    enable_mkldnn=True,
    cpu_threads=4
)
"""),
        
        ("Fast Mode (Lower Accuracy)", """
ocr = PaddleOCR(
    lang='en',
    det_db_thresh=0.5,  # Higher threshold = fewer detections
    det_db_box_thresh=0.6,
    rec_batch_num=8,  # Batch processing
    max_text_length=25  # Limit text length
)
"""),
        
        ("Minimal Preprocessing", """
ocr = PaddleOCR(
    lang='en',
    det_algorithm='DB',  # Simpler detection
    rec_algorithm='CRNN',  # Simpler recognition
    det_db_unclip_ratio=1.5  # Less preprocessing
)
""")
    ]
    
    # Run benchmarks
    results = {}
    
    for config_name, config_code in configurations:
        metrics = benchmark_configuration(config_name, config_code)
        results[config_name] = metrics
        
        if metrics and 'total_time' in metrics:
            print(f"  ✓ Total Time: {metrics.get('total_time', 'N/A'):.2f}s")
            print(f"  ✓ OCR Time: {metrics.get('ocr_time', 'N/A'):.2f}s")
            print(f"  ✓ Init Time: {metrics.get('init_time', 'N/A'):.2f}s")
            print(f"  ✓ Regions Detected: {metrics.get('regions', 'N/A')}")
            print(f"  ✓ Memory Delta: {metrics.get('memory_delta_mb', 0):.0f} MB")
        else:
            print(f"  ✗ Error: {metrics.get('error', 'Unknown')}")
    
    # Summary
    print("\n" + "="*60)
    print("BENCHMARK SUMMARY")
    print("="*60)
    
    # Sort by speed
    valid_results = {k: v for k, v in results.items() if 'total_time' in v and 'error' not in v}
    
    if valid_results:
        sorted_results = sorted(valid_results.items(), key=lambda x: x[1].get('total_time', 999))
        
        print("\n🏆 Performance Ranking (by speed):")
        for i, (name, metrics) in enumerate(sorted_results, 1):
            time_diff = metrics['total_time'] - sorted_results[0][1]['total_time']
            print(f"\n{i}. {name}")
            print(f"   Total: {metrics['total_time']:.2f}s" + 
                  (f" (+{time_diff:.2f}s)" if i > 1 else " ⚡ FASTEST"))
            print(f"   OCR: {metrics.get('ocr_time', 0):.2f}s")
            print(f"   Regions: {metrics.get('regions', 0)}")
            print(f"   Memory: {metrics.get('memory_delta_mb', 0):.0f} MB")
    
    # Recommendations
    print("\n" + "="*60)
    print("💡 OPTIMIZATION RECOMMENDATIONS")
    print("="*60)
    
    if valid_results:
        fastest = sorted_results[0]
        default = results.get("Default (Full Models)", {})
        
        if fastest[0] != "Default (Full Models)" and 'total_time' in default:
            speedup = default['total_time'] / fastest[1]['total_time']
            print(f"\n✅ Use '{fastest[0]}' configuration")
            print(f"   - {speedup:.1f}x faster than default")
            print(f"   - Saves {default['total_time'] - fastest[1]['total_time']:.1f}s per scan")
        
        # Check accuracy vs speed tradeoff
        if fastest[1].get('regions', 0) < 5:
            print("\n⚠️ Warning: Fastest config may have accuracy issues")
            print("   Consider using CPU Optimized or Mobile Models instead")
    
    # Save results
    with open('/home/profusionai/CardMint/ocr_benchmark_results.json', 'w') as f:
        json.dump(results, f, indent=2)
    
    print("\n📄 Full results saved to: ocr_benchmark_results.json")
    
    return results

if __name__ == "__main__":
    run_benchmark()