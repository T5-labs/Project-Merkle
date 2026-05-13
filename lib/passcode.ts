/**
 * Passcode utilities for per-session join protection.
 *
 * generatePasscode()  — creates a 16-char URL-safe base64 string (~96 bits entropy).
 * hashPasscode()      — scrypt-hashes the passcode with a random salt.
 *                       Stored format: `${saltHex}:${derivedKeyHex}`.
 * verifyPasscode()    — constant-time comparison against a stored hash.
 *
 * No external dependencies — uses Node's built-in `crypto` module only.
 * SERVER-ONLY: never import this from client code.
 */
import "server-only";

import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt) as (
  pwd: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** Returns a 16-character URL-safe base64 passcode (~96 bits of entropy). */
export function generatePasscode(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * Hashes a passcode with scrypt + 16-byte random salt.
 * Returns `${saltHex}:${derivedKeyHex}` suitable for DB storage.
 */
export async function hashPasscode(passcode: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(passcode, salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Verifies a plaintext passcode against a stored hash string.
 * Uses timingSafeEqual to prevent timing-based attacks.
 * Returns false (not throws) on malformed stored values.
 */
export async function verifyPasscode(
  passcode: string,
  stored: string,
): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  const derived = await scryptAsync(passcode, salt, 64);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
