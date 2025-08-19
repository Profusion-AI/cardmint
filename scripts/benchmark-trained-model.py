#!/usr/bin/env python3
"""
Benchmark trained SmolVLM model performance
Tests speed, memory usage, and resource utilization
"""

import sys
import os
import json
import time
import argparse
import psutil
import threading
from pathlib import Path
from PIL import Image
import logging
from collections import deque
import gc

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ModelBenchmark:
    """Comprehensive benchmarking for SmolVLM model."""
    
    def __init__(self, model_path):
        """Initialize benchmark with model path."""
        self.model_path = model_path
        self.service = None
        self.monitoring_active = False
        self.memory_samples = deque(maxlen=1000)
        self.cpu_samples = deque(maxlen=1000)
        
    def load_model(self):
        """Load model for benchmarking."""
        logger.info("Loading model for benchmark...")
        
        try:
            from src.ml.smolvlm_optimized_service import OptimizedSmolVLMService
            
            start_time = time.time()
            self.service = OptimizedSmolVLMService(model_path=self.model_path)
            load_time = time.time() - start_time
            
            logger.info(f"✅ Model loaded in {load_time:.2f}s")
            return load_time
            
        except Exception as e:
            logger.error(f"❌ Failed to load model: {e}")
            return None
            
    def start_monitoring(self):
        """Start resource monitoring in background."""
        self.monitoring_active = True
        
        def monitor():
            process = psutil.Process()
            while self.monitoring_active:
                try:
                    # Memory info
                    memory_info = process.memory_info()
                    memory_mb = memory_info.rss / (1024 * 1024)
                    self.memory_samples.append(memory_mb)
                    
                    # CPU info
                    cpu_percent = process.cpu_percent(interval=0.1)
                    self.cpu_samples.append(cpu_percent)
                    
                    time.sleep(1)
                except:
                    break
                    
        self.monitor_thread = threading.Thread(target=monitor)
        self.monitor_thread.daemon = True
        self.monitor_thread.start()
        
    def stop_monitoring(self):
        """Stop resource monitoring."""
        self.monitoring_active = False
        if hasattr(self, 'monitor_thread'):
            self.monitor_thread.join(timeout=2)
            
    def benchmark_single_inference(self, image_path, iterations=10):
        """Benchmark single image inference multiple times."""
        logger.info(f"Benchmarking single inference ({iterations} iterations)...")
        
        if not os.path.exists(image_path):
            logger.error(f"Test image not found: {image_path}")
            return None
            
        times = []
        results = []
        
        # Warmup
        logger.info("Warming up model...")
        for _ in range(2):
            self.service.process_image(image_path)
            
        # Benchmark iterations
        logger.info(f"Running {iterations} benchmark iterations...")
        for i in range(iterations):
            gc.collect()  # Force garbage collection
            
            start_time = time.time()
            result = self.service.process_image(image_path)
            inference_time = time.time() - start_time
            
            times.append(inference_time)
            results.append(result)
            
            if (i + 1) % 10 == 0:
                logger.info(f"  Completed {i + 1}/{iterations} iterations")
                
        return {
            'iterations': iterations,
            'times': times,
            'average_time': sum(times) / len(times),
            'min_time': min(times),
            'max_time': max(times),
            'p50_time': sorted(times)[len(times)//2],
            'p95_time': sorted(times)[int(len(times)*0.95)],
            'p99_time': sorted(times)[int(len(times)*0.99)],
            'sample_results': results[:3]  # First 3 results for verification
        }
        
    def benchmark_batch_inference(self, image_paths, batch_sizes=[1, 2, 4, 8]):
        """Benchmark batch inference with different batch sizes."""
        logger.info(f"Benchmarking batch inference with sizes: {batch_sizes}")
        
        batch_results = {}
        
        for batch_size in batch_sizes:
            logger.info(f"Testing batch size: {batch_size}")
            
            # Prepare batch
            batch = (image_paths * ((batch_size // len(image_paths)) + 1))[:batch_size]
            
            # Warmup
            if hasattr(self.service, 'batch_process'):
                self.service.batch_process(batch)
            
            # Benchmark
            start_time = time.time()
            if hasattr(self.service, 'batch_process'):
                results = self.service.batch_process(batch)
                batch_time = time.time() - start_time
                per_image_time = batch_time / batch_size
            else:
                # Fallback to sequential processing
                results = []
                for img_path in batch:
                    result = self.service.process_image(img_path)
                    results.append(result)
                batch_time = time.time() - start_time
                per_image_time = batch_time / batch_size
                
            batch_results[batch_size] = {
                'total_time': batch_time,
                'per_image_time': per_image_time,
                'throughput': batch_size / batch_time,  # images per second
                'results_count': len(results)
            }
            
        return batch_results
        
    def benchmark_memory_usage(self, image_path, duration_minutes=5):
        """Benchmark memory usage over time."""
        logger.info(f"Benchmarking memory usage for {duration_minutes} minutes...")
        
        start_time = time.time()
        end_time = start_time + (duration_minutes * 60)
        
        initial_memory = self.memory_samples[-1] if self.memory_samples else 0
        request_count = 0
        
        while time.time() < end_time:
            # Make inference request
            self.service.process_image(image_path)
            request_count += 1
            
            # Small delay to allow monitoring
            time.sleep(1)
            
            if request_count % 60 == 0:  # Every minute
                current_memory = self.memory_samples[-1] if self.memory_samples else 0
                logger.info(f"  Memory: {current_memory:.1f}MB, Requests: {request_count}")
                
        final_memory = self.memory_samples[-1] if self.memory_samples else 0
        memory_growth = final_memory - initial_memory
        
        return {
            'duration_minutes': duration_minutes,
            'total_requests': request_count,
            'initial_memory_mb': initial_memory,
            'final_memory_mb': final_memory,
            'memory_growth_mb': memory_growth,
            'requests_per_minute': request_count / duration_minutes,
            'memory_per_request_kb': (memory_growth * 1024) / max(request_count, 1)
        }
        
    def get_resource_stats(self):
        """Get current resource usage statistics."""
        if not self.memory_samples or not self.cpu_samples:
            return None
            
        memory_stats = {
            'current_mb': self.memory_samples[-1],
            'average_mb': sum(self.memory_samples) / len(self.memory_samples),
            'peak_mb': max(self.memory_samples),
            'min_mb': min(self.memory_samples)
        }
        
        cpu_stats = {
            'current_percent': self.cpu_samples[-1],
            'average_percent': sum(self.cpu_samples) / len(self.cpu_samples),
            'peak_percent': max(self.cpu_samples)
        }
        
        return {
            'memory': memory_stats,
            'cpu': cpu_stats,
            'samples_count': len(self.memory_samples)
        }
        
    def run_comprehensive_benchmark(self, test_images, output_path=None):
        """Run comprehensive benchmark suite."""
        logger.info("Running comprehensive benchmark suite...")
        
        benchmark_results = {
            'model_path': self.model_path,
            'timestamp': time.time(),
            'test_images': test_images
        }
        
        # Load model and start monitoring
        load_time = self.load_model()
        if not load_time:
            return None
            
        benchmark_results['load_time'] = load_time
        self.start_monitoring()
        
        try:
            # Single inference benchmark
            if test_images:
                single_results = self.benchmark_single_inference(test_images[0], iterations=50)
                benchmark_results['single_inference'] = single_results
                
            # Batch inference benchmark
            if len(test_images) >= 2:
                batch_results = self.benchmark_batch_inference(test_images[:4])
                benchmark_results['batch_inference'] = batch_results
                
            # Memory usage benchmark (shorter for testing)
            if test_images:
                memory_results = self.benchmark_memory_usage(test_images[0], duration_minutes=2)
                benchmark_results['memory_usage'] = memory_results
                
            # Resource statistics
            resource_stats = self.get_resource_stats()
            benchmark_results['resource_stats'] = resource_stats
            
            # Service statistics
            service_stats = self.service.get_stats()
            benchmark_results['service_stats'] = service_stats
            
        finally:
            self.stop_monitoring()
            
        # Save results
        if output_path:
            with open(output_path, 'w') as f:
                json.dump(benchmark_results, f, indent=2, default=str)
            logger.info(f"📊 Benchmark results saved to: {output_path}")
            
        return benchmark_results
        
    def print_summary(self, results):
        """Print benchmark summary."""
        print("\n" + "="*60)
        print("SMOLVLM BENCHMARK SUMMARY")
        print("="*60)
        
        print(f"Model: {results['model_path']}")
        print(f"Load time: {results['load_time']:.2f}s")
        
        # Single inference stats
        if 'single_inference' in results:
            single = results['single_inference']
            print(f"\nSingle Inference ({single['iterations']} iterations):")
            print(f"  Average: {single['average_time']:.3f}s")
            print(f"  P50: {single['p50_time']:.3f}s")
            print(f"  P95: {single['p95_time']:.3f}s")
            print(f"  P99: {single['p99_time']:.3f}s")
            print(f"  Min/Max: {single['min_time']:.3f}s / {single['max_time']:.3f}s")
            
        # Batch inference stats
        if 'batch_inference' in results:
            print(f"\nBatch Inference:")
            for batch_size, stats in results['batch_inference'].items():
                print(f"  Batch {batch_size}: {stats['per_image_time']:.3f}s/image, "
                      f"{stats['throughput']:.1f} images/s")
                      
        # Memory stats
        if 'memory_usage' in results:
            memory = results['memory_usage']
            print(f"\nMemory Usage ({memory['duration_minutes']}min test):")
            print(f"  Initial: {memory['initial_memory_mb']:.1f}MB")
            print(f"  Final: {memory['final_memory_mb']:.1f}MB")
            print(f"  Growth: {memory['memory_growth_mb']:.1f}MB")
            print(f"  Per request: {memory['memory_per_request_kb']:.1f}KB")
            
        # Resource stats
        if 'resource_stats' in results:
            resources = results['resource_stats']
            print(f"\nResource Usage:")
            print(f"  Memory: {resources['memory']['average_mb']:.1f}MB avg, "
                  f"{resources['memory']['peak_mb']:.1f}MB peak")
            print(f"  CPU: {resources['cpu']['average_percent']:.1f}% avg, "
                  f"{resources['cpu']['peak_percent']:.1f}% peak")
                  
        # Performance assessment
        print(f"\n" + "="*60)
        print("PERFORMANCE ASSESSMENT")
        print("="*60)
        
        if 'single_inference' in results:
            avg_time = results['single_inference']['average_time']
            if avg_time <= 2:
                print("✅ Excellent: Average inference ≤2s")
            elif avg_time <= 3:
                print("✅ Good: Average inference ≤3s") 
            elif avg_time <= 5:
                print("⚠️ Acceptable: Average inference ≤5s")
            else:
                print("❌ Poor: Average inference >5s")
                
        if 'memory_usage' in results:
            growth = results['memory_usage']['memory_growth_mb']
            if growth <= 50:
                print("✅ Good: Memory growth ≤50MB")
            elif growth <= 100:
                print("⚠️ Acceptable: Memory growth ≤100MB")
            else:
                print("❌ Poor: Memory growth >100MB")
                
    def close(self):
        """Close benchmark resources."""
        self.stop_monitoring()
        if self.service:
            self.service.close()

def find_test_images(test_dir, max_images=10):
    """Find test images in directory."""
    test_images = []
    
    if os.path.isdir(test_dir):
        extensions = ['*.png', '*.jpg', '*.jpeg']
        for ext in extensions:
            for img_path in Path(test_dir).glob(ext):
                test_images.append(str(img_path))
                if len(test_images) >= max_images:
                    break
            if len(test_images) >= max_images:
                break
                
    return test_images

def main():
    parser = argparse.ArgumentParser(description="Benchmark SmolVLM model")
    parser.add_argument("--model", required=True, help="Path to model")
    parser.add_argument("--test-images", required=True, help="Directory with test images")
    parser.add_argument("--iterations", type=int, default=50, help="Inference iterations")
    parser.add_argument("--batch-sizes", default="1,2,4", help="Batch sizes to test")
    parser.add_argument("--memory-duration", type=int, default=2, help="Memory test duration (minutes)")
    parser.add_argument("--output", help="Output file for results")
    
    args = parser.parse_args()
    
    # Find test images
    test_images = find_test_images(args.test_images)
    if not test_images:
        logger.error(f"No test images found in: {args.test_images}")
        sys.exit(1)
        
    logger.info(f"Found {len(test_images)} test images")
    
    # Run benchmark
    benchmark = ModelBenchmark(args.model)
    
    try:
        results = benchmark.run_comprehensive_benchmark(test_images, args.output)
        if results:
            benchmark.print_summary(results)
        else:
            logger.error("Benchmark failed")
            sys.exit(1)
            
    finally:
        benchmark.close()

if __name__ == "__main__":
    main()