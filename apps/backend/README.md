# CardMint Backend

**High-level architecture**: Express.js REST API with SQLite persistence, event-driven job queue, and pluggable inference/retrieval layers.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        HTTP Layer                            │
│  Express Server (server.ts)                                  │
│  - REST endpoints (/api/*, /metrics, /health)               │
│  - Static file serving (job images)                         │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│                    Service Layer                             │
│                                                              │
│  ┌─────────────────┐    ┌──────────────────┐              │
│  │  CaptureAdapter │    │   JobWorker      │              │
│  │  (Sony binary)  │    │  (background)    │              │
│  └────────┬────────┘    └────────┬─────────┘              │
│           │                      │                          │
│           │        ┌─────────────▼──────────┐              │
│           │        │    JobQueue            │              │
│           │        │  (event-driven queue)  │              │
│           │        └─────────────┬──────────┘              │
│           │                      │                          │
│  ┌────────▼──────────────────────▼───────────┐             │
│  │          Inference + Retrieval             │             │
│  │                                            │             │
│  │  ┌──────────────┐   ┌──────────────────┐  │             │
│  │  │  LM Studio   │   │ RetrievalService │  │             │
│  │  │  (Vision)    │   │  - Scorer        │  │             │
│  │  │              │   │  - PriceCharting │  │             │
│  │  │              │   │  - Enrichment    │  │             │
│  │  └──────────────┘   └──────────────────┘  │             │
│  └────────────────────────────────────────────┘             │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│                   Persistence Layer                          │
│                                                              │
│  ┌─────────────────┐    ┌──────────────────┐              │
│  │  JobRepository  │    │  PriceCharting   │              │
│  │   (SQLite)      │    │   Repository     │              │
│  └─────────────────┘    └──────────────────┘              │
│                                                              │
│  Database: cardmint_dev.db (SQLite)                         │
└──────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/
├── server.ts                    # Express app + dependency wiring
├── config.ts                    # Runtime configuration (env vars)
├── migrate.ts                   # Auto-run migrations on startup
│
├── domain/
│   └── job.ts                   # Core types: ScanJob, JobStatus, Candidate
│
├── db/
│   ├── connection.ts            # SQLite database factory
│   └── migrations/              # SQL migration files
│       ├── 20251002_operator_ui.sql
│       ├── 20251004_add_job_locking.sql
│       └── 20251005_reference_datasets.sql
│
├── repositories/
│   └── jobRepository.ts         # SQLite CRUD for jobs table
│
├── services/
│   ├── captureAdapter.ts        # Spawns Sony capture binary
│   ├── jobQueue.ts              # In-memory event-driven queue
│   ├── jobWorker.ts             # Background processor loop
│   │
│   ├── inference/
│   │   └── lmstudio.ts          # LM Studio vision API client
│   │
│   └── retrieval/
│       ├── retrievalService.ts  # Orchestrates search + scoring + enrichment
│       ├── candidateScorer.ts   # Pluggable scoring algorithm (BasicScorer)
│       ├── pricechartingRepository.ts  # PriceCharting CSV ingestion + search
│       └── stubEnrichment.ts    # Placeholder for RFC-002 API enrichment
│
└── routes/                      # (empty - routes inline in server.ts)
```

## Core Concepts

### Job Lifecycle

```
QUEUED → CAPTURING → CAPTURED → PREPROCESSING → INFERENCING
  → CANDIDATES_READY → OPERATOR_PENDING
  → [ACCEPTED | FLAGGED | NEEDS_REVIEW | FAILED]
```

**Active States** (worker processes):
- `QUEUED`, `CAPTURING`, `CAPTURED`, `PREPROCESSING`, `INFERENCING`, `CANDIDATES_READY`, `OPERATOR_PENDING`

**Terminal States** (operator resolved):
- `ACCEPTED`, `FLAGGED`, `NEEDS_REVIEW`, `FAILED`

### Job Queue

Event-driven in-memory queue backed by SQLite persistence:

- **Events**: `job:queued`, `job:updated`, `job:completed`
- **Locking**: Worker claims jobs with 60s timeout (prevents duplicate processing)
- **FIFO ordering**: Jobs processed in creation order
- **Warmup**: Retrieval service preloads on startup

### Job Worker

Background loop (500ms poll interval):

1. **Claim** next pending job (locks it)
2. **Inference** via LM Studio (extracts card_name, hp_value, set_number)
3. **Retrieval** from PriceCharting dataset (top 3 candidates)
4. **Attach** candidates + extracted fields to job
5. **Update** status to `OPERATOR_PENDING`
6. **Release** lock

**Idle behavior**: If no jobs for 10 minutes, triggers keepalive warmup.

### Inference Layer

**LM Studio Integration** (`services/inference/lmstudio.ts`):
- Endpoint: `http://10.0.24.97:12345/v1/chat/completions`
- Model: `mistralai/magistral-small-2509`
- Config: 777 context + 42 max_tokens (Phase 4D baseline)
- Input: base64 PNG image
- Output: JSON schema with `card_name`, `hp_value`, `set_number`

### Retrieval Layer

**Pluggable Architecture** (Oct 3 design):

```typescript
interface CandidateScorer {
  score(extracted: ExtractedFields, candidate: PriceChartingCandidate): number;
}

interface EnrichmentAdapter {
  enrichCandidates(extracted: ExtractedFields, candidates: Candidate[]): Promise<Candidate[]>;
}
```

**Current Implementation**:
- **Scorer**: `BasicCandidateScorer` (name fuzzy match + sales volume)
- **Enrichment**: `StubEnrichmentAdapter` (returns input unchanged, defer to RFC-002)

**Data Source**: PriceCharting CSV (72,056 cards)
- Ingested on first request
- Indexed in SQLite reference_data table
- Searched via LIKE queries on product_name

### Capture Adapter

Spawns external Sony capture binary:
- Path: `/home/kyle/CardMint-workspace/apps/sony-capture-operator/target/release/sony-capture-operator`
- Timeout: 30s
- Output: JSON with job metadata
- Creates job in `QUEUED` state with image_path

## API Endpoints

### Health & Metrics

**GET /health**
```json
{
  "status": "ok",
  "queueDepth": 13,
  "warning": true
}
```

**GET /metrics**
```json
{
  "queueDepth": 13,
  "warning": true,
  "recent": [...]
}
```

### Job Operations

**POST /api/capture**
- Triggers Sony capture binary
- Returns job + queue depth
- 503 if binary unavailable

**GET /api/jobs/recent**
```json
{
  "jobs": [
    {
      "id": "uuid",
      "status": "OPERATOR_PENDING",
      "created_at": 1696351200000,
      "updated_at": 1696351210000,
      "image_path": "/path/to/image.png",
      "extracted": {
        "card_name": "Pikachu",
        "hp_value": 60,
        "set_number": "4"
      },
      "top3": [
        {
          "id": "pricecharting:12345",
          "title": "Pikachu - Base Set",
          "confidence": 0.95,
          "source": "local"
        }
      ],
      "timings": {
        "capture_ms": 1200,
        "infer_ms": 16600,
        "end_to_end_ms": 18500
      },
      "session_id": "2024-10-03-AM",
      "retry_count": 0
    }
  ]
}
```

**PATCH /api/jobs/:id**
```json
{
  "action": "ACCEPT",
  "candidateIndex": 0
}
```
Actions: `ACCEPT`, `FLAG`, `RETRY`

**GET /api/jobs/:id/image**
- Serves image file from `image_path`
- 404 if missing

**POST /api/jobs/:id/status**
```json
{
  "status": "ACCEPTED"
}
```
Legacy endpoint (prefer PATCH)

**POST /api/jobs/:id/candidates**
```json
{
  "extracted": { "card_name": "Pikachu", "hp_value": 60, "set_number": "4" },
  "candidates": [...]
}
```
Direct candidate attachment (testing only)

## Configuration

**Environment Variables** (via `.env` or runtime):

```bash
# LM Studio endpoint
CARDMINT_LMSTUDIO_ENDPOINT=http://10.0.24.97:12345

# PriceCharting dataset
CARDMINT_PRICECHARTING_CSV=/path/to/pricecharting-pokemon-cards.csv

# Queue warning threshold
CARDMINT_QUEUE_WARN_DEPTH=10

# Server port
PORT=4000
```

**Defaults** (from `config.ts`):
- Retrieval DB: `data/cardmint_dev.db`
- Capture binary: Auto-detected in workspace
- Queue warn depth: 10 jobs

## Database Schema

**jobs table**:
```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  image_path TEXT,
  extracted TEXT,           -- JSON: ExtractedFields
  top3 TEXT,                -- JSON: Candidate[]
  retry_count INTEGER DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  operator_id TEXT,
  session_id TEXT,
  timings TEXT,             -- JSON: StageTimings
  processor_id TEXT,
  locked_at INTEGER
);
```

**reference_data table**:
```sql
CREATE TABLE reference_data (
  dataset_key TEXT NOT NULL,
  record_id TEXT NOT NULL,
  data TEXT NOT NULL,       -- JSON
  PRIMARY KEY (dataset_key, record_id)
);
```

## Development

**Start backend**:
```bash
cd apps/backend
npm run dev
```

**Run migrations**:
```bash
npm run migrate
```

**Build for production**:
```bash
npm run build
node dist/server.js
```

## Testing

**Manual API test**:
```bash
# Health check
curl http://localhost:4000/health

# Trigger capture
curl -X POST http://localhost:4000/api/capture

# List recent jobs
curl http://localhost:4000/api/jobs/recent

# Accept job
curl -X PATCH http://localhost:4000/api/jobs/<job-id> \
  -H "Content-Type: application/json" \
  -d '{"action":"ACCEPT","candidateIndex":0}'
```

## Extension Points

### RFC-001: Enhanced Vision Extraction
- Modify `services/inference/lmstudio.ts` to extract copyright years + confidence scores
- Update `domain/job.ts` ExtractedFields schema
- Add new migration for schema changes

### RFC-002: PokePriceTracker Enrichment
- Replace `StubEnrichmentAdapter` with `PokePriceTrackerAdapter`
- Add API client in `services/retrieval/pokepricetracker.ts`
- Store enrichment metadata in new table

### Custom Scoring Algorithm
- Implement `CandidateScorer` interface
- Pass custom scorer to `RetrievalService` constructor
- Example: RFC-001 copyright year matching scorer

## Key Dependencies

- `express` - HTTP server
- `better-sqlite3` - SQLite database
- `pino` - Structured logging
- `sharp` - Image processing (preprocessing)
- `zod` - Runtime validation
- `tsx` - TypeScript execution (dev)

## Known Issues

- Pre-existing TypeScript errors in `jobRepository.ts` lines 164-173 (property access on empty objects)
- No authentication/authorization (production blocker)
- In-memory queue loses state on restart (by design for dev)
