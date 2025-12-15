#!/usr/bin/env python3
"""Performance Validation Template for CardMint Changes

Template script for validating performance impact of code changes against
the established 10% delta threshold for accuracy and speed metrics.

Usage:
    python scripts/performance_validation_template.py --baseline-run --description "Feature XYZ"
    python scripts/performance_validation_template.py --compare-run --description "Feature XYZ"

This template should be copied and customized for each significant change requiring
performance validation per the Performance Impact Policy.
"""

import argparse
import json
import time
import datetime as dt
from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional
import statistics

# Configuration - Update these for your specific validation
BASELINE_NAME = "phase3a_daemon_baseline"  # Update with your baseline identifier
TEST_DESCRIPTION = "Template validation run"
CARDS_TO_TEST = 10  # Minimum 10 for statistical significance
SIGNIFICANCE_THRESHOLD = 10.0  # 10% threshold per policy

def run_baseline_measurement(description: str) -> Dict[str, Any]:
    """Run baseline performance measurement.

    CUSTOMIZE THIS FUNCTION for your specific testing scenario.
    """
    print(f"🔍 Running baseline measurement: {description}")

    # TEMPLATE: Replace with actual baseline measurement
    # Example: Call existing Phase 3A script or equivalent
    results = {
        "timestamp": dt.datetime.now().isoformat(),
        "description": description,
        "test_type": "baseline",
        "metrics": {
            "avg_inference_ms": 12000.0,  # 12s baseline
            "accuracy_percent": 95.0,     # 95% accuracy baseline
            "variance_percent": 12.0,     # <15% variance baseline
            "memory_usage_mb": 150.0,     # Memory usage baseline
        },
        "individual_timings": [
            12100, 11950, 12050, 11900, 12200,
            11850, 12150, 11800, 12300, 12000
        ],
        "accuracy_results": [
            {"card": 1, "correct": True},
            {"card": 2, "correct": True},
            {"card": 3, "correct": False},
            {"card": 4, "correct": True},
            {"card": 5, "correct": True},
            {"card": 6, "correct": True},
            {"card": 7, "correct": True},
            {"card": 8, "correct": True},
            {"card": 9, "correct": True},
            {"card": 10, "correct": True}
        ]
    }

    # Save baseline results
    results_dir = Path("results")
    results_dir.mkdir(exist_ok=True)

    baseline_path = results_dir / f"baseline_{BASELINE_NAME}_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with baseline_path.open("w") as f:
        json.dump(results, f, indent=2)

    print(f"✅ Baseline saved: {baseline_path}")
    return results


def run_comparison_measurement(description: str) -> Dict[str, Any]:
    """Run comparison measurement with your changes.

    CUSTOMIZE THIS FUNCTION for your specific testing scenario.
    """
    print(f"🔍 Running comparison measurement: {description}")

    # TEMPLATE: Replace with actual measurement of your changes
    # Example: Call modified script with your changes
    results = {
        "timestamp": dt.datetime.now().isoformat(),
        "description": description,
        "test_type": "comparison",
        "metrics": {
            "avg_inference_ms": 12150.0,  # Slightly slower
            "accuracy_percent": 94.0,     # Slightly less accurate
            "variance_percent": 13.5,     # Within bounds
            "memory_usage_mb": 155.0,     # Slightly more memory
        },
        "individual_timings": [
            12200, 12100, 12150, 12050, 12300,
            12000, 12250, 11950, 12400, 12100
        ],
        "accuracy_results": [
            {"card": 1, "correct": True},
            {"card": 2, "correct": True},
            {"card": 3, "correct": False},
            {"card": 4, "correct": True},
            {"card": 5, "correct": True},
            {"card": 6, "correct": True},
            {"card": 7, "correct": True},
            {"card": 8, "correct": True},
            {"card": 9, "correct": False},  # Additional failure
            {"card": 10, "correct": True}
        ]
    }

    # Save comparison results
    results_dir = Path("results")
    results_dir.mkdir(exist_ok=True)

    comparison_path = results_dir / f"comparison_{BASELINE_NAME}_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with comparison_path.open("w") as f:
        json.dump(results, f, indent=2)

    print(f"✅ Comparison saved: {comparison_path}")
    return results


