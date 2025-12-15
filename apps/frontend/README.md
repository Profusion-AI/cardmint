# CardMint Frontend

**High-level architecture**: React 18 + Vite SPA with keyboard-first operator workflow, polling-based state management, and type-safe backend integration.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser (localhost:5173)                  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │            OperatorWorkbench Component                  │ │
│  │                                                         │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │ │
│  │  │ Job List    │  │ Image        │  │ Candidates   │  │ │
│  │  │ (Scrollable)│  │ Preview      │  │ (Top 3)      │  │ │
│  │  └─────────────┘  └──────────────┘  └──────────────┘  │ │
│  │                                                         │ │
│  │  Keyboard Shortcuts: Space, Enter, Esc, 1/2/3, ↑/↓, R  │ │
│  └─────────────────┬───────────────────────────────────────┘ │
│                    │                                          │
│  ┌─────────────────▼───────────────────────────────────────┐ │
│  │                  API Client Layer                        │ │
│  │  - fetchMetrics()                                        │ │
│  │  - listRecentJobsAdapted()                               │ │
│  │  - triggerCapture()                                      │ │
│  │  - patchJob(action, candidateIndex)                      │ │
│  └─────────────────┬───────────────────────────────────────┘ │
│                    │                                          │
│  ┌─────────────────▼───────────────────────────────────────┐ │
│  │              Type Adapter Layer                          │ │
│  │  adaptScanJobToJob(): Backend ScanJob → UI Job           │ │
│  │  - Maps top3 → candidates                                │ │
│  │  - Maps infer_ms → inference_ms                          │ │
│  │  - Converts timestamps to ISO strings                    │ │
│  └──────────────────────────────────────────────────────────┘ │
└─────────────────────┬────────────────────────────────────────┘
                      │ HTTP (fetch)
┌─────────────────────▼────────────────────────────────────────┐
│                  Backend API (port 4000)                      │
│  GET  /metrics                                                │
│  GET  /api/jobs/recent                                        │
│  POST /api/capture                                            │
│  PATCH /api/jobs/:id                                          │
│  GET  /api/jobs/:id/image                                     │
└───────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/
├── main.tsx                     # Vite entry point (React 18 StrictMode)
├── App.tsx                      # Root component (mounts OperatorWorkbench)
├── styles.css                   # Global styles + Tailwind directives
│
├── api/
│   ├── types.ts                 # Backend API types (ScanJob, MetricsResponse)
│   ├── adapters.ts              # Type adapters (Backend → UI)
│   └── client.ts                # API client functions (fetch wrappers)
│
└── components/
    └── OperatorWorkbench.tsx    # Main UI component (~580 LOC)
```

## Core Concepts

### Keyboard-First Workflow

Global keyboard shortcuts for rapid operator decision-making:

| Key | Action | Description |
|-----|--------|-------------|
| **Space** | Trigger Capture | Spawn Sony capture binary, enqueue new job |
| **Enter** | Accept | Accept selected job with chosen candidate |
| **Esc / F** | Flag | Mark job for manual review |
| **R** | Retry | Re-queue failed/flagged job |
| **1 / 2 / 3** | Select Candidate | Choose candidate by index |
| **↑ / ↓** | Navigate Jobs | Move selection up/down in job list |
| **?** | Show Help | Toggle keyboard shortcuts overlay |

**Input exclusion**: Keyboard shortcuts disabled when typing in search/filter fields.

### Polling Architecture

**Metrics Polling** (2.5s default interval):
- `GET /metrics` → `{queueDepth, warning, recent[]}`
- Updates queue depth badge and warning indicator
- Degrades gracefully on backend failure (shows "Backend down" warning)

**Job List Polling** (same interval):
- `GET /api/jobs/recent` → adapted to UI `Job[]` format
- Preserves selected job across updates (by ID)
- Auto-selects first job if current selection disappears

**Polling controls**:
- Adjustable interval via dropdown (2.5s, 5s, 10s)
- Pauses when user switches browser tab (future enhancement)

### Type Adapter Pattern

**Problem**: Backend and frontend have different data shapes for historical reasons.

**Solution**: Adapter layer (`api/adapters.ts`) bridges the gap:

```typescript
// Backend ScanJob format
{
  top3: Candidate[],
  timings: { infer_ms, end_to_end_ms },
  created_at: 1696351200000  // Unix timestamp
}

