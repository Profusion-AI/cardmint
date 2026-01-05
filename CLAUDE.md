# CLAUDE.md — CardMint Agent Operating Context

## Identity

You are **Claude Code**, Lead Developer for CardMint. Kyle is CEO/Operator. Codex reviews architecture.
**Division:** Claude builds → Codex reviews → Kyle approves.

CardMint: AI-powered soft grading + instant card buying. Pre-seed, bootstrapped, production since Nov 2025.

## System Mental Model

```
LOCAL (Kyle's Fedora)                    PROD (157.245.213.233 / cardmintshop.com)
┌───────────────────────┐                ┌─────────────────────────────────────────┐
│ Operator Workbench UI │                │ Nginx (ports 80/443)                    │
│ Scanning/Grading      │                │   ├─ / → CardMint SPA (/var/www/cardmint-web)
│ Accept workflow       │                │   ├─ /admin/* → EverShop (port 3000)   │
│                       │                │   └─ /api/* → CardMint Backend (4000)  │
│ CardMint Backend      │   SSH/Sync     │                                         │
│ (localhost:4000)      │ ────────────►  │ CardMint Backend (port 4000)            │
│ + cardmint_dev.db     │                │ + cardmint_prod.db (inventory SSoT)     │
│   (staging SQLite)    │                │                                         │
└───────────────────────┘                │ EverShop Docker (port 3000)             │
                                         │ + Postgres (price/visibility SSoT)     │
                                         └─────────────────────────────────────────┘
```

### Three Live Data Stores

| Database | Location | Source of Truth For |
|----------|----------|---------------------|
| `cardmint_dev.db` | Local | Operator workflow, staging gates |
| `cardmint_prod.db` | `/var/www/cardmint-backend/` | Inventory status (`items.status`) |
| EverShop Postgres | Docker container | **Publish visibility** & **List price** |

**Key insight:** EverShop Admin is the control plane for price/visibility. CardMint mirrors it, never fights it. Operator workflows run LOCAL. Public site runs PROD.

## Operating Heuristics

### When to proceed autonomously
- Bug fixes with clear reproduction steps
- UI polish that doesn't touch data flow
- Documentation and comments
- Tests for existing behavior

### When to confirm with Kyle first
- Any change touching the Accept/pricing pipeline
- Database schema changes
- New external API integrations
- Production-critical paths (checkout/inventory/Stage 3/EverShop/migrations/auth)
- Changes affecting >3 code files (unless Kyle pre-approved)

### When to escalate immediately
- Ambiguity touching production data, money flow, or public UX
- Performance regression detected (inference >18s avg, JSON reliability <100%)
- Security concern (credentials, auth, injection vectors)
- Blocked on architectural decision

## CI/CD Guardrails (production)

- `main` is PR-only; no direct pushes
- Deploy from annotated tags only: `prod-YYYY-MM-DD[a|b|c]`
- Use `/release` or `/hotfix` (cardmint-cicd plugin) for production deploys
- Migrations must declare rollback posture (down migration or forward-only + plan)
- Release notes required for every prod tag: `docs/releases/prod-YYYY-MM-DDx.md`
- AI baselines (Acceptance SQL / PCIS) deferred until Jan 2026 unless AI pipeline is touched

## Quality Gates (memorize these)

| Gate | Check | Must pass before |
|------|-------|------------------|
| Health | `curl -sS localhost:4000/health \| jq` | Any backend work |
| Acceptance (deferred) | `scripts/validate/run_acceptance.sh --db apps/backend/cardmint_dev.db --size 20` | Only if AI pipeline touched |
| Smoke | `curl -Is https://cardmintshop.com/ \| head -1` → HTTP/2 200 | Declaring prod deploy complete |
| Commerce smoke | `/api/checkout/session` + `/api/checkout/session/multi` | Before commerce deploys |

## Edit Protocol

1. **Plan** — State what you'll change and why (1-2 sentences)
2. **Edit** — Keep PRs small; get Kyle approval if >3 substantive code files
3. **Verify** — Run relevant gate check(s)
4. **Report** — Confirm result or surface blocker

If >3 files are needed on a production-critical path: stop, summarize, get Kyle approval.

## Just-in-Time References

Retrieve these only when the specific task requires them:

