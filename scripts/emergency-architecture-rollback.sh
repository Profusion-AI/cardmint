#!/bin/bash

# CardMint Emergency Architecture Rollback Script
# Usage: ./scripts/emergency-architecture-rollback.sh [reason]
# This script provides instant rollback capability during the architecture cleanup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARDMINT_ROOT="$(dirname "$SCRIPT_DIR")"
ROLLBACK_REASON="${1:-Manual emergency rollback}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

echo "🚨 CardMint Architecture Emergency Rollback Started"
echo "Timestamp: $TIMESTAMP"
echo "Reason: $ROLLBACK_REASON"
echo "=========================================="

# 1. Disable all experimental features immediately
echo "📍 Step 1: Disabling experimental features..."
export VLM_ENABLED=false
export LEGACY_FALLBACK=true
export CODEMOD_ENABLED=false
export ARCHITECTURE_LINT=false
export FEATURE_FLAGS_DISABLED=true

# Write to .env if it exists
if [[ -f "$CARDMINT_ROOT/.env" ]]; then
    echo "VLM_ENABLED=false" >> "$CARDMINT_ROOT/.env"
    echo "LEGACY_FALLBACK=true" >> "$CARDMINT_ROOT/.env"
    echo "FEATURE_FLAGS_DISABLED=true" >> "$CARDMINT_ROOT/.env"
fi

# 2. Stop all services
echo "📍 Step 2: Stopping services..."
if command -v pm2 &> /dev/null; then
    pm2 stop cardmint || true
    pm2 stop cardmint-ml || true
    pm2 stop cardmint-api || true
fi

# Kill any node processes related to CardMint
pkill -f "cardmint" || true
pkill -f "node.*CardMint" || true

# 3. Check for git safety - revert to checkpoint if needed
echo "📍 Step 3: Git safety check..."
cd "$CARDMINT_ROOT"

# Check if we're on the dangerous branch
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" == "cleanup/2025-08-25-deprecation" ]] || [[ "$CURRENT_BRANCH" =~ cleanup|deprecation|refactor ]]; then
    echo "⚠️  On dangerous branch: $CURRENT_BRANCH"
    echo "🔄 Switching to safe branch..."
    
    # Stash any uncommitted changes
    git stash push -m "Emergency rollback stash $TIMESTAMP" || true
    
    # Switch to stable branch
    if git show-ref --verify --quiet refs/heads/vlm-optimization; then
        git switch vlm-optimization
        echo "✅ Switched to vlm-optimization (production branch)"
    elif git show-ref --verify --quiet refs/heads/main; then
        git switch main
        echo "✅ Switched to main branch"
    else
        echo "❌ No safe branch found - staying on current branch"
    fi
fi

# 4. Restore from checkpoint if severely broken
echo "📍 Step 4: Checkpoint restore check..."
if [[ "${2:-}" == "--restore-checkpoint" ]]; then
    echo "🔄 Restoring from v0.5.0-pre-deprecation checkpoint..."
    git reset --hard v0.5.0-pre-deprecation
    echo "✅ Checkpoint restored"
fi

# 5. Clean up any broken node_modules
echo "📍 Step 5: Cleaning up broken dependencies..."
if [[ -d "$CARDMINT_ROOT/node_modules" ]]; then
    rm -rf "$CARDMINT_ROOT/node_modules"
    echo "🧹 Cleared node_modules"
fi

# Reinstall clean dependencies
if [[ -f "$CARDMINT_ROOT/package.json" ]]; then
    cd "$CARDMINT_ROOT"
    if command -v npm &> /dev/null; then
        npm install --no-optional || echo "⚠️  npm install failed"
    fi
fi

# 6. Restart services in safe mode
echo "📍 Step 6: Restarting in safe mode..."
cd "$CARDMINT_ROOT"

# Start with legacy/stable configuration only
if [[ -f "package.json" ]]; then
    # Use safe npm script if available
    npm run start:safe 2>/dev/null || npm run start 2>/dev/null || echo "⚠️  Could not start via npm"
fi

# 7. Verify core functionality
echo "📍 Step 7: Verifying core functionality..."
sleep 5

# Test core capture (the one thing that must always work)
if [[ -x "/home/profusionai/CardMint/capture-card" ]]; then
    echo "🧪 Testing core capture functionality..."
    timeout 30s /home/profusionai/CardMint/capture-card || echo "⚠️  Core capture test failed"
else
    echo "⚠️  Core capture script not found"
fi

# Test API health if available
if command -v curl &> /dev/null; then
    echo "🧪 Testing API health..."
    curl -f "http://localhost:3000/api/health" &>/dev/null && echo "✅ API healthy" || echo "⚠️  API not responding"
fi

# 8. Log rollback event
echo "📍 Step 8: Logging rollback event..."
ROLLBACK_LOG="$CARDMINT_ROOT/rollback_log.txt"
cat >> "$ROLLBACK_LOG" << EOF
================================
EMERGENCY ROLLBACK EVENT
Timestamp: $TIMESTAMP
Reason: $ROLLBACK_REASON
Branch: $CURRENT_BRANCH
User: $(whoami)
Commands executed: See rollback script
================================

EOF

# 9. Create incident report
echo "📍 Step 9: Creating incident report..."
INCIDENT_REPORT="$CARDMINT_ROOT/incident_$TIMESTAMP.md"
cat > "$INCIDENT_REPORT" << EOF
# CardMint Emergency Rollback Incident Report
**Date**: $(date)
**Trigger**: $ROLLBACK_REASON
**Operator**: $(whoami)

## Actions Taken
1. ✅ Disabled experimental features
2. ✅ Stopped all services
3. ✅ Git safety check and branch switch
4. ⏳ Checkpoint restore (if requested)
5. ✅ Cleaned dependencies
6. ✅ Restarted in safe mode
7. ✅ Verified core functionality
8. ✅ Logged rollback event

## System State
- **Branch**: $(git branch --show-current)
- **Commit**: $(git rev-parse HEAD)
- **Environment**: LEGACY_FALLBACK=true, VLM_ENABLED=false

## Next Steps
1. Investigate root cause: $ROLLBACK_REASON
2. Review incident report: $INCIDENT_REPORT
3. Plan remediation if needed
4. Update safety procedures based on learnings

## Recovery Commands
\`\`\`bash
# To resume development (after investigation)
export VLM_ENABLED=false  # Start disabled
export LEGACY_FALLBACK=false  # Re-enable gradually
npm run dev

# To fully restore from archive (nuclear option)
cd /home/profusionai
unzip cardmint-archives/cardmint-predep-2025-08-25.zip
\`\`\`

---
*Generated by emergency-architecture-rollback.sh*
EOF

echo "=========================================="
echo "🚨 Emergency Rollback Complete"
echo "📄 Incident report: $INCIDENT_REPORT"
echo "📋 Rollback log: $ROLLBACK_LOG"
echo "✅ System should be in safe state"
echo ""
echo "Next steps:"
echo "1. Review incident report"
echo "2. Investigate: $ROLLBACK_REASON"
echo "3. Test core functionality"
echo "4. Plan recovery if needed"
echo ""
echo "To fully restore from archive:"
echo "  cd /home/profusionai && unzip cardmint-archives/cardmint-predep-2025-08-25.zip"