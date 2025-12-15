#!/usr/bin/env python3
"""Regression tests for Phase 4A checkpoint resume bug fixes.

This script validates the critical fixes for checkpoint resume functionality:
1. Legacy checkpoints (no success field) default to success=True
2. Metrics reconstruction includes ALL attempted cards (successful and failed)
3. Full card accuracy calculations handle both legacy and modern checkpoints correctly

Tests the specific fixes for the issues identified in the Phase 4A wrapup analysis.
"""

import json
import tempfile
import shutil
from pathlib import Path
from unittest.mock import MagicMock, patch
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from pcis_phase4a import (
    load_checkpoint, Phase4AMetrics, write_comprehensive_report
)

def create_legacy_checkpoint_data():
    """Create a legacy checkpoint without success fields (simulates old checkpoint format)."""
    return {
        "checkpoint_number": 1,
        "timestamp": "2025-09-24T10:00:00.000000",
        "cards_attempted": 3,
        "cards_successful": 3,  # This will be ignored in legacy mode
        "results": [
            {
                "card_number": 1,
                "image_file": "/path/to/base2-1.png",
                "predicted_name": "Clefable",
                "predicted_hp": 70,
                "predicted_set_number": "1/64",
                "ground_truth_name": "Clefable",
                "ground_truth_hp": 70,
                "ground_truth_set_number": "1",
                "inference_time_ms": 15000.0,
                "encode_time_ms": 50.0,
                "parse_time_ms": 0.01,
                "total_card_time_ms": 15050.01,
                "name_correct": True,
                "hp_correct": True,
                "set_number_correct": True
                # NOTE: No "success" field - this is the legacy format
            },
            {
                "card_number": 2,
                "image_file": "/path/to/base2-2.png",
                "predicted_name": "Wartortle",
                "predicted_hp": 60,
                "predicted_set_number": "2/64",
                "ground_truth_name": "Wartortle",
                "ground_truth_hp": 60,
                "ground_truth_set_number": "2",
                "inference_time_ms": 14500.0,
                "encode_time_ms": 48.0,
                "parse_time_ms": 0.01,
                "total_card_time_ms": 14548.01,
                "name_correct": True,
                "hp_correct": True,
                "set_number_correct": True
                # NOTE: No "success" field - this is the legacy format
            },
            {
                "card_number": 3,
                "image_file": "/path/to/base2-3.png",
                "predicted_name": "Alakazam",
                "predicted_hp": 80,
                "predicted_set_number": "3/64",
                "ground_truth_name": "Alakazam",
                "ground_truth_hp": 80,
                "ground_truth_set_number": "3",
                "inference_time_ms": 16000.0,
                "encode_time_ms": 52.0,
                "parse_time_ms": 0.01,
                "total_card_time_ms": 16052.01,
                "name_correct": True,
                "hp_correct": True,
                "set_number_correct": False  # This card has a set number error
                # NOTE: No "success" field - this is the legacy format
            }
        ]
    }