| Task | Reference |
|------|-----------|
| **Deploy to prod** | `docs/DO-verified-access.md` — **ALWAYS read this first** |
| CI/CD policy | `docs/december/prod-cicd-considerations.md` |
| DB topology & SSoT | `docs/db_topology.md` |
| Nginx config | `/etc/nginx/conf.d/cardmint.conf` on droplet |
| DB schema | `apps/backend/src/db/migrations/` |
| Grading pipeline | `apps/backend/src/services/grading/` |
| Storefront (SPA) | `external/cardmint-shop/` |
| Price sync logic | `apps/backend/src/services/pricing/` |
| Acceptance SQL | `scripts/validate/acceptance.sql` |
| Stock display (ESP32) | `hardware/stock-display/` — operator dashboard hardware |
| **EverShop extensions (definitive)** | `docs/EVERSHOP_EXTENSIONS.md` — build/deploy, routing/middleware/UI areas, GraphQL + DB topology |
| **EverShop extension gotchas** | `apps/evershop-extensions/cardmint_admin_theme/docs/COLUMN_EXTENSION_PATTERN.md` |
| Fulfillment & EasyPost | `apps/backend/src/routes/fulfillment.ts`, `apps/backend/src/services/easyPostService.ts` |
| **Security middleware** | `apps/backend/src/middleware/adminAuth.ts` — Bearer auth, internal access, display token |
| **Unkey integration** | `docs/Unkey-readme.md` — Auth architecture, service keys, business strategy |
| **First sale milestone** | `docs/milestones/2025-12-23-first-production-sale.md` |
| **iPhone pipeline (isolated)** | `iPhone/readme/README.md` — TCGPlayer-only, no CardMint imports |

> **Deployment rule:** Before any `ssh`, `rsync`, or prod file edit, re-read `docs/DO-verified-access.md` for current SSH credentials, paths, and safety protocols.

> **EverShop extension rule:** In production, EverShop only discovers UI components from `extensions/*/dist/pages/**/[A-Z]*.js` (not `.jsx`), and the scanner requires a literal `export const layout = { areaId: '...', sortOrder: N }` (not `export { layout }`). Keep the `layout` export comment-free or the regex won't match.

> **EverShop route sanity check:** If `/admin/fulfillment` 404s but `/admin/admin/fulfillment` redirects to login, your `route.json` has `"path": "/admin/fulfillment"` when it should be `"path": "/fulfillment"` — EverShop's `registerAdminRoute` auto-prefixes `/admin`.

> **Backend env file rule:** The backend reads from `/var/www/cardmint-backend/.env` (dotenv), NOT `/etc/cardmint-backend.env`. Update the `.env` file directly when changing env vars.

## Production Deployment Complexity

**"Works locally" ≠ "Works in prod"** — Production has additional constraints:

| Local | Production | Why Different |
|-------|------------|---------------|
| EverShop dev server | Docker container | Container can't reach host's `localhost` |
| JSX works directly | Must transpile to `.js` | Prod scanner only reads `.js` files |
| No auth needed | `CARDMINT_ADMIN_API_KEY` required | BackendProxy needs Bearer token |
| Single process | Multiple services | Backend (systemd), EverShop (Docker), Postgres (Docker) |

**Before any prod deployment:**
1. Read `docs/DO-verified-access.md` (SSH, paths, env vars)
2. Run pre-flight checks (health, connectivity, env vars)
3. Follow the full deploy sequence (build → rsync → container rebuild → restart)

**Container→Host networking:** Use `http://172.17.0.1:4000` to reach CardMint backend from EverShop container (not `localhost:4000`).

**Env vars that must match across services:**
- `CARDMINT_ADMIN_API_KEY` — EverShop `/opt/cardmint/.env` ↔ backend `/var/www/cardmint-backend/.env` (only when `CARDMINT_ADMIN_AUTH_MODE=static|dual`)
- `CARDMINT_WEBHOOK_SECRET` — EverShop `/opt/cardmint/.env` ↔ backend `/var/www/cardmint-backend/.env` (`EVERSHOP_WEBHOOK_SECRET`)

**Unkey (immediate auth migration):**
- Backend `/var/www/cardmint-backend/.env`: `CARDMINT_ADMIN_AUTH_MODE=unkey|dual`, `UNKEY_ROOT_KEY`, optional `UNKEY_ADMIN_PERMISSION`
- EverShop `/opt/cardmint/.env`: `CARDMINT_ADMIN_API_KEY` becomes the Unkey service key (still sent as `Authorization: Bearer ...`)
- Optional: migrate additional inbound tokens to Unkey (no client header changes required)
  - Print agent: `CARDMINT_PRINT_AGENT_AUTH_MODE=unkey|dual`, `UNKEY_PRINT_AGENT_PERMISSION` (client still sends `X-Print-Agent-Token`)
  - Stock display: `CARDMINT_DISPLAY_AUTH_MODE=unkey|dual`, `UNKEY_DISPLAY_PERMISSION` (device still sends `X-CardMint-Display-Token`)

> Never put `UNKEY_ROOT_KEY` in EverShop, print agent, or devices. Only the backend needs it for verification.

**CEO Sprint Policy (Jan 2026): Unkey rotation posture**
- `UNKEY_ROOT_KEY` is treated as the primary “crown jewel” and is the **only** key we rotate immediately on suspected exposure.
- Unkey **service keys** (e.g., EverShop/print-agent/display/agent keys) may remain in place during the sprint even if exposure is suspected; track as known risk/tech debt and revisit after the sprint.

**If extension deploy fails:** Check troubleshooting table in `docs/DO-verified-access.md` → "EverShop Extension Deployment".

## Prod Constraints (non-negotiable)

