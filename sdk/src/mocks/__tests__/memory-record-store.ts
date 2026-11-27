import { jsonEqual } from "../saved-answers.js";
import type { JsonObject, MockSeed } from "../definition-types.js";
import type {
  MockRecordOp,
  MockRecordOutcome,
  MockRecordStore,
  MockRecordWrite,
  MockStateContext,
} from "../record-store.js";

type Collections = Map<string, Map<string, JsonObject>>;

/**
 * A record store in this process's memory, for tests only: the backend's store
 * (B5, B6) is shared across replicas and applies each call in one transaction.
 * Each state context starts from `seed` the first time it is used. `reset`
 * raises a run's epoch and restores its seed, as the backend's reset does.
 */
export function createMemoryRecordStore(
  seed: MockSeed = {}
): MockRecordStore & {
  reset(runId: string): number;
  /** How many writes were applied (a replayed outcome is not one). */
  applied: number;
} {
  const copies = new Map<string, Collections>();
  const epochs = new Map<string, number>();
  const saved = new Map<
    string,
    { fingerprint: string; outcome: MockRecordOutcome }
  >();
  let generated = 0;

  const fresh = (): Collections =>
    new Map(
      Object.entries(seed).map(([name, records]) => [
        name,
        new Map(
          Object.entries(records).map(([k, r]) => [k, structuredClone(r)])
        ),
      ])
    );
  const scopeOf = (context: MockStateContext) =>
    context.scope === "version" ? "version" : `run:${context.runId}`;
  const collectionsOf = (context: MockStateContext): Collections => {
    const scope = scopeOf(context);
    if (!copies.has(scope)) copies.set(scope, fresh());
    return copies.get(scope)!;
  };
  const records = (context: MockStateContext, name: string) => {
    const collections = collectionsOf(context);
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };

  const run = (
    context: MockStateContext,
    op: MockRecordOp
  ): MockRecordOutcome => {
    const rows = records(context, op.collection);
    switch (op.op) {
      case "get": {
        const record = rows.get(op.key);
        return record
          ? {
              ok: true,
              kind: "record",
              key: op.key,
              record: structuredClone(record),
            }
          : { ok: false, code: "not_found" };
      }
      case "list": {
        const keys = [...rows.keys()]
          .sort()
          .filter((k) =>
            Object.entries(op.where ?? {}).every(([f, v]) =>
              jsonEqual(rows.get(k)![f], v)
            )
          );
        let start = 0;
        if (op.cursor !== undefined) {
          const after = /^after:(.*)$/.exec(op.cursor)?.[1];
          if (after === undefined) return { ok: false, code: "invalid_cursor" };
          start = keys.findIndex((k) => k > after);
          if (start < 0) start = keys.length;
        }
        const page = keys.slice(start, start + op.limit);
        const more = start + op.limit < keys.length;
        return {
          ok: true,
          kind: "page",
          records: page.map((k) => structuredClone(rows.get(k)!)),
          ...(more && { nextCursor: `after:${page[page.length - 1]}` }),
        };
      }
      case "create": {
        const key = op.key ?? `gen-${++generated}`;
        if (rows.has(key)) return { ok: false, code: "already_exists" };
        rows.set(key, structuredClone(op.value));
        return {
          ok: true,
          kind: "record",
          key,
          record: structuredClone(op.value),
        };
      }
      case "patch": {
        const record = rows.get(op.key);
        if (!record) return { ok: false, code: "not_found" };
        const next = { ...record, ...structuredClone(op.set) };
        rows.set(op.key, next);
        return {
          ok: true,
          kind: "record",
          key: op.key,
          record: structuredClone(next),
        };
      }
      case "delete":
        return rows.delete(op.key)
          ? { ok: true, kind: "deleted", key: op.key }
          : { ok: false, code: "not_found" };
    }
  };

  const store = {
    applied: 0,
    reset(runId: string): number {
      const epoch = (epochs.get(runId) ?? 1) + 1;
      epochs.set(runId, epoch);
      copies.set(`run:${runId}`, fresh());
      return epoch;
    },
    async execute(
      context: MockStateContext,
      op: MockRecordOp,
      write?: MockRecordWrite
    ): Promise<MockRecordOutcome> {
      const writes = op.op !== "get" && op.op !== "list";
      if (context.scope === "run") {
        const current = epochs.get(context.runId) ?? 1;
        if (writes && context.epoch < current)
          return { ok: false, code: "stale_epoch" };
      }
      const slot =
        write &&
        `${scopeOf(context)}|${context.scope === "run" ? context.epoch : 0}|${write.key}`;
      if (write && slot) {
        const earlier = saved.get(slot);
        if (earlier) {
          return earlier.fingerprint === write.fingerprint
            ? earlier.outcome
            : { ok: false, code: "operation_conflict" };
        }
      }
      const outcome = run(context, op);
      if (writes && outcome.ok) {
        store.applied += 1;
        if (write && slot)
          saved.set(slot, { fingerprint: write.fingerprint, outcome });
      }
      return outcome;
    },
  };
  return store;
}
