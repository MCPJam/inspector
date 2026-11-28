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
  /** UTF-16 length of every string value and key seen so far. */
  chars: number;
  stopped: boolean;
  issues: MockCapIssue[];
}

const MAX_ISSUES = 50;
function fail(w: Walk, code: MockCapIssueCode, path: string, message: string) {
  if (w.issues.length < MAX_ISSUES) w.issues.push({ code, path, message });
}

/**
 * Adds a string's length to the running total; false once it passes the byte
 * cap. UTF-8 JSON is never shorter than the UTF-16 length of its strings and
 * keys, so the definition is then certainly too large, and the walk stops
 * before anything is serialized.
 */
function countChars(w: Walk, length: number): boolean {
  w.chars += length;
  if (w.chars <= maxBytes) return true;
  w.stopped = true;
  // Recorded even when earlier issues filled the list: it is why the walk stopped.
  w.issues.push({
    code: "too_large",
    path: "",
    message: `The definition is more than ${maxBytes} bytes. Shorten descriptions, or drop schemas you do not change.`,
  });
  return false;
}

/** Counts one value; false once the node cap is passed, after recording it. */
function countNode(w: Walk, path: string): boolean {
  w.nodes += 1;
  if (w.nodes <= maxNodes) return true;
  w.stopped = true;
  // Recorded even when earlier issues filled the list: it is why the walk stopped.
  w.issues.push({
    code: "too_many_nodes",
    path,
    message: `The definition has more than ${maxNodes} values (objects, arrays and fields each count). Remove unused schema branches, then save again.`,
  });
  return false;
}

function visit(
  value: unknown,
  path: string,
  key: string | undefined,
  depth: number,
  w: Walk
): void {
  if (w.stopped) return;
  if (!countNode(w, path)) return;
  const where = path || "The definition";
  if (typeof value === "string") {
    if (!countChars(w, value.length)) return;
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
  if (!container || typeof value !== "object") {
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
    // Recorded even when earlier issues filled the list: it is why the walk stopped.
    w.issues.push({
      code: "too_deep",
      path,
      message: `The definition nests deeper than ${maxDepth} levels at ${path}. Flatten that schema.`,
    });
    return;
  }
  // A toJSON hook changes what JSON.stringify writes, so the walk (which reads
  // the fields) and the byte count would disagree about what is stored.
  if (typeof Reflect.get(value, "toJSON") === "function") {
    fail(
      w,
      "not_json",
      path,
      `${where} has a toJSON function, so what is stored would differ from what is checked. Remove toJSON and use plain data.`
    );
    return;
  }
  // Children are visited one at a time, so a huge container stops at the node
  // cap without first building a path for every child.
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && !w.stopped; i += 1) {
      const childPath = `${path}[${i}]`;
      if (!(i in value)) {
        // A hole counts like a visited value, so a sparse array of millions of
        // slots stops at the node cap instead of failing once per slot.
        if (!countNode(w, childPath)) break;
        fail(
          w,
          "not_json",
          childPath,
          `${childPath} is an empty slot in a list, which JSON cannot carry. Fill it with a value or null.`
        );
        continue;
      }
      visit(value[i], childPath, undefined, depth + 1, w);
    }
    return;
  }
  for (const childKey of Object.keys(value)) {
    if (w.stopped || !countChars(w, childKey.length)) return;
    visit(
      Reflect.get(value, childKey),
      path === "" ? childKey : `${path}.${childKey}`,
      childKey,
      depth + 1,
      w
    );
  }
}

/** Every cap `value` breaks; an empty list means it fits. Never throws. */
export function checkDefinitionCaps(value: unknown): MockCapIssue[] {
  return readDefinition(value, false).issues;
}

function walk(value: unknown): MockCapIssue[] {
  const w: Walk = { nodes: 0, chars: 0, stopped: false, issues: [] };
  visit(value, "", undefined, 1, w);
  return w.issues;
}

/**
 * The caps walk plus, when asked and the value fits, a plain copy parsed from
 * the JSON the byte count serialized. The copy is what gets stored, so the
 * shape pass reads it instead of the input: a getter, proxy, non-enumerable
 * field or prototype on the input cannot differ from what is saved. Never
 * throws; reading a getter, a proxy or a toJSON hook can, and the definition
 * is not plain JSON then.
 */
export function readDefinition(
  value: unknown,
  wantCopy: boolean
): { issues: MockCapIssue[]; copy?: unknown } {
  try {
    const read = walk(value);
    // Serializing is safe only once the walk found nothing JSON cannot carry
    // and nothing too deep (a cycle is always too deep).
    if (read.length > 0) return { issues: read };
    const w: Walk = { nodes: 0, chars: 0, stopped: false, issues: [] };
    const json: unknown = JSON.stringify(value);
    if (typeof json !== "string") {
      fail(
        w,
        "not_json",
        "",
        "The definition does not serialize to JSON. Use plain objects, arrays, strings, numbers, booleans and null."
      );
      return { issues: w.issues };
    }
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > maxBytes) {
      fail(
        w,
        "too_large",
        "",
        `The definition is ${bytes} bytes; the limit is ${maxBytes}. Shorten descriptions, or drop schemas you do not change.`
      );
      return { issues: w.issues };
    }
    // JSON.stringify read every getter again, and a getter can answer
    // differently the second time, such as a remote $ref after a local one.
    // The caps hold for what is stored only once the copy passes them too.
    const copy: unknown = JSON.parse(json);
    const stored = walk(copy);
    if (stored.length > 0) return { issues: stored };
    return { issues: [], copy: wantCopy ? copy : undefined };
  } catch {
    return {
      issues: [
        {
          code: "not_json",
          path: "",
          message:
            "The definition could not be read as JSON: a getter, proxy or toJSON function threw. Use plain objects, arrays, strings, numbers, booleans and null.",
        },
      ],
    };
  }
}
