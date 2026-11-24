/**
 * Structural caps on a stored mock definition. The numbers are the same as the
 * backend's `convex/lib/mockDefinitionCaps.ts`; the two repos cannot import
 * each other, so `npm run check:mirrors` there pins both. Change them in both
 * places or not at all.
 */
export const MOCK_DEFINITION_CAPS = {
  /** UTF-8 length of `JSON.stringify(definition)`. */
  maxBytes: 524288,
  /** The root object is depth 1; each nested object or array adds 1. */
  maxDepth: 32,
  /** Every object, array and primitive value counts once. */
  maxNodes: 20000,
  /** Longest string under any key named `pattern`. */
  maxPatternLength: 1000,
} as const;

/** A `$ref` must start with this, so a definition never reaches outside itself. */
export const MOCK_DEFINITION_REF_PREFIX = "#";

export type MockCapIssueCode =
  | "not_json"
  | "too_large"
  | "too_deep"
  | "too_many_nodes"
  | "pattern_too_long"
  | "ref_not_local";

export interface MockCapIssue {
  code: MockCapIssueCode;
  /** Dotted path to the value, e.g. `tools.search.inputSchema.pattern`. */
  path: string;
  message: string;
}

const { maxBytes, maxDepth, maxNodes, maxPatternLength } = MOCK_DEFINITION_CAPS;

interface Walk {
  nodes: number;
  stopped: boolean;
  issues: MockCapIssue[];
}

const MAX_ISSUES = 50;
function fail(w: Walk, code: MockCapIssueCode, path: string, message: string) {
  if (w.issues.length < MAX_ISSUES) w.issues.push({ code, path, message });
}

function visit(
  value: unknown,
  path: string,
  key: string | undefined,
  depth: number,
  w: Walk
): void {
  if (w.stopped) return;
  w.nodes += 1;
  if (w.nodes > maxNodes) {
    w.stopped = true;
    fail(
      w,
      "too_many_nodes",
      path,
      `The definition has more than ${maxNodes} values (objects, arrays and fields each count). Remove unused schema branches, then save again.`
    );
    return;
  }
  const where = path || "The definition";
  if (typeof value === "string") {
    if (key === "pattern" && value.length > maxPatternLength) {
      fail(
        w,
        "pattern_too_long",
        path,
        `The pattern at ${path} is ${value.length} characters; the limit is ${maxPatternLength}. Shorten it.`
      );
    }
    if (key === "$ref" && !value.startsWith(MOCK_DEFINITION_REF_PREFIX)) {
      fail(
        w,
        "ref_not_local",
        path,
        `The $ref at ${path} points outside the definition. A $ref must start with "#" and name a place in the same schema.`
      );
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  const proto =
    typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  const container =
    Array.isArray(value) ||
    proto === Object.prototype ||
    (proto === null && typeof value === "object");
  if (!container || typeof value !== "object" || value === null) {
    fail(
      w,
      "not_json",
      path,
      `${where} holds a value JSON cannot carry. Use only objects, arrays, strings, finite numbers, booleans and null.`
    );
    return;
  }
  if (depth > maxDepth) {
    w.stopped = true;
    fail(
      w,
      "too_deep",
      path,
      `The definition nests deeper than ${maxDepth} levels at ${path}. Flatten that schema.`
    );
    return;
  }
  const entries: Array<[string | undefined, unknown, string]> = Array.isArray(
    value
  )
    ? value.map((item, i): [undefined, unknown, string] => [
        undefined,
        item,
        `${path}[${i}]`,
      ])
    : Object.entries(value).map(([k, v]): [string, unknown, string] => [
        k,
        v,
        path === "" ? k : `${path}.${k}`,
      ]);
  for (const [childKey, child, childPath] of entries)
    visit(child, childPath, childKey, depth + 1, w);
}

/** Every cap `value` breaks; an empty list means it fits. Never throws. */
export function checkDefinitionCaps(value: unknown): MockCapIssue[] {
  const w: Walk = { nodes: 0, stopped: false, issues: [] };
  visit(value, "", undefined, 1, w);
  // Serializing is safe only once the walk found nothing JSON cannot carry and
  // nothing too deep (a cycle is always too deep).
  if (w.issues.length === 0) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes > maxBytes) {
      fail(
        w,
        "too_large",
        "",
        `The definition is ${bytes} bytes; the limit is ${maxBytes}. Shorten descriptions, or drop schemas you do not change.`
      );
    }
  }
  return w.issues;
}
