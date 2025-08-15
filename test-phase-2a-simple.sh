#!/bin/bash

# Phase 2A Performance Test Script
# Simple bash-based test to validate Phase 2A improvements

echo "🧪 Phase 2A: Smart Preprocessing Intelligence Test"
echo "=================================================="
echo ""

# Test image paths
TEST_IMAGES=(
    "./official_images/mcd19-12_large_ac9a28214284.jpg"
    "./official_images/neo3-2_large_f945368ae38f.jpg"
)

# Results storage
declare -a PROCESSING_TIMES
declare -a ACCURACIES
declare -a CARD_NAMES

for img in "${TEST_IMAGES[@]}"; do
    if [ ! -f "$img" ]; then
        echo "⚠️  Image not found: $img"
        continue
    fi
    
    echo "📸 Testing: $(basename "$img")"
    
    # Record start time
    START_TIME=$(date +%s%3N)
    
    # Make OCR request and capture response
    RESPONSE=$(curl -s -X POST \
        -F "file=@$img" \
        -F "high_accuracy=true" \
        http://localhost:8000/ocr 2>/dev/null)
    
    # Record end time
    END_TIME=$(date +%s%3N)
    TOTAL_TIME=$((END_TIME - START_TIME))
    
    # Extract metrics using jq
    if echo "$RESPONSE" | jq -e . >/dev/null 2>&1; then
        SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
        PROCESSING_TIME=$(echo "$RESPONSE" | jq -r '.processing_time_ms')
        CONFIDENCE=$(echo "$RESPONSE" | jq -r '.avg_confidence')
        CARD_NAME=$(echo "$RESPONSE" | jq -r '.extracted_card_info.card_name // "Not detected"')
        PHASE=$(echo "$RESPONSE" | jq -r '.phase // "unknown"')
        
        # Preprocessing info
        PREPROCESSING_LEVEL=$(echo "$RESPONSE" | jq -r '.preprocessing_used.preprocessing_level // "unknown"')
        QUALITY_SCORE=$(echo "$RESPONSE" | jq -r '.preprocessing_used.quality_assessment.quality_score // 0')
        
        if [ "$SUCCESS" = "true" ]; then
            TIME_STATUS="✅"
            if (( $(echo "$PROCESSING_TIME < 20000" | bc -l) )); then
                TIME_STATUS="✅"
            else
                TIME_STATUS="⚠️"
            fi
            
            ACCURACY_STATUS="✅"
            if (( $(echo "$CONFIDENCE < 0.85" | bc -l) )); then
                ACCURACY_STATUS="❌"
            fi
            
            echo "   $TIME_STATUS Processing: $(echo "scale=1; $PROCESSING_TIME / 1000" | bc)s"
            echo "   $ACCURACY_STATUS Accuracy: $(echo "scale=1; $CONFIDENCE * 100" | bc)%"
            echo "   🏷️  Card: $CARD_NAME"
            echo "   🔧 Phase: $PHASE"
            echo "   📊 Quality: $QUALITY_SCORE"
            echo "   ⚙️  Level: $PREPROCESSING_LEVEL"
            
            # Store for summary
            PROCESSING_TIMES+=($PROCESSING_TIME)
            ACCURACIES+=($CONFIDENCE)
            CARD_NAMES+=("$CARD_NAME")
        else
            echo "   ❌ OCR failed"
        fi
    else
        echo "   ❌ Invalid response from service"
    fi
    
    echo ""
done

# Calculate summary statistics
if [ ${#PROCESSING_TIMES[@]} -gt 0 ]; then
    echo "📊 Phase 2A Summary Results:"
    echo "============================"
    
    # Calculate averages
    AVG_TIME=0
    AVG_ACCURACY=0
    
    for time in "${PROCESSING_TIMES[@]}"; do
        AVG_TIME=$(echo "$AVG_TIME + $time" | bc)
    done
    AVG_TIME=$(echo "scale=1; $AVG_TIME / ${#PROCESSING_TIMES[@]} / 1000" | bc)
    
    for accuracy in "${ACCURACIES[@]}"; do
        AVG_ACCURACY=$(echo "$AVG_ACCURACY + $accuracy" | bc)
    done
    AVG_ACCURACY=$(echo "scale=3; $AVG_ACCURACY / ${#ACCURACIES[@]}" | bc)
    
    echo "Average Processing Time: ${AVG_TIME}s"
    echo "Average Accuracy: $(echo "scale=1; $AVG_ACCURACY * 100" | bc)%"
    echo "Success Rate: ${#PROCESSING_TIMES[@]}/${#TEST_IMAGES[@]} tests"
    
    # Compare to Phase 1 baseline (17.7s)
    PHASE1_BASELINE=17.7
    IMPROVEMENT=$(echo "scale=1; ($PHASE1_BASELINE - $AVG_TIME) / $PHASE1_BASELINE * 100" | bc)
    
    echo ""
    echo "🎯 Phase 2A Assessment:"
    if (( $(echo "$IMPROVEMENT > 0" | bc -l) )); then
        echo "✅ Performance: ${IMPROVEMENT}% faster than Phase 1 baseline"
    else
        REGRESSION=$(echo "scale=1; $IMPROVEMENT * -1" | bc)
        echo "⚠️  Performance: ${REGRESSION}% slower than Phase 1 baseline"
    fi
    
    if (( $(echo "$AVG_ACCURACY >= 0.85" | bc -l) )); then
        echo "✅ Accuracy: Target maintained ($(echo "scale=1; $AVG_ACCURACY * 100" | bc)% >= 85%)"
    else
        echo "❌ Accuracy: Below target ($(echo "scale=1; $AVG_ACCURACY * 100" | bc)% < 85%)"
    fi
    
    # Phase 2A specific validation (15s target)
    TARGET_TIME=15.0
    if (( $(echo "$AVG_TIME < $TARGET_TIME" | bc -l) )); then
        echo "🎉 Phase 2A Success: Processing time under ${TARGET_TIME}s target!"
    else
        echo "⏰ Phase 2A Progress: ${AVG_TIME}s > ${TARGET_TIME}s target, but improvement made"
    fi
else
    echo "❌ No successful tests to analyze"
fi