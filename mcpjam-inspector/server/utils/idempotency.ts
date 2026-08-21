/**
 * Write-path idempotency for unattended callers.
 *
 * An unattended caller — the Slack bot, the scheduled worker — is exactly the
 * caller that retries. If a turn crashes after persisting an eval suite but
 * before its reply lands, the retry has to run again, and its mutations must
 * land on the SAME rows rather than authoring a second suite and billing a
 * second run.
 *
 * The key is carried on a HEADER rather than in the request body, for two
 * reasons:
 *
 *   1. It is transport metadata, not part of any operation's public schema.
 *      The agent's tool schemas are model-facing; a model must never be able
 *      to invent, omit, or vary an idempotency key, because the key is the
 *      whole safety property.
 *   2. It applies uniformly to every write route without each one having to
 *      grow (and correctly forward) another body field.
 */
import { createHash } from "node:crypto";
import type { Context } from "hono";

export const IDEMPOTENCY_KEY_HEADER = "x-mcpjam-idempotency-key";

/**
 * The OTHER spelling, and it is not a typo.
 *
 * `PlatformApiClient` puts `options.idempotencyKey` on a bare
 * `idempotency-key` header, and the journey / swarm / persona routes read it
 * there directly. So the platform genuinely has two channels: this one, which
 * every SDK caller reaches for free, and the prefixed one above, which the
 * agent adapter sets on its internal fetch.
 *
 * The two not matching is a silent failure, not a loud one — a route that
 * reads only the prefixed header ignores an SDK caller's key and re-spends
 * on every retry, while the caller sees a key going out and assumes it took.
 * A route that spends should accept both.
 */
export const IDEMPOTENCY_KEY_TRANSPORT_HEADER = "idempotency-key";

/**
 * Convex's `idempotencyKey` columns are plain strings; a runaway key would be
 * stored verbatim on every row it touches. Long enough for
 * `${teamId}:${eventId}:${operation}:${sha256}` with room to spare.
 */
const MAX_KEY_LENGTH = 256;

/**
 * Read a caller-supplied idempotency key off the request.
 *
 * Returns undefined for absent OR malformed keys rather than throwing: an
 * unusable key must degrade to "no idempotency" (the pre-existing behaviour),
 * never to a rejected write. A caller that mis-formats its key should still
 * get its suite created.
 */
export function readIdempotencyKey(c: Context): string | undefined {
  return readKeyHeader(c, IDEMPOTENCY_KEY_HEADER);
}

/**
 * Read the key off EITHER header, prefixed first.
 *
 * For routes that spend, where "the caller sent a key on the other header and
 * we ignored it" costs real money. Precedence keeps the prefixed header
 * authoritative: the agent adapter sets it per operation, and on the agent
 * surfaces an inbound transport header is not ours to trust over it.
 */
export function readAnyIdempotencyKey(c: Context): string | undefined {
  return (
    readKeyHeader(c, IDEMPOTENCY_KEY_HEADER) ??
    readKeyHeader(c, IDEMPOTENCY_KEY_TRANSPORT_HEADER)
  );
}

function readKeyHeader(c: Context, header: string): string | undefined {
  const raw = c.req.header(header);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH) {
    return undefined;
  }
  return trimmed;
}

/**
 * Derive the per-tool-call key for one operation invocation.
 *
 * A single agent turn can issue several writes, so the turn-level key alone
 * would collapse them onto one row. Scoping by operation NAME and by a hash of
 * the INPUT gives each distinct write its own identity while keeping a retry
 * of the same write stable — the retried turn re-issues the same call with the
 * same arguments, so it hashes the same and lands on the same record.
 *
 * The input is hashed rather than embedded: arguments can be kilobytes of
 * authored eval cases, and the key is persisted on the row.
 *
 * Note the residual case this deliberately does NOT solve: a retried turn
 * whose model authors *materially different* arguments produces a different
 * hash and therefore a second row. That is correct — it is genuinely a
 * different write — and it is why durable event claims sit in front of this
 * layer to keep most retries from re-running the turn at all.
 */
