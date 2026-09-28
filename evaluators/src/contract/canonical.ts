/**
 * Canonical JSON + SHA-256, the hashing primitive under the evaluation
 * contract.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * Every hash in the contract must be reproducible in FOUR runtimes that share
 * no code: the SDK (Node), the inspector client (browser), the inspector server
 * and the Convex default runtime (where the backend hand-mirrors this file,
 * because `convex/` may not import the SDK main entry). That constraint drives
 * two choices:
 *
 *   - **Canonicalization is RFC 8785-style, not `JSON.stringify`.** Key order
 *     is an accident of construction; `{a,b}` and `{b,a}` describe the same
 *     evaluation config and must digest identically, or a cosmetic refactor
 *     would mark every case `configChanged`.
 *   - **The digest is `@noble/hashes` SHA-256, not Web Crypto.** Web Crypto's
 *     `subtle.digest` is async, and an async digest would poison every pure
 *     derivation in `derive.ts` — `definitionHash` is called from schema
 *     validation and from a Convex mutation, neither of which can await.
 *
 * The mirror in `mcpjam-backend/convex/lib/scoreContract.ts` is proven equal by
 * the `__digests` block of `score-contract-parity-fixtures.json`, which pins
 * literal digests rather than recomputing an expectation on both sides.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Thrown when a value cannot be canonicalized. Deliberately loud: silently
 * coercing `NaN` to `null` (which is what `JSON.stringify` does) would let two
 * different configs share a digest.
 */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(
      `Cannot canonicalize non-finite number: ${String(value)}`,
    );
  }
  // `-0` and `0` are the same JSON number; normalize so they cannot digest
  // differently. Otherwise `String(-0)` is already the shortest round-trip
  // form, which is what RFC 8785 specifies.
  return value === 0 ? "0" : String(value);
}

/**
 * RFC 8785-style canonical JSON.
 *
 * Rules, stated exactly so the Convex mirror can be read against them:
 *
 *   1. Object keys are sorted by UTF-16 code unit (plain `Array#sort`).
 *   2. Object properties whose value is `undefined` are DROPPED — this is what
 *      makes an unresolved optional and an absent field digest identically.
 *   3. `undefined` inside an array becomes `null`, matching `JSON.stringify`:
 *      dropping it would silently renumber positions.
 *   4. Numbers use the shortest round-trip form, with `-0` normalized to `0`.
 *      Non-finite numbers throw.
 *   5. Strings use `JSON.stringify` escaping, which is already RFC 8785's.
 *   6. Anything else (function, symbol, bigint, class instance with `toJSON`)
 *      throws rather than being coerced.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new CanonicalJsonError("Cannot canonicalize `undefined` at the root");
  }
  return write(value, new Set());
}

function write(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalizeNumber(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(
        `Cannot canonicalize value of type ${typeof value}`,
      );
  }

  // A cycle would otherwise recurse to a stack-overflow RangeError, which
  // reads as a crash rather than as "this value is not canonicalizable".
  if (ancestors.has(value as object)) {
    throw new CanonicalJsonError("Cannot canonicalize a circular structure");
  }
  ancestors.add(value as object);

  try {
    if (Array.isArray(value)) {
      // Indexed, NOT `.map()`. `map` skips holes in a sparse array, and the
      // resulting `join` emits empty fields — `[1,,3]` would canonicalize to
      // `"[1,,3]"`, which is not JSON and lets distinct configs collide.
      const entries: string[] = [];
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        const entry = value[index];
        entries.push(entry === undefined ? "null" : write(entry, ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(
        "Cannot canonicalize a non-plain object (only plain objects, arrays and " +
          "JSON primitives are part of the contract)",
      );
    }

    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${write(entry, ancestors)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    // Released on the way back up so a value that legitimately appears twice
    // in DIFFERENT branches is not mistaken for a cycle.
    ancestors.delete(value as object);
  }
}

/**
 * The outcome of {@link canonicalJsonBounded}.
 *
 * `overBudget` and `uncanonical` are both "we could not read this value", and
 * they stay distinct only so a reason can say which. Neither is ever a
 * truncated string: a prefix of canonical JSON is not canonical JSON, and a
 * caller that matched against one would be grading text the value never had.
 */
export type CanonicalJsonBoundedResult =
  | { ok: true; json: string }
  | { ok: false; reason: "overBudget" }
  | { ok: false; reason: "uncanonical"; message: string };

