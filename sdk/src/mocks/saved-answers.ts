import type { CallToolResult } from "@modelcontextprotocol/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import type {
  JsonObject,
  JsonValue,
  MockSavedAnswer,
  MockSavedCase,
} from "./definition-types.js";

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Deep equality for JSON values; key order does not matter. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

/** Every key of `when` equals the same key of the input. A missing `when` matches anything. */
export function caseMatches(when: JsonObject | undefined, input: Obj): boolean {
  return Object.entries(when ?? {}).every(
    ([key, expected]) =>
      Object.hasOwn(input, key) && jsonEqual(expected, input[key])
  );
}

const placeholders = (root: string) => ({
  whole: new RegExp(`^\\{\\{${root}\\.([^{}]+)\\}\\}$`),
  any: new RegExp(`\\{\\{${root}\\.([^{}]+)\\}\\}`, "g"),
});
const INPUT_PLACEHOLDERS = placeholders("input");

/** The value at a dotted path of the scope, or `undefined` when any step is missing. */
function valueAt(scope: Obj, path: string): unknown {
  let node: unknown = scope;
  for (const step of path.split(".")) {
    if (!isObj(node) || !Object.hasOwn(node, step)) return undefined;
    node = node[step];
  }
  return node;
}

/**
 * Fills `{{<root>.x}}` from the scope in every string of a value; `fillInputs`
 * is the `input` root. A string that is only one placeholder takes the value
 * itself, type included; a placeholder inside a longer string takes its text
 * (a non-string as JSON). A placeholder naming something the scope does not
 * hold is left as written, so the mistake shows in the answer. A filled value
 * is never filled again.
 */
export function fillScope<T extends JsonValue | undefined>(
  value: T,
  scope: Obj,
  patterns: ReturnType<typeof placeholders>
): T {
  if (typeof value === "string") {
    const whole = patterns.whole.exec(value);
    if (whole) {
      const found = valueAt(scope, whole[1]!);
      if (found !== undefined) return found as T;
    }
    return value.replace(patterns.any, (text, path: string) => {
      const found = valueAt(scope, path);
      if (found === undefined) return text;
      return typeof found === "string" ? found : JSON.stringify(found);
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => fillScope(item, scope, patterns)) as T;
  }
  if (isObj(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        fillScope(v as JsonValue, scope, patterns),
      ])
    ) as T;
  }
  return value;
}

export const fillInputs = <T extends JsonValue | undefined>(
  value: T,
  input: Obj
): T => fillScope(value, input, INPUT_PLACEHOLDERS);

/** `{{steps.<id>.x}}`: what the client replied to a step's question. */
export const fillSteps = <T extends JsonValue | undefined>(
  value: T,
  replies: Obj
): T => fillScope(value, replies, placeholders("steps"));

export type SavedOutcome =
  | { kind: "answered"; caseIndex: number; result: CallToolResult }
  | { kind: "no_match" };

/** The first case whose `when` matches the input, with its place in the list. */
export function chooseCase(
  answer: MockSavedAnswer,
  input: Obj
): { caseIndex: number; chosen: MockSavedCase } | undefined {
  const caseIndex = answer.cases.findIndex((c: MockSavedCase) =>
    caseMatches(c.when, input)
  );
  return caseIndex < 0
    ? undefined
    : { caseIndex, chosen: answer.cases[caseIndex]! };
}

/**
 * What a chosen case answers once its steps are done: `{{input.x}}` is filled
 * from the call, and `{{steps.<id>.x}}` from `replies` (what the client said
 * to each question by step id). A case that holds a protocol error throws it,
 * as a real server would.
 */
export function finishCase(
  chosen: MockSavedCase,
  input: Obj,
  replies: Obj = {}
): CallToolResult {
  const fill = <T extends JsonValue | undefined>(value: T): T =>
    fillSteps(fillInputs(value, input), replies);
  if (chosen.error) {
    const { code, message, data } = chosen.error;
    throw new ProtocolError(
      code,
      fill(message),
      data === undefined ? undefined : fill(data)
    );
  }
  return fill(chosen.result ?? { content: [] }) as CallToolResult;
}

/** The first case whose `when` matches the input answers (its steps are not run here). */
export function answerFromSaved(
  answer: MockSavedAnswer,
  input: Obj
): SavedOutcome {
  const found = chooseCase(answer, input);
  if (!found) return { kind: "no_match" };
  return {
    kind: "answered",
    caseIndex: found.caseIndex,
    result: finishCase(found.chosen, input),
  };
}
