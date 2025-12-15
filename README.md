# CardMint Repository Setup
This directory is prepared for CardMint repository setup.
To complete setup:
1. Obtain CardMint.git from trusted source
2. Run: git clone --mirror /path/to/CardMint.git CardMint.git
3. Run: cd CardMint.git && git worktree add ../CardMint-fed42 dev-fed42
4. Run: cd ../CardMint-fed42 && git remote set-url --push origin no_push

## Database Files

CardMint uses SQLite for local development and operations. The following database files exist in the workspace:

- **`apps/backend/cardmint_dev.db`**: Active development database. This is the primary database used during local development and should be referenced in your `.env` file as `SQLITE_DB=apps/backend/cardmint_dev.db`. All validation scripts and acceptance tests should target this database.

- **`apps/backend/cardmint.db`**: Production snapshot (archived). This is a frozen copy of production data used for reference and should not be modified during normal development.

- **`canonical.db`**: Deprecated schema reference. This file exists for historical schema validation but is not used in current operations due to schema mismatches. It may be removed in future cleanup.

**Note**: Database files are excluded from version control via `.gitignore`. Only schema migrations in `apps/backend/src/db/migrations/` are tracked.
