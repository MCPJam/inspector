import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "./definition-types.js";
import type {
  JsonObject,
  JsonValue,
  MockToolState,
} from "./definition-types.js";
import type { MockRecordOp, MockRecordOutcome } from "./record-store.js";
import { bindRefs } from "./state-refs.js";

/** Binding a declaration to a call's input, and turning a store's answer into the tool's result. */

type Obj = Record<string, unknown>;

export type Bind<T> = { ok: true; value: T } | { ok: false; message: string };

const missingInput = (tool: string, ref: string): string =>
  `The call to ${tool} has no value for ${ref}, which the mock's declaration reads. Pass it in the arguments and call again.`;

/** Fills a field's references from the input; a reference the input lacks is named. */
function bound(tool: string, value: JsonValue, input: Obj): Bind<JsonValue> {
  const filled = bindRefs(value, { input });
  return filled.ok
    ? filled
    : { ok: false, message: missingInput(tool, `{{${filled.missing}}}`) };
}

function bindText(
  tool: string,
  field: string,
  value: string | undefined,
  input: Obj
): Bind<string> {
  const filled = bound(tool, value ?? "", input);
  if (!filled.ok) return filled;
  if (typeof filled.value === "string" && filled.value !== "")
    return { ok: true, value: filled.value };
  return {
    ok: false,
    message: `The ${field} for ${tool} must be a non-empty string, and it came out as ${JSON.stringify(filled.value)}. Pass ${field === "key" ? "the record's key" : "text"} as a string.`,
  };
}

function bindObject(
  tool: string,
  value: JsonObject | undefined,
  input: Obj
): Bind<JsonObject> {
  const filled = bound(tool, value ?? {}, input);
  if (!filled.ok) return filled;
  return {
    ok: true,
    value: filled.value as JsonObject,
  };
}

/** A reference to `limit` or `cursor` the caller left out means "not given". */
function bindOptional(value: JsonValue | undefined, input: Obj) {
  if (value === undefined) return undefined;
  const filled = bindRefs(value, { input });
  return filled.ok ? filled.value : undefined;
}

/** The declaration with `input` filled in, ready for the store. */
export function bindOperation(
  tool: string,
  state: MockToolState,
  input: Obj
): Bind<MockRecordOp> {
  const { op, collection } = state;
  if (op === "list") {
    const where = bindObject(tool, state.where, input);
    if (!where.ok) return where;
    // Only a limit the call leaves out gets the default; a null the caller sent is its value and fails the check below.
    const given = bindOptional(state.limit, input);
    const limit = given === undefined ? DEFAULT_LIST_LIMIT : given;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIST_LIMIT
    ) {
      return {
        ok: false,
        message: `The limit for ${tool} must be a whole number from 1 to ${MAX_LIST_LIMIT}, and it came out as ${JSON.stringify(limit)}. Pass a smaller number.`,
      };
    }
    const cursor = bindOptional(state.cursor, input);
    if (cursor !== undefined && typeof cursor !== "string") {
      return {
        ok: false,
        message: `The cursor for ${tool} must be the nextCursor text an earlier call returned. Pass it as a string.`,
      };
    }
    return {
      ok: true,
      value: {
        op,
        collection,
        ...(state.where && { where: where.value }),
        limit,
        ...(cursor !== undefined && { cursor }),
      },
    };
  }
  if (op === "create") {
    const value = bindObject(tool, state.value, input);
    if (!value.ok) return value;
    if (state.key === undefined)
      return { ok: true, value: { op, collection, value: value.value } };
    const key = bindText(tool, "key", state.key, input);
    if (!key.ok) return key;
    return {
      ok: true,
      value: { op, collection, key: key.value, value: value.value },
    };
  }
  const key = bindText(tool, "key", state.key, input);
  if (!key.ok) return key;
  if (op === "patch") {
    const set = bindObject(tool, state.set, input);
    if (!set.ok) return set;
    return {
      ok: true,
      value: { op, collection, key: key.value, set: set.value },
    };
  }
  return { ok: true, value: { op, collection, key: key.value } };
}

/** What the store's answer is before a `result` template shapes it. */
export function recordOf(
  outcome: Extract<MockRecordOutcome, { ok: true }>
): JsonObject {
  if (outcome.kind === "record") return outcome.record;
  if (outcome.kind === "deleted") return { deleted: true, key: outcome.key };
  return {
    records: outcome.records,
    ...(outcome.nextCursor !== undefined && { nextCursor: outcome.nextCursor }),
  };
}

/**
 * The tool's structured result: the record (or `{ records, nextCursor }` for
 * `list`), or the `result` template filled over `record` or `records` and the
 * input. A reference the template makes to something missing is named.
 */
export function shapeResult(
  tool: string,
  state: MockToolState,
  outcome: Extract<MockRecordOutcome, { ok: true }>,
  input: Obj
): Bind<JsonObject> {
  const plain = recordOf(outcome);
  if (!state.result) return { ok: true, value: plain };
  const scope =
    outcome.kind === "page"
      ? { input, records: outcome.records }
      : { input, record: plain };
  const filled = bindRefs(state.result, scope);
  if (filled.ok) return { ok: true, value: filled.value };
  return {
    ok: false,
    message: `The result template for ${tool} reads {{${filled.missing}}}, which this call does not have. Fix the template, or pass the missing argument.`,
  };
}