def calculate_performance_delta(baseline: Dict[str, Any], comparison: Dict[str, Any]) -> Dict[str, Any]:
    """Calculate performance delta and assess against thresholds."""
    print("\n📊 PERFORMANCE DELTA ANALYSIS")
    print("=" * 50)

    baseline_metrics = baseline["metrics"]
    comparison_metrics = comparison["metrics"]

    # Calculate deltas
    speed_delta_ms = comparison_metrics["avg_inference_ms"] - baseline_metrics["avg_inference_ms"]
    speed_delta_percent = (speed_delta_ms / baseline_metrics["avg_inference_ms"]) * 100

    accuracy_delta = comparison_metrics["accuracy_percent"] - baseline_metrics["accuracy_percent"]
    accuracy_delta_percent = abs(accuracy_delta / baseline_metrics["accuracy_percent"]) * 100

    variance_delta = comparison_metrics["variance_percent"] - baseline_metrics["variance_percent"]
    variance_delta_percent = (variance_delta / baseline_metrics["variance_percent"]) * 100

    memory_delta_mb = comparison_metrics["memory_usage_mb"] - baseline_metrics["memory_usage_mb"]
    memory_delta_percent = (memory_delta_mb / baseline_metrics["memory_usage_mb"]) * 100

    # Statistical significance testing
    baseline_timings = baseline.get("individual_timings", [])
    comparison_timings = comparison.get("individual_timings", [])

    if len(baseline_timings) >= 2 and len(comparison_timings) >= 2:
        baseline_std = statistics.stdev(baseline_timings)
        comparison_std = statistics.stdev(comparison_timings)
        pooled_std = ((baseline_std**2 + comparison_std**2) / 2)**0.5
        standard_error = pooled_std * (2/len(baseline_timings))**0.5
        t_statistic = abs(speed_delta_ms) / standard_error if standard_error > 0 else 0
        statistically_significant = t_statistic > 2.0  # Approximate t-test threshold
    else:
        statistically_significant = False

    delta_analysis = {
        "speed_delta_ms": speed_delta_ms,
        "speed_delta_percent": speed_delta_percent,
        "accuracy_delta_percent": accuracy_delta,
        "accuracy_delta_magnitude": accuracy_delta_percent,
        "variance_delta_percent": variance_delta_percent,
        "memory_delta_mb": memory_delta_mb,
        "memory_delta_percent": memory_delta_percent,
        "statistically_significant": statistically_significant,
        "t_statistic": t_statistic if 't_statistic' in locals() else 0.0
    }

    # Display results
    print(f"Speed Impact:")
    print(f"  Baseline: {baseline_metrics['avg_inference_ms']:.1f}ms")
    print(f"  Comparison: {comparison_metrics['avg_inference_ms']:.1f}ms")
    print(f"  Delta: {speed_delta_ms:+.1f}ms ({speed_delta_percent:+.2f}%)")

    print(f"\nAccuracy Impact:")
    print(f"  Baseline: {baseline_metrics['accuracy_percent']:.1f}%")
    print(f"  Comparison: {comparison_metrics['accuracy_percent']:.1f}%")
    print(f"  Delta: {accuracy_delta:+.1f}% ({accuracy_delta_percent:.2f}% magnitude)")

    print(f"\nVariance Impact:")
    print(f"  Baseline: {baseline_metrics['variance_percent']:.1f}%")
    print(f"  Comparison: {comparison_metrics['variance_percent']:.1f}%")
    print(f"  Delta: {variance_delta:+.1f}% ({variance_delta_percent:+.2f}%)")

    print(f"\nMemory Impact:")
    print(f"  Baseline: {baseline_metrics['memory_usage_mb']:.1f}MB")
    print(f"  Comparison: {comparison_metrics['memory_usage_mb']:.1f}MB")
    print(f"  Delta: {memory_delta_mb:+.1f}MB ({memory_delta_percent:+.2f}%)")

    print(f"\nStatistical Significance: {'Yes' if statistically_significant else 'No'}")
    if 't_statistic' in locals():
        print(f"T-statistic: {t_statistic:.2f}")

    return delta_analysis


