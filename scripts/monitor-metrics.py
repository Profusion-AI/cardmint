#!/usr/bin/env python3
"""
VLM Metrics Monitor - Real-time performance tracking

Displays current metrics and compares with baseline performance.
Use this to monitor VLM rollout progress and detect regressions.
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional
import time

# ANSI color codes for terminal output
class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

def load_baseline(baseline_path: str = "baselines/ocr-baseline-latest.json") -> Dict[str, Any]:
    """Load baseline metrics from file"""
    baseline_file = Path(baseline_path)
    if not baseline_file.exists():
        return None
    
    with open(baseline_file, 'r') as f:
        return json.load(f)

def load_current_metrics(metrics_path: str = "baselines/vlm-metrics-latest.json") -> Optional[Dict[str, Any]]:
    """Load current VLM metrics if available"""
    metrics_file = Path(metrics_path)
    if not metrics_file.exists():
        return None
    
    with open(metrics_file, 'r') as f:
        return json.load(f)

def get_status_emoji(current: float, target: float, lower_is_better: bool = True) -> str:
    """Get status emoji based on performance vs target"""
    if lower_is_better:
        if current <= target:
            return "✅"
        elif current <= target * 1.5:
            return "⚠️"
        else:
            return "❌"
    else:
        if current >= target:
            return "✅"
        elif current >= target * 0.75:
            return "⚠️"
        else:
            return "❌"

def format_metric(value: float, unit: str = "", decimals: int = 1) -> str:
    """Format metric value with unit"""
    if decimals == 0:
        return f"{int(value)}{unit}"
    return f"{value:.{decimals}f}{unit}"

def calculate_improvement(baseline: float, current: float, lower_is_better: bool = True) -> str:
    """Calculate and format improvement percentage"""
    if baseline == 0:
        return "N/A"
    
    if lower_is_better:
        improvement = ((baseline - current) / baseline) * 100
    else:
        improvement = ((current - baseline) / baseline) * 100
    
    if improvement > 0:
        return f"{Colors.GREEN}↑{improvement:.1f}%{Colors.ENDC}"
    elif improvement < 0:
        return f"{Colors.RED}↓{abs(improvement):.1f}%{Colors.ENDC}"
    else:
        return f"{Colors.YELLOW}→0%{Colors.ENDC}"

def print_header():
    """Print dashboard header"""
    print("\n" + "=" * 80)
    print(f"{Colors.BOLD}{Colors.HEADER}📊 VLM OPTIMIZATION METRICS DASHBOARD{Colors.ENDC}")
    print("=" * 80)
    print(f"Last Update: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 80 + "\n")

def print_summary(baseline: Dict[str, Any], current: Optional[Dict[str, Any]] = None):
    """Print metrics summary"""
    # Performance Targets
    targets = {
        "processing_time_ms": 2000,  # 2 seconds
        "cpu_percent": 60,           # 60%
        "memory_mb": 5000,           # 5GB
        "success_rate": 0.85,        # 85%
        "thread_count": 20           # 20 threads
    }
    
    print(f"{Colors.BOLD}📈 PERFORMANCE METRICS{Colors.ENDC}")
    print("-" * 40)
    
    # Processing Time
    baseline_time = baseline["summary"]["processing_time"]["avg_ms"]
    current_time = current["summary"]["processing_time"]["avg_ms"] if current else baseline_time
    
    print(f"Processing Time:")
    print(f"  Baseline: {format_metric(baseline_time, 'ms', 0)}")
    if current:
        print(f"  Current:  {format_metric(current_time, 'ms', 0)} {calculate_improvement(baseline_time, current_time)}")
    print(f"  Target:   {format_metric(targets['processing_time_ms'], 'ms', 0)} {get_status_emoji(current_time, targets['processing_time_ms'])}")
    print()
    
    # CPU Usage
    baseline_cpu = baseline["summary"]["cpu_usage"]["avg_percent"]
    current_cpu = current["summary"]["cpu_usage"]["avg_percent"] if current else baseline_cpu
    
    print(f"CPU Usage:")
    print(f"  Baseline: {format_metric(baseline_cpu, '%')}")
    if current:
        print(f"  Current:  {format_metric(current_cpu, '%')} {calculate_improvement(baseline_cpu, current_cpu)}")
    print(f"  Target:   {format_metric(targets['cpu_percent'], '%')} {get_status_emoji(current_cpu, targets['cpu_percent'])}")
    print()
    
    # Memory Usage
    baseline_mem = baseline["summary"]["memory_usage"]["avg_mb"]
    current_mem = current["summary"]["memory_usage"]["avg_mb"] if current else baseline_mem
    
    print(f"Memory Usage:")
    print(f"  Baseline: {format_metric(baseline_mem, 'MB', 0)}")
    if current:
        print(f"  Current:  {format_metric(current_mem, 'MB', 0)} {calculate_improvement(baseline_mem, current_mem)}")
    print(f"  Target:   <{format_metric(targets['memory_mb'], 'MB', 0)} {get_status_emoji(current_mem, targets['memory_mb'])}")
    print()
    
    # Success Rate
    baseline_success = baseline["summary"]["success_rate"]
    current_success = current["summary"]["success_rate"] if current else baseline_success
    
    print(f"Success Rate:")
    print(f"  Baseline: {format_metric(baseline_success * 100, '%')}")
    if current:
        print(f"  Current:  {format_metric(current_success * 100, '%')} {calculate_improvement(baseline_success, current_success, False)}")
    print(f"  Target:   {format_metric(targets['success_rate'] * 100, '%')} {get_status_emoji(current_success, targets['success_rate'], False)}")
    print()

def print_rollout_status():
    """Print VLM rollout status"""
    print(f"\n{Colors.BOLD}🚀 ROLLOUT STATUS{Colors.ENDC}")
    print("-" * 40)
    
    # Check environment variables
    vlm_enabled = os.environ.get('VLM_ENABLED', 'false')
    vlm_percentage = int(os.environ.get('VLM_PERCENTAGE', '0'))
    vlm_shadow = os.environ.get('VLM_SHADOW_MODE', 'false')
    vlm_emergency = os.environ.get('VLM_EMERGENCY_KILL', 'false')
    
    # Status indicators
    if vlm_emergency == 'true':
        status = f"{Colors.RED}🚨 EMERGENCY SHUTDOWN{Colors.ENDC}"
    elif vlm_enabled == 'false':
        status = f"{Colors.YELLOW}⏸️  DISABLED{Colors.ENDC}"
    elif vlm_shadow == 'true':
        status = f"{Colors.CYAN}👻 SHADOW MODE{Colors.ENDC}"
    elif vlm_percentage == 0:
        status = f"{Colors.YELLOW}📊 READY (0%){Colors.ENDC}"
    elif vlm_percentage < 100:
        status = f"{Colors.BLUE}📈 ROLLING OUT ({vlm_percentage}%){Colors.ENDC}"
    else:
        status = f"{Colors.GREEN}✅ FULLY DEPLOYED{Colors.ENDC}"
    
    print(f"Status: {status}")
    print(f"VLM Enabled: {vlm_enabled}")
    print(f"Shadow Mode: {vlm_shadow}")
    print(f"Traffic %: {vlm_percentage}%")
    print(f"Emergency Kill: {vlm_emergency}")
    print()

def print_alerts(baseline: Dict[str, Any], current: Optional[Dict[str, Any]] = None):
    """Print any alerts or warnings"""
    print(f"\n{Colors.BOLD}⚠️  ALERTS & WARNINGS{Colors.ENDC}")
    print("-" * 40)
    
    alerts = []
    
    # Check baseline metrics
    if baseline["summary"]["processing_time"]["avg_ms"] > 10000:
        alerts.append(f"{Colors.RED}🚨 CRITICAL: Processing time >10s{Colors.ENDC}")
    elif baseline["summary"]["processing_time"]["avg_ms"] > 5000:
        alerts.append(f"{Colors.YELLOW}⚠️  WARNING: Processing time >5s{Colors.ENDC}")
    
    if baseline["summary"]["success_rate"] < 0.6:
        alerts.append(f"{Colors.RED}🚨 CRITICAL: Success rate <60%{Colors.ENDC}")
    elif baseline["summary"]["success_rate"] < 0.8:
        alerts.append(f"{Colors.YELLOW}⚠️  WARNING: Success rate <80%{Colors.ENDC}")
    
    if baseline["summary"]["cpu_usage"]["avg_percent"] > 80:
        alerts.append(f"{Colors.YELLOW}⚠️  WARNING: High CPU usage{Colors.ENDC}")
    
    # Check camera status
    if "camera_capture" in baseline and not baseline["camera_capture"]["success"]:
        alerts.append(f"{Colors.YELLOW}⚠️  WARNING: Camera capture not functional{Colors.ENDC}")
    
    if alerts:
        for alert in alerts:
            print(f"  • {alert}")
    else:
        print(f"  {Colors.GREEN}✅ No alerts - system healthy{Colors.ENDC}")
    print()

def print_recommendations(baseline: Dict[str, Any]):
    """Print optimization recommendations"""
    print(f"\n{Colors.BOLD}💡 RECOMMENDATIONS{Colors.ENDC}")
    print("-" * 40)
    
    recommendations = []
    
    # Based on metrics
    if baseline["summary"]["processing_time"]["avg_ms"] > 5000:
        recommendations.append("Implement hot model loading to eliminate startup time")
    
    if baseline["summary"]["cpu_usage"]["avg_percent"] > 80:
        recommendations.append("Reduce worker threads from 38 to 1-2")
        recommendations.append("Enable Intel IPEX optimizations")
    
    if baseline["summary"]["success_rate"] < 0.8:
        recommendations.append("Add more diverse test images")
        recommendations.append("Improve error handling for edge cases")
    
    if "camera_capture" in baseline and not baseline["camera_capture"]["success"]:
        recommendations.append("Fix Sony SDK library path (libCr_Core.so)")
    
    for i, rec in enumerate(recommendations, 1):
        print(f"  {i}. {rec}")
    print()

def main():
    """Main monitoring loop"""
    # Load baseline
    baseline = load_baseline()
    if not baseline:
        print(f"{Colors.RED}Error: No baseline found. Run 'python scripts/create-baseline.py' first.{Colors.ENDC}")
        sys.exit(1)
    
    # Load current metrics if available
    current = load_current_metrics()
    
    # Clear screen for dashboard
    os.system('clear' if os.name == 'posix' else 'cls')
    
    # Print dashboard
    print_header()
    print_summary(baseline, current)
    print_rollout_status()
    print_alerts(baseline, current)
    print_recommendations(baseline)
    
    # Footer
    print("=" * 80)
    print(f"{Colors.CYAN}Press Ctrl+C to exit{Colors.ENDC}")
    print(f"{Colors.CYAN}Run 'python scripts/create-baseline.py' to update baseline{Colors.ENDC}")
    print(f"{Colors.CYAN}Run './scripts/emergency-rollback.sh' for emergency shutdown{Colors.ENDC}")
    print("=" * 80)

if __name__ == "__main__":
    try:
        main()
        # In production, this could refresh every few seconds
        # while True:
        #     time.sleep(5)
        #     os.system('clear')
        #     main()
    except KeyboardInterrupt:
        print(f"\n{Colors.YELLOW}Monitoring stopped.{Colors.ENDC}")
        sys.exit(0)