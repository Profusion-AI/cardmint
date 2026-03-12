# Reconciliation and Security Maintenance - 2026-02-18

## Scope
- Remove/retire single-use James-HND feature footprint from CardMint prod surface and backend code path.
- Reconcile migration checksum drift to silence repeated migration warnings without schema mutation.
- Resolve known package vulnerability findings tied to open Dependabot alerts.
- Perform production host security maintenance (Fedora security updates, firewall/fail2ban validation, nginx config hygiene).
- Add backend log redaction for kiosk health/capture errors to prevent token leakage in logs.

## Code and Data Reconciliation
- Removed James-HND backend route registration in `apps/backend/src/app/http.ts`.
- Removed runtime endpoint usage by deleting server-side route file and test in deployed backend tree (`/var/www/cardmint-backend/src/routes/imagekitAuth.ts`, `/var/www/cardmint-backend/src/routes/__tests__/imagekitAuth.test.ts`).
- Added metadata-only checksum reconciliation migration:
  - `apps/backend/src/db/migrations/20260218_reconcile_privacy_requests_checksum.sql`
  - `apps/backend/src/db/migrations/20260218_reconcile_privacy_requests_checksum_down.sql`
- Applied migration on production and verified `schema_migrations` checksum for `20251217_privacy_requests` now matches current source hash (`c6c33b2d...`).

## Dependency and Dependabot Remediation
### Updated manifests/locks
- `apps/backend/package.json`, `apps/backend/package-lock.json`
- `apps/frontend/package.json`, `apps/frontend/package-lock.json`
- `apps/evershop-extensions/package.json`, `apps/evershop-extensions/package-lock.json`
- `apps/evershop-extensions/cardmint_analytics/package.json`, `apps/evershop-extensions/cardmint_analytics/package-lock.json`
- `package.json`, `package-lock.json`

### Effective package outcomes
- Backend now resolves:
  - `axios@1.13.5`
  - `lodash@4.17.23`
  - `qs@6.14.2`
  - `cookie@0.7.1`
- Frontend now resolves:
  - `preact@10.28.2`
  - tailwind toolchain upgraded via lock refresh (`@tailwindcss/postcss@4.2.0`, `tailwindcss@4.2.0`)
- Workspace/package audits after updates were clean for touched package sets.

## Production Infra and Security Checks
### Host and services
- Host: `cardmint-shop-prod` (DigitalOcean)
- Key services verified active post-maintenance:
  - `nginx`
  - `cardmint-backend`
  - `cardmint-search-app`
  - `docker`
  - `fail2ban`

### Security updates and reboot
- Executed `dnf upgrade --security -y`.
- Security-updated components included nginx/node/openssl/openssh/glibc and related libs.
- Reboot performed because updated core libs required it.
- Post-reboot validation completed:
  - backend health endpoint returns `ok`
  - storefront/vault endpoints reachable
  - James-HND endpoints still return `410`

### Firewall and fail2ban
- Firewalld tightened:
  - removed `mdns`
  - active services now: `dhcpv6-client http https ssh`
- Fail2ban corrected from passive state (0 jails) to active enforcement:
  - configured `sshd` jail in `/etc/fail2ban/jail.d/cardmint.local`
  - verified jail active and banning behavior present.

### dnf automatic
- Added `/etc/dnf/automatic.conf` with security-focused automatic behavior:
  - `apply_updates = yes`
  - `upgrade_type = security`
  - `download_updates = yes`

### nginx hygiene
- Updated production and staging nginx config to modern `http2 on;` syntax and removed deprecated `listen ... http2` usage.
- `nginx -t` clean after change.

## Kiosk Token Exposure Mitigation
- Root cause: raw `AxiosError` objects in kiosk driver logs could include request config headers (`Authorization`).
- Mitigation added in code:
  - `apps/backend/src/services/capture/pi5KioskDriver.ts`
  - structured error sanitizer now redacts auth header and logs bounded, non-secret fields.
- Additional operational step (same maintenance window): rotate capture kiosk bearer token in backend env and restart backend.

## Verification Snapshot (post-maintenance)
- `https://cardmintshop.com/vault` -> `200`
- `https://cardmintshop.com/api/vault/products?...` -> `200`
- `https://cardmintshop.com/James-HND/` -> `410`
- `https://cardmintshop.com/api/imagekit-auth` -> `410`
- backend `/health` -> `ok`

## Notes
- This maintenance intentionally avoided schema changes beyond `schema_migrations` checksum metadata correction.
- Any future edits to historical migration files should be avoided; use metadata-only reconciliation migrations when needed.