export function deriveOperationIdempotencyKey(
  turnKey: string,
  operation: string,
  input: unknown
): string {
  let canonical: string;
  try {
    canonical = stableStringify(input);
  } catch {
    // Cyclic or otherwise un-serializable input. Fall back to the operation
    // alone: still stable across a retry of the same turn, which is what the
    // key is for.
    canonical = `__uncanonicalizable__:${operation}`;
  }
  // The turn key is HASHED rather than prefixed verbatim. Prefixing let the
  // derived key inherit the caller's length AND its character set, so a long
  // (but individually valid) turn key produced a composite past MAX_KEY_LENGTH
  // — which `readIdempotencyKey` then dropped SILENTLY, quietly turning off
  // idempotency for exactly the caller who asked for it. Hashing makes the
  // width fixed by construction.
  const turnDigest = createHash("sha256")
    .update(turnKey)
    .digest("hex")
    .slice(0, 24);
  const digest = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 32);
  // Bounded: 24 + 1 + operation + 1 + 32. Operation names are code-defined and
  // short, so this is comfortably inside MAX_KEY_LENGTH.
  return `${turnDigest}:${operation}:${digest}`;
}

/**
 * Derive a key for one item within an operation (e.g. each case authored by a
 * single `create_eval_suite` call), so a retry after a PARTIAL failure
 * re-creates only the cases that did not commit.
 */
export function deriveItemIdempotencyKey(
  operationKey: string,
  itemDiscriminator: string
): string {
  const digest = createHash("sha256")
    .update(itemDiscriminator)
    .digest("hex")
    .slice(0, 16);
  return `${operationKey}:item:${digest}`;
}

/**
 * JSON.stringify with sorted object keys.
 *
 * Plain `JSON.stringify` preserves insertion order, so two structurally
 * identical inputs whose keys were built in a different order would hash
 * differently — and a retry would silently create a duplicate. Arrays keep
 * their order, which is correct: `steps` order is semantic.
 */
/**
 * Depth bound. Authored eval suites nest a few levels (suite → cases → steps →
 * assertion args); anything past this is either pathological or adversarial,
 * and an unbounded recursion here would throw `RangeError` and fail the WRITE
 * — turning a hashing detail into a lost suite.
 */
const MAX_CANONICAL_DEPTH = 32;

/**
 * Fingerprint the subtree below the depth cap without recursing and without
 * throwing.
 *
 * The obvious implementation — `JSON.stringify` the subtree and hash it — has
 * two ways to throw: a cycle, and a structure deep enough to overflow the
 * stack. Both would land on a catch, and the only thing a catch can return is a
 * constant, which is exactly the collision this exists to avoid: two materially
 * different inputs would share an idempotency key, and the second write would
 * silently REPLAY the first one\'s row.
 *
 * So this walks iteratively with an explicit stack and treats a repeated
 * reference as a back-edge marker instead of following it. Every exit is a
 * value, so no input can fall through to a constant. Keys are sorted here too,
 * which the `JSON.stringify` version did not do — structurally identical
 * subtrees built in a different key order now agree.
 *
 * NOTHING IS TRUNCATED. An earlier version stopped at a node budget and emitted
 * a fixed marker, which reintroduced the collision one layer down: every input
 * whose tail fell past the budget shared a digest, so a later write with a
 * different tail could replay an earlier one. A fingerprint that silently stops
 * distinguishing is worse than no fingerprint, because the caller cannot tell.
 * The bound that matters is upstream — the request body is size-limited before
 * it ever reaches here — and reading an input you have already accepted is
 * work you have already agreed to do.
 */
function boundedDigest(root: unknown): string {
  const hash = createHash("sha256");
  const seen = new Set<object>();
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== "object") {
      hash.update(` ${JSON.stringify(value) ?? "null"}`);
      continue;
    }
    if (seen.has(value)) {
      // A cycle or a shared reference. Marking it keeps the walk finite while
      // still distinguishing "points back" from "absent".
      hash.update(" cycle");
      continue;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      hash.update(` [${value.length}`);
      // Pushed in reverse so the stack pops them in source order: order is
      // semantic for arrays and must survive into the digest.
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push(value[index]);
      }
      continue;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    // Keys are folded into the hash directly rather than pushed onto the stack
    // as marker strings: a marker on the stack is indistinguishable from a
    // string VALUE that happens to equal it. The quoted list keeps a key
    // containing a comma from reading as two keys.
    hash.update(` {${JSON.stringify(entries.map(([key]) => key))}`);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      stack.push(entries[index]?.[1]);
    }
  }
  return hash.digest("hex");
}

function stableStringify(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    // Past the depth bound, stop RECURSING but do not stop DISTINGUISHING.
    // A constant here would give two materially different inputs the same key,
    // so a second write could silently land on the first one's row.
    return JSON.stringify(boundedDigest(value));
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((member) => stableStringify(member, depth + 1))
      .join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members are absent from JSON, so including them would make
    // `{a: 1}` and `{a: 1, b: undefined}` hash differently despite being the
    // same request on the wire.
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(
      ([key, member]) =>
        `${JSON.stringify(key)}:${stableStringify(member, depth + 1)}`
    )
    .join(",")}}`;
}