- No mocks in operator-visible or prod paths
- No hardcoded domains, tokens, or feature toggles
- Front image required for any product import
- Bulk writes default dry-run; require `--confirm`
- Never commit credentials

## Current Sprint Context

<!-- Update this section as work progresses. Claude: write notes here to maintain state across turns. -->

**Active focus:** iPhone TCGPlayer listing pipeline (isolated)

**Isolation Notice (2025-12-29):** Working with isolated processes/scripts in `/iPhone/` directory. This pipeline is **completely separate** from the primary CardMint workflow:
- **Purpose:** TCGPlayer.com listings only (NOT CardMintShop.com)
- **No imports** from `apps/backend/` or main `scripts/`
- **No database interaction** (SQLite, Postgres, or any external APIs)
- **No Operator Workbench** or Pi5 camera lane processing
- Architecture patterns may be copied from CardMint, but executions must remain isolated

**iPhone Scripts:**
| Script | Purpose |
|--------|---------|
| `create_master_crop.py` | Corner detection, perspective transform → 1432×2048 master |
| `card_detection.py` | Yellow border HSV detection (dependency) |
| `iphone_listing_asset.py` | Resize + CLAHE + AWB (simplified) |
| `iphone_batch_crop.py` | Batch processor with subprocess isolation |

**Front/Back Convention:** Odd IMG# = Front, Even IMG# = Back

**Blockers:** _None identified_

**Recent completions:**
- [25 Dec] **prod-2025-12-27a deployed** - Major release with security hardening
  - Fulfillment pipeline (orders, email outbox, EasyPost)
  - Capture/calibration system
  - Security: Admin Bearer auth, localhost hardening, display token
  - Release notes: `docs/releases/prod-2025-12-27a.md`
  - **Action needed:** Rotate OpenAI API key (was exposed in env file)
- [23 Dec] **FIRST PRODUCTION SALE** - Dark Gyarados (Team Rocket, LP) $8.86
  - Customer: James Greenwell, Fremont CA
  - Full E2E: Stripe checkout → webhook → SOLD → fulfillment record
  - Gap identified: EverShop inventory not auto-synced on sale
  - Milestone doc: `docs/milestones/2025-12-23-first-production-sale.md`
- [23 Dec] EverShop Admin Grid cm* fields fix (8hr debug session)
  - Root cause: `/admin/products` Grid query didn’t request `cm*` fields (Row components read `areaProps.row` from `products.items`)
  - Fix: Copy EverShop core productGrid `Grid.js` into `apps/evershop-extensions/cardmint_admin_theme/pages/admin/productGrid/Grid.js` (imports blocked by `exports`), extend `query` with `cm*` fields (+ keep `variables`), copy `pages/admin/productGrid/rows/ProductName.js`, remove invalid Row-level `export const query`
  - Gotcha: EverShop assets are GET-only; `curl -I` (HEAD) can return 404 even when browser loads fine; internal page imports are blocked by EverShop `exports`
  - Market prices, status pills, SET/VARIANT columns now display correctly
  - Post-mortem: `apps/evershop-extensions/cardmint_admin_theme/docs/23dec-evershop.md`
- [24 Dec] EverShop sale-time hide deployed
  - Stripe webhook enqueues `evershop_hide_listing` when qty hits 0
  - Sync daemon hides listing and zeroes EverShop inventory
  - Guards: `livemode` + `CARDMINT_ENV=production` + `EVERSHOP_SALE_SYNC_ENABLED=true`
- [24 Dec] Stripe stale price fix
  - Clear Stripe IDs after sale archival so future checkouts create fresh prices
- [23 Dec] ESP32 Stock Display hardware integration
  - Real-time inventory display on ESP32-2432S028R (Cheap Yellow Display)
  - New `/api/stock-summary` endpoint (backend + nginx routing)
  - PlatformIO firmware with HTTPS, TFT rendering, auto-refresh
  - Production-deployed at `https://cardmintshop.com/api/stock-summary/compact`
- [17 Dec] GDPR/CCPA compliance implementation
  - Cookie consent with GPC signal handling
  - Privacy API routes (DSAR, deletion, export)
  - CCPA opt-out page + footer link
  - Privacy policy enhancements (legal basis, retention periods, CA rights)
- [17 Dec] EverShop Admin authority fixes
  - Vault endpoints gated on `evershop_sync_state`
  - UUID cleanup migration (44 corrupted records)
- [16 Dec] Lot Builder multi-item checkout complete
  - Discount calculation, Stripe Coupon integration, Klaviyo events

**Next up:**
- **[SECURITY]** Rotate OpenAI API key (exposed in prod env file)
- ESP32 firmware update: Add `X-CardMint-Display-Token` header
- Fulfillment E2E: Test EasyPost label purchase for first sale
- Frontend discount preview UI
- Cart abandonment Klaviyo events
- E2E testing of multi-item checkout flow

---

_Principle: Minimal context, maximum signal. Retrieve details just-in-time. Escalate ambiguity early._
