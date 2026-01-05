# Unkey: CardMint API Key Source of Truth

CardMint is migrating from shared static secrets (`CARDMINT_ADMIN_API_KEY`, etc.) to **Unkey-managed service keys**.

## What This Covers

- EverShop → CardMint backend: `Authorization: Bearer <service key>`
- CardMint backend verifies the key via Unkey (server-to-server verification)
- Optional permission scoping via Unkey permission expressions
- Optional migration for other inbound tokens (print-agent, stock display) to Unkey-managed keys

## Backend Configuration (Prod)

> **CRITICAL:** Backend env file: `/var/www/cardmint-backend/.env` (NOT `/etc/cardmint-backend.env`)
>
> The backend reads via dotenv from its local `.env` file. The `/etc/` file is legacy (systemd reference only).

Required variables to enable Unkey verification:
- `CARDMINT_ADMIN_AUTH_MODE=unkey` (or `dual` during migration)
- `UNKEY_ROOT_KEY=...` (root key with `keys.verifyKey` permission; **verify-only**, not full admin)

Optional:
- `UNKEY_ADMIN_PERMISSION=...` (permission expression evaluated by Unkey, e.g. `cardmint.fulfillment.write`)
- `CARDMINT_PRINT_AGENT_AUTH_MODE=unkey|dual` (migrate `/api/print-agent/*` token auth to Unkey)
- `UNKEY_PRINT_AGENT_PERMISSION=...` (e.g. `cardmint.print_agent`)
- `CARDMINT_DISPLAY_AUTH_MODE=unkey|dual` (migrate `/api/stock-summary` token auth to Unkey)
- `UNKEY_DISPLAY_PERMISSION=...` (e.g. `cardmint.display.read`)
- `UNKEY_API_URL=https://api.unkey.com`
- `UNKEY_VERIFY_TIMEOUT_MS=2500`
- `UNKEY_VERIFY_CACHE_TTL_MS=60000`

### Suggested Migration Path

1. Start with `CARDMINT_ADMIN_AUTH_MODE=dual`
2. Configure EverShop to use an Unkey service key
3. Verify the EverShop admin UI can load and perform actions
4. Switch to `CARDMINT_ADMIN_AUTH_MODE=unkey`
5. Remove/blank `CARDMINT_ADMIN_API_KEY` in the backend env file (break-glass key should live offline)

## EverShop Configuration (Prod)

EverShop env file: `/opt/cardmint/.env`
- `CARDMINT_ADMIN_API_KEY=...` should be set to the Unkey **service key** value
- `CARDMINT_BACKEND_URL=http://172.17.0.1:4000`

EverShop compose should reference env vars (no hardcoded secrets):
- `/opt/cardmint/docker-compose.yml`

## WorkOS Note (Next)

WorkOS will introduce its own secrets (API key, client ID). Those should remain in the backend env file (or a dedicated secrets file with `600` perms). Unkey is for **issuing/verifying** API keys, not general secret retrieval.
