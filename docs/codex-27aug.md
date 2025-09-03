# CardMint – 27 Aug Summary (codex-27aug.md)

## What I Changed Today
- Watcher pathing: Switched `ProductionCaptureWatcher` from watching the directory with a custom `ignored` filter to a file glob.
  - Before: `chokidar.watch(watchDirectory, { ignored: (...) => !pattern.test(basename) })`
  - After: `chokidar.watch(path.join(watchDirectory, '*.jpg'), ...)`
  - Rationale: Prevents the root directory from being ignored and ensures add/change events fire reliably.
- Start order: Start `ProductionCaptureWatcher` regardless of camera init success so files always trigger processing.
  - Implemented in `src/index.ts` before the camera init block.
- Reliability tweaks: Enabled polling (`usePolling: true`, `interval: 300`) and `ignorePermissionErrors` for constrained environments/containers. Added temporary debug `all` event logging to aid diagnosis.
- Logging: Startup logs now report the exact glob being watched for clarity.

Files modified
- `src/services/ProductionCaptureWatcher.ts`
  - Use glob `.../inventory_images/*.jpg`
  - Removed custom `ignored` filter; added polling and debug `all` event hook
  - Updated ready log to show the actual glob
- `src/index.ts`
  - Instantiate + start `ProductionCaptureWatcher` unconditionally

## Why This Fixes The Triggering Issue
- The previous `ignored` predicate effectively caused chokidar to ignore the root directory, suppressing file events. Using a direct glob matches files without muting the directory itself.
- Starting the watcher independent of camera health ensures processing continues even when the camera layer hits errors.

## How To Verify (E2E)
- Prereqs: `cp .env.example .env`, `npm i`.
- Run in E2E mode: `E2E_NO_REDIS=true npm run dev:api` (or `npm run dev:full`).
- Drop a test image: create `./data/inventory_images/card_YYYYMMDD_HHMMSS.jpg`.
- Expect logs:
  - “New production capture detected …”
  - “Created card record …”
  - “Queued production capture for processing …”
- In E2E, `FileQueueManager` emits `processJob` and `IntegratedScannerService` completes the job. You should see “Job … completed successfully”.
- Note: Temporary debug logs show watcher events; we can remove them after validation.

## Current Pipeline Status
- Direct ML pipeline (IntegratedScannerService) validated as working and accurate via your test script.
- Watcher now starts early and watches via robust glob/polling; designed to function even if camera integration is flaky.

## Workload Capacity (Tomorrow’s Plan)
- Baseline single-worker throughput (E2E mode): ~12–13s per card (dominated by remote ML), ~5 cards/min (~300/hour).
  - Current `FileQueueManager` intentionally processes one job at a time; concurrency = 1.
- Tomorrow’s goals:
  - Run a soak test with 20–30 images dropped into `data/inventory_images` and confirm steady throughput and queue drain time.
  - Validate processed tracking (`./data/processed_captures.json`) prevents reprocessing across restarts.
  - Exercise reprocessing path: call `ProductionCaptureWatcher.reprocessFile('card_...jpg')` on one sample and confirm requeue.
  - Confirm filename patterning: only files matching `card_YYYYMMDD_HHMMSS.jpg` are processed.
  - Optional: Evaluate raising concurrency (either add a second worker loop or move to the distributed/Redis worker for higher parallelism) if we need >5/min throughput.

## Known Follow-ups
- Remove debug `all` watcher logging once validated.
- If capture timing is impacted, revisit polling config (prefer native fs events in production environment, keep polling only for constrained setups).
- Investigate controller/camera error codes separately from the watcher; they are orthogonal to file-triggered processing.

## Quick Commands
- E2E dev API: `E2E_NO_REDIS=true npm run dev:api`
- Full dev (API + worker + dashboard): `npm run dev:full`
- Drop a file: `cp <img>.jpg data/inventory_images/card_YYYYMMDD_HHMMSS.jpg`

