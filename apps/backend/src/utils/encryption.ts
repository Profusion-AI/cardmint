/**
 * AES-256-GCM encryption utilities for PII storage
 *
 * Used for marketplace shipping addresses that need temporary storage.
 * Key should be stored in environment variable CARDMINT_ENCRYPTION_KEY (32 bytes, hex-encoded).
 *
 * Security notes:
 * - Uses AES-256-GCM (authenticated encryption)
 * - Generates unique IV for each encryption
 * - Includes auth tag to prevent tampering
 * - Never log decrypted values
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

// Track whether we've warned about fallback key (log once max)
let fallbackWarningLogged = false;

/**
 * Get or derive the encryption key from environment.
 * In production (CARDMINT_ENV=production), fails fast if CARDMINT_ENCRYPTION_KEY is not set.
 * In dev, derives from a fallback (warns once).
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.CARDMINT_ENCRYPTION_KEY;

  if (envKey) {
    // Expect 64 hex characters (32 bytes)
    if (envKey.length !== 64) {
      throw new Error(
        "CARDMINT_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"
      );
    }
    return Buffer.from(envKey, "hex");
  }

  // In production, fail fast - no fallback allowed
  if (process.env.CARDMINT_ENV === "production") {
    throw new Error(
      "CARDMINT_ENCRYPTION_KEY is required in production. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  // Fallback for development only - warn once
  const fallbackSeed =
    process.env.EASYPOST_API_KEY ||
    process.env.STRIPE_SECRET_KEY ||
    "cardmint-dev-fallback-key";

  if (!fallbackWarningLogged) {
    console.warn(
      "[encryption] CARDMINT_ENCRYPTION_KEY not set, using derived fallback key (dev only)"
    );
    fallbackWarningLogged = true;
  }

  return createHash("sha256").update(fallbackSeed).digest();
}

/**
 * Encrypt a string value using AES-256-GCM.
 * Returns base64-encoded string containing: IV + ciphertext + authTag
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: IV (12 bytes) + ciphertext + authTag (16 bytes)
  const combined = Buffer.concat([iv, encrypted, authTag]);
  return combined.toString("base64");
}

/**
 * Decrypt a value encrypted with encrypt().
 * Returns the original plaintext string.
 */
export function decrypt(encryptedBase64: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(encryptedBase64, "base64");

  // Extract components
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(
    IV_LENGTH,
    combined.length - AUTH_TAG_LENGTH
  );

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Encrypt a JSON object.
 */
export function encryptJson<T>(data: T): string {
  return encrypt(JSON.stringify(data));
}

/**
 * Decrypt to a JSON object.
 */
export function decryptJson<T>(encryptedBase64: string): T {
  const plaintext = decrypt(encryptedBase64);
  return JSON.parse(plaintext) as T;
}

/**
 * Generate a new random encryption key (for setup/rotation).
 * Returns a 64-character hex string suitable for CARDMINT_ENCRYPTION_KEY.
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Compute SHA-256 hash of content (for file checksums, etc.)
 */
export function computeChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