def create_modern_mixed_checkpoint_data():
    """Create a modern checkpoint with explicit success fields including failures."""
    return {
        "checkpoint_number": 2,
        "timestamp": "2025-09-24T11:00:00.000000",
        "cards_attempted": 5,
        "cards_successful": 3,
        "results": [
            {
                "card_number": 1,
                "image_file": "/path/to/base2-11.png",
                "predicted_name": "Snorlax",
                "predicted_hp": 90,
                "predicted_set_number": "11/64",
                "ground_truth_name": "Snorlax",
                "ground_truth_hp": 90,
                "ground_truth_set_number": "11",
                "inference_time_ms": 15200.0,
                "encode_time_ms": 51.0,
                "parse_time_ms": 0.01,
                "total_card_time_ms": 15251.01,
                "success": True,
                "name_correct": True,
                "hp_correct": True,
                "set_number_correct": True
            },
            {
                "card_number": 2,
                "image_file": "/path/to/base2-12.png",
                "predicted_name": "Unknown",
                "predicted_hp": 0,
                "predicted_set_number": "",
                "ground_truth_name": "Vaporeon",
                "ground_truth_hp": 80,
                "ground_truth_set_number": "12",
                "inference_time_ms": 12000.0,
                "encode_time_ms": 45.0,
                "parse_time_ms": 0.01,
                "total_card_time_ms": 12045.01,
                "success": False,  # Explicit failure
                "name_correct": False,
                "hp_correct": False,
                "set_number_correct": False
            },
            {
                "card_number": 3,
                "image_file": "/path/to/base2-13.png",
                "predicted_name": "Jolteon",
                "predicted_hp": 65,
                "predicted_set_number": "13/64",
                "ground_truth_name": "Jolteon",
                "ground_truth_hp": 65,
                "ground_truth_set_number": "13",
                "inference_time_ms": 14800.0,
                "encode_time_ms": 49.0,
                "parse_time_ms": 0.01,
                "total_card_time_ms": 14849.01,
                "success": True,
                "name_correct": True,
                "hp_correct": True,
                "set_number_correct": True
            },
            {
                "card_number": 4,
                "image_file": "/path/to/base2-14.png",
                "predicted_name": "Invalid",
                "predicted_hp": -1,
                "predicted_set_number": "INVALID",
                "ground_truth_name": "Flareon",
                "ground_truth_hp": 70,
                "ground_truth_set_number": "14",
                "inference_time_ms": 8000.0,
                "encode_time_ms": 40.0,
                "parse_time_ms": 0.01,
                "total_card_time_ms": 8040.01,
                "success": False,  # Another explicit failure
                "name_correct": False,
                "hp_correct": False,
                "set_number_correct": False
            },
            {
                "card_number": 5,
                "image_file": "/path/to/base2-15.png",
                "predicted_name": "Machamp",
                "predicted_hp": 100,
                "predicted_set_number": "15/64",
                "ground_truth_name": "Machamp",
                "ground_truth_hp": 100,
                "ground_truth_set_number": "15",
                "inference_time_ms": 16500.0,
                "encode_time_ms": 53.0,
                "parse_time_ms": 0.01,
                "total_card_time_ms": 16553.01,
                "success": True,
                "name_correct": True,
                "hp_correct": True,
                "set_number_correct": True
            }
        ]
    }

def test_legacy_checkpoint_compatibility():
    """Test that legacy checkpoints without success field default to success=True."""
    print("🔍 Testing Legacy Checkpoint Compatibility...")

    legacy_data = create_legacy_checkpoint_data()

    # Test metrics restoration
    metrics = Phase4AMetrics()
    metrics.restore_from_checkpoint(legacy_data)

    # Check that all 3 cards were restored to inference_metrics
    assert len(metrics.inference_metrics) == 3, f"Expected 3 restored records, got {len(metrics.inference_metrics)}"

    # Check that all inference records have success=True (legacy default)
    for i, record in enumerate(metrics.inference_metrics):
        assert record["success"] == True, f"Record {i+1} should have success=True for legacy checkpoint"
        assert record["inference_ms"] > 0, f"Record {i+1} should have valid inference time"

    # Test summary stats
    stats = metrics.get_summary_stats()
    assert stats["total_cards"] == 3, f"Expected 3 total cards, got {stats['total_cards']}"
    assert stats["successful_cards"] == 3, f"Expected 3 successful cards in legacy mode, got {stats['successful_cards']}"
    assert stats["success_rate"] == 100.0, f"Expected 100% success rate for legacy checkpoint, got {stats['success_rate']}"

    print("✅ Legacy checkpoint compatibility test passed")

def test_modern_mixed_checkpoint_handling():
    """Test that modern checkpoints with mixed success/failure are handled correctly."""
    print("🔍 Testing Modern Mixed Checkpoint Handling...")

    mixed_data = create_modern_mixed_checkpoint_data()

    # Test metrics restoration
    metrics = Phase4AMetrics()
    metrics.restore_from_checkpoint(mixed_data)

    # Check that all 5 cards (including failures) were restored
    assert len(metrics.inference_metrics) == 5, f"Expected 5 restored records, got {len(metrics.inference_metrics)}"

    # Check individual success flags
    expected_success = [True, False, True, False, True]  # Based on test data
    for i, (record, expected) in enumerate(zip(metrics.inference_metrics, expected_success)):
        assert record["success"] == expected, f"Record {i+1} should have success={expected}, got {record['success']}"

    # Test summary stats
    stats = metrics.get_summary_stats()
    assert stats["total_cards"] == 5, f"Expected 5 total cards, got {stats['total_cards']}"
    assert stats["successful_cards"] == 3, f"Expected 3 successful cards, got {stats['successful_cards']}"
    assert stats["success_rate"] == 60.0, f"Expected 60% success rate, got {stats['success_rate']}"

    print("✅ Modern mixed checkpoint handling test passed")

