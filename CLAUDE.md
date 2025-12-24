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
| **EverShop extension gotchas** | `apps/evershop-extensions/cardmint_admin_theme/docs/COLUMN_EXTENSION_PATTERN.md` |
| Fulfillment & EasyPost | `apps/backend/src/routes/fulfillment.ts`, `apps/backend/src/services/easyPostService.ts` |
| **First sale milestone** | `docs/milestones/2025-12-23-first-production-sale.md` |

> **Deployment rule:** Before any `ssh`, `rsync`, or prod file edit, re-read `docs/DO-verified-access.md` for current SSH credentials, paths, and safety protocols.

## Prod Constraints (non-negotiable)

- No mocks in operator-visible or prod paths
- No hardcoded domains, tokens, or feature toggles
- Front image required for any product import
- Bulk writes default dry-run; require `--confirm`
- Never commit credentials

## Current Sprint Context

<!-- Update this section as work progresses. Claude: write notes here to maintain state across turns. -->

**Active focus:** Commerce MVP QA + CI/CD hardening

**Blockers:** _None identified_

**Recent completions:**
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
- Fulfillment E2E: Test EasyPost label purchase for first sale
- Frontend discount preview UI
- Cart abandonment Klaviyo events
- E2E testing of multi-item checkout flow

---

_Principle: Minimal context, maximum signal. Retrieve details just-in-time. Escalate ambiguity early._
