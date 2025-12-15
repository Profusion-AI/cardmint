/**
 * SQL Sanitization Utilities for PostgreSQL
 *
 * Provides safe SQL value escaping for use with raw SQL execution.
 * This is necessary because we execute SQL via SSH to a remote PostgreSQL instance
 * and cannot use parameterized queries directly.
 *
 * SECURITY: All user-provided values MUST go through these functions before SQL interpolation.
 */

/**
 * Escape a string value for safe use in PostgreSQL single-quoted literals.
 * Handles:
 * - Single quotes (doubled)
 * - Backslashes (doubled for standard_conforming_strings compatibility)
 * - NULL bytes (removed)
 * - Control characters (removed)
 *
 * @param value - The string to escape (null/undefined returns SQL NULL)
 * @returns Escaped string WITHOUT surrounding quotes, or "NULL" for null values
 */
export function escapeString(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  // Remove NULL bytes and other control characters (except newlines/tabs which may be valid)
  const sanitized = String(value)
    .replace(/\0/g, "") // Remove NULL bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, ""); // Remove control chars except \t, \n, \r

  // Escape backslashes first, then single quotes
  return sanitized
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''");
}

/**
 * Format a string value as a SQL literal (with surrounding quotes).
 * Returns NULL (without quotes) for null/undefined values.
 *
 * @param value - The string to format
 * @returns SQL literal like 'escaped_value' or NULL
 */
export function sqlString(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return `'${escapeString(value)}'`;
}

/**
 * Validate and format a numeric value for SQL.
 * Returns NULL for null/undefined/NaN values.
 * Throws on invalid input that could indicate injection attempt.
 *
 * @param value - The number to format
 * @param options - Formatting options
 * @returns Formatted number string or NULL
 */
export function sqlNumber(
  value: number | string | null | undefined,
  options: { decimals?: number; allowNegative?: boolean } = {}
): string {
  const { decimals, allowNegative = true } = options;

  if (value === null || value === undefined) {
    return "NULL";
  }

  // Parse if string
  const num = typeof value === "string" ? parseFloat(value) : value;

  // Validate it's a finite number
  if (!Number.isFinite(num)) {
    return "NULL";
  }

  // Check for negative if not allowed
  if (!allowNegative && num < 0) {
    throw new Error(`Negative number not allowed: ${num}`);
  }

  // Format with decimals if specified
  if (decimals !== undefined) {
    return num.toFixed(decimals);
  }

  return String(num);
}

/**
 * Validate and format an integer value for SQL.
 * Returns NULL for null/undefined/NaN values.
 * Throws on non-integer values.
 *
 * @param value - The integer to format
 * @returns Integer string or NULL
 */
export function sqlInt(value: number | string | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  const num = typeof value === "string" ? parseInt(value, 10) : value;

  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    return "NULL";
  }

  return String(num);
}

/**
 * Format a boolean value for SQL.
 *
 * @param value - The boolean to format
 * @returns 'true', 'false', or 'NULL'
 */
export function sqlBool(value: boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return value ? "true" : "false";
}

/**
 * Escape an identifier (table/column name) for PostgreSQL.
 * Uses double-quote escaping.
 *
 * @param identifier - The identifier to escape
 * @returns Double-quoted identifier
 */
export function sqlIdentifier(identifier: string): string {
  if (!identifier || typeof identifier !== "string") {
    throw new Error("Invalid SQL identifier");
  }

  // Only allow alphanumeric, underscore, and dollar sign (PostgreSQL identifier chars)
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(identifier)) {
    // If it contains special chars, double-quote it with proper escaping
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  return identifier;
}

/**
 * Build a SET clause from an object of column-value pairs.
 * Only includes non-undefined values.
 *
 * @param updates - Object mapping column names to values
 * @returns SET clause without the "SET" keyword, e.g., "col1 = 'val1', col2 = 123"
 */
export function buildSetClause(
  updates: Record<string, { value: unknown; type: "string" | "number" | "int" | "bool" }>
): string {
  const parts: string[] = [];

  for (const [column, config] of Object.entries(updates)) {
    if (config.value === undefined) continue;

    const col = sqlIdentifier(column);
    let val: string;

    switch (config.type) {
      case "string":
        val = sqlString(config.value as string | null);
        break;
      case "number":
        val = sqlNumber(config.value as number | null);
        break;
      case "int":
        val = sqlInt(config.value as number | null);
        break;
      case "bool":
        val = sqlBool(config.value as boolean | null);
        break;
      default:
        throw new Error(`Unknown type: ${config.type}`);
    }

    parts.push(`${col} = ${val}`);
  }

  return parts.join(", ");
}
