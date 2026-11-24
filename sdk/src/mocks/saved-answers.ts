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

const WHOLE_PLACEHOLDER = /^\{\{input\.([^{}]+)\}\}$/;
const PLACEHOLDER = /\{\{input\.([^{}]+)\}\}/g;

/** The value at a dotted path of the input, or `undefined` when any step is missing. */
function inputAt(input: Obj, path: string): unknown {
  let node: unknown = input;
  for (const step of path.split(".")) {
    if (!isObj(node) || !Object.hasOwn(node, step)) return undefined;
    node = node[step];
  }
  return node;
}

/**
 * Fills `{{input.x}}` from the call's input in every string of a value. A
 * string that is only one placeholder takes the input's own value, type
 * included; a placeholder inside a longer string takes its text (a non-string
 * as JSON). A placeholder naming input the call did not send is left as
 * written, so the mistake shows in the answer. A filled value is never filled
 * again.
 */
export function fillInputs<T extends JsonValue | undefined>(
  value: T,
  input: Obj
): T {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole) {
      const found = inputAt(input, whole[1]!);
      if (found !== undefined) return found as T;
    }
    return value.replace(PLACEHOLDER, (text, path: string) => {
      const found = inputAt(input, path);
      if (found === undefined) return text;
      return typeof found === "string" ? found : JSON.stringify(found);
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => fillInputs(item, input)) as T;
  }
  if (isObj(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        fillInputs(v as JsonValue, input),
      ])
    ) as T;
  }
  return value;
}

export type SavedOutcome =
  | { kind: "answered"; caseIndex: number; result: CallToolResult }
  | { kind: "no_match" };

/**
 * The first case whose `when` matches the input answers. A case that holds a
 * protocol error throws it, as a real server would.
 */
export function answerFromSaved(
  answer: MockSavedAnswer,
  input: Obj
): SavedOutcome {
  const caseIndex = answer.cases.findIndex((c: MockSavedCase) =>
    caseMatches(c.when, input)
  );
  if (caseIndex < 0) return { kind: "no_match" };
  const chosen = answer.cases[caseIndex]!;
  if (chosen.error) {
    const { code, message, data } = chosen.error;
    throw new ProtocolError(
      code,
      fillInputs(message, input),
      data === undefined ? undefined : fillInputs(data, input)
    );
  }
  return {
    kind: "answered",
    caseIndex,
    result: fillInputs(
      chosen.result ?? { content: [] },
      input
    ) as CallToolResult,
  };
}