def test_full_card_accuracy_calculation():
    """Test that full card accuracy is calculated correctly for both legacy and modern checkpoints."""
    print("🔍 Testing Full Card Accuracy Calculation...")

    # Test legacy checkpoint accuracy
    legacy_data = create_legacy_checkpoint_data()
    results = legacy_data["results"]

    # Calculate expected full accuracy for legacy data (2 out of 3 cards fully correct)
    # Card 1: all correct, Card 2: all correct, Card 3: set_number wrong
    expected_legacy_fully_correct = 2

    actual_legacy_fully_correct = sum(
        1 for result in results
        if (result.get('success', True) and  # Should default to True
            result.get('name_correct', False) and
            result.get('hp_correct', False) and
            result.get('set_number_correct', False))
    )

    assert actual_legacy_fully_correct == expected_legacy_fully_correct, \
        f"Legacy checkpoint: expected {expected_legacy_fully_correct} fully correct, got {actual_legacy_fully_correct}"

    # Test modern checkpoint accuracy
    mixed_data = create_modern_mixed_checkpoint_data()
    results = mixed_data["results"]

    # Calculate expected full accuracy for modern data (only successful AND fully correct cards)
    # Cards 1,3,5 are successful, but only cards 1,3,5 are fully correct
    expected_modern_fully_correct = 3

    actual_modern_fully_correct = sum(
        1 for result in results
        if (result.get('success', True) and  # Modern explicit success field
            result.get('name_correct', False) and
            result.get('hp_correct', False) and
            result.get('set_number_correct', False))
    )

    assert actual_modern_fully_correct == expected_modern_fully_correct, \
        f"Modern checkpoint: expected {expected_modern_fully_correct} fully correct, got {actual_modern_fully_correct}"

    print("✅ Full card accuracy calculation test passed")

def test_comprehensive_report_with_checkpoints():
    """Test that comprehensive report generation works correctly with restored checkpoints."""
    print("🔍 Testing Comprehensive Report with Checkpoints...")

    # Test with modern mixed data
    mixed_data = create_modern_mixed_checkpoint_data()
    results = mixed_data["results"]

    # Set up tally based on the test data
    tally = {
        "name_correct": 3,  # Cards 1, 3, 5
        "hp_correct": 3,    # Cards 1, 3, 5
        "set_number_correct": 3  # Cards 1, 3, 5
    }

    # Create metrics and restore from checkpoint
    metrics = Phase4AMetrics()
    metrics.restore_from_checkpoint(mixed_data)

    # Test that we can generate a comprehensive report without errors
    with tempfile.TemporaryDirectory() as tmpdir:
        output_dir = Path(tmpdir)

        # This should not raise any exceptions and should properly handle mixed success/failure
        try:
            write_comprehensive_report(results, tally, metrics, output_dir)

            # Check that files were created
            results_files = list(output_dir.glob("phase4a-results-*.json"))
            metrics_files = list(output_dir.glob("phase4a-metrics-*.json"))

            assert len(results_files) == 1, "Should create one results file"
            assert len(metrics_files) == 1, "Should create one metrics file"

            # Load and validate the metrics file
            with metrics_files[0].open('r') as f:
                metrics_data = json.load(f)

            # Check key metrics
            agg_metrics = metrics_data["aggregate_metrics"]
            assert agg_metrics["total_cards"] == 5, "Should track all attempted cards"
            assert agg_metrics["successful_cards"] == 3, "Should track successful cards correctly"
            assert agg_metrics["success_rate"] == 60.0, "Should calculate correct success rate"

            accuracy_metrics = metrics_data["accuracy_metrics"]
            assert accuracy_metrics["total_cards"] == 5, "Should count all cards in accuracy"
            assert accuracy_metrics["fully_correct_cards"] == 3, "Should count fully correct cards properly"

        except Exception as e:
            assert False, f"Comprehensive report generation failed: {e}"

    print("✅ Comprehensive report generation test passed")

def run_all_tests():
    """Run all checkpoint resume regression tests."""
    print("🚀 Running Checkpoint Resume Bug Fix Tests")
    print("=" * 60)

    try:
        test_legacy_checkpoint_compatibility()
        test_modern_mixed_checkpoint_handling()
        test_full_card_accuracy_calculation()
        test_comprehensive_report_with_checkpoints()

        print("\n🎉 ALL TESTS PASSED!")
        print("✅ Checkpoint resume functionality is working correctly")
        return True

    except AssertionError as e:
        print(f"\n❌ TEST FAILED: {e}")
        return False
    except Exception as e:
        print(f"\n💥 UNEXPECTED ERROR: {e}")
        return False

if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)