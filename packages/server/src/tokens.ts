/**
 * tokens.ts — token minting + hashing for the credential handoff.
 *
 * Token = 12 random bytes → base64url (16 chars, no padding), URL/CLI-safe.
 * Hash   = SHA-256(`${kind}:${raw}`) via Web Crypto — portable, available in
 *          every JS runtime (Bun/Node/Deno/browsers) and trivially in other
 *          languages. Stored as 64 lowercase hex chars.
 *
 * We store ONLY hashes; raw tokens are returned to the caller once and never
 * persisted or logged.
 */
import { randomBytes } from "crypto";
import { createHash } from "crypto";

/** 12 random bytes → base64url without padding → 16 chars. */
function randomToken(): string {
  return randomBytes(12).toString("base64url");
}

export type TokenKind = "bootstrap" | "access";

/** Mint a token: returns the raw value + its hash. */
export function mintToken(kind: TokenKind): { raw: string; hash: string } {
  const raw = randomToken();
  return { raw, hash: hashToken(kind, raw) };
}

/** Hash a raw token for verification / storage (SHA-256, lowercase hex). */
export function hashToken(kind: TokenKind, raw: string): string {
  return createHash("sha256").update(`${kind}:${raw}`).digest("hex");
}
