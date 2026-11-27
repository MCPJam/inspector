import { MAX_LIST_LIMIT, MOCK_STATE_OPS } from "./definition-types.js";
import type { MockStateOp } from "./definition-types.js";
import { refProblems } from "./state-refs.js";
import type { RefRoot } from "./state-refs.js";

/** Shape checks for a tool's `state` declaration and the definition's `seed`. */

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const at = (path: string, key: string) => `${path}.${key}`;

export type StateIssue = {
  code: "invalid_type" | "invalid_value" | "unknown_field" | "too_large";
  path: string;
  message: string;
};
type Add = (issue: StateIssue) => void;

const FIELDS: Record<MockStateOp, string[]> = {
  get: ["op", "collection", "key", "result"],
  list: ["op", "collection", "where", "limit", "cursor", "result"],
  create: ["op", "collection", "key", "value", "result"],
  patch: ["op", "collection", "key", "set", "result"],
  delete: ["op", "collection", "key", "result"],
};
const REQUIRED: Record<MockStateOp, string[]> = {
  get: ["key"],
  list: [],
  create: ["value"],
  patch: ["key", "set"],
  delete: ["key"],
};

const MAX_NAME = 256;

function checkName(value: unknown, path: string, what: string, add: Add): void {
  if (typeof value === "string" && value !== "" && value.length <= MAX_NAME)
    return;
  add({
    code: "invalid_type",
    path,
    message: `${path} must be ${what}: a string of 1 to ${MAX_NAME} characters.`,
  });
}

/** Checks one tool's `state`; every issue names its field path. */
export function checkToolState(value: unknown, path: string, add: Add): void {
  if (!isObj(value)) {
    add({
      code: "invalid_type",
      path,
      message: `${path} must be an object with "op" and "collection".`,
    });
    return;
  }
  const op = value.op;
  if (!MOCK_STATE_OPS.includes(op as MockStateOp)) {
    add({
      code: "invalid_value",
      path: at(path, "op"),
      message: `${at(path, "op")} must be one of ${MOCK_STATE_OPS.join(", ")}, not ${JSON.stringify(op)}.`,
    });
    return;
  }
  const kind = op as MockStateOp;
  for (const key of Object.keys(value)) {
    if (FIELDS[kind].includes(key)) continue;
    add({
      code: "unknown_field",
      path: at(path, key),
      message: `${at(path, key)} does not apply to "${kind}". Allowed fields: ${FIELDS[kind].join(", ")}.`,
    });
  }
  for (const key of REQUIRED[kind]) {
    if (!(key in value)) {
      add({
        code: "invalid_value",
        path: at(path, key),
        message: `${at(path, key)} is required for "${kind}". Add it.`,
      });
    }
  }
  checkName(value.collection, at(path, "collection"), "the collection", add);
  if ("key" in value) checkName(value.key, at(path, "key"), "a key", add);
  for (const field of ["where", "value", "set", "result"] as const) {
    if (field in value && !isObj(value[field])) {
      add({
        code: "invalid_type",
        path: at(path, field),
        message: `${at(path, field)} must be an object.`,
      });
    }
  }
  if (isObj(value.set) && Object.keys(value.set).length === 0) {
    add({
      code: "invalid_value",
      path: at(path, "set"),
      message: `${at(path, "set")} changes nothing. Name at least one field to change.`,
    });
  }
  if ("cursor" in value && typeof value.cursor !== "string") {
    add({
      code: "invalid_type",
      path: at(path, "cursor"),
      message: `${at(path, "cursor")} must be a string, usually "{{input.cursor}}".`,
    });
  }
  if ("limit" in value) {
    const limit = value.limit;
    const reference =
      typeof limit === "string" && /^\{\{[^{}]+\}\}$/.test(limit);
    const number =
      typeof limit === "number" &&
      Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= MAX_LIST_LIMIT;
    if (!reference && !number) {
      add({
        code: "invalid_value",
        path: at(path, "limit"),
        message: `${at(path, "limit")} must be a whole number from 1 to ${MAX_LIST_LIMIT}, or one reference such as "{{input.limit}}".`,
      });
    }
  }
  const bound: RefRoot[] = ["input"];
  for (const field of ["key", "where", "value", "set", "limit", "cursor"]) {
    if (field in value) {
      for (const p of refProblems(value[field], at(path, field), bound))
        add({ code: "invalid_value", ...p });
    }
  }
  if ("result" in value) {
    const roots: RefRoot[] = ["input", kind === "list" ? "records" : "record"];
    for (const p of refProblems(value.result, at(path, "result"), roots))
      add({ code: "invalid_value", ...p });
  }
}

/** The most records a seed may hold, across all collections. The backend refuses a save over it too. */
export const MOCK_SEED_MAX_RECORDS = 2000;

/** Checks `seed`: collections of records by key, each record an object, at most `MOCK_SEED_MAX_RECORDS` in all. */
export function checkSeed(value: unknown, path: string, add: Add): void {
  if (!isObj(value)) {
    add({
      code: "invalid_type",
      path,
      message: `${path} must be an object of collections.`,
    });
    return;
  }
  let count = 0;
  for (const [collection, records] of Object.entries(value)) {
    const cPath = at(path, collection);
    checkName(collection, cPath, "a collection name", add);
    if (!isObj(records)) {
      add({
        code: "invalid_type",
        path: cPath,
        message: `${cPath} must be an object of records by key.`,
      });
      continue;
    }
    for (const [key, record] of Object.entries(records)) {
      // Counted as the backend counts: an object in an object collection.
      if (isObj(record)) count++;
      const rPath = at(cPath, key);
      checkName(key, rPath, "a key", add);
      if (!isObj(record)) {
        add({
          code: "invalid_type",
          path: rPath,
          message: `${rPath} must be an object, the record stored under "${key}".`,
        });
      }
    }
  }
  if (count > MOCK_SEED_MAX_RECORDS) {
    add({
      code: "too_large",
      path,
      message: `${path} holds ${count} records, and a seed may hold at most ${MOCK_SEED_MAX_RECORDS}. Remove some records from the seed.`,
    });
  }
}