def assess_threshold_compliance(delta_analysis: Dict[str, Any]) -> Dict[str, Any]:
    """Assess whether changes comply with 10% threshold policy."""
    print(f"\n🚨 THRESHOLD COMPLIANCE ASSESSMENT")
    print("=" * 50)

    violations = []
    warnings = []

    # Speed threshold check
    if abs(delta_analysis["speed_delta_percent"]) >= SIGNIFICANCE_THRESHOLD:
        violations.append({
            "metric": "Speed",
            "delta": delta_analysis["speed_delta_percent"],
            "threshold": SIGNIFICANCE_THRESHOLD,
            "severity": "CRITICAL"
        })
    elif abs(delta_analysis["speed_delta_percent"]) >= SIGNIFICANCE_THRESHOLD * 0.5:
        warnings.append({
            "metric": "Speed",
            "delta": delta_analysis["speed_delta_percent"],
            "threshold": SIGNIFICANCE_THRESHOLD * 0.5,
            "severity": "WARNING"
        })

    # Accuracy threshold check
    if delta_analysis["accuracy_delta_magnitude"] >= SIGNIFICANCE_THRESHOLD:
        violations.append({
            "metric": "Accuracy",
            "delta": delta_analysis["accuracy_delta_magnitude"],
            "threshold": SIGNIFICANCE_THRESHOLD,
            "severity": "CRITICAL"
        })
    elif delta_analysis["accuracy_delta_magnitude"] >= SIGNIFICANCE_THRESHOLD * 0.5:
        warnings.append({
            "metric": "Accuracy",
            "delta": delta_analysis["accuracy_delta_magnitude"],
            "threshold": SIGNIFICANCE_THRESHOLD * 0.5,
            "severity": "WARNING"
        })

    # Memory threshold check (more lenient)
    if abs(delta_analysis["memory_delta_percent"]) >= SIGNIFICANCE_THRESHOLD * 2:
        violations.append({
            "metric": "Memory",
            "delta": delta_analysis["memory_delta_percent"],
            "threshold": SIGNIFICANCE_THRESHOLD * 2,
            "severity": "MODERATE"
        })

    compliance_assessment = {
        "compliant": len(violations) == 0,
        "violations": violations,
        "warnings": warnings,
        "requires_review": len(violations) > 0 or len(warnings) > 0,
        "statistical_significance": delta_analysis["statistically_significant"]
    }

    # Display assessment
    if compliance_assessment["compliant"] and len(warnings) == 0:
        print("✅ COMPLIANT: Changes are within acceptable performance thresholds")
        print("   No review required - proceed with implementation")
    elif compliance_assessment["compliant"] and len(warnings) > 0:
        print("🟡 COMPLIANT WITH WARNINGS: Changes within thresholds but approaching limits")
        for warning in warnings:
            print(f"   ⚠️  {warning['metric']}: {warning['delta']:+.2f}% (threshold: {warning['threshold']:.1f}%)")
        print("   Consider: Documentation of performance trade-offs")
    else:
        print("🔴 NON-COMPLIANT: Changes exceed performance impact thresholds")
        for violation in violations:
            print(f"   ❌ {violation['metric']}: {violation['delta']:+.2f}% (threshold: {violation['threshold']:.1f}%)")
        print("   REQUIRED: Formal performance impact review and approval")

    return compliance_assessment


