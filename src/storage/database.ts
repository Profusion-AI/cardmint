// Re-export everything from the SQLite implementation
export * from './sqlite-database';

// For backward compatibility, provide a getPool function that throws a helpful error
export function getPool(): never {
  throw new Error('PostgreSQL has been replaced with SQLite. Use getDatabase() instead.');
}