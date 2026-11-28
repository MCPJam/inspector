import type { JsonValue } from "./definition-types.js";

/**
 * `{{input.<path>}}` references in a state declaration. A reference is a root
 * and a dotted path of field names; there are no expressions. A string that is
 * only one reference takes the value itself, type included; inside a longer
 * string it takes the value's text (a non-string as JSON).
 */

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type RefRoot = "input" | "record" | "records";

const BRACES = /\{\{([^{}]*)\}\}/g;
const REF = /^(input|record|records)((?:\.[A-Za-z0-9_$-]+)+)$/;

/** What is wrong with one string's references, or `undefined` when they are fine. */
export function refProblem(
  text: string,
  roots: readonly RefRoot[]
): string | undefined {
  for (const [, inner] of text.matchAll(BRACES)) {
    const found = REF.exec(inner!);
    if (!found) {
      return `"{{${inner}}}" is not a reference. Write {{input.<field>}}; expressions are not supported.`;
    }
    if (!roots.includes(found[1] as RefRoot)) {
      return `"{{${inner}}}" is not available here. Use ${roots.map((r) => `{{${r}.<field>}}`).join(" or ")}.`;
    }
  }
  if (text.replace(BRACES, "").match(/\{\{|\}\}/)) {
    return `"${text}" has an unmatched "{{" or "}}". Close the reference, or remove the braces.`;
  }
  return undefined;
}

/** Every string under `value` with a problem, with its path under `path`. */
export function refProblems(
  value: unknown,
  path: string,
  roots: readonly RefRoot[]
): Array<{ path: string; message: string }> {
  if (typeof value === "string") {
    const message = refProblem(value, roots);
    return message ? [{ path, message: `${path}: ${message}` }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) =>
      refProblems(item, `${path}[${i}]`, roots)
    );
  }
  if (isObj(value)) {
    return Object.entries(value).flatMap(([k, v]) =>
      refProblems(v, `${path}.${k}`, roots)
    );
  }
  return [];
}

/** Whether any string under `value` holds a reference. */
export function hasRefs(value: unknown): boolean {
  if (typeof value === "string") return /\{\{/.test(value);
  if (Array.isArray(value)) return value.some(hasRefs);
  if (isObj(value)) return Object.values(value).some(hasRefs);
  return false;
}

function valueAt(scope: Obj, path: string): unknown {
  let node: unknown = scope;
  for (const step of path.split(".")) {
    if (!isObj(node) || !Object.hasOwn(node, step)) return undefined;
    node = node[step];
  }
  return node;
}

export type Bound<T> = { ok: true; value: T } | { ok: false; missing: string };

/**
 * Fills every reference under `value` from `scope` (`{ input }`, or `{ input,
 * record }` for a result). A reference the scope cannot answer stops the fill
 * and is named, so a missing field never reaches a record as literal text. A
 * filled value is never filled again.
 */
export function bindRefs<T extends JsonValue>(value: T, scope: Obj): Bound<T> {
  let missing: string | undefined;
  const fill = (node: JsonValue): JsonValue => {
    if (missing !== undefined) return node;
    if (typeof node === "string") {
      const whole = /^\{\{([^{}]*)\}\}$/.exec(node);
      if (whole) {
        const found = valueAt(scope, whole[1]!);
        if (found === undefined) missing = whole[1]!;
        return found === undefined ? node : (found as JsonValue);
      }
      return node.replace(BRACES, (text, inner: string) => {
        const found = valueAt(scope, inner);
        if (found === undefined) {
          missing ??= inner;
          return text;
        }
        return typeof found === "string" ? found : JSON.stringify(found);
      });
    }
    if (Array.isArray(node)) return node.map(fill);
    if (isObj(node)) {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, fill(v as JsonValue)])
      );
    }
    return node;
  };
  const filled = fill(value);
  return missing === undefined
    ? { ok: true, value: filled as T }
    : { ok: false, missing };
}
