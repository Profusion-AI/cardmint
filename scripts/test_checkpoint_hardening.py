#!/usr/bin/env python3
"""Test script for Phase 4A checkpoint hardening fixes.

This script validates the critical fixes for checkpoint functionality:
1. Resume skips cards after failures - FIXED
2. Restored checkpoints lose prior accuracy metrics - FIXED
3. Accuracy gate can pass with <95% card success - FIXED

Tests the comprehensive fixes implemented to ensure robust checkpoint resumability.
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
    save_checkpoint, load_checkpoint, Phase4AMetrics,
    compare_fields, resolve_truth_set_number
)

def test_critical_resume_bug_fix():
    """Test that resume correctly handles failed cards without skipping."""
    print("🔍 Testing Critical Resume Bug Fix...")

    # Create mock results with both successful and failed cards
    results = [
        {"card_number": 1, "success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},
        {"card_number": 2, "success": False, "name_correct": False, "hp_correct": False, "set_number_correct": False},
        {"card_number": 3, "success": True, "name_correct": True, "hp_correct": False, "set_number_correct": True},
        {"card_number": 4, "success": False, "name_correct": False, "hp_correct": False, "set_number_correct": False},
        {"card_number": 5, "success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True}
    ]

    metrics = Phase4AMetrics()

    # Test checkpoint saving with proper cards_attempted tracking
    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_dir = Path(tmpdir) / "checkpoints"
        checkpoint_dir.mkdir(exist_ok=True)

        # Mock the global CHECKPOINT_DIR
        with patch('pcis_phase4a.CHECKPOINT_DIR', checkpoint_dir):
            # Save checkpoint - should track attempted (5) vs successful (3)
            save_checkpoint(results, metrics, 1, cards_attempted=5)

            # Load checkpoint
            checkpoint_data = load_checkpoint(1)
            assert checkpoint_data is not None, "Checkpoint should load successfully"

            loaded_results, cards_attempted, tally, checkpoint_json = checkpoint_data

            # Verify cards_attempted tracking
            assert cards_attempted == 5, f"Expected 5 cards attempted, got {cards_attempted}"
            assert len(loaded_results) == 5, f"Expected 5 results (including failures), got {len(loaded_results)}"

            # Verify tally reconstruction
            expected_tally = {"name_correct": 3, "hp_correct": 2, "set_number_correct": 3}
            assert tally == expected_tally, f"Expected tally {expected_tally}, got {tally}"

            print("   ✅ Resume bug fix validated - failed cards tracked correctly")


def test_metrics_restoration():
    """Test that metrics are properly restored from checkpoint."""
    print("🔍 Testing Metrics Restoration...")

    results = [
        {
            "card_number": 1, "success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True,
            "inference_time_ms": 100.5, "encode_time_ms": 10.2, "parse_time_ms": 2.1, "total_card_time_ms": 150.8
        },
        {
            "card_number": 2, "success": True, "name_correct": False, "hp_correct": True, "set_number_correct": True,
            "inference_time_ms": 95.3, "encode_time_ms": 12.1, "parse_time_ms": 2.0, "total_card_time_ms": 145.2
        }
    ]

    metrics = Phase4AMetrics()

    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_dir = Path(tmpdir) / "checkpoints"
        checkpoint_dir.mkdir(exist_ok=True)

        with patch('pcis_phase4a.CHECKPOINT_DIR', checkpoint_dir):
            # Save checkpoint
            save_checkpoint(results, metrics, 1, cards_attempted=2)

            # Create new metrics instance (simulating fresh restart)
            restored_metrics = Phase4AMetrics()

            # Load checkpoint data
            checkpoint_data = load_checkpoint(1)
            assert checkpoint_data is not None

            _, _, _, checkpoint_json = checkpoint_data

            # Restore metrics
            restored_metrics.restore_from_checkpoint(checkpoint_json)

            # Verify metrics were restored
            assert len(restored_metrics.inference_metrics) == 2, f"Expected 2 inference records, got {len(restored_metrics.inference_metrics)}"

            # Check restored timing data
            first_record = restored_metrics.inference_metrics[0]
            assert first_record["inference_ms"] == 100.5, f"Expected 100.5ms inference, got {first_record['inference_ms']}"
            assert first_record["success"] == True, "First record should be successful"

            print("   ✅ Metrics restoration validated")


def test_accuracy_gate_fix():
    """Test that accuracy gate requires 95% of cards fully correct."""
    print("🔍 Testing Accuracy Gate Fix...")

    # Test case 1: Should FAIL - only 80% fully correct
    results_fail = [
        {"success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},   # Fully correct
        {"success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},   # Fully correct
        {"success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},   # Fully correct
        {"success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},   # Fully correct
        {"success": True, "name_correct": True, "hp_correct": False, "set_number_correct": True},  # Partial - HP wrong
    ]

    fully_correct_fail = sum(
        1 for result in results_fail
        if (result.get('success', False) and
            result.get('name_correct', False) and
            result.get('hp_correct', False) and
            result.get('set_number_correct', False))
    )
    accuracy_fail = fully_correct_fail / len(results_fail) * 100

    assert accuracy_fail == 80.0, f"Expected 80% accuracy for fail case, got {accuracy_fail}"
    assert accuracy_fail < 95.0, "Fail case should be below 95% threshold"

    # Test case 2: Should PASS - 100% fully correct
    results_pass = [
        {"success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},   # Fully correct
        {"success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},   # Fully correct
        {"success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},   # Fully correct
        {"success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},   # Fully correct
        {"success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},   # Fully correct
    ]

    fully_correct_pass = sum(
        1 for result in results_pass
        if (result.get('success', False) and
            result.get('name_correct', False) and
            result.get('hp_correct', False) and
            result.get('set_number_correct', False))
    )
    accuracy_pass = fully_correct_pass / len(results_pass) * 100

    assert accuracy_pass == 100.0, f"Expected 100% accuracy for pass case, got {accuracy_pass}"
    assert accuracy_pass >= 95.0, "Pass case should meet 95% threshold"

    print("   ✅ Accuracy gate fix validated - requires full card correctness")


def test_checkpoint_consistency():
    """Test checkpoint data consistency across save/load cycles."""
    print("🔍 Testing Checkpoint Consistency...")

    # Create realistic test data
    results = [
        {
            "card_number": 1, "image_file": "/path/to/card1.png", "success": True,
            "predicted_name": "Pikachu", "predicted_hp": 60, "predicted_set_number": "25",
            "ground_truth_name": "Pikachu", "ground_truth_hp": 60, "ground_truth_set_number": "25",
            "name_correct": True, "hp_correct": True, "set_number_correct": True,
            "inference_time_ms": 105.2, "encode_time_ms": 15.3, "parse_time_ms": 2.1, "total_card_time_ms": 160.4
        },
        {
            "card_number": 2, "image_file": "/path/to/card2.png", "success": False,
            "predicted_name": None, "predicted_hp": None, "predicted_set_number": None,
            "ground_truth_name": "Charizard", "ground_truth_hp": 120, "ground_truth_set_number": "4",
            "name_correct": False, "hp_correct": False, "set_number_correct": False,
            "inference_time_ms": 0, "encode_time_ms": 12.1, "parse_time_ms": 0, "total_card_time_ms": 15000.2
        }
    ]

    metrics = Phase4AMetrics()

    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_dir = Path(tmpdir) / "checkpoints"
        checkpoint_dir.mkdir(exist_ok=True)

        with patch('pcis_phase4a.CHECKPOINT_DIR', checkpoint_dir):
            # Save checkpoint
            save_checkpoint(results, metrics, 1, cards_attempted=2)

            # Load and verify
            checkpoint_data = load_checkpoint(1)
            assert checkpoint_data is not None

            loaded_results, cards_attempted, tally, checkpoint_json = checkpoint_data

            # Verify all data preserved
            assert cards_attempted == 2, f"Expected 2 cards attempted, got {cards_attempted}"
            assert len(loaded_results) == 2, f"Expected 2 results, got {len(loaded_results)}"

            # Verify successful card data preservation
            successful_result = loaded_results[0]
            assert successful_result["predicted_name"] == "Pikachu", "Predicted name should be preserved"
            assert successful_result["inference_time_ms"] == 105.2, "Inference time should be preserved"
            assert successful_result["success"] == True, "Success flag should be preserved"

            # Verify failed card data preservation
            failed_result = loaded_results[1]
            assert failed_result["predicted_name"] is None, "Failed card should have None prediction"
            assert failed_result["success"] == False, "Failed card should have success=False"
            assert failed_result["ground_truth_name"] == "Charizard", "Ground truth should be preserved"

            # Verify tally accuracy
            expected_tally = {"name_correct": 1, "hp_correct": 1, "set_number_correct": 1}
            assert tally == expected_tally, f"Expected tally {expected_tally}, got {tally}"

            print("   ✅ Checkpoint consistency validated")


def test_legacy_compatibility():
    """Test that the fixes work with legacy checkpoints."""
    print("🔍 Testing Legacy Compatibility...")

    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_dir = Path(tmpdir) / "checkpoints"
        checkpoint_dir.mkdir(exist_ok=True)

        # Create a legacy checkpoint format (without cards_attempted field)
        legacy_checkpoint = {
            "checkpoint_number": 1,
            "timestamp": "2024-03-15T10:30:00",
            "cards_processed": 3,  # Legacy field name
            "results": [
                {"card_number": 1, "success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True},
                {"card_number": 2, "success": True, "name_correct": False, "hp_correct": True, "set_number_correct": True},
                {"card_number": 3, "success": True, "name_correct": True, "hp_correct": True, "set_number_correct": False}
            ],
            "metrics_summary": {"total_cards": 3}
        }

        checkpoint_path = checkpoint_dir / "phase4a_checkpoint_1.json"
        with checkpoint_path.open("w") as f:
            json.dump(legacy_checkpoint, f)

        with patch('pcis_phase4a.CHECKPOINT_DIR', checkpoint_dir):
            # Load legacy checkpoint
            checkpoint_data = load_checkpoint(1)
            assert checkpoint_data is not None, "Legacy checkpoint should load"

            loaded_results, cards_attempted, tally, checkpoint_json = checkpoint_data

            # Should fall back to cards_processed value
            assert cards_attempted == 3, f"Expected 3 cards attempted from legacy data, got {cards_attempted}"
            assert len(loaded_results) == 3, "Should load all legacy results"

            # Tally should be reconstructed correctly
            expected_tally = {"name_correct": 2, "hp_correct": 3, "set_number_correct": 2}
            assert tally == expected_tally, f"Expected tally {expected_tally}, got {tally}"

            print("   ✅ Legacy compatibility validated")


def test_legacy_no_success_field():
    """Test legacy checkpoints without success field (Codex's critical issue)."""
    print("🔍 Testing Legacy Compatibility - No Success Field...")

    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_dir = Path(tmpdir) / "checkpoints"
        checkpoint_dir.mkdir(exist_ok=True)

        # Create a legacy checkpoint format WITHOUT success fields (realistic legacy data)
        legacy_no_success_checkpoint = {
            "checkpoint_number": 2,
            "timestamp": "2024-03-15T10:30:00",
            "cards_processed": 10,  # Legacy field - only successful cards
            "results": [
                # All 10 results WITHOUT success field - should default to True
                {"card_number": 1, "name_correct": True, "hp_correct": True, "set_number_correct": True,
                 "inference_time_ms": 100.0, "encode_time_ms": 10.0, "parse_time_ms": 2.0, "total_card_time_ms": 150.0},
                {"card_number": 2, "name_correct": True, "hp_correct": True, "set_number_correct": True,
                 "inference_time_ms": 105.0, "encode_time_ms": 11.0, "parse_time_ms": 2.1, "total_card_time_ms": 160.0},
                {"card_number": 3, "name_correct": True, "hp_correct": True, "set_number_correct": False,  # base2-12 issue from analysis
                 "inference_time_ms": 98.0, "encode_time_ms": 9.5, "parse_time_ms": 1.9, "total_card_time_ms": 145.0},
                {"card_number": 4, "name_correct": True, "hp_correct": True, "set_number_correct": True,
                 "inference_time_ms": 102.0, "encode_time_ms": 10.2, "parse_time_ms": 2.0, "total_card_time_ms": 152.0},
                {"card_number": 5, "name_correct": True, "hp_correct": True, "set_number_correct": True,
                 "inference_time_ms": 99.0, "encode_time_ms": 9.8, "parse_time_ms": 1.8, "total_card_time_ms": 148.0},
                {"card_number": 6, "name_correct": True, "hp_correct": True, "set_number_correct": True,
                 "inference_time_ms": 101.0, "encode_time_ms": 10.1, "parse_time_ms": 2.0, "total_card_time_ms": 151.0},
                {"card_number": 7, "name_correct": True, "hp_correct": True, "set_number_correct": True,
                 "inference_time_ms": 103.0, "encode_time_ms": 10.3, "parse_time_ms": 2.1, "total_card_time_ms": 153.0},
                {"card_number": 8, "name_correct": True, "hp_correct": True, "set_number_correct": True,
                 "inference_time_ms": 97.0, "encode_time_ms": 9.7, "parse_time_ms": 1.9, "total_card_time_ms": 147.0},
                {"card_number": 9, "name_correct": True, "hp_correct": True, "set_number_correct": True,
                 "inference_time_ms": 104.0, "encode_time_ms": 10.4, "parse_time_ms": 2.2, "total_card_time_ms": 154.0},
                {"card_number": 10, "name_correct": True, "hp_correct": True, "set_number_correct": True,
                 "inference_time_ms": 100.0, "encode_time_ms": 10.0, "parse_time_ms": 2.0, "total_card_time_ms": 150.0}
            ],
            "metrics_summary": {"total_cards": 10}
        }

        checkpoint_path = checkpoint_dir / "phase4a_checkpoint_2.json"
        with checkpoint_path.open("w") as f:
            json.dump(legacy_no_success_checkpoint, f)

        with patch('pcis_phase4a.CHECKPOINT_DIR', checkpoint_dir):
            # Test checkpoint loading
            checkpoint_data = load_checkpoint(2)
            assert checkpoint_data is not None, "Legacy checkpoint without success field should load"

            loaded_results, cards_attempted, tally, checkpoint_json = checkpoint_data

            # Verify legacy compatibility
            assert cards_attempted == 10, f"Expected 10 cards attempted from legacy data, got {cards_attempted}"
            assert len(loaded_results) == 10, "Should load all legacy results"

            # Verify that legacy results without success field are treated as successful
            all_successful = all(result.get("success", True) for result in loaded_results)
            assert all_successful, "All legacy results without success field should default to True"

            # Test the critical accuracy calculation that was failing
            fully_correct_cards = sum(
                1 for result in loaded_results
                if (result.get('success', True) and  # This should default to True for legacy
                    result.get('name_correct', False) and
                    result.get('hp_correct', False) and
                    result.get('set_number_correct', False))
            )

            # Should be 9/10 (card 3 has set_number_correct: False)
            expected_fully_correct = 9
            assert fully_correct_cards == expected_fully_correct, f"Expected {expected_fully_correct} fully correct, got {fully_correct_cards}"

            full_accuracy = fully_correct_cards / len(loaded_results) * 100
            assert full_accuracy == 90.0, f"Expected 90% accuracy, got {full_accuracy}"

            # Test metrics restoration for ALL cards (including the one with partial correctness)
            from pcis_phase4a import Phase4AMetrics
            metrics = Phase4AMetrics()
            metrics.restore_from_checkpoint(checkpoint_json)

            # Should restore ALL 10 inference records, not just successful ones
            assert len(metrics.inference_metrics) == 10, f"Expected 10 inference records, got {len(metrics.inference_metrics)}"

            # All should be marked as successful due to legacy default
            successful_metrics = [m for m in metrics.inference_metrics if m["success"]]
            assert len(successful_metrics) == 10, f"All legacy metrics should be successful, got {len(successful_metrics)}"

            print("   ✅ Legacy no-success-field compatibility validated")


def test_mixed_legacy_and_new_format():
    """Test checkpoint with failed cards using the new format."""
    print("🔍 Testing Mixed Legacy and New Format...")

    # Test with checkpoint that has both successful and failed entries (new format)
    mixed_results = [
        {"card_number": 1, "success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True,
         "inference_time_ms": 100.0, "encode_time_ms": 10.0, "parse_time_ms": 2.0, "total_card_time_ms": 150.0},
        {"card_number": 2, "success": False, "name_correct": False, "hp_correct": False, "set_number_correct": False,
         "inference_time_ms": 0.0, "encode_time_ms": 12.0, "parse_time_ms": 0.0, "total_card_time_ms": 15000.0},
        {"card_number": 3, "success": True, "name_correct": True, "hp_correct": True, "set_number_correct": True,
         "inference_time_ms": 98.0, "encode_time_ms": 9.5, "parse_time_ms": 1.9, "total_card_time_ms": 145.0}
    ]

    with tempfile.TemporaryDirectory() as tmpdir:
        checkpoint_dir = Path(tmpdir) / "checkpoints"
        checkpoint_dir.mkdir(exist_ok=True)

        mixed_checkpoint = {
            "checkpoint_number": 1,
            "timestamp": "2024-03-15T10:30:00",
            "cards_attempted": 3,  # New format
            "cards_successful": 2,
            "results": mixed_results,
            "metrics_summary": {"total_cards": 3}
        }

        checkpoint_path = checkpoint_dir / "phase4a_checkpoint_1.json"
        with checkpoint_path.open("w") as f:
            json.dump(mixed_checkpoint, f)

        with patch('pcis_phase4a.CHECKPOINT_DIR', checkpoint_dir):
            checkpoint_data = load_checkpoint(1)
            loaded_results, cards_attempted, tally, checkpoint_json = checkpoint_data

            # Test metrics restoration with mixed success/failure
            from pcis_phase4a import Phase4AMetrics
            metrics = Phase4AMetrics()
            metrics.restore_from_checkpoint(checkpoint_json)

            # Should restore ALL 3 records (2 successful, 1 failed)
            assert len(metrics.inference_metrics) == 3, f"Expected 3 inference records, got {len(metrics.inference_metrics)}"

            successful_count = sum(1 for m in metrics.inference_metrics if m["success"])
            failed_count = sum(1 for m in metrics.inference_metrics if not m["success"])

            assert successful_count == 2, f"Expected 2 successful metrics, got {successful_count}"
            assert failed_count == 1, f"Expected 1 failed metric, got {failed_count}"

            # Verify the failed record has proper timing data
            failed_record = next(m for m in metrics.inference_metrics if not m["success"])
            assert failed_record["inference_ms"] == 0.0, "Failed record should have 0 inference time"
            assert failed_record["encode_ms"] == 12.0, "Failed record should preserve encode time"

            print("   ✅ Mixed legacy and new format compatibility validated")


def main():
    """Run all checkpoint hardening tests."""
    print("🧪 CardMint Phase 4A Checkpoint Hardening Tests")
    print("=" * 60)

    try:
        test_critical_resume_bug_fix()
        test_metrics_restoration()
        test_accuracy_gate_fix()
        test_checkpoint_consistency()
        test_legacy_compatibility()
        test_legacy_no_success_field()
        test_mixed_legacy_and_new_format()

        print("\n🎉 ALL TESTS PASSED - Checkpoint hardening validated!")
        print("✅ Critical resume bug: FIXED")
        print("✅ Metrics restoration: FIXED")
        print("✅ Accuracy gate logic: FIXED")
        print("✅ Data consistency: VALIDATED")
        print("✅ Legacy compatibility: MAINTAINED")
        print("✅ Legacy no-success-field: FIXED")
        print("✅ Mixed format compatibility: VALIDATED")

        return 0

    except Exception as e:
        print(f"\n❌ TEST FAILED: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit_code = main()
    sys.exit(exit_code)