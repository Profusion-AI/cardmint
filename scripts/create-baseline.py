#!/usr/bin/env python3
"""
Performance Baseline Creator for VLM Optimization
 
Creates comprehensive performance baselines before VLM implementation.
This data will be used to validate improvements and detect regressions.
"""

import json
import time
import psutil
import os
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Any
import subprocess

# Add src directories to path
sys.path.insert(0, str(Path(__file__).parent.parent / 'src'))
sys.path.insert(0, str(Path(__file__).parent.parent / 'src' / 'ocr'))

# Import OCR service
try:
    from paddleocr_service import CardOCRService
except ImportError:
    print("Error: Could not import CardOCRService")
    print("Make sure you're in the CardMint directory")
    sys.exit(1)

class BaselineCreator:
    """Creates and stores performance baselines for OCR processing"""
    
    def __init__(self, output_dir: str = "baselines"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
        self.ocr_service = CardOCRService()
        self.results = []
        
    def measure_system_resources(self) -> Dict[str, Any]:
        """Capture current system resource usage"""
        # CPU usage over 1 second interval
        cpu_percent = psutil.cpu_percent(interval=1, percpu=True)
        
        # Memory usage
        memory = psutil.virtual_memory()
        
        # Process-specific metrics
        process = psutil.Process()
        
        return {
            "cpu": {
                "total_percent": sum(cpu_percent),
                "per_core": cpu_percent,
                "count": psutil.cpu_count(),
                "freq": psutil.cpu_freq().current if psutil.cpu_freq() else 0
            },
            "memory": {
                "total_mb": memory.total / (1024 * 1024),
                "used_mb": memory.used / (1024 * 1024),
                "available_mb": memory.available / (1024 * 1024),
                "percent": memory.percent,
                "process_mb": process.memory_info().rss / (1024 * 1024)
            },
            "process": {
                "threads": process.num_threads(),
                "cpu_percent": process.cpu_percent()
            }
        }
    
    def test_camera_capture(self) -> Dict[str, Any]:
        """Test camera capture performance"""
        capture_script = Path("/home/profusionai/CardMint/capture-card")
        
        if not capture_script.exists():
            return {
                "available": False,
                "error": "Capture script not found"
            }
        
        try:
            start_time = time.time()
            result = subprocess.run(
                [str(capture_script)],
                capture_output=True,
                text=True,
                timeout=5
            )
            capture_time = (time.time() - start_time) * 1000
            
            return {
                "available": True,
                "capture_time_ms": capture_time,
                "success": result.returncode == 0,
                "output": result.stdout.strip() if result.returncode == 0 else result.stderr.strip()
            }
        except Exception as e:
            return {
                "available": False,
                "error": str(e)
            }
    
    def process_test_card(self, image_path: str) -> Dict[str, Any]:
        """Process a single card and collect metrics"""
        if not Path(image_path).exists():
            return {
                "error": f"Image not found: {image_path}",
                "success": False
            }
        
        # Measure resources before processing
        resources_before = self.measure_system_resources()
        
        # Process the card with OCR
        start_time = time.time()
        try:
            ocr_result = self.ocr_service.process_card(image_path, high_accuracy=True)
            processing_time = (time.time() - start_time) * 1000
        except Exception as e:
            return {
                "error": str(e),
                "success": False,
                "processing_time_ms": 0
            }
        
        # Measure resources after processing
        resources_after = self.measure_system_resources()
        
        # Calculate resource deltas
        cpu_delta = resources_after["cpu"]["total_percent"] - resources_before["cpu"]["total_percent"]
        memory_delta = resources_after["memory"]["process_mb"] - resources_before["memory"]["process_mb"]
        
        return {
            "success": ocr_result.get("success", False),
            "image_path": image_path,
            "processing_time_ms": processing_time,
            "ocr_result": {
                "card_name": ocr_result.get("extracted_card_info", {}).get("card_name", "Unknown"),
                "confidence": ocr_result.get("avg_confidence", 0),
                "regions_detected": ocr_result.get("total_regions", 0),
                "requires_review": ocr_result.get("requires_review", False)
            },
            "resources": {
                "cpu_usage_percent": cpu_delta,
                "memory_usage_mb": memory_delta,
                "threads": resources_after["process"]["threads"]
            },
            "timestamp": datetime.now().isoformat()
        }
    
    def create_baseline(self, test_images: List[str] = None) -> Dict[str, Any]:
        """Create comprehensive baseline with test images"""
        print("🔬 Creating Performance Baseline")
        print("=" * 50)
        
        # Use default test images if none provided
        if not test_images:
            test_dir = Path("test-images")
            if test_dir.exists():
                test_images = [str(f) for f in test_dir.glob("*.jpg")][:10]
            else:
                # Create a dummy list for testing
                test_images = ["test1.jpg", "test2.jpg", "test3.jpg"]
        
        baseline = {
            "created_at": datetime.now().isoformat(),
            "system_info": {
                "cpu_count": psutil.cpu_count(),
                "cpu_model": "Intel Core i5 10th Gen",  # From our knowledge
                "total_memory_gb": psutil.virtual_memory().total / (1024**3),
                "python_version": sys.version
            },
            "camera_capture": self.test_camera_capture(),
            "ocr_tests": [],
            "summary": {}
        }
        
        # Test each image
        print(f"\nTesting {len(test_images)} images...")
        
        processing_times = []
        cpu_usages = []
        memory_usages = []
        success_count = 0
        
        for i, image_path in enumerate(test_images, 1):
            print(f"  [{i}/{len(test_images)}] Processing {Path(image_path).name}...", end="")
            
            result = self.process_test_card(image_path)
            baseline["ocr_tests"].append(result)
            
            if result["success"]:
                success_count += 1
                processing_times.append(result["processing_time_ms"])
                cpu_usages.append(result["resources"]["cpu_usage_percent"])
                memory_usages.append(result["resources"]["memory_usage_mb"])
                print(f" ✓ {result['processing_time_ms']:.0f}ms")
            else:
                print(f" ✗ {result.get('error', 'Failed')}")
        
        # Calculate summary statistics
        if processing_times:
            baseline["summary"] = {
                "total_tests": len(test_images),
                "successful_tests": success_count,
                "success_rate": success_count / len(test_images),
                "processing_time": {
                    "min_ms": min(processing_times),
                    "max_ms": max(processing_times),
                    "avg_ms": sum(processing_times) / len(processing_times),
                    "median_ms": sorted(processing_times)[len(processing_times)//2]
                },
                "cpu_usage": {
                    "avg_percent": sum(cpu_usages) / len(cpu_usages) if cpu_usages else 0,
                    "max_percent": max(cpu_usages) if cpu_usages else 0
                },
                "memory_usage": {
                    "avg_mb": sum(memory_usages) / len(memory_usages) if memory_usages else 0,
                    "max_mb": max(memory_usages) if memory_usages else 0
                }
            }
        else:
            baseline["summary"] = {
                "error": "No successful tests",
                "total_tests": len(test_images),
                "successful_tests": 0
            }
        
        # Save baseline
        output_file = self.output_dir / f"ocr-baseline-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
        with open(output_file, 'w') as f:
            json.dump(baseline, f, indent=2)
        
        # Also save as latest
        latest_file = self.output_dir / "ocr-baseline-latest.json"
        with open(latest_file, 'w') as f:
            json.dump(baseline, f, indent=2)
        
        print("\n" + "=" * 50)
        print("📊 Baseline Summary:")
        print(f"  • Tests run: {baseline['summary'].get('total_tests', 0)}")
        print(f"  • Success rate: {baseline['summary'].get('success_rate', 0):.1%}")
        
        if processing_times:
            print(f"  • Avg processing time: {baseline['summary']['processing_time']['avg_ms']:.0f}ms")
            print(f"  • Min/Max time: {baseline['summary']['processing_time']['min_ms']:.0f}ms / {baseline['summary']['processing_time']['max_ms']:.0f}ms")
            print(f"  • Avg CPU usage: {baseline['summary']['cpu_usage']['avg_percent']:.1f}%")
            print(f"  • Avg memory delta: {baseline['summary']['memory_usage']['avg_mb']:.1f}MB")
        
        print(f"\n✅ Baseline saved to: {output_file}")
        print(f"   Latest symlink: {latest_file}")
        
        return baseline
    
    def compare_with_baseline(self, new_results: Dict[str, Any], baseline_file: str = None) -> Dict[str, Any]:
        """Compare new results with existing baseline"""
        if not baseline_file:
            baseline_file = self.output_dir / "ocr-baseline-latest.json"
        
        if not Path(baseline_file).exists():
            return {"error": "No baseline found for comparison"}
        
        with open(baseline_file, 'r') as f:
            baseline = json.load(f)
        
        comparison = {
            "baseline_date": baseline["created_at"],
            "current_date": new_results["created_at"],
            "improvements": {},
            "regressions": {},
            "unchanged": {}
        }
        
        # Compare processing times
        if "processing_time" in baseline["summary"] and "processing_time" in new_results["summary"]:
            old_avg = baseline["summary"]["processing_time"]["avg_ms"]
            new_avg = new_results["summary"]["processing_time"]["avg_ms"]
            change_pct = ((new_avg - old_avg) / old_avg) * 100
            
            if change_pct < -5:  # More than 5% improvement
                comparison["improvements"]["processing_time"] = {
                    "old_ms": old_avg,
                    "new_ms": new_avg,
                    "improvement_pct": abs(change_pct)
                }
            elif change_pct > 5:  # More than 5% regression
                comparison["regressions"]["processing_time"] = {
                    "old_ms": old_avg,
                    "new_ms": new_avg,
                    "regression_pct": change_pct
                }
            else:
                comparison["unchanged"]["processing_time"] = {
                    "value_ms": new_avg,
                    "change_pct": change_pct
                }
        
        return comparison


def main():
    """Main entry point for baseline creation"""
    import argparse
    
    parser = argparse.ArgumentParser(description="Create OCR performance baseline")
    parser.add_argument("--images", nargs="+", help="Test images to process")
    parser.add_argument("--compare", help="Compare with existing baseline file")
    parser.add_argument("--output", default="baselines", help="Output directory")
    
    args = parser.parse_args()
    
    creator = BaselineCreator(output_dir=args.output)
    
    if args.compare:
        # Run tests and compare
        print("Running comparison tests...")
        new_results = creator.create_baseline(test_images=args.images)
        comparison = creator.compare_with_baseline(new_results, args.compare)
        
        print("\n📈 Comparison Results:")
        print(json.dumps(comparison, indent=2))
    else:
        # Just create baseline
        creator.create_baseline(test_images=args.images)


if __name__ == "__main__":
    main()