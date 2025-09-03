<!-- (Codex-CTO) HEIC Strategy A: Normalize on ingest; keep JPEG pipeline intact -->

# HEIC Integration Plan (Strategy A)

Goal: Accept `.heic/.heif` inputs and normalize to JPEG at ingestion, preserving the existing JPEG-based pipeline (OCR/ML/UI) while leaving the door open for future HEIF-native enhancements.

## Summary
- Keep capture → inventory as-is (SDK currently delivers `.jpg` via PC Remote).
- Allow `.heic` from other sources/imports.
- Normalize HEIC→JPEG on ingest (watcher), atomically rename into `data/inventory_images`.
- Preserve optional original `.heic` for auditing if desired.

## Why Strategy A
- Near 1:1 swap from the perspective of downstream services.
- Minimal risk and packaging complexity; decode-only avoids HEVC licensing concerns.
- Conversion latency is small (typically 50–200ms) vs. overall capture latency.

## Components
- `src/utils/heic-normalizer.ts`
  - Sharp fast path (requires libvips with libheif).
  - Fallback to `heif-convert` CLI if sharp lacks HEIF support.
  - API:
    - `heicSupportAvailable(): boolean`
    - `normalizeHeic(source: Buffer | string, opts?): Promise<{ jpegBuffer, info }>`
    - `normalizeIfHeic(sourcePath): Promise<{ normalizedPath | null, result? }>`

## Env Flags
- `ALLOW_HEIC=1` Enable HEIC acceptance.
- `HEIC_PRESERVE_ORIGINAL=1` Keep original `.heic` alongside normalized JPEG (optional).
- `HEIC_NORMALIZE_QUALITY=90` JPEG quality used by normalizer.
- `HEIC_MAX_DIM_PX=3000` Optional max dimension for normalization (keeps aspect).

## Watcher Changes (for Claude)
- `src/services/ProductionCaptureWatcher.ts`
  - Update glob/regex to watch `*.{jpg,jpeg,heic}`.
  - If extension is `.heic/.heif`, call `normalizeHeic()` and write JPEG into staging; perform atomic rename into inventory dir.
  - Record `imageUrl` as final `.jpg`; optionally include `originalPath` in stored metadata when `HEIC_PRESERVE_ORIGINAL=1`.
  - Keep concurrency/backpressure unchanged. Maintain `.tmp` ignore and atomic rename.

## API/UI (optional)
- `src/api/router.ts`: Add HEIC MIME types only if serving originals; UI can continue to use JPEG thumbnails.
- `camera-websocket`: For latest capture, prefer JPEG when both `.heic` and `.jpg` exist.

## Doctor Probe (optional)
- `src/config/doctor.ts`: Add a check to log HEIC support: `sharp.format.heif?.input`. Warn if unsupported and `ALLOW_HEIC=1`.

## Acceptance Criteria
- Dropping a `.heic` into the watched directory yields exactly one `.jpg` in `data/inventory_images/` via atomic rename; queue receives a job.
- If HEIC decode unsupported and no CLI fallback present, log a clear guidance message; pipeline continues to accept JPEG.
- HEIC→JPEG p50 < 200ms on main host; no E2E regression in capture pipeline.

## Future (Strategy B placeholder)
- Native HEIC end-to-end with libheif on Node and pillow-heif on Python, OpenCV bridge, and broader MIME support. Requires packaging validation and HEVC licensing review.