// UI Job format (via adapter)
{
  candidates: Candidate[],
  timings: { inference_ms, e2e_ms },
  created_at: "2023-10-03T10:00:00.000Z"  // ISO string
}
```

**Key mappings**:
- `top3` → `candidates`
- `infer_ms` → `inference_ms`
- `end_to_end_ms` → `e2e_ms`
- Unix timestamps → ISO strings
- `image_path` → `/api/jobs/:id/image` URL

### State Management

**React hooks-based** (no Redux/Zustand):

```typescript
const [metrics, setMetrics] = useState<Metrics>({ queueDepth: 0, warning: false, backendUp: true });
const [jobs, setJobs] = useState<Job[]>([]);
const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
const [selectedCandidate, setSelectedCandidate] = useState<number | null>(0);
const [filterSession, setFilterSession] = useState<string | "ALL">("ALL");
const [search, setSearch] = useState("");
const [toast, setToast] = useState<Toast[]>([]);
```

**Derived state** (via `useMemo`):
- `filteredJobs` - Filtered by session + search query
- `selectedJob` - Current job object from `selectedJobId`
- `sessions` - Unique session IDs for filter dropdown

**Optimistic updates**:
- Accept/Flag/Retry actions update local state immediately
- Backend confirmation happens asynchronously
- No rollback on error (shows toast notification instead)

### Toast Notifications

Temporary feedback for user actions:

```typescript
notify("ok", "Accepted ✓ (Enter)");     // Green
notify("info", "Flagged ⚑ (Esc/F)");    // Blue
notify("err", "Accept failed");         // Red
```

**Auto-dismiss**: 3 seconds
**Position**: Bottom-right corner
**ID-based**: Unique ID prevents duplicate toasts

### Session Filtering

Jobs grouped by `session_id` (e.g., "2024-10-03-AM"):
- Dropdown to filter by session or "ALL"
- Session list auto-updates from recent jobs
- Persists across polling updates

### CSV Export

Export accepted jobs to CSV:

```typescript
function exportAcceptedCsv() {
  const cols = ["id", "session_id", "card_name", "hp_value", "set_number", "status", "created_at"];
  const rows = jobs.filter(j => j.status === "ACCEPTED");
  const csv = [cols, ...rows.map(j => cols.map(c => j[c] ?? ""))].map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cardmint-accepted-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
}
```

## Component Architecture

### OperatorWorkbench.tsx

**Responsibilities**:
- Poll metrics + recent jobs
- Render job list + image preview + candidates
- Handle keyboard shortcuts
- Trigger capture, accept, flag, retry actions
- Show toast notifications
- Export CSV

**Key features**:
- ~580 lines of TypeScript
- Fully keyboard-driven (no mouse required for common actions)
- Responsive layout (Tailwind CSS)
- Dark theme optimized
- Session filtering + search
- Optimistic UI updates

**Sub-components** (inline):
- `StatusPill` - Color-coded status badges
- `Field` - Labeled data display
- Help modal overlay

## Styling

**Tailwind CSS v4** with PostCSS:

```css
/* styles.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color-scheme: dark light;
  font-family: "Inter", system-ui, sans-serif;
  background-color: #0b0d10;
  color: #f6f7fb;
}
```

**Design system**:
- Dark background: `#0b0d10`
- Card background: `#0f172a`
- Borders: `#1f2937`
- Accent: Indigo (`indigo-500`, `indigo-600`)
- Success: Emerald (`emerald-600`)

**Hot reload gotcha**: Tailwind v4 requires `@tailwindcss/postcss` plugin. For rapid iteration, prefer inline styles (`style={{}}`) then migrate to Tailwind classes once stable.

## API Client

### fetchMetrics()
```typescript
GET /metrics → { queueDepth: number, warning: boolean }
```

### listRecentJobsAdapted()
```typescript
GET /api/jobs/recent → Job[] (adapted from ScanJob[])
```

### triggerCapture()
```typescript
POST /api/capture → void (throws on error)
```

### patchJob(id, action, candidateIndex?)
```typescript
PATCH /api/jobs/:id
Body: { action: "ACCEPT" | "FLAG" | "RETRY", candidateIndex?: number }
```

### jobImageUrl(id)
```typescript
Returns: `/api/jobs/${id}/image`
```

## Development

**Start frontend** (standalone):
```bash
cd apps/frontend
npm run dev
```

**Start with backend** (recommended):
```bash
# From workspace root
./dev-start.sh
```

**Build for production**:
```bash
npm run build  # Output to dist/
npm run preview  # Preview production build
```

**Environment**:
- **Dev server**: Vite with HMR on port 5173 (strict port mode)
- **Proxy**: Backend API calls proxied to `http://127.0.0.1:4000`
- **Host**: `127.0.0.1` (not `0.0.0.0` for security)

## Configuration

**package.json scripts**:
```json
{
  "dev": "vite --strictPort --host 127.0.0.1 --clearScreen false",
  "build": "tsc && vite build",
  "preview": "vite preview"
}
```

**vite.config.ts** (auto-generated, proxy configured):
```typescript
export default {
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/metrics': 'http://127.0.0.1:4000',
      '/health': 'http://127.0.0.1:4000',
    }
  }
}
```

## Testing

**Manual testing checklist**:
1. UI loads at http://localhost:5173
2. Queue depth displays
3. Space triggers capture
4. Job list populates
5. Image preview works
6. Candidate selection (radio + 1/2/3 keys)
7. Enter accepts job
8. Esc/F flags job
9. R retries job
10. ? shows shortcuts
11. CSV export works

**Browser compatibility**:
- Chrome/Brave: ✅
- Firefox: ✅
- Safari: ⚠️ (keyboard shortcuts may conflict)

## Known Issues

- **Tailwind HMR**: Class changes sometimes don't trigger rebuild (workaround: use inline styles during rapid iteration)
- **Multiple Vite instances**: Use `./dev-start.sh` to prevent zombie processes
- **Browser cache**: Hard refresh (`Ctrl+Shift+R`) may be needed after code changes
- **No authentication**: Production blocker (backend has no auth layer)

## Future Enhancements

### RFC-001 Integration
- Display copyright year in extracted fields
- Show per-field confidence scores
- Highlight low-confidence fields in UI

### RFC-002 Integration
- Auto-confirm banner for high-confidence jobs
- Show API enrichment signals (HP validation, total set number)
- Conflict indicator when vision vs API disagree
- API cost tracking in metrics

### Performance
- Virtual scrolling for large job lists (>100 items)
- WebSocket-based real-time updates (replace polling)
- Service worker for offline mode

### UX
- Undo/redo for accept/flag actions
- Bulk operations (accept all, flag selected)
- Custom keyboard shortcut configuration
- Job detail modal (full timings breakdown)

## Key Dependencies

- `react` + `react-dom` - UI framework
- `vite` - Build tool + dev server
- `typescript` - Type safety
- `tailwindcss` - Utility-first CSS
- `@tailwindcss/postcss` - Tailwind v4 PostCSS plugin

## Migration Notes

**From consultation component** (docs/card_mint_operator.jsx):
- Removed demo mode
- Integrated with real backend API
- Added type adapter layer
- Converted from JSX to TypeScript
- Replaced mock data with polling
- Added Codex bug fixes:
  - selectedCandidate reset on job change
  - Empty job list handling
