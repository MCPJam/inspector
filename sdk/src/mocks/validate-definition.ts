import { checkDefinitionCaps } from "./definition-caps.js";
import type { MockCapIssueCode } from "./definition-caps.js";
import { MAX_SAVED_CASES, MOCK_CAPABILITY_KEYS } from "./definition-types.js";
import { checkItems } from "./validate-items.js";
import { checkCaseSteps } from "./validate-steps.js";
import type { MockDefinition } from "./definition-types.js";

export type MockIssueCode =
  | MockCapIssueCode
  | "invalid_type"
  | "invalid_value"
  | "unknown_field"
  | "param_conflict"
  | "uncallable_input";

export interface MockIssue {
  code: MockIssueCode;
  path: string;
  message: string;
}

export type MockValidationResult =
  | { ok: true; definition: MockDefinition }
  | { ok: false; issues: MockIssue[] };

const TOP_FIELDS = [
  "serverInfo",
  "instructions",
  "capabilities",
  "pageSize",
  "tools",
  "prompts",
  "resources",
  "resourceTemplates",
];
const MAX_PAGE_SIZE = 1000;
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
const SAVED_ANSWER_FIELDS = ["from", "cases"];
const MODEL_ANSWER_FIELDS = ["from", "instructions"];
const MAX_ANSWER_INSTRUCTIONS = 4000;
const SAVED_CASE_FIELDS = ["when", "steps", "result", "error"];
const SAVED_ERROR_FIELDS = ["code", "message", "data"];
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

  savedAnswer(value: Obj, path: string): void {
    this.fields(value, SAVED_ANSWER_FIELDS, path);
    const cases = value.cases;
    if (!Array.isArray(cases) || cases.length === 0) {
      this.add(
        "invalid_type",
        at(path, "cases"),
        `${at(path, "cases")} must be a list with at least one case. Add a case, or leave answer out to call the real tool.`
      );
      return;
    }
    if (cases.length > MAX_SAVED_CASES) {
      this.add(
        "invalid_value",
        at(path, "cases"),
        `A tool may have ${MAX_SAVED_CASES} saved cases at most. Merge cases that differ only by input, using {{input.x}}.`
      );
      return;
    }
    cases.forEach((entry, i) => this.savedCase(entry, at(path, `cases.${i}`)));
  }

  savedCase(value: unknown, path: string): void {
    if (!this.object(value, path)) return;
    this.fields(value, SAVED_CASE_FIELDS, path);
    if ("when" in value) this.object(value.when, at(path, "when"));
    checkCaseSteps(value, path, (code, p, message) =>
      this.add(code, p, message)
    );
    const hasResult = "result" in value;
    const hasError = "error" in value;
    if (hasResult === hasError) {
      this.add(
        "invalid_value",
        path,
        `${path} must have exactly one of "result" (the tool's whole result) or "error" (a protocol error).`
      );
    }
    if (hasResult && this.object(value.result, at(path, "result"))) {
      if (!Array.isArray(value.result.content)) {
        this.add(
          "invalid_type",
          at(path, "result.content"),
          `${at(path, "result.content")} must be a list of content blocks, as a tool result carries. Use [] for none.`
        );
      }
    }
    if (hasError && this.object(value.error, at(path, "error"))) {
      const error = value.error;
      const p = at(path, "error");
      this.fields(error, SAVED_ERROR_FIELDS, p);
      if (!Number.isInteger(error.code)) {
        this.add(
          "invalid_type",
          at(p, "code"),
          `${at(p, "code")} must be an integer JSON-RPC error code.`
        );
      }
      this.string(error.message, at(p, "message"), true);
    }
  }

  answer(value: unknown, path: string): void {
    if (!this.object(value, path)) return;
    const from = value.from;
    if (from === "saved") return this.savedAnswer(value, path);
    if (from === "model") {
      this.fields(value, MODEL_ANSWER_FIELDS, path);
      if ("instructions" in value) {
        this.string(value.instructions, at(path, "instructions"), true);
        if (
          typeof value.instructions === "string" &&
          value.instructions.length > MAX_ANSWER_INSTRUCTIONS
        ) {
          this.add(
            "invalid_value",
            at(path, "instructions"),
            `${at(path, "instructions")} may be ${MAX_ANSWER_INSTRUCTIONS} characters at most. Keep what the model needs to answer like this server.`
          );
        }
      }
      return;
    }
    if (from !== undefined && from !== "real") {
      this.add(
        "invalid_value",
        at(path, "from"),
        `answer.from must be "real", "saved" or "model", not ${JSON.stringify(from)}. Use one of them, or leave it out.`
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
    c.fields(input, TOP_FIELDS, "");
    if ("serverInfo" in input && c.object(input.serverInfo, "serverInfo")) {
      c.fields(input.serverInfo, INFO_FIELDS, "serverInfo");
      for (const key of INFO_FIELDS) {
        if (key in input.serverInfo)
          c.string(input.serverInfo[key], at("serverInfo", key), true);
      }
    }
    if ("instructions" in input) c.string(input.instructions, "instructions");
    if (
      "pageSize" in input &&
      !(
        Number.isInteger(input.pageSize) &&
        (input.pageSize as number) >= 1 &&
        (input.pageSize as number) <= MAX_PAGE_SIZE
      )
    ) {
      c.add(
        "invalid_value",
        "pageSize",
        `pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}. Remove it to list everything in one page.`
      );
    }
    if ("capabilities" in input)
      c.capabilities(input.capabilities, "capabilities");
    if ("tools" in input && c.object(input.tools, "tools")) {
      for (const [name, tool] of Object.entries(input.tools))
        c.tool(name, tool, at("tools", name));
    }
    checkItems(input, (issue) => c.add(issue.code, issue.path, issue.message));
  }
  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  // The checks above establish every field's type, so this is the one place the
  // unknown value becomes a `MockDefinition`.
  return { ok: true, definition: input as MockDefinition };
}
