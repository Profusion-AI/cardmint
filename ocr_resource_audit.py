#!/usr/bin/env python3
"""
System Resource Audit for OCR Processing
Monitors CPU, Memory, Disk I/O, and process metrics during OCR scan
"""

import os
import sys
import time
import psutil
import threading
import subprocess
import json
from datetime import datetime
from pathlib import Path
import numpy as np
import cv2

class ResourceMonitor:
    """Monitor system resources during OCR processing"""
    
    def __init__(self):
        self.monitoring = False
        self.metrics = {
            'cpu_percent': [],
            'cpu_per_core': [],
            'memory_percent': [],
            'memory_mb': [],
            'disk_io_read': [],
            'disk_io_write': [],
            'process_cpu': [],
            'process_memory_mb': [],
            'process_threads': [],
            'timestamps': []
        }
        self.process_pid = None
        self.peak_metrics = {}
        
    def start_monitoring(self, pid=None):
        """Start monitoring in background thread"""
        self.monitoring = True
        self.process_pid = pid or os.getpid()
        self.monitor_thread = threading.Thread(target=self._monitor_loop)
        self.monitor_thread.daemon = True
        self.monitor_thread.start()
        
    def stop_monitoring(self):
        """Stop monitoring and calculate peaks"""
        self.monitoring = False
        if hasattr(self, 'monitor_thread'):
            self.monitor_thread.join(timeout=2)
        self._calculate_peaks()
        
    def _monitor_loop(self):
        """Background monitoring loop"""
        try:
            process = psutil.Process(self.process_pid)
        except:
            process = None
            
        initial_disk = psutil.disk_io_counters()
        
        while self.monitoring:
            timestamp = time.time()
            
            # System-wide metrics
            cpu_percent = psutil.cpu_percent(interval=0.1)
            cpu_per_core = psutil.cpu_percent(interval=0.1, percpu=True)
            memory = psutil.virtual_memory()
            disk = psutil.disk_io_counters()
            
            self.metrics['timestamps'].append(timestamp)
            self.metrics['cpu_percent'].append(cpu_percent)
            self.metrics['cpu_per_core'].append(cpu_per_core)
            self.metrics['memory_percent'].append(memory.percent)
            self.metrics['memory_mb'].append(memory.used / 1024 / 1024)
            
            # Disk I/O (bytes per second)
            if len(self.metrics['timestamps']) > 1:
                time_delta = timestamp - self.metrics['timestamps'][-2]
                read_speed = (disk.read_bytes - initial_disk.read_bytes) / time_delta / 1024 / 1024
                write_speed = (disk.write_bytes - initial_disk.write_bytes) / time_delta / 1024 / 1024
                self.metrics['disk_io_read'].append(read_speed)
                self.metrics['disk_io_write'].append(write_speed)
                initial_disk = disk
            
            # Process-specific metrics
            if process and process.is_running():
                try:
                    process_info = process.as_dict(attrs=['cpu_percent', 'memory_info', 'num_threads'])
                    self.metrics['process_cpu'].append(process_info['cpu_percent'])
                    self.metrics['process_memory_mb'].append(process_info['memory_info'].rss / 1024 / 1024)
                    self.metrics['process_threads'].append(process_info['num_threads'])
                except:
                    pass
            
            time.sleep(0.5)  # Sample every 500ms
            
    def _calculate_peaks(self):
        """Calculate peak values from collected metrics"""
        if self.metrics['cpu_percent']:
            self.peak_metrics['cpu_peak'] = max(self.metrics['cpu_percent'])
            self.peak_metrics['cpu_avg'] = np.mean(self.metrics['cpu_percent'])
            
        if self.metrics['cpu_per_core']:
            core_peaks = [max(core_values) for core_values in zip(*self.metrics['cpu_per_core'])]
            self.peak_metrics['cpu_core_peaks'] = core_peaks
            self.peak_metrics['cpu_cores_used'] = sum(1 for peak in core_peaks if peak > 50)
            
        if self.metrics['memory_mb']:
            self.peak_metrics['memory_peak_mb'] = max(self.metrics['memory_mb'])
            self.peak_metrics['memory_avg_mb'] = np.mean(self.metrics['memory_mb'])
            
        if self.metrics['process_memory_mb']:
            self.peak_metrics['process_memory_peak_mb'] = max(self.metrics['process_memory_mb'])
            self.peak_metrics['process_memory_avg_mb'] = np.mean(self.metrics['process_memory_mb'])
            
        if self.metrics['process_cpu']:
            self.peak_metrics['process_cpu_peak'] = max(self.metrics['process_cpu'])
            self.peak_metrics['process_cpu_avg'] = np.mean(self.metrics['process_cpu'])
            
        if self.metrics['process_threads']:
            self.peak_metrics['process_threads_peak'] = max(self.metrics['process_threads'])
            
        if self.metrics['disk_io_read']:
            self.peak_metrics['disk_read_peak_mbps'] = max(self.metrics['disk_io_read'])
            self.peak_metrics['disk_write_peak_mbps'] = max(self.metrics['disk_io_write'])
            
    def get_report(self):
        """Generate resource usage report"""
        report = {
            'summary': {
                'duration_seconds': len(self.metrics['timestamps']) * 0.5,
                'samples_collected': len(self.metrics['timestamps'])
            },
            'peaks': self.peak_metrics,
            'system_info': {
                'cpu_count': psutil.cpu_count(),
                'cpu_count_physical': psutil.cpu_count(logical=False),
                'total_memory_gb': psutil.virtual_memory().total / 1024 / 1024 / 1024,
                'available_memory_gb': psutil.virtual_memory().available / 1024 / 1024 / 1024
            }
        }
        return report

