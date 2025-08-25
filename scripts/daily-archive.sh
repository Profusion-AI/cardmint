#!/bin/bash

# CardMint Daily Archive Script
# Automatically archives processed captures to 4TB drive
# Runs daily at 4:30 PM via systemd timer

set -euo pipefail

# Configuration
ARCHIVE_BASE="/mnt/usb_transfer/CardMint/archive"
SOURCE_DIR="$HOME/CardMint/captures"
DB_PATH="$HOME/CardMint/data/cardmint.db"
LOG_FILE="$HOME/CardMint/logs/archive.log"
RETENTION_DAYS=7  # Keep locally for 7 days before archiving

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== CardMint Daily Archive Started ==="

# Check if source directory exists
if [[ ! -d "$SOURCE_DIR" ]]; then
    log "ERROR: Source directory $SOURCE_DIR not found"
    exit 1
fi

# Check if 4TB drive is mounted
if [[ ! -d "$ARCHIVE_BASE" ]]; then
    log "ERROR: Archive drive not mounted at $ARCHIVE_BASE"
    log "Please ensure 4TB USB drive is connected and mounted"
    exit 1
fi

# Create archive directory structure
DATE_PATH=$(date +%Y/%m/%d)
ARCHIVE_DIR="$ARCHIVE_BASE/$DATE_PATH"

log "Creating archive directory: $ARCHIVE_DIR"
mkdir -p "$ARCHIVE_DIR"

# Check available space on archive drive
ARCHIVE_SPACE=$(df -BG "$ARCHIVE_BASE" | tail -1 | awk '{print $4}' | sed 's/G//')
if [[ "$ARCHIVE_SPACE" -lt 50 ]]; then
    log "WARNING: Archive drive has less than 50GB free space ($ARCHIVE_SPACE GB)"
fi

# Find files to archive (older than retention period)
log "Finding files older than $RETENTION_DAYS days in $SOURCE_DIR"

ARCHIVED_COUNT=0
ARCHIVED_SIZE=0
FAILED_COUNT=0

# Process JPG files older than retention period
while IFS= read -r -d '' file; do
    if [[ -f "$file" ]]; then
        filename=$(basename "$file")
        
        # Generate checksum for integrity verification
        checksum=$(sha256sum "$file" | cut -d' ' -f1)
        file_size=$(stat -c%s "$file")
        
        log "Archiving: $filename ($(numfmt --to=iec $file_size), checksum: ${checksum:0:16}...)"
        
        # Copy to archive with verification
        if cp "$file" "$ARCHIVE_DIR/"; then
            # Verify copied file
            archive_checksum=$(sha256sum "$ARCHIVE_DIR/$filename" | cut -d' ' -f1)
            
            if [[ "$checksum" == "$archive_checksum" ]]; then
                # Log to manifest
                echo "$filename|$checksum|$(date -Iseconds)|$file_size" >> "$ARCHIVE_DIR/manifest.txt"
                
                # Remove original after successful archive
                rm "$file"
                
                ARCHIVED_COUNT=$((ARCHIVED_COUNT + 1))
                ARCHIVED_SIZE=$((ARCHIVED_SIZE + file_size))
                
                log "✅ Successfully archived: $filename"
            else
                log "❌ Checksum mismatch for $filename, keeping original"
                rm "$ARCHIVE_DIR/$filename"  # Remove corrupted copy
                FAILED_COUNT=$((FAILED_COUNT + 1))
            fi
        else
            log "❌ Failed to copy $filename to archive"
            FAILED_COUNT=$((FAILED_COUNT + 1))
        fi
    fi
done < <(find "$SOURCE_DIR" -name "*.JPG" -type f -mtime +$RETENTION_DAYS -print0)

# Update database with archive paths
if [[ -f "$DB_PATH" && $ARCHIVED_COUNT -gt 0 ]]; then
    log "Updating database with archive paths"
    
    sqlite3 "$DB_PATH" <<EOF
UPDATE cards 
SET metadata = json_set(
    COALESCE(metadata, '{}'), 
    '$.archive_path', '$ARCHIVE_DIR',
    '$.archived_at', '$(date -Iseconds)'
)
WHERE status IN ('approved', 'processed') 
  AND datetime(captured_at) < datetime('now', '-$RETENTION_DAYS days')
  AND json_extract(metadata, '$.archive_path') IS NULL;
EOF
    
    # Log archive statistics to database
    sqlite3 "$DB_PATH" <<EOF
INSERT INTO archive_log (
    archive_date,
    archive_path,
    file_count,
    total_size_mb,
    checksum_manifest,
    source_path
) VALUES (
    date('now'),
    '$ARCHIVE_DIR',
    $ARCHIVED_COUNT,
    $((ARCHIVED_SIZE / 1024 / 1024)),
    '$ARCHIVE_DIR/manifest.txt',
    '$SOURCE_DIR'
);
EOF
    
    log "Database updated with archive information"
fi

# Generate summary report
ARCHIVE_SIZE_MB=$((ARCHIVED_SIZE / 1024 / 1024))
ARCHIVE_SIZE_HUMAN=$(numfmt --to=iec $ARCHIVED_SIZE)

log "=== Archive Summary ==="
log "Files archived: $ARCHIVED_COUNT"
log "Total size: $ARCHIVE_SIZE_HUMAN ($ARCHIVE_SIZE_MB MB)"
log "Failed: $FAILED_COUNT"
log "Archive location: $ARCHIVE_DIR"

# Check if manifest was created
if [[ -f "$ARCHIVE_DIR/manifest.txt" ]]; then
    log "Manifest created: $(wc -l < "$ARCHIVE_DIR/manifest.txt") entries"
else
    log "No manifest created (no files archived)"
fi

# Cleanup old archive logs (keep 30 days)
find "$(dirname "$LOG_FILE")" -name "archive.log*" -mtime +30 -delete 2>/dev/null || true

# Send notification if files were archived
if [[ $ARCHIVED_COUNT -gt 0 ]]; then
    # Create notification for dashboard
    curl -s -X POST "http://localhost:3000/api/notifications" \
        -H "Content-Type: application/json" \
        -d "{
            \"type\": \"archive_complete\",
            \"message\": \"Archived $ARCHIVED_COUNT files ($ARCHIVE_SIZE_HUMAN) to $ARCHIVE_DIR\",
            \"timestamp\": \"$(date -Iseconds)\"
        }" 2>/dev/null || true
        
    log "📦 Archive complete: $ARCHIVED_COUNT files moved to 4TB drive"
else
    log "📄 No files to archive (all files within $RETENTION_DAYS day retention)"
fi

log "=== CardMint Daily Archive Complete ==="

exit 0