def generate_review_report(baseline: Dict[str, Any], comparison: Dict[str, Any],
                          delta_analysis: Dict[str, Any], compliance: Dict[str, Any]) -> str:
    """Generate formatted review report."""
    report_lines = [
        "# Performance Impact Review Report",
        f"**Generated:** {dt.datetime.now().isoformat()}",
        f"**Baseline:** {baseline['description']}",
        f"**Comparison:** {comparison['description']}",
        "",
        "## Summary",
        f"- **Compliance Status:** {'✅ COMPLIANT' if compliance['compliant'] else '🔴 NON-COMPLIANT'}",
        f"- **Review Required:** {'Yes' if compliance['requires_review'] else 'No'}",
        f"- **Statistical Significance:** {'Yes' if compliance['statistical_significance'] else 'No'}",
        "",
        "## Performance Metrics",
        "| Metric | Baseline | Comparison | Delta | % Change | Status |",
        "|--------|----------|------------|-------|----------|--------|",
        f"| Speed (ms) | {baseline['metrics']['avg_inference_ms']:.1f} | {comparison['metrics']['avg_inference_ms']:.1f} | {delta_analysis['speed_delta_ms']:+.1f} | {delta_analysis['speed_delta_percent']:+.2f}% | {'❌' if abs(delta_analysis['speed_delta_percent']) >= SIGNIFICANCE_THRESHOLD else '✅'} |",
        f"| Accuracy (%) | {baseline['metrics']['accuracy_percent']:.1f} | {comparison['metrics']['accuracy_percent']:.1f} | {delta_analysis['accuracy_delta_percent']:+.1f} | {delta_analysis['accuracy_delta_magnitude']:.2f}% | {'❌' if delta_analysis['accuracy_delta_magnitude'] >= SIGNIFICANCE_THRESHOLD else '✅'} |",
        f"| Variance (%) | {baseline['metrics']['variance_percent']:.1f} | {comparison['metrics']['variance_percent']:.1f} | {delta_analysis['variance_delta_percent']:+.1f} | - | {'✅'} |",
        f"| Memory (MB) | {baseline['metrics']['memory_usage_mb']:.1f} | {comparison['metrics']['memory_usage_mb']:.1f} | {delta_analysis['memory_delta_mb']:+.1f} | {delta_analysis['memory_delta_percent']:+.2f}% | {'✅'} |",
        "",
        "## Threshold Analysis",
        f"**Performance Impact Policy Compliance:**"
    ]

    if compliance["violations"]:
        report_lines.append("### ❌ Violations")
        for violation in compliance["violations"]:
            report_lines.append(f"- **{violation['metric']}**: {violation['delta']:+.2f}% exceeds {violation['threshold']:.1f}% threshold ({violation['severity']})")

    if compliance["warnings"]:
        report_lines.append("### ⚠️ Warnings")
        for warning in compliance["warnings"]:
            report_lines.append(f"- **{warning['metric']}**: {warning['delta']:+.2f}% approaching {warning['threshold']:.1f}% threshold")

    if not compliance["violations"] and not compliance["warnings"]:
        report_lines.append("- All metrics within acceptable thresholds")

    report_lines.extend([
        "",
        "## Recommendations",
        "### If Non-Compliant:",
        "1. Review `docs/optimization/PERFORMANCE_IMPACT_POLICY.md`",
        "2. Obtain approval from performance review board",
        "3. Document performance trade-offs and rationale",
        "4. Consider performance optimizations to reduce impact",
        "",
        "### If Compliant:",
        "1. Document performance validation in PR/commit message",
        "2. Include this report in change documentation",
        "3. Monitor for performance regression in production",
        "",
        f"---",
        f"*Report generated by performance_validation_template.py*"
    ])

    return "\n".join(report_lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-run", action="store_true", help="Run baseline measurement")
    parser.add_argument("--compare-run", action="store_true", help="Run comparison measurement")
    parser.add_argument("--description", default=TEST_DESCRIPTION, help="Description of the test")
    parser.add_argument("--baseline-file", help="Path to existing baseline JSON file")
    parser.add_argument("--comparison-file", help="Path to existing comparison JSON file")

    args = parser.parse_args()

    if args.baseline_run:
        baseline_results = run_baseline_measurement(args.description)
        return 0

    elif args.compare_run:
        comparison_results = run_comparison_measurement(args.description)
        return 0

    elif args.baseline_file and args.comparison_file:
        # Load existing results and analyze
        with open(args.baseline_file) as f:
            baseline_results = json.load(f)
        with open(args.comparison_file) as f:
            comparison_results = json.load(f)

    else:
        print("Must specify --baseline-run, --compare-run, or both --baseline-file and --comparison-file")
        return 1

    # Perform analysis
    delta_analysis = calculate_performance_delta(baseline_results, comparison_results)
    compliance_assessment = assess_threshold_compliance(delta_analysis)

    # Generate report
    report = generate_review_report(baseline_results, comparison_results, delta_analysis, compliance_assessment)

    # Save report
    results_dir = Path("results")
    results_dir.mkdir(exist_ok=True)
    report_path = results_dir / f"performance_review_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}.md"

    with report_path.open("w") as f:
        f.write(report)

    print(f"\n📋 PERFORMANCE REVIEW REPORT")
    print("=" * 50)
    print(report)
    print(f"\n💾 Report saved: {report_path}")

    # Return appropriate exit code
    if compliance_assessment["compliant"]:
        print(f"\n🎉 VALIDATION COMPLETE: Changes approved for implementation")
        return 0
    else:
        print(f"\n🚨 VALIDATION FAILED: Review required before implementation")
        return 1


if __name__ == "__main__":
    exit_code = main()
    exit(exit_code)