def run_ocr_with_monitoring():
    """Run OCR while monitoring resources"""
    
    print("="*60)
    print("OCR RESOURCE AUDIT")
    print("="*60)
    
    # System baseline
    print("\n📊 System Baseline:")
    print(f"  CPU Cores: {psutil.cpu_count()} logical, {psutil.cpu_count(logical=False)} physical")
    print(f"  Total RAM: {psutil.virtual_memory().total / 1024 / 1024 / 1024:.1f} GB")
    print(f"  Available RAM: {psutil.virtual_memory().available / 1024 / 1024 / 1024:.1f} GB")
    print(f"  CPU Usage: {psutil.cpu_percent(interval=1)}%")
    
    # Check for GPU
    try:
        nvidia_smi = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,memory.free', '--format=csv,noheader'], 
                                  capture_output=True, text=True, timeout=2)
        if nvidia_smi.returncode == 0:
            print(f"  GPU: {nvidia_smi.stdout.strip()}")
        else:
            print("  GPU: Not available")
    except:
        print("  GPU: Not detected")
    
    # Create test image
    print("\n🖼️ Creating test image...")
    test_image = np.ones((1200, 900, 3), dtype=np.uint8) * 255
    cv2.putText(test_image, "Charizard", (100, 150), cv2.FONT_HERSHEY_DUPLEX, 3, (0, 0, 0), 4)
    cv2.putText(test_image, "HP 150", (600, 150), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 0), 3)
    cv2.putText(test_image, "Fire Flying Pokemon", (100, 250), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 0), 2)
    for i in range(5):
        cv2.putText(test_image, f"Attack {i+1}: Flame Burst", (100, 400 + i*80), 
                   cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)
    cv2.putText(test_image, "6/150 Rare Holo", (100, 1000), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
    
    test_path = "/tmp/audit_test_card.jpg"
    cv2.imwrite(test_path, test_image)
    print(f"  Test image created: {test_path}")
    
    # Start monitoring
    monitor = ResourceMonitor()
    
    print("\n🔍 Starting OCR scan with resource monitoring...")
    print("  This will take 20-30 seconds...\n")
    
    # Run OCR in subprocess so we can monitor it properly
    ocr_script = """
import sys
sys.path.insert(0, '/home/profusionai/CardMint/src/ocr')
from paddleocr import PaddleOCR
import time

start = time.time()
ocr = PaddleOCR(lang='en')
result = ocr.ocr('/tmp/audit_test_card.jpg')
duration = time.time() - start

if result and result[0]:
    print(f"OCR completed in {duration:.2f}s")
    print(f"Detected {len(result[0])} text regions")
else:
    print(f"OCR failed after {duration:.2f}s")
"""
    
    # Write OCR script
    with open('/tmp/ocr_audit_script.py', 'w') as f:
        f.write(ocr_script)
    
    # Start OCR process
    ocr_process = subprocess.Popen(
        [sys.executable, '/tmp/ocr_audit_script.py'],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    
    # Monitor the OCR process
    monitor.start_monitoring(pid=ocr_process.pid)
    
    # Wait for OCR to complete
    stdout, stderr = ocr_process.communicate(timeout=60)
    
    # Stop monitoring
    monitor.stop_monitoring()
    
    print("\n📈 OCR Process Output:")
    print("  ", stdout.strip().replace('\n', '\n  '))
    
    # Generate report
    report = monitor.get_report()
    
    print("\n🎯 RESOURCE USAGE REPORT")
    print("="*60)
    
    print(f"\n⏱️ Duration: {report['summary']['duration_seconds']:.1f} seconds")
    print(f"📊 Samples: {report['summary']['samples_collected']}")
    
    if report['peaks']:
        print("\n💻 CPU Usage:")
        print(f"  System CPU Peak: {report['peaks'].get('cpu_peak', 0):.1f}%")
        print(f"  System CPU Average: {report['peaks'].get('cpu_avg', 0):.1f}%")
        print(f"  Process CPU Peak: {report['peaks'].get('process_cpu_peak', 0):.1f}%")
        print(f"  Process CPU Average: {report['peaks'].get('process_cpu_avg', 0):.1f}%")
        print(f"  Cores Heavily Used (>50%): {report['peaks'].get('cpu_cores_used', 0)}")
        
        print("\n💾 Memory Usage:")
        print(f"  System Memory Peak: {report['peaks'].get('memory_peak_mb', 0):.0f} MB")
        print(f"  Process Memory Peak: {report['peaks'].get('process_memory_peak_mb', 0):.0f} MB")
        print(f"  Process Memory Average: {report['peaks'].get('process_memory_avg_mb', 0):.0f} MB")
        print(f"  Process Threads Peak: {report['peaks'].get('process_threads_peak', 0)}")
        
        print("\n💿 Disk I/O:")
        print(f"  Read Peak: {report['peaks'].get('disk_read_peak_mbps', 0):.1f} MB/s")
        print(f"  Write Peak: {report['peaks'].get('disk_write_peak_mbps', 0):.1f} MB/s")
    
    # Resource efficiency analysis
    print("\n🔬 EFFICIENCY ANALYSIS:")
    print("="*60)
    
    cpu_efficiency = report['peaks'].get('cpu_cores_used', 0) / psutil.cpu_count() * 100
    print(f"\n  CPU Utilization: {cpu_efficiency:.1f}% of available cores")
    
    if cpu_efficiency < 25:
        print("  ⚠️ LOW CPU utilization - mostly single-threaded")
        print("  💡 Opportunity: Enable multi-threading or batch processing")
    elif cpu_efficiency < 50:
        print("  ⚠️ MODERATE CPU utilization - some parallelism")
        print("  💡 Opportunity: Increase parallel processing")
    else:
        print("  ✅ GOOD CPU utilization across cores")
    
    process_mem = report['peaks'].get('process_memory_peak_mb', 0)
    if process_mem > 2000:
        print(f"\n  ⚠️ HIGH memory usage: {process_mem:.0f} MB")
        print("  💡 Opportunity: Use lighter models or optimize memory allocation")
    elif process_mem > 1000:
        print(f"\n  ⚡ MODERATE memory usage: {process_mem:.0f} MB")
        print("  💡 Opportunity: Consider memory-optimized models")
    else:
        print(f"\n  ✅ EFFICIENT memory usage: {process_mem:.0f} MB")
    
    # Save detailed metrics
    with open('/home/profusionai/CardMint/ocr_audit_report.json', 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'report': report,
            'raw_metrics': {k: v[:20] if len(v) > 20 else v for k, v in monitor.metrics.items() if k != 'cpu_per_core'}
        }, f, indent=2)
    
    print("\n📄 Detailed report saved to: ocr_audit_report.json")
    
    return report

if __name__ == "__main__":
    run_ocr_with_monitoring()