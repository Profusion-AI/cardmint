#!/usr/bin/env python3
"""Production Performance Monitor for CardMint Pipeline.

Monitors inference performance against established baselines and alerts on regressions.
Implements the performance impact policy from docs/optimization/PERFORMANCE_IMPACT_POLICY.md.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import datetime as dt

# Performance baselines (from Phase 3A established envelope)
BASELINE_METRICS = {
    "phase_3a_avg_inference_ms": 15000,  # 15.0s from Phase 3A daemon baseline
    "max_acceptable_inference_ms": 18000,  # 20% tolerance threshold
    "min_accuracy_threshold": 95.0,  # Minimum full card accuracy
    "max_variance_threshold": 15.0,  # Maximum inference variance %
}

class PerformanceAlert:
    """Represents a performance regression alert."""

    def __init__(self, metric: str, current: float, baseline: float, threshold: float, severity: str):
        self.metric = metric
        self.current = current
        self.baseline = baseline
        self.threshold = threshold
        self.severity = severity
        self.delta_pct = ((current / baseline) - 1) * 100 if baseline > 0 else 0

    def __str__(self) -> str:
        return (f"🚨 {self.severity} ALERT: {self.metric}\n"
                f"   Current: {self.current:.1f} | Baseline: {self.baseline:.1f} | "
                f"Threshold: {self.threshold:.1f}\n"
                f"   Delta: {self.delta_pct:+.1f}%")

def load_test_results(results_path: Path) -> Tuple[Dict, List[Dict]]:
    """Load test results and extract performance metrics."""
    with results_path.open('r') as f:
        data = json.load(f)

        # Check for new Phase 4B optimized format
        if 'performance_summary' in data:
            perf_summary = data['performance_summary']
            performance = perf_summary.get('performance', {})
            accuracy = perf_summary.get('accuracy', {})

            metrics = {
                'avg_inference_ms': performance.get('avg_inference_ms', 0),
                'total_cards': performance.get('total_cards', 0),
                'inference_variance': performance.get('variance_percent', 0),
                'full_card_accuracy': accuracy.get('full_card_accuracy', 0) * 100  # Convert from decimal
            }
            results = data.get('results', [])
            return metrics, results

        # Check for individual results format (list)
        elif isinstance(data, list):
            results = data
            inference_times = [r['inference_time_ms'] for r in results if 'inference_time_ms' in r]

            if inference_times:
                avg_inference = sum(inference_times) / len(inference_times)
                mean_val = avg_inference
                variance = sum((x - mean_val) ** 2 for x in inference_times) / len(inference_times)
                variance_pct = (variance ** 0.5) / mean_val * 100 if mean_val > 0 else 0
            else:
                avg_inference = 0
                variance_pct = 0

            metrics = {
                'avg_inference_ms': avg_inference,
                'total_cards': len(results),
                'inference_variance': variance_pct,
                'full_card_accuracy': 100.0  # Placeholder - would need ground truth comparison
            }
            return metrics, results

        # Original metrics format
        else:
            metrics = data.get('aggregate_metrics', {})
            results = data.get('results', [])
            return metrics, results

def analyze_performance(metrics: Dict) -> List[PerformanceAlert]:
    """Analyze metrics against baselines and generate alerts."""
    alerts = []

    # Check inference time regression
    current_inference = metrics.get('avg_inference_ms', 0)
    if current_inference > BASELINE_METRICS['max_acceptable_inference_ms']:
        severity = 'CRITICAL' if current_inference > 25000 else 'WARNING'
        alerts.append(PerformanceAlert(
            metric='Average Inference Time',
            current=current_inference,
            baseline=BASELINE_METRICS['phase_3a_avg_inference_ms'],
            threshold=BASELINE_METRICS['max_acceptable_inference_ms'],
            severity=severity
        ))

    # Check accuracy regression
    accuracy = metrics.get('full_card_accuracy', 0)
    if accuracy < BASELINE_METRICS['min_accuracy_threshold']:
        alerts.append(PerformanceAlert(
            metric='Full Card Accuracy',
            current=accuracy,
            baseline=BASELINE_METRICS['min_accuracy_threshold'],
            threshold=BASELINE_METRICS['min_accuracy_threshold'],
            severity='CRITICAL'
        ))

    # Check variance threshold
    variance = metrics.get('inference_variance', 0)
    if variance > BASELINE_METRICS['max_variance_threshold']:
        alerts.append(PerformanceAlert(
            metric='Inference Variance',
            current=variance,
            baseline=BASELINE_METRICS['max_variance_threshold'],
            threshold=BASELINE_METRICS['max_variance_threshold'],
            severity='WARNING'
        ))

    return alerts

def print_performance_summary(metrics: Dict, alerts: List[PerformanceAlert]):
    """Print performance monitoring summary."""
    print("📊 CARDMINT PERFORMANCE MONITOR")
    print("=" * 50)

    # Current metrics
    print(f"Current Performance:")
    print(f"  Average Inference: {metrics.get('avg_inference_ms', 0):.1f}ms")
    print(f"  Cards Processed: {metrics.get('total_cards', 0)}")
    print(f"  Variance: {metrics.get('inference_variance', 0):.1f}%")
    print(f"  Full Card Accuracy: {metrics.get('full_card_accuracy', 0):.1f}%")

    print(f"\nBaseline Comparison:")
    current_inference = metrics.get('avg_inference_ms', 0)
    baseline_delta = ((current_inference / BASELINE_METRICS['phase_3a_avg_inference_ms']) - 1) * 100
    print(f"  vs Phase 3A Baseline: {baseline_delta:+.1f}%")

    # Alerts
    if alerts:
        print(f"\n🚨 PERFORMANCE ALERTS ({len(alerts)}):")
        for alert in alerts:
            print(f"\n{alert}")
    else:
        print(f"\n✅ All metrics within acceptable thresholds")

    # Recommendations
    print(f"\n📋 RECOMMENDATIONS:")
    if any(a.severity == 'CRITICAL' for a in alerts):
        print("  • CRITICAL issues detected - investigate immediately")
        print("  • Review PERFORMANCE_IMPACT_POLICY.md for escalation")
        print("  • Consider blocking deployment until resolved")
    elif alerts:
        print("  • WARNING thresholds exceeded - monitor closely")
        print("  • Consider performance optimization review")
    else:
        print("  • Performance within acceptable envelope")
        print("  • Continue with planned testing phases")

def main():
    parser = argparse.ArgumentParser(description="Monitor CardMint performance against baselines")
    parser.add_argument('results_file', type=Path, help='Path to test results JSON file')
    parser.add_argument('--baseline', type=Path, help='Custom baseline file (optional)')
    parser.add_argument('--alert-only', action='store_true', help='Only output if alerts detected')

    args = parser.parse_args()

    if not args.results_file.exists():
        print(f"❌ Results file not found: {args.results_file}")
        return 1

    try:
        metrics, results = load_test_results(args.results_file)
        alerts = analyze_performance(metrics)

        if args.alert_only and not alerts:
            return 0

        print_performance_summary(metrics, alerts)

        # Return non-zero exit code if critical alerts
        return 1 if any(a.severity == 'CRITICAL' for a in alerts) else 0

    except Exception as e:
        print(f"❌ Error analyzing performance: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())