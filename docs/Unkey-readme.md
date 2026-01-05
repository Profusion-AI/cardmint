# Unkey Integration — CardMint Backend

**Status:** Production-ready (Dual Mode Active)
**Last Updated:** January 5, 2026
**Author:** Claude (Lead Developer)
**Reviewed By:** Kyle (CEO/Operator)

---

## Executive Summary

CardMint has migrated from static shared-secret authentication to [Unkey](https://unkey.dev), a modern API key management platform. The backend operates in **dual mode**, accepting both legacy static tokens and Unkey-managed keys for all authenticated endpoints.

**Key Benefits:**
- Centralized key management via Unkey dashboard
- Instant key revocation without deployment
- Per-key rate limiting and analytics
- Permission-scoped access control
- Audit trail for all key operations

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Unkey Console Configuration](#unkey-console-configuration)
3. [Backend Integration](#backend-integration)
4. [File Reference](#file-reference)
5. [Environment Variables](#environment-variables)
6. [Authentication Flows](#authentication-flows)
7. [Security Hardening](#security-hardening)
8. [Testing & Verification](#testing--verification)
9. [Operational Procedures](#operational-procedures)
10. [Business Strategy Analysis](#business-strategy-analysis)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Unkey Cloud                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Workspace: cardmint-shop                                             │    │
│  │ API: cardmint-backend                                                │    │
│  │                                                                      │    │
│  │ Keys:                          Permissions:                          │    │
│  │  ├─ evershop-service           cardmint.admin                       │    │
│  │  ├─ print-agent-service        cardmint.admin                       │    │
│  │  ├─ esp32-display-01           cardmint.admin                       │    │
│  │  ├─ claude-agent-2026-01       cardmint.admin                       │    │
│  │  └─ codex-agent-2026-01        cardmint.admin                       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ POST /v2/keys.verifyKey
                                      │ Authorization: Bearer <ROOT_KEY>
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CardMint Backend (Droplet)                          │
│                                                                             │
│  ┌─────────────────────┐    ┌─────────────────────┐                        │
│  │ adminAuth.ts        │    │ printAgentAuth.ts   │                        │
│  │ requireAdminAuth()  │    │ requirePrintAgent() │                        │
│  └──────────┬──────────┘    └──────────┬──────────┘                        │
│             │                          │                                    │
│             └──────────┬───────────────┘                                    │
│                        ▼                                                    │
│             ┌─────────────────────┐                                        │
│             │ unkeyAuth.ts        │                                        │
│             │ verifyUnkeyKey()    │                                        │
│             │ - Cache (5k max)    │                                        │
│             │ - Rate limiting     │                                        │
│             │ - Failure tracking  │                                        │
│             └─────────────────────┘                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ EverShop Container  │  │ Print Agent (Local) │  │ ESP32 Display       │
│ Authorization:      │  │ X-Print-Agent-Token │  │ X-CardMint-Display- │
│ Bearer <SERVICE_KEY>│  │ <SERVICE_KEY>       │  │ Token <SERVICE_KEY> │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

### Auth Mode: Dual

The backend accepts **both** static tokens and Unkey keys:

1. **Static token check first** — If configured and matches, allow immediately
2. **Unkey verification second** — If static fails/missing, verify via Unkey API
3. **Reject** — If both fail, return 401

This provides resilience against Unkey service outages while enabling modern key management.

---

## Unkey Console Configuration

### Workspace Details

| Property | Value |
|----------|-------|
| Workspace Name | `cardmint-shop` |
| API Name | `cardmint-backend` |
| API ID | (auto-generated) |
| Root Key | Stored in `/var/www/cardmint-backend/.env` |

### Permission Schema

| Permission | Description | Used By |
|------------|-------------|---------|
| `cardmint.admin` | Full admin access to `/api/cm-admin/*`, `/api/vault/*` | All service keys |

### Service Keys

| Key Name | Purpose | Permission | Header |
|----------|---------|------------|--------|
| `evershop-service` | EverShop BackendProxy calls | `cardmint.admin` | `Authorization: Bearer` |
| `print-agent-service` | Local print agent | `cardmint.admin` | `X-Print-Agent-Token` |
| `esp32-display-01` | Stock display device | `cardmint.admin` | `X-CardMint-Display-Token` |
| `claude-agent-2026-01` | Claude Code automation | `cardmint.admin` | `Authorization: Bearer` |
| `codex-agent-2026-01` | Codex automation | `cardmint.admin` | `Authorization: Bearer` |

### Root Key Permissions (11 total)

The root key (`UNKEY_ROOT_KEY`) has verify-only permissions plus extended capabilities for production readiness. It is **never** shared with clients — only the backend uses it to verify incoming service keys.

---

## Backend Integration

### Verification Flow

```typescript
// Simplified flow in verifyUnkeyKey()
async function verifyUnkeyKey(options: VerifyOptions) {
  const { key, permissions, ip, path } = options;

  // 1. Check rate limit (block spam)
  if (isRateLimited(key)) return { ok: false, error: "RATE_LIMITED", status: 429 };

  // 2. Check cache (valid results only)
  if (isCached(key)) return { ok: true, data: cached };

  // 3. Call Unkey API
  const response = await fetch("https://api.unkey.com/v2/keys.verifyKey", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UNKEY_ROOT_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ key, permissions }),
  });

  // 4. Track failures for monitoring
  if (!response.data.valid) trackFailure(key, ip);

  // 5. Cache valid results only
  if (response.data.valid) cacheResult(key, response.data);

  return { ok: true, data: response.data };
}
```

### Dual Mode Logic (adminAuth.ts)

```typescript
export function requireAdminAuth(req, res, next) {
  const mode = runtimeConfig.adminAuthMode; // "static" | "unkey" | "dual"
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (mode === "dual") {
    // Try static first
    if (staticToken && timingSafeEqual(token, staticToken)) {
      return next();
    }
    // Fall back to Unkey
    const result = await verifyUnkeyKey({ key: token, permissions: "cardmint.admin" });
    if (result.ok && result.data.valid) return next();
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
  // ... static-only and unkey-only modes
}
```

---

## File Reference

### Core Authentication Files

| File | Purpose | Key Functions |
|------|---------|---------------|
| `apps/backend/src/services/unkeyAuth.ts` | Unkey API client | `verifyUnkeyKey()`, `checkRateLimit()`, `trackFailure()` |
| `apps/backend/src/middleware/adminAuth.ts` | Admin endpoint auth | `requireAdminAuth()`, `requireDisplayToken()` |
| `apps/backend/src/middleware/printAgentAuth.ts` | Print agent auth | `requirePrintAgentAuth()` |
| `apps/backend/src/config.ts` | Runtime config | Loads env vars, exports `runtimeConfig` |

### Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `.env` | `/var/www/cardmint-backend/.env` | **Primary** — Backend reads via dotenv |
| `.env` | `/etc/cardmint-backend.env` | Legacy systemd reference (not used) |
| `.env` | `/opt/cardmint/.env` | EverShop service key |
| `docker-compose.yml` | `/opt/cardmint/docker-compose.yml` | EverShop env injection |

### Protected Routes

| Route Pattern | Middleware | Auth Header |
|---------------|------------|-------------|
| `/api/cm-admin/*` | `requireAdminAuth` | `Authorization: Bearer` |
| `/api/vault/*` | `requireAdminAuth` | `Authorization: Bearer` |
| `/api/print-agent/*` | `requirePrintAgentAuth` | `X-Print-Agent-Token` |
| `/api/stock-summary/*` | `requireDisplayToken` | `X-CardMint-Display-Token` |

---

## Environment Variables

### Backend (`/var/www/cardmint-backend/.env`)

```bash
# Auth mode for each endpoint group
CARDMINT_ADMIN_AUTH_MODE=dual          # static | unkey | dual
CARDMINT_PRINT_AGENT_AUTH_MODE=dual    # static | unkey | dual
CARDMINT_DISPLAY_AUTH_MODE=dual        # static | unkey | dual

# Unkey configuration
UNKEY_ROOT_KEY=unkey_...               # Root key (verify permission)
UNKEY_ADMIN_PERMISSION=cardmint.admin  # Required permission for admin endpoints
UNKEY_PRINT_AGENT_PERMISSION=cardmint.admin
UNKEY_DISPLAY_PERMISSION=cardmint.admin

# Static tokens (fallback in dual mode)
PRINT_AGENT_TOKEN=...                  # 64-char hex
DISPLAY_TOKEN=...                      # Base64 token

# Rate limiting (optional overrides)
UNKEY_RATE_WARN_THRESHOLD=50           # Warn at 50 req/10s (default)
UNKEY_RATE_BLOCK_THRESHOLD=200         # Block at 200 req/10s (default)
UNKEY_BLOCK_DURATION_MS=60000          # 1 minute block (default)
```

### EverShop (`/opt/cardmint/.env`)

```bash
# Unkey service key (sent as Bearer token to backend)
CARDMINT_ADMIN_API_KEY=SERVICE_KEY_HERE  # evershop-service key value
CARDMINT_BACKEND_URL=http://172.17.0.1:4000
```

---

## Authentication Flows

### EverShop Extension → Backend

```
EverShop Container                    CardMint Backend
       │                                     │
       │ GET /api/vault/products             │
       │ Authorization: Bearer SERVICE_KEY_HERE │
       │────────────────────────────────────►│
       │                                     │
       │                          ┌──────────┴──────────┐
       │                          │ adminAuth.ts        │
       │                          │ mode=dual           │
       │                          │ 1. Static? No match │
       │                          │ 2. Unkey verify     │
       │                          └──────────┬──────────┘
       │                                     │
       │                                     │ POST /v2/keys.verifyKey
       │                                     │────────────────────────►│ Unkey
       │                                     │◄────────────────────────│
       │                                     │ { valid: true }
       │                                     │
       │◄────────────────────────────────────│
       │ 200 OK { products: [...] }          │
```

### Print Agent → Backend

```
Print Agent (Local)                   CardMint Backend
       │                                     │
       │ POST /api/print-agent/heartbeat     │
       │ X-Print-Agent-Token: bf0b878a...    │
       │────────────────────────────────────►│
       │                                     │
       │                          ┌──────────┴──────────┐
       │                          │ printAgentAuth.ts   │
       │                          │ mode=dual           │
       │                          │ 1. Static? MATCH    │
       │                          └──────────┬──────────┘
       │                                     │
       │◄────────────────────────────────────│
       │ 200 OK { ok: true }                 │
```

### ESP32 Display → Backend

```
ESP32 Device                          CardMint Backend
       │                                     │
       │ GET /api/stock-summary/compact      │
       │ X-CardMint-Display-Token: QFSj...   │
       │────────────────────────────────────►│
       │                                     │
       │                          ┌──────────┴──────────┐
       │                          │ adminAuth.ts        │
       │                          │ requireDisplayToken │
       │                          │ mode=dual           │
       │                          │ 1. Static? MATCH    │
       │                          └──────────┬──────────┘
       │                                     │
       │◄────────────────────────────────────│
       │ 200 OK { s: 69, v: 36705, ... }     │
```

---

## Security Hardening

### Rate Limiting (unkeyAuth.ts)

| Parameter | Default | Env Override | Purpose |
|-----------|---------|--------------|---------|
| Warn threshold | 50 req/10s | `UNKEY_RATE_WARN_THRESHOLD` | Log warning |
| Block threshold | 200 req/10s | `UNKEY_RATE_BLOCK_THRESHOLD` | Return 429 |
| Block duration | 60 seconds | `UNKEY_BLOCK_DURATION_MS` | Cooldown period |

### Failure Tracking

- Tracks auth failures per key hash (not full key)
- Logs warning after 3+ consecutive failures
- Includes IP and request path for forensics
- Auto-resets after 60 seconds of no failures

### Memory Protection

| Map | Max Size | Eviction |
|-----|----------|----------|
| `verifyCache` | 5,000 entries | LRU (oldest first) |
| `failureTracker` | 10,000 entries | LRU (oldest first) |
| `rateTracker` | 10,000 entries | LRU (oldest first) |
| `blockedKeys` | 10,000 entries | LRU (oldest first) |

### Cache Behavior

- **Only valid results are cached** — Invalid/revoked keys re-verify each request
- Cache TTL: Configurable via `UNKEY_VERIFY_CACHE_TTL_MS` (default: 60s)
- Key revocation is instant (invalid results bypass cache)
- Permission changes take effect within cache TTL (max 60s default)

---

## Testing & Verification

### Health Check

```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 \
  'curl -sS localhost:4000/health | jq -r .status'
# Expected: "ok"
```

### Smoke Tests

```bash
# Test print-agent (static token)
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 << 'EOF'
source /var/www/cardmint-backend/.env
curl -sS -X POST -H "X-Print-Agent-Token: $PRINT_AGENT_TOKEN" \
  -H "Content-Type: application/json" -d '{"agentId":"test"}' \
  localhost:4000/api/print-agent/heartbeat
EOF
# Expected: {"ok":true,"now":...}

# Test stock-summary (static token)
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 << 'EOF'
source /var/www/cardmint-backend/.env
curl -sS -H "X-CardMint-Display-Token: $DISPLAY_TOKEN" \
  localhost:4000/api/stock-summary/compact
EOF
# Expected: {"s":69,"r":0,"d":0,...}

# Test vault (Unkey service key via EverShop)
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 << 'EOF'
UNKEY_KEY=$(docker exec cardmint-app-1 printenv CARDMINT_ADMIN_API_KEY)
curl -sS -H "Authorization: Bearer $UNKEY_KEY" \
  "http://172.17.0.1:4000/api/vault/products?limit=1"
EOF
# Expected: {"ok":true,"products":[...],"pagination":{...}}
```

### Verify Unkey Key Directly

```bash
# Test a service key against Unkey API (requires root key)
curl -sS -X POST https://api.unkey.com/v2/keys.verifyKey \
  -H "Authorization: Bearer $UNKEY_ROOT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"SERVICE_KEY_HERE", "permissions":"cardmint.admin"}'
# Expected: {"valid":true,"keyId":"...","permissions":["cardmint.admin"]}
```

---

## Operational Procedures

### Rotating the Root Key

1. Generate new root key in Unkey dashboard (Settings → Root Keys)
2. Update `/var/www/cardmint-backend/.env`:
   ```bash
   ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 \
     'sed -i "s/^UNKEY_ROOT_KEY=.*/UNKEY_ROOT_KEY=unkey_NEW_KEY_HERE/" /var/www/cardmint-backend/.env'
   ```
3. Restart backend:
   ```bash
   ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 \
     'sudo systemctl restart cardmint-backend'
   ```
4. Verify health and run smoke tests
5. Revoke old root key in Unkey dashboard

### Revoking a Service Key

1. Go to Unkey dashboard → Keys
2. Find the compromised key
3. Click "Revoke" — takes effect immediately
4. (Optional) Generate replacement key with same permissions
5. Update client configuration if needed

### Adding a New Service Key

1. Unkey dashboard → Keys → Create Key
2. Set name (e.g., `new-operator-service`)
3. Assign permission: `cardmint.admin`
4. Copy key value (shown only once)
5. Configure client to use the new key

### Switching to Full Unkey Mode

```bash
# Update auth modes
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 << 'EOF'
sed -i 's/CARDMINT_ADMIN_AUTH_MODE=dual/CARDMINT_ADMIN_AUTH_MODE=unkey/' /var/www/cardmint-backend/.env
sed -i 's/CARDMINT_PRINT_AGENT_AUTH_MODE=dual/CARDMINT_PRINT_AGENT_AUTH_MODE=unkey/' /var/www/cardmint-backend/.env
sed -i 's/CARDMINT_DISPLAY_AUTH_MODE=dual/CARDMINT_DISPLAY_AUTH_MODE=unkey/' /var/www/cardmint-backend/.env
EOF

# Restart
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 \
  'sudo systemctl restart cardmint-backend'
```

**Prerequisites before switching:**
- All clients updated to use Unkey service keys
- ESP32 firmware updated with `X-CardMint-Display-Token: <UNKEY_KEY>`
- Print agent config updated with Unkey key
- Static tokens can be removed from `.env` after verification

---

## Business Strategy Analysis

### Current State: Dual Mode

Dual mode is **production-ready** and provides:
- Resilience against Unkey service outages
- Zero client changes required
- Gradual migration path
- No operational urgency to change

### When to Consider Full Unkey

| Scenario | Recommendation | Timeline |
|----------|----------------|----------|
| **Continuing as single-operator** | Stay on dual | Indefinitely |
| **Preparing for acquisition** | Migrate to full Unkey | 3-6 months before talks |
| **Building white-label platform** | Migrate to full Unkey | Before first external operator |
| **Raising seed round** | Optional (nice-to-have) | Before investor deep-dive |
| **Security incident (key leak)** | Full Unkey enables instant key revocation (bypasses cache) | Immediately |

### Acquisition/Sale Considerations

| Aspect | Dual Mode | Full Unkey |
|--------|-----------|------------|
| Due diligence complexity | Moderate (two auth paths) | Simple (single dashboard) |
| Key inventory | Grep through env files | Unkey dashboard export |
| Ownership transfer | Hand over env files + docs | Transfer Unkey workspace |
| Buyer perception | Adequate | Signals operational maturity |
| Audit trail | Server logs only | Unkey analytics + logs |

### White-Label/Platform Considerations

| Capability | Static Tokens | Full Unkey |
|------------|---------------|------------|
| Multi-tenant keys | Manual generation per operator | Self-service or API provisioning |
| Per-operator rate limits | Not possible | Native feature |
| Usage analytics | Build custom | Built-in dashboard |
| Billing integration | Manual tracking | Usage data export for metering |
| Operator onboarding | Generate token, email securely | API-driven key creation |
| Operator offboarding | Find and delete tokens | Single-click revocation |

### Cost Analysis

| Tier | Price | Keys | Verifications | Fits CardMint? |
|------|-------|------|---------------|----------------|
| Free | $0/mo | 1,000 | 150,000/mo | Current scale |
| Pro | $25/mo | 10,000 | 1,000,000/mo | Multi-operator |
| Enterprise | Custom | Unlimited | Unlimited | Platform scale |

**Current usage:** ~5 keys, <1,000 verifications/day — well within free tier.

### Recommendation

**Stay on dual mode** unless/until:

1. **White-label MVP** — Multi-tenant key management becomes a requirement
2. **Acquisition prep** — Clean audit trail and single-dashboard handoff preferred
3. **Security incident** — Instant revocation capability becomes critical
4. **Scale milestone** — Managing static tokens across many clients becomes burdensome

Dual mode is not technical debt — it's **operational resilience**. The marginal complexity of two auth paths is justified by the fallback protection, especially for a bootstrapped startup where uptime is critical and Unkey is a dependency on a relatively young service.

---

## Appendix: Error Codes

| Code | HTTP Status | Meaning | Resolution |
|------|-------------|---------|------------|
| `NOT_FOUND` | 401 | Key doesn't exist in Unkey | Check key value, may be revoked |
| `INSUFFICIENT_PERMISSIONS` | 401 | Key lacks required permission | Add permission in Unkey dashboard |
| `DISABLED` | 401 | Key manually disabled | Re-enable in dashboard |
| `RATE_LIMITED` | 429 | Too many requests | Wait and retry |
| `EXPIRED` | 401 | Key has expiration date passed | Create new key |
| `UNKEY_NOT_CONFIGURED` | 503 | `UNKEY_ROOT_KEY` not set | Add to `.env` |
| `UNKEY_HTTP_ERROR` | 503 | Unkey API returned error | Check Unkey status page |
| `UNKEY_BAD_RESPONSE` | 503 | Unexpected Unkey response | Check API version compatibility |

---

## Document History

| Date | Author | Change |
|------|--------|--------|
| 2026-01-05 | Claude | Initial document creation |
| 2026-01-05 | Kyle | Root key rotation (extended permissions) |
| 2026-01-05 | Claude | EverShop migration to Unkey service key |
