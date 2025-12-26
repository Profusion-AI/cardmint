"""
PostgreSQL connection management for Internal Debug API.

Uses psycopg 3 with async connection pooling. Connection pool is initialized
at startup via FastAPI lifespan and cleaned up on shutdown.

Security: Default read-only role. Full CRUD requires Kyle approval + BTFRS snapshot.
"""

import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator, Optional

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import Settings

logger = logging.getLogger(__name__)


class DatabaseManager:
    """
    Manages PostgreSQL connection pool for async operations.

    Designed for use with FastAPI lifespan pattern:
    - Call connect() at startup
    - Use connection() context manager for queries
    - Call disconnect() at shutdown
    """

    def __init__(self, settings: Settings):
        """
        Initialize database manager.

        Args:
            settings: Application settings containing DB configuration
        """
        self.settings = settings
        self._pool: Optional[AsyncConnectionPool] = None

    async def connect(self) -> None:
        """
        Initialize the connection pool.

        Call this during application startup.
        """
        if self._pool is not None:
            logger.warning("Connection pool already initialized")
            return
        if self.settings.db_write_enabled:
            if not (self.settings.db_write_approved and self.settings.db_btfrs_snapshot):
                raise RuntimeError(
                    "DB write role enabled without required approval/snapshot. "
                    "Set DB_WRITE_APPROVED=true and DB_BTFRS_SNAPSHOT=true."
                )

        try:
            self._pool = AsyncConnectionPool(
                self.settings.postgres_dsn,
                min_size=self.settings.postgres_pool_min,
                max_size=self.settings.postgres_pool_max,
                open=False,  # Don't open immediately
            )
            await self._pool.open()
            logger.info(
                "PostgreSQL connection pool opened",
                extra={
                    "host": self.settings.postgres_host,
                    "port": self.settings.postgres_port,
                    "database": self.settings.postgres_db,
                    "pool_min": self.settings.postgres_pool_min,
                    "pool_max": self.settings.postgres_pool_max,
                },
            )
        except Exception as e:
            logger.error(f"Failed to initialize connection pool: {e}")
            raise

    async def disconnect(self) -> None:
        """
        Close the connection pool.

        Call this during application shutdown.
        """
        if self._pool is None:
            return

        try:
            await self._pool.close()
            self._pool = None
            logger.info("PostgreSQL connection pool closed")
        except Exception as e:
            logger.error(f"Error closing connection pool: {e}")

    @asynccontextmanager
    async def connection(self) -> AsyncGenerator[psycopg.AsyncConnection, None]:
        """
        Get a connection from the pool.

        Usage:
            async with db_manager.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute("SELECT 1")

        Yields:
            AsyncConnection from the pool

        Raises:
            RuntimeError: If pool is not initialized
        """
        if self._pool is None:
            raise RuntimeError("Database pool not initialized. Call connect() first.")

        async with self._pool.connection() as conn:
            yield conn

    async def execute_query(
        self,
        query: str,
        params: Optional[dict[str, Any]] = None,
        timeout: float = 10.0,
    ) -> list[dict[str, Any]]:
        """
        Execute a query and return results as list of dicts.

        This is a convenience method for simple queries.

        Args:
            query: SQL query string (use %(name)s for parameters)
            params: Query parameters dict
            timeout: Query timeout in seconds

        Returns:
            List of result rows as dictionaries
        """
        async with self.connection() as conn:
            # Set statement timeout for this connection
            await conn.execute(
                f"SET statement_timeout = '{int(timeout * 1000)}'"
            )

            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(query, params)

                # Handle queries that don't return rows
                if cur.description is None:
                    return []

                rows = await cur.fetchall()
                return list(rows)

    async def health_check(self) -> bool:
        """
        Check if database connection is healthy.

        Returns:
            True if database is reachable, False otherwise
        """
        try:
            async with self.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute("SELECT 1")
                    return True
        except Exception as e:
            logger.warning(f"Database health check failed: {e}")
            return False

    @property
    def is_connected(self) -> bool:
        """Check if pool is initialized and open."""
        return self._pool is not None
