// Atlas configuration for CardMint SQLite databases
// Owner: Claude Code | Created: 2025-12-26
//
// Purpose: Lint + drift detection layer over existing migrate.ts
// Atlas validates, migrate.ts applies (for now)
//
// IMPORTANT: Run atlas commands from apps/backend/ directory:
//   cd apps/backend && atlas migrate lint --env cardmint
//
// All paths in this file are relative to apps/backend/

variable "db_path" {
  type        = string
  default     = "cardmint_dev.db"
  description = "Path to SQLite database (relative to apps/backend/)"
}

env "cardmint" {
  // Source of truth: the baseline schema snapshot
  src = "file://db/atlas/schema.sql"

  // Use in-memory SQLite for diff calculations
  dev = "sqlite://file?mode=memory"

  migration {
    // Existing migrations directory (managed by migrate.ts)
    dir    = "file://src/db/migrations"
    format = atlas
  }

  lint {
    // Block destructive changes (column drops, table drops)
    destructive {
      error = true
    }

    // Block data-dependent changes that could lose data
    data_depend {
      error = true
    }
  }

  // Exclude _down.sql files (documentation only, not executable)
  exclude = ["*_down.sql", "*.down.sql"]
}

// Development environment - uses local dev database
env "dev" {
  url = "sqlite://${var.db_path}"
  src = "file://db/atlas/schema.sql"
  dev = "sqlite://file?mode=memory"

  migration {
    dir    = "file://src/db/migrations"
    format = atlas
  }

  lint {
    destructive {
      error = true
    }
    data_depend {
      error = true
    }
  }

  exclude = ["*_down.sql", "*.down.sql"]
}

// Production environment - for drift detection only (NO apply)
env "prod" {
  // Note: This connects via SSH tunnel or remote URL
  // Actual apply is done via migrate.ts, not Atlas
  src = "file://db/atlas/schema.sql"
  dev = "sqlite://file?mode=memory"

  migration {
    dir    = "file://src/db/migrations"
    format = atlas
  }

  lint {
    destructive {
      error = true
    }
    data_depend {
      error = true
    }
  }

  exclude = ["*_down.sql", "*.down.sql"]
}
