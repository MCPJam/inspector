import { checkDefinitionCaps } from "./definition-caps.js";
import type { MockCapIssueCode } from "./definition-caps.js";
import {
  MOCK_CAPABILITY_KEYS,
  MOCK_RESERVED_DEFINITION_KEYS,
} from "./definition-types.js";
import type { MockDefinition } from "./definition-types.js";

export type MockIssueCode =
  | MockCapIssueCode
  | "invalid_type"
  | "invalid_value"
  | "unknown_field"
  | "not_available_yet"
  | "answer_not_supported"
  | "param_conflict"
  | "uncallable_input";

export interface MockIssue {
  code: MockIssueCode;
  path: string;
  message: string;
}

export type MockValidationResult =
  { ok: true; definition: MockDefinition } | { ok: false; issues: MockIssue[] };

const TOP_FIELDS = ["serverInfo", "instructions", "capabilities", "tools"];
const TOOL_FIELDS = [
  "hidden",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
  "icons",
  "_meta",
  "params",
  "answer",
];
const PARAM_FIELDS = ["hidden", "fixed", "description"];
const ANSWER_FIELDS = ["from", "tool", "arguments"];
const INFO_FIELDS = ["name", "title", "version"];
const HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
];

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const at = (path: string, key: string) =>
  path === "" ? key : `${path}.${key}`;

/** Collects issues for one validation; each check says what to change. */
class Check {
  readonly issues: MockIssue[] = [];

  add(code: MockIssueCode, path: string, message: string): void {
    this.issues.push({ code, path, message });
  }

  object(value: unknown, path: string): value is Obj {
    if (isObj(value)) return true;
    this.add(
      "invalid_type",
      path,
      `${path || "The definition"} must be an object.`
    );
    return false;
  }

  string(value: unknown, path: string, nonEmpty = false): void {
    if (typeof value === "string" && (!nonEmpty || value !== "")) return;
    this.add(
      "invalid_type",
      path,
      `${path} must be ${nonEmpty ? "a non-empty string" : "a string"}.`
    );
  }

  trueOnly(value: unknown, path: string, what: string): void {
    if (value !== true)
      this.add(
        "invalid_value",
        path,
        `${path} must be true. Remove it to ${what}.`
      );
  }

