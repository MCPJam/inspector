/**
 * Overrides that depend on the real server's tool: a rename's target, a
 * parameter that is hidden, fixed or described, and arguments laid over a
 * call. When the real tool is gone or no longer fits, the override is broken,
 * and the mock says which one by path so the author can repair it. It never
 * picks another name on its own.
 */
import type { Tool } from "@modelcontextprotocol/server";
import {
  answersItself,
  realAnswerOf,
  realToolNameFor,
} from "./definition-types.js";
import type { MockDefinition, MockTool } from "./definition-types.js";

export type MockBindingCode =
  /** The real tool the entry points at is not in the real listing. */
  | "target_missing"
  /** An edited parameter the real tool no longer has. */
  | "param_missing"
  /** A hidden parameter the real tool requires, with no fixed value to send. */
  | "param_required"
  /** A fixed or laid-over value of a type the real parameter no longer takes. */
  | "value_incompatible";

export interface MockBindingIssue {
  /** The override to repair, from the definition's root: `tools.find.answer.tool`. */
  path: string;
  /** The name a client sees. */
  tool: string;
  /** The real tool the entry points at. */
  realTool: string;
  code: MockBindingCode;
  message: string;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** True when a JSON Schema `type` keyword rules the value out. Other keywords are not judged. */
function typeRefuses(schema: unknown, value: unknown): boolean {
  if (!isObj(schema)) return false;
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
  const names = declared.filter((t): t is string => typeof t === "string");
  if (names.length === 0) return false;
  const actual = typeOf(value);
  return !names.some((t) => t === actual || (t === "number" && actual === "integer"));
}

function checkEntry(key: string, entry: MockTool, real: Tool): MockBindingIssue[] {
  const issues: MockBindingIssue[] = [];
  const realTool = real.name;
  const schema = real.inputSchema as Obj;
  const properties = isObj(schema.properties) ? schema.properties : undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const add = (path: string, code: MockBindingCode, message: string) =>
    issues.push({ path, tool: key, realTool, code, message });
  for (const [param, edit] of Object.entries(entry.params ?? {})) {
    const path = `tools.${key}.params.${param}`;
    if (properties && !(param in properties)) {
      add(path, "param_missing", `The real tool "${realTool}" no longer has the parameter "${param}".`);
      continue;
    }
    const hidden = edit.hidden === true || "fixed" in edit;
    if (hidden && !("fixed" in edit) && required.includes(param)) {
      add(path, "param_required", `The real tool "${realTool}" now requires "${param}", and this entry hides it without a fixed value.`);
    }
    if ("fixed" in edit && typeRefuses(properties?.[param], edit.fixed)) {
      add(`${path}.fixed`, "value_incompatible", `The fixed value of "${param}" is a ${typeOf(edit.fixed)}, which the real tool's "${param}" no longer takes.`);
    }
  }
  for (const [param, value] of Object.entries(realAnswerOf(entry)?.arguments ?? {})) {
    const path = `tools.${key}.answer.arguments.${param}`;
    if (properties && !(param in properties) && schema.additionalProperties === false) {
      add(path, "param_missing", `The real tool "${realTool}" no longer takes the argument "${param}".`);
    } else if (typeRefuses(properties?.[param], value)) {
      add(path, "value_incompatible", `The laid-over value of "${param}" is a ${typeOf(value)}, which the real tool's "${param}" no longer takes.`);
    }
  }
  return issues;
}

/**
 * The overrides the real listing breaks, for entries that forward to a real tool.
 */
export function findBindingIssues(
  definition: MockDefinition,
  realTools: readonly Tool[]
): MockBindingIssue[] {
  const byName = new Map(realTools.map((tool) => [tool.name, tool]));
  const issues: MockBindingIssue[] = [];
  for (const [key, entry] of Object.entries(definition.tools ?? {})) {
    // A tool that answers for itself calls no real tool, so nothing it depends
    // on can break, and its replies keep working while the base is down.
    if (answersItself(entry)) continue;
    const realTool = realToolNameFor(key, entry);
    const real = byName.get(realTool);
    if (!real) {
      const renamed = realAnswerOf(entry)?.tool !== undefined;
      issues.push({
        path: renamed ? `tools.${key}.answer.tool` : `tools.${key}`,
        tool: key,
        realTool,
        code: "target_missing",
        message: `The real server no longer lists "${realTool}".`,
      });
      continue;
    }
    if (entry.hidden !== true) issues.push(...checkEntry(key, entry, real));
  }
  return issues;
}
