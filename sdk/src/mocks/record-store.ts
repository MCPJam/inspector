import { canonicalDigest } from "../contract/canonical.js";
import type { JsonObject } from "./definition-types.js";

/**
 * Where a mock's records are read and written. The host supplies the store and
 * says which copy a call works on; the SDK never holds records itself.
 */

/** The request `_meta` key a caller sends to make a write safe to retry. */
export const OPERATION_KEY_META = "mcpjam.com/operationKey";

/** Longest operation key the runtime accepts. */
export const MAX_OPERATION_KEY_LENGTH = 256;

/**
 * Which copy of the records a call works on: the saved version's shared
 * records, or one run's own copy at an epoch. A reset raises the run's epoch,
 * and the store refuses a write from an older one.
 */
export type MockStateContext =
  { scope: "version" } | { scope: "run"; runId: string; epoch: number };

/** One declared operation with its references filled in. */
export type MockRecordOp =
  | { op: "get"; collection: string; key: string }
  | {
      op: "list";
      collection: string;
      where?: JsonObject;
      /** 1 to 200. */
      limit: number;
      cursor?: string;
    }
  | { op: "create"; collection: string; key?: string; value: JsonObject }
  | { op: "patch"; collection: string; key: string; set: JsonObject }
  | { op: "delete"; collection: string; key: string };

/**
 * What a retried write needs. `key` is the caller's operation key and
 * `fingerprint` the canonical digest of the method, tool and arguments, so
 * the store can tell a retry from a different request that reused the key.
 */
export interface MockRecordWrite {
  key: string;
  fingerprint: string;
}

/** Why the store refused an operation. */
export type MockRecordErrorCode =
  /** `get`, `patch` or `delete` on a key the collection does not hold. */
  | "not_found"
  /** `create` on a key the collection already holds. */
  | "already_exists"
  /** The call's epoch is older than the run's: a reset happened since. */
  | "stale_epoch"
  /** The operation key was used before with a different fingerprint. */
  | "operation_conflict"
  /** `list` was given a cursor the store did not issue. */
  | "invalid_cursor"
  /** A write would add a record to a scope that already holds the most it may (10,000). */
  | "records_full";

export type MockRecordOutcome =
  /** `get`, `create` or `patch`: the record, and the key it is stored under. */
  | { ok: true; kind: "record"; key: string; record: JsonObject }
  | { ok: true; kind: "deleted"; key: string }
  | {
      ok: true;
      kind: "page";
      /** In key order. */
      records: JsonObject[];
      nextCursor?: string;
    }
  | { ok: false; code: MockRecordErrorCode };

/**
 * Every call is atomic. A write carrying `write` is applied at most once per
 * operation key, scoped by caller, tenant and project, mock version, state
 * context and epoch: in one transaction the store looks the key up, applies
 * the mutation and saves the outcome with the fingerprint.
 *
 * - A repeated key with the same fingerprint returns the saved outcome and
 *   applies nothing.
 * - The same key with a different fingerprint answers `operation_conflict`.
 * - A call without `write` is a new operation every time.
 * - Only an applied write saves an outcome: a refusal leaves the key unused.
 * - A write whose epoch is older than the run's answers `stale_epoch` and
 *   applies nothing.
 * - `create` without a key generates one; the record is stored as given.
 * - `patch` merges the declared fields over the record (top level).
 * - `list` returns records in key order, those whose fields all equal
 *   `where`, at most `limit`, with `nextCursor` when more remain.
 */
export interface MockRecordStore {
  execute(
    context: MockStateContext,
    op: MockRecordOp,
    write?: MockRecordWrite
  ): Promise<MockRecordOutcome>;
}

/** What `buildMock` needs to serve tools that declare `state`. */
export interface MockRecords {
  store: MockRecordStore;
  context: MockStateContext;
}

/** `_meta` for a request that retries a write under `key`; spread it into the call's `_meta`. */
export function operationKeyMeta(key: string): Record<string, string> {
  return { [OPERATION_KEY_META]: key };
}

/** The fingerprint of a tool call: the same method, tool and arguments digest the same whatever the key order. */
export function fingerprintToolCall(
  tool: string,
  args: Record<string, unknown>
): string {
  return canonicalDigest({ method: "tools/call", tool, arguments: args });
}