  fields(obj: Obj, allowed: string[], path: string): void {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      this.add(
        "unknown_field",
        at(path, key),
        `Unknown field "${key}" at ${path || "the top level"}. Allowed fields: ${allowed.join(", ")}.`
      );
    }
  }

  schema(value: unknown, path: string): void {
    if (!this.object(value, path)) return;
    if (value.type !== "object") {
      this.add(
        "invalid_value",
        at(path, "type"),
        `${path} must have "type": "object", as MCP requires.`
      );
    }
  }

  params(value: unknown, path: string): void {
    if (!this.object(value, path)) return;
    for (const [name, param] of Object.entries(value)) {
      const p = at(path, name);
      if (!this.object(param, p)) continue;
      this.fields(param, PARAM_FIELDS, p);
      if (Object.keys(param).length === 0) {
        this.add(
          "invalid_value",
          p,
          `The edit for "${name}" states nothing. Remove it, or set hidden, fixed or description.`
        );
      }
      if ("hidden" in param)
        this.trueOnly(param.hidden, at(p, "hidden"), "show the parameter");
      if ("description" in param)
        this.string(param.description, at(p, "description"));
      if (("hidden" in param || "fixed" in param) && "description" in param) {
        this.add(
          "param_conflict",
          p,
          `Parameter "${name}" is hidden, so its description is never shown. Remove the description, or stop hiding the parameter.`
        );
      }
    }
  }

  answer(value: unknown, path: string): void {
    if (!this.object(value, path)) return;
    const from = value.from;
    if (from === "saved" || from === "model") {
      this.add(
        "answer_not_supported",
        at(path, "from"),
        `Answers from "${from}" are not available yet. Use "real", or leave answer.from out.`
      );
      return;
    }
    if (from !== undefined && from !== "real") {
      this.add(
        "invalid_value",
        at(path, "from"),
        `answer.from must be "real", not ${JSON.stringify(from)}. Use "real", or leave it out.`
      );
      return;
    }
    this.fields(value, ANSWER_FIELDS, path);
    if ("tool" in value) this.string(value.tool, at(path, "tool"), true);
    if ("arguments" in value)
      this.object(value.arguments, at(path, "arguments"));
  }

  tool(name: string, value: unknown, path: string): void {
    if (name === "" || name.length > 256) {
      this.add(
        "invalid_value",
        path,
        "A tool name must be 1 to 256 characters."
      );
    }
    if (!this.object(value, path)) return;
    this.fields(value, TOOL_FIELDS, path);
    if ("hidden" in value) {
      this.trueOnly(value.hidden, at(path, "hidden"), "show the tool");
      const extra = Object.keys(value).filter(
        (k) => k !== "hidden" && k !== "answer"
      );
      if (value.hidden === true && extra.length > 0) {
        this.add(
          "param_conflict",
          path,
          `Tool "${name}" is hidden, so ${extra.join(", ")} would have no effect. Remove them, or stop hiding the tool.`
        );
      }
    }
    for (const key of ["title", "description"]) {
      if (key in value) this.string(value[key], at(path, key));
    }
    for (const key of ["inputSchema", "outputSchema"]) {
      if (key in value) this.schema(value[key], at(path, key));
    }
    if (
      "annotations" in value &&
      this.object(value.annotations, at(path, "annotations"))
    ) {
      const notes = value.annotations;
      for (const key of HINTS) {
        if (key in notes && typeof notes[key] !== "boolean") {
          this.add(
            "invalid_type",
            at(path, `annotations.${key}`),
            `annotations.${key} must be true or false.`
          );
        }
      }
    }
    if ("icons" in value && !Array.isArray(value.icons)) {
      this.add("invalid_type", at(path, "icons"), "icons must be a list.");
    }
    if ("_meta" in value) this.object(value._meta, at(path, "_meta"));
    if ("params" in value) this.params(value.params, at(path, "params"));
    if ("answer" in value) this.answer(value.answer, at(path, "answer"));
  }

  capabilities(value: unknown, path: string): void {
    if (!this.object(value, path)) return;
    this.fields(value, [...MOCK_CAPABILITY_KEYS], path);
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== null && !isObj(entry)) {
        this.add(
          "invalid_type",
          at(path, key),
          `${at(path, key)} must be an object, or null to remove it.`
        );
      }
    }
    if (value.tools === null) {
      this.add(
        "invalid_value",
        at(path, "tools"),
        "A mock always serves tools, so capabilities.tools cannot be null."
      );
    }
  }
}

/**
 * Checks a stored definition: the structural caps, then its shape. Returns the
 * definition unchanged when it passes, or every issue found, each saying what
 * is wrong and what to do about it.
 *
 * The check needs no real server, so it cannot know whether an input change
 * leaves a real tool uncallable. Call `findUncallableInputs` with the real
 * server's listing for that.
 */
export function validateMockDefinition(input: unknown): MockValidationResult {
  const c = new Check();
  // Caps first, so a hostile value is refused before anything reads it at length.
  for (const issue of checkDefinitionCaps(input))
    c.add(issue.code, issue.path, issue.message);
  if (c.issues.length === 0 && c.object(input, "")) {
    for (const key of MOCK_RESERVED_DEFINITION_KEYS) {
      if (key in input) {
        c.add(
          "not_available_yet",
          key,
          `Editing "${key}" is not available yet. Remove it and edit tools instead.`
        );
      }
    }
    // Reserved keys were reported by name above, so they are allowed here.
    c.fields(input, [...TOP_FIELDS, ...MOCK_RESERVED_DEFINITION_KEYS], "");
    if ("serverInfo" in input && c.object(input.serverInfo, "serverInfo")) {
      c.fields(input.serverInfo, INFO_FIELDS, "serverInfo");
      for (const key of INFO_FIELDS) {
        if (key in input.serverInfo)
          c.string(input.serverInfo[key], at("serverInfo", key), true);
      }
    }
    if ("instructions" in input) c.string(input.instructions, "instructions");
    if ("capabilities" in input)
      c.capabilities(input.capabilities, "capabilities");
    if ("tools" in input && c.object(input.tools, "tools")) {
      for (const [name, tool] of Object.entries(input.tools))
        c.tool(name, tool, at("tools", name));
    }
  }
  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  // The checks above establish every field's type, so this is the one place the
  // unknown value becomes a `MockDefinition`.
  return { ok: true, definition: input as MockDefinition };
}
