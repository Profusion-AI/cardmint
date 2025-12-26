"""
Configuration management for Internal Debug API.

Uses Pydantic Settings for environment-based configuration with validation.
"""

from functools import lru_cache
from typing import Set

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Security
    internal_debug_token: str = ""
    internal_allowed_ips: str = ""  # Comma-separated
    internal_trusted_proxies: str = ""  # Comma-separated

    # PostgreSQL - Default read-only role
    # Full CRUD requires Kyle approval + BTFRS snapshot
    postgres_host: str = "database"  # Docker network hostname in prod
    postgres_port: int = 5432
    postgres_user: str = "evershop"
    postgres_password: str = ""
    postgres_db: str = "evershop"
    postgres_pool_min: int = 1
    postgres_pool_max: int = 5
    postgres_connect_timeout: int = 10
    # Write role guardrails (CRUD requires explicit approval + BTFRS snapshot)
    db_write_enabled: bool = False
    db_write_approved: bool = False
    db_btfrs_snapshot: bool = False

    # EverShop
    evershop_graphql_url: str = "http://evershop:3000/api/graphql"
    evershop_admin_token: str = ""

    # Rate limiting (requests per minute)
    rate_limit_db_rpm: int = 10
    rate_limit_evershop_rpm: int = 5
    rate_limit_logs_rpm: int = 2

    # Execution limits
    command_timeout_sec: int = 10
    max_output_bytes: int = 65536  # 64KB
    max_log_lines: int = 500

    # Logging
    log_level: str = "INFO"

    # Log sources (explicit allowlist - fixed paths only)
    log_source_nginx_access: str = "/var/log/nginx/access.log"
    log_source_nginx_error: str = "/var/log/nginx/error.log"
    log_source_cardmint_backend: str = ""  # journalctl unit or file path
    log_source_evershop_file: str = ""  # File path only (no Docker socket)
    log_source_postgres_file: str = ""  # File path only (no Docker socket)

    @property
    def allowed_ips_set(self) -> Set[str]:
        """Parse comma-separated IP allowlist into a set."""
        if not self.internal_allowed_ips:
            return set()
        return {ip.strip() for ip in self.internal_allowed_ips.split(",") if ip.strip()}

    @property
    def trusted_proxies_set(self) -> Set[str]:
        """Parse comma-separated trusted proxy IPs into a set."""
        if not self.internal_trusted_proxies:
            return set()
        return {
            ip.strip()
            for ip in self.internal_trusted_proxies.split(",")
            if ip.strip()
        }

    @property
    def postgres_dsn(self) -> str:
        """Build PostgreSQL connection string."""
        return (
            f"host={self.postgres_host} "
            f"port={self.postgres_port} "
            f"user={self.postgres_user} "
            f"password={self.postgres_password} "
            f"dbname={self.postgres_db} "
            f"connect_timeout={self.postgres_connect_timeout}"
        )


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
