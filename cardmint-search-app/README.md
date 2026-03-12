# CardMint Search App

Internal-first development lane for CardMint Search.

## Release intent

- Stage 1: Internal development and QA only
- Stage 2: Internal operator usage
- Stage 3: Trusted alpha (limited external)
- Stage 4: Public beta (only after quality gates are green)

By default, this scaffold starts in `internal_dev` and blocks public mode.

## Quick start

```bash
npm install
npm run typecheck
npm test
npm run dev
```

Server defaults:

- Port: `4310`
- Health: `GET /health`
- Search: `POST /api/search`

## Environment

Copy `.env.example` to `.env` and adjust values.

Key toggles:

- `SEARCH_APP_RELEASE_STAGE=internal_dev|internal_ga|trusted_alpha|public_beta`
- `SEARCH_APP_ALLOW_PUBLIC=true|false`
- `SEARCH_APP_REQUIRE_AUTH=true|false`
- `SEARCH_APP_API_KEY=...`
- `SEARCH_APP_MIN_CONFIDENCE=0.85`

## Internal auth model (scaffold)

When `SEARCH_APP_REQUIRE_AUTH=true`, API requests to `/api/*` require:

- Header: `x-search-api-key: <SEARCH_APP_API_KEY>`

## Notes

- This scaffold intentionally uses placeholder retrieval logic.
- It is designed for internal correctness and testability before public launch.
- Do not expose internal endpoints from outside this lane without explicit approval.
