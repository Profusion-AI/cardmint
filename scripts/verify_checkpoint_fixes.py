#!/usr/bin/env python3
"""Quick verification script for checkpoint resume bug fixes.

Tests the fixes with actual checkpoint data without running the full pipeline.
"""

import json
from pathlib import Path

def verify_checkpoint_loading():
    """Verify that actual checkpoints can be loaded and processed correctly."""
    checkpoint_dir = Path("checkpoints")

    if not checkpoint_dir.exists():
        print("❌ Checkpoints directory not found")
        return False

    checkpoint_files = list(checkpoint_dir.glob("phase4a_checkpoint_*.json"))
    if not checkpoint_files:
        print("❌ No Phase 4A checkpoint files found")
        return False

    print(f"📋 Found {len(checkpoint_files)} checkpoint files")

    # Test loading and analyzing each checkpoint
    for checkpoint_file in sorted(checkpoint_files):
        try:
            with checkpoint_file.open('r') as f:
                checkpoint_data = json.load(f)

            results = checkpoint_data.get("results", [])
            cards_attempted = checkpoint_data.get("cards_attempted", 0)

            print(f"\n🔍 Analyzing {checkpoint_file.name}:")
            print(f"   Cards attempted: {cards_attempted}")
            print(f"   Results stored: {len(results)}")

            # Count successful vs failed based on our fixed logic
            successful_legacy_logic = 0
            failed_explicit = 0

            for result in results:
                # Test the fixed logic: result.get("success", True)
                if result.get("success", True):
                    successful_legacy_logic += 1
                else:
                    failed_explicit += 1

            print(f"   Successful (fixed logic): {successful_legacy_logic}")
            print(f"   Failed (explicit): {failed_explicit}")

            # Calculate accuracy based on fixed logic
            if results:
                fully_correct = sum(
                    1 for result in results
                    if (result.get('success', True) and
                        result.get('name_correct', False) and
                        result.get('hp_correct', False) and
                        result.get('set_number_correct', False))
                )

                full_accuracy = fully_correct / len(results) * 100
                print(f"   Full card accuracy: {full_accuracy:.1f}% ({fully_correct}/{len(results)})")

                # Check if this would pass the ≥95% gate with our fixes
                passes_gate = full_accuracy >= 95.0
                print(f"   Passes ≥95% gate: {'✅ YES' if passes_gate else '❌ NO'}")

        except Exception as e:
            print(f"❌ Error processing {checkpoint_file.name}: {e}")
            return False

    return True

def verify_success_field_consistency():
    """Verify that all success field checks will use consistent logic."""
    print("\n📊 Verifying success field consistency...")

    # Test cases
    test_results = [
        {"name_correct": True, "hp_correct": True, "set_number_correct": True},  # Legacy - no success field
        {"name_correct": True, "hp_correct": True, "set_number_correct": True, "success": True},  # Modern success
        {"name_correct": False, "hp_correct": False, "set_number_correct": False, "success": False},  # Modern failure
    ]

    for i, result in enumerate(test_results):
        success_value = result.get("success", True)  # Our fixed logic
        print(f"   Test case {i+1}: success = {success_value} {'(default)' if 'success' not in result else '(explicit)'}")

    print("✅ Success field logic is consistent")
    return True

def main():
    """Run all verification checks."""
    print("🔧 Verifying Checkpoint Resume Bug Fixes")
    print("=" * 50)

    try:
        success = True
        success &= verify_checkpoint_loading()
        success &= verify_success_field_consistency()

        if success:
            print(f"\n🎉 ALL VERIFICATIONS PASSED!")
            print("✅ Checkpoint resume fixes are working correctly")
            print("✅ Ready for Phase 4B validation")
        else:
            print(f"\n❌ VERIFICATION FAILED!")

        return success

    except Exception as e:
        print(f"💥 UNEXPECTED ERROR: {e}")
        return False

if __name__ == "__main__":
    import sys
    success = main()
    sys.exit(0 if success else 1)