/** Thrown internally to unwind the writer the moment the budget is spent. */
const OVER_BUDGET: unique symbol = Symbol("canonicalJsonBounded.overBudget");

/** Appends output while counting it, and stops at the first overflow. */
class BoundedOutput {
  private readonly parts: string[] = [];
  private length = 0;

  constructor(private readonly maxChars: number) {}

  /** Characters still available before the budget is exceeded. */
  remaining(): number {
    return this.maxChars - this.length;
  }

  push(text: string): void {
    if (text.length > this.remaining()) throw OVER_BUDGET;
    this.parts.push(text);
    this.length += text.length;
  }

  /**
   * `JSON.stringify(text)` is at least `text.length + 2` characters, so a
   * string that cannot fit is refused BEFORE it is escaped. Escaping a
   * multi-megabyte argument only to throw the result away is the work the
   * budget exists to avoid.
   */
  pushString(text: string, suffix = ""): void {
    if (text.length + 2 + suffix.length > this.remaining()) throw OVER_BUDGET;
    this.push(JSON.stringify(text) + suffix);
  }

  toString(): string {
    return this.parts.join("");
  }
}

/**
 * {@link canonicalJson} with a character budget, for reading values nobody
 * bounded before we got them — a model-authored tool call's arguments.
 *
 * For any value whose canonical form fits in `maxChars` UTF-16 code units the
 * output is BYTE-IDENTICAL to `canonicalJson(value)`: same key order, same
 * number form, same escaping, same `undefined` rules. It is a second writer
 * rather than a wrapper because the point is to STOP — `canonicalJson` builds
 * the whole string before anyone can measure it, and a caller that measured
 * afterwards would already have paid for a value of any size. This one counts
 * as it writes and unwinds the moment the next piece would not fit, so a
 * ten-megabyte argument costs about `maxChars` of work.
 *
 * `canonicalJson` itself is untouched: it is a hash input, and hashes are
 * pinned across four runtimes.
 *
 * Never throws. A value `canonicalJson` would refuse (a non-finite number, a
 * cycle, a class instance, a getter that throws) is `uncanonical`; one that
 * does not fit is `overBudget`.
 */
export function canonicalJsonBounded(
  value: unknown,
  maxChars: number,
): CanonicalJsonBoundedResult {
  if (value === undefined) {
    return {
      ok: false,
      reason: "uncanonical",
      message: "Cannot canonicalize `undefined` at the root",
    };
  }
  const out = new BoundedOutput(maxChars);
  try {
    writeBounded(value, new Set(), out);
  } catch (error) {
    if (error === OVER_BUDGET) return { ok: false, reason: "overBudget" };
    return {
      ok: false,
      reason: "uncanonical",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, json: out.toString() };
}

/**
 * The bounded twin of {@link write}. Every branch mirrors it rule for rule;
 * the only difference is that output goes through `out`, which refuses to
 * grow past the budget. Change one without the other and the byte-identity
 * property test in `tests/tool-arguments-match.test.ts` fails.
 */
function writeBounded(
  value: unknown,
  ancestors: Set<object>,
  out: BoundedOutput,
): void {
  if (value === null) {
    out.push("null");
    return;
  }

  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      out.push(canonicalizeNumber(value));
      return;
    case "string":
      out.pushString(value);
      return;
    case "object":
      break;
    default:
      throw new CanonicalJsonError(
        `Cannot canonicalize value of type ${typeof value}`,
      );
  }

  if (ancestors.has(value as object)) {
    throw new CanonicalJsonError("Cannot canonicalize a circular structure");
  }
  ancestors.add(value as object);

  try {
    if (Array.isArray(value)) {
      out.push("[");
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        if (index > 0) out.push(",");
        const entry = value[index];
        if (entry === undefined) out.push("null");
        else writeBounded(entry, ancestors, out);
      }
      out.push("]");
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(
        "Cannot canonicalize a non-plain object (only plain objects, arrays and " +
          "JSON primitives are part of the contract)",
      );
    }

    const record = value as Record<string, unknown>;
    out.push("{");
    let first = true;
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      if (!first) out.push(",");
      first = false;
      out.pushString(key, ":");
      writeBounded(entry, ancestors, out);
    }
    out.push("}");
  } finally {
    ancestors.delete(value as object);
  }
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/**
 * The contract's one hashing entry point: canonicalize, then SHA-256.
 *
 * Returns bare lowercase hex (64 chars) with no algorithm prefix — the
 * narrowest possible surface for a hand-written mirror to reproduce.
 */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
