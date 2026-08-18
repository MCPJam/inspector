/**
 * Opaque identity for contract objects — cases and suites.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * ── Why ids are opaque ────────────────────────────────────────────────────────
 *
 * Four id regimes already exist and all of them must remain valid: Convex
 * document ids on hosted cases, `ui_<nanoid>` on cases authored in the
 * inspector, ids minted here, and whatever a user hand-writes in a suite file.
 * So the validator constrains the CHARACTER SET and the LENGTH, and nothing
 * else — it never requires one of our prefixes. The prefixes {@link CASE_ID_PREFIX}
 * / {@link SUITE_ID_PREFIX} exist for humans grepping logs, not for machines
 * dispatching on them; a validator that demanded them would reject every id the
 * platform already issued.
 *
 * The charset is deliberately the URL/filename-safe one: ids end up in file
 * paths, YAML keys, CLI arguments and dashboard URLs, and a whitespace or
 * control character in any of those is a bug that surfaces far from where it
 * was authored.
 *
 * ── Why identity is DECLARED, never derived ──────────────────────────────────
 *
 * Nothing here derives an id from a title, a name, or a content hash. That is
 * the bug being retired: hosted history is joined on case identity, so an id
 * derived from display text forks a case's whole history the moment somebody
 * fixes a typo in its name. Minting is a convenience for authoring; once minted
 * the id is committed alongside the case and survives every rename.
 */

import { z } from "zod";

/** Max length of an opaque id. Comfortably above a Convex id or a `ui_<nanoid>`. */
export const MAX_OPAQUE_ID_LENGTH = 128;

/**
 * The one identity rule: URL-safe characters, 1..128 of them.
 *
 * Accepts every id regime in play (Convex ids, `ui_<nanoid>`, minted ids,
 * hand-authored ids) and rejects whitespace, control characters, path
 * separators and quoting metacharacters.
 */
export const opaqueIdSchema = z
  .string()
  .min(1)
  .max(MAX_OPAQUE_ID_LENGTH)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "id must contain only letters, digits, '-' and '_' (no whitespace or punctuation)"
  );

export type OpaqueId = z.infer<typeof opaqueIdSchema>;

/** Prefix stamped on minted CASE ids. Human-facing only — never dispatched on. */
export const CASE_ID_PREFIX = "c_";
/** Prefix stamped on minted SUITE ids. Human-facing only — never dispatched on. */
export const SUITE_ID_PREFIX = "s_";

/** Random characters in a minted id (nanoid's default entropy). */
export const MINTED_ID_ENTROPY_CHARS = 21;

/**
 * The 64-character URL-safe alphabet. Exactly 64 entries so `byte & 63` is a
 * uniform selection — no modulo bias, and no rejection loop to get it.
 */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * `crypto.getRandomValues`, resolved at CALL time rather than module load.
 *
 * Resolving at load would evaluate in environments that import the contract
 * purely for its types (a bundler's tree-shaking pass, a Convex analysis run),
 * and throwing there would break importers that never mint anything.
 */
function randomBytes(length: number): Uint8Array {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!webCrypto?.getRandomValues) {
    throw new Error(
      "Cannot mint an id: this runtime has no `crypto.getRandomValues`. " +
        "Pass an explicit id instead."
    );
  }
  return webCrypto.getRandomValues(new Uint8Array(length));
}

function mintId(prefix: string): string {
  const bytes = randomBytes(MINTED_ID_ENTROPY_CHARS);
  let out = prefix;
  for (const byte of bytes) {
    out += ALPHABET[byte & 63];
  }
  return out;
}

/**
 * A fresh case id: `c_` + 21 URL-safe characters of CSPRNG entropy.
 *
 * Mint ONCE and commit the result — an id regenerated on every run is not an
 * identity, and would fork history exactly the way a name-derived id does.
 */
export function mintCaseId(): string {
  return mintId(CASE_ID_PREFIX);
}

/** A fresh suite id: `s_` + 21 URL-safe characters of CSPRNG entropy. */
export function mintSuiteId(): string {
  return mintId(SUITE_ID_PREFIX);
}

/** True when `value` satisfies {@link opaqueIdSchema}. */
export function isOpaqueId(value: unknown): value is string {
  return opaqueIdSchema.safeParse(value).success;
}
