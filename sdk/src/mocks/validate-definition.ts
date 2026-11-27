import { readDefinition } from "./definition-caps.js";
import type { MockCapIssueCode } from "./definition-caps.js";
import { MAX_SAVED_CASES, MOCK_CAPABILITY_KEYS } from "./definition-types.js";
import type { MockDefinition } from "./definition-types.js";
import { checkItems } from "./validate-items.js";
import { checkCaseSteps, checkCompletions } from "./validate-steps.js";

export type MockIssueCode =
  | MockCapIssueCode
  | "invalid_type"
  | "invalid_value"
  | "unknown_field"
  | "param_conflict"
  | "uncallable_input"
  /** A field the stored shape has room for that is out of scope (model answers). */
  | "unsupported";

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
  "completions",
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
const SAVED_CASE_FIELDS = ["when", "steps", "task", "result", "error"];
const SAVED_ERROR_FIELDS = ["code", "message", "data"];
const INFO_FIELDS = ["name", "title", "version"];
/** The fields each MCP content block type requires, as strings. */
const CONTENT_BLOCK_FIELDS: Record<string, string[]> = {
  text: ["text"],
  image: ["data", "mimeType"],
  audio: ["data", "mimeType"],
  resource_link: ["uri", "name"],
  resource: ["resource"],
};
/** A string that is exactly one placeholder: the call fills it with a whole value. */
const WHOLE_PLACEHOLDER = /^\{\{[^{}]+\}\}$/;
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
    if (value.$async) {
      this.add(
        "invalid_value",
        at(path, "$async"),
        `${at(path, "$async")} makes the schema asynchronous. MCP clients check a schema synchronously, so an asynchronous schema is never applied. Remove $async.`
      );
    }
    if (value.type !== "object") {
      this.add(
        "invalid_value",
        at(path, "type"),
        `${path} must have "type": "object". A mock also serves 2025-11-25 clients, whose tool schemas must have an object root.`
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
      if ("hidden" in param && "fixed" in param) {
        this.add(
          "param_conflict",
          p,
          `Parameter "${name}" has both hidden and fixed. fixed already hides the parameter and sends its value, so remove hidden.`
        );
      }
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
      const rp = at(path, "result");
      if (
        "isError" in value.result &&
        typeof value.result.isError !== "boolean"
      ) {
        this.add(
          "invalid_type",
          at(rp, "isError"),
          `${at(rp, "isError")} must be true or false. Remove it for a successful result.`
        );
      }
      if (!Array.isArray(value.result.content)) {
        this.add(
          "invalid_type",
          at(path, "result.content"),
          `${at(path, "result.content")} must be a list of content blocks, as a tool result carries. Use [] for none.`
        );
      } else {
        value.result.content.forEach((block, i) =>
          this.contentBlock(block, at(rp, `content.${i}`))
        );
      }
      if ("_meta" in value.result)
        this.object(value.result._meta, at(rp, "_meta"));
      if ("structuredContent" in value.result) {
        const structured = value.result.structuredContent;
        if (
          !isObj(structured) &&
          !(
            typeof structured === "string" && WHOLE_PLACEHOLDER.test(structured)
          )
        ) {
          this.add(
            "invalid_type",
            at(rp, "structuredContent"),
            `${at(rp, "structuredContent")} must be an object, because MCP requires an object for structured content. Use an object, a single placeholder such as {{input.obj}} that a call fills with an object, or remove it.`
          );
        }
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

  /** One MCP content block: presence and type of what its kind requires. Values are not decoded. */
  contentBlock(block: unknown, path: string): void {
    if (!this.object(block, path)) return;
    const type = block.type;
    if (
      typeof type !== "string" ||
      !Object.hasOwn(CONTENT_BLOCK_FIELDS, type)
    ) {
      this.add(
        "invalid_value",
        at(path, "type"),
        `${at(path, "type")} must be one of ${Object.keys(CONTENT_BLOCK_FIELDS).join(", ")}. Change the block's type, or remove the block.`
      );
      return;
    }
    for (const field of CONTENT_BLOCK_FIELDS[type]) {
      if (field === "resource")
        this.embeddedResource(block.resource, at(path, field));
      else this.string(block[field], at(path, field));
    }
    if (type === "resource_link") {
      for (const key of ["mimeType", "title", "description"]) {
        if (key in block) this.string(block[key], at(path, key));
      }
      if ("icons" in block) this.icons(block.icons, at(path, "icons"));
      if ("size" in block && typeof block.size !== "number") {
        this.add(
          "invalid_type",
          at(path, "size"),
          `${at(path, "size")} must be a number of bytes. Remove it when the size is not known.`
        );
      }
    }
    if ("annotations" in block)
      this.contentAnnotations(block.annotations, at(path, "annotations"));
    if ("_meta" in block) this.object(block._meta, at(path, "_meta"));
  }

  /** MCP content annotations: `audience`, `priority` and `lastModified`, each optional. */
  contentAnnotations(value: unknown, path: string): void {
    if (!this.object(value, path)) return;
    const audience = value.audience;
    if (
      "audience" in value &&
      (!Array.isArray(audience) ||
        audience.some((role) => role !== "user" && role !== "assistant"))
    ) {
      this.add(
        "invalid_value",
        at(path, "audience"),
        `${at(path, "audience")} must be a list of "user" and "assistant". Fix the list, or remove it.`
      );
    }
    const priority = value.priority;
    if (
      "priority" in value &&
      (typeof priority !== "number" || priority < 0 || priority > 1)
    ) {
      this.add(
        "invalid_value",
        at(path, "priority"),
        `${at(path, "priority")} must be a number from 0 to 1. Fix it, or remove it.`
      );
    }
    if ("lastModified" in value)
      this.string(value.lastModified, at(path, "lastModified"));
  }

  embeddedResource(value: unknown, path: string): void {
    if (!this.object(value, path)) return;
    this.string(value.uri, at(path, "uri"));
    if ("mimeType" in value) this.string(value.mimeType, at(path, "mimeType"));
    if ("_meta" in value) this.object(value._meta, at(path, "_meta"));
    if (typeof value.text !== "string" && typeof value.blob !== "string") {
      this.add(
        "invalid_type",
        path,
        `${path} must have a text string or a blob string. Add one of them.`
      );
    }
  }

  answer(value: unknown, path: string): void {
    if (!this.object(value, path)) return;
    const from = value.from;
    if (from === "saved") return this.savedAnswer(value, path);
    if (from === "model") {
      this.add(
        "unsupported",
        at(path, "from"),
        `${at(path, "from")} "model" is not supported: a mock does not generate answers. Save the answer with from "saved", or leave answer out to call the real tool.`
      );
      return;
    }
    if (from !== undefined && from !== "real") {
      this.add(
        "invalid_value",
        at(path, "from"),
        `answer.from must be "real" or "saved", not ${JSON.stringify(from)}. Use one of them, or leave it out.`
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
      // A hidden tool is only the one a rename hides, so answer.tool is all
      // it may say; any other answer would never be served.
      const answerOk =
        isObj(value.answer) &&
        Object.keys(value.answer).every((k) => k === "tool");
      const extra = Object.keys(value).filter(
        (k) => k !== "hidden" && !(k === "answer" && answerOk)
      );
      if (value.hidden === true && extra.length > 0) {
        this.add(
          "param_conflict",
          path,
          `Tool "${name}" is hidden, so ${extra.join(", ")} would have no effect. Remove them, or stop hiding the tool.${extra.includes("answer") ? " A hidden tool may carry only answer.tool, the real tool to hide." : ""}`
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
      if ("title" in notes)
        this.string(notes.title, at(path, "annotations.title"));
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
    if ("icons" in value) this.icons(value.icons, at(path, "icons"));
    if ("_meta" in value) this.object(value._meta, at(path, "_meta"));
    if ("params" in value) this.params(value.params, at(path, "params"));
    if ("answer" in value) this.answer(value.answer, at(path, "answer"));
  }

  /** A list of MCP Icons. */
  icons(value: unknown, path: string): void {
    if (!Array.isArray(value)) {
      this.add("invalid_type", path, "icons must be a list.");
      return;
    }
    value.forEach((icon, i) => {
      const p = at(path, String(i));
      if (this.object(icon, p)) this.icon(icon, p);
    });
  }

  /** An MCP Icon: `src` is required; `mimeType`, `sizes` and `theme` are optional. */
  icon(icon: Obj, p: string): void {
    this.string(icon.src, at(p, "src"));
    if ("mimeType" in icon) this.string(icon.mimeType, at(p, "mimeType"));
    if (
      "sizes" in icon &&
      (!Array.isArray(icon.sizes) ||
        icon.sizes.some((size) => typeof size !== "string"))
    ) {
      this.add(
        "invalid_type",
        at(p, "sizes"),
        `${at(p, "sizes")} must be a list of strings such as "48x48". Fix the list, or remove it.`
      );
    }
    if ("theme" in icon && icon.theme !== "light" && icon.theme !== "dark") {
      this.add(
        "invalid_value",
        at(p, "theme"),
        `${at(p, "theme")} must be "light" or "dark". Fix it, or remove it.`
      );
    }
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
 * Checks a stored definition: the structural caps, then its shape. The shape
 * is read from a plain copy parsed from the JSON the caps step serialized, so
 * the check sees exactly what is stored. Returns that copy as `definition`
 * when it passes, or every issue found, each saying what is wrong and what to
 * do about it.
 *
 * The check needs no real server, so it cannot know whether an input change
 * leaves a real tool uncallable. Call `findUncallableInputs` with the real
 * server's listing for that.
 */
export function validateMockDefinition(raw: unknown): MockValidationResult {
  const c = new Check();
  // Caps first, so a hostile value is refused before anything reads it at
  // length. Everything below reads the copy, never the input.
  const { issues: capIssues, copy } = readDefinition(raw, true);
  for (const issue of capIssues) c.add(issue.code, issue.path, issue.message);
  const input: unknown = copy;
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
        `pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}. Remove it to list as the real server pages (one page for a mock made from nothing).`
      );
    }
    if ("capabilities" in input)
      c.capabilities(input.capabilities, "capabilities");
    if ("tools" in input && c.object(input.tools, "tools")) {
      for (const [name, tool] of Object.entries(input.tools))
        c.tool(name, tool, at("tools", name));
    }
    checkItems(input, (issue) => c.add(issue.code, issue.path, issue.message));
    checkCompletions(input, (code, path, message) =>
      c.add(code, path, message)
    );
  }
  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  // The checks above establish every field's type, so this is the one place the
  // unknown value becomes a `MockDefinition`.
  return { ok: true, definition: input as MockDefinition };
}
