import type { MockIssue, MockIssueCode } from "./validate-definition.js";
import { MCP_APP_MIME_TYPE } from "./definition-types.js";
import { templateVariables } from "./uri-template.js";

/**
 * The shape checks for `prompts`, `resources` and `resourceTemplates`, called
 * by `validateMockDefinition` once the caps pass. Each message says what to
 * change.
 */

type Obj = Record<string, unknown>;
type Add = (code: MockIssueCode, path: string, message: string) => void;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const at = (path: string, key: string) => `${path}.${key}`;

const COMMON = ["hidden", "title", "description", "icons", "_meta"];
const PROMPT_FIELDS = [...COMMON, "arguments", "messages"];
const RESOURCE_FIELDS = [
  ...COMMON,
  "name",
  "mimeType",
  "size",
  "annotations",
  "text",
  "blob",
];
const TEMPLATE_FIELDS = [
  ...COMMON,
  "name",
  "mimeType",
  "annotations",
  "text",
  "blob",
];
const ARGUMENT_FIELDS = ["name", "title", "description", "required"];
const MESSAGE_FIELDS = ["role", "content"];

class ItemCheck {
  constructor(readonly add: Add) {}

  fields(entry: Obj, allowed: string[], path: string): void {
    for (const key of Object.keys(entry)) {
      if (allowed.includes(key)) continue;
      this.add(
        "unknown_field",
        at(path, key),
        `Unknown field "${key}" at ${path}. Allowed fields: ${allowed.join(", ")}.`
      );
    }
  }

  strings(entry: Obj, keys: string[], path: string): void {
    for (const key of keys) {
      if (key in entry && typeof entry[key] !== "string") {
        this.add(
          "invalid_type",
          at(path, key),
          `${at(path, key)} must be a string.`
        );
      }
    }
  }

  /** `hidden` stands alone: anything else beside it would have no effect. */
  hidden(entry: Obj, path: string, what: string): boolean {
    if (!("hidden" in entry)) return false;
    if (entry.hidden !== true) {
      this.add(
        "invalid_value",
        at(path, "hidden"),
        `${at(path, "hidden")} must be true. Remove it to show the ${what}.`
      );
    }
    const extra = Object.keys(entry).filter((k) => k !== "hidden");
    if (entry.hidden === true && extra.length > 0) {
      this.add(
        "param_conflict",
        path,
        `The ${what} at ${path} is hidden, so ${extra.join(", ")} would have no effect. Remove them, or stop hiding it.`
      );
    }
    return true;
  }

  common(entry: Obj, path: string): void {
    this.strings(entry, ["title", "description"], path);
    if ("icons" in entry && !Array.isArray(entry.icons)) {
      this.add("invalid_type", at(path, "icons"), "icons must be a list.");
    }
    if ("_meta" in entry && !isObj(entry._meta)) {
      this.add("invalid_type", at(path, "_meta"), "_meta must be an object.");
    }
  }

  entry(value: unknown, path: string): value is Obj {
    if (isObj(value)) return true;
    this.add("invalid_type", path, `${path} must be an object.`);
    return false;
  }

  /** `text` or `blob`, not both; a blob is base64. */
  content(entry: Obj, path: string): void {
    if ("text" in entry && "blob" in entry) {
      this.add(
        "param_conflict",
        path,
        `${path} has both text and blob. Keep one.`
      );
    }
    this.strings(entry, ["text", "blob"], path);
    if (
      typeof entry.blob === "string" &&
      !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.blob)
    ) {
      this.add(
        "invalid_value",
        at(path, "blob"),
        `${at(path, "blob")} must be base64.`
      );
    }
  }
}

function checkPrompt(c: ItemCheck, name: string, value: unknown, path: string) {
  if (name === "") c.add("invalid_value", path, "A prompt needs a name.");
  if (!c.entry(value, path) || c.hidden(value, path, "prompt")) return;
  c.fields(value, PROMPT_FIELDS, path);
  c.common(value, path);
  if ("arguments" in value) {
    const list = value.arguments;
    if (!Array.isArray(list)) {
      c.add(
        "invalid_type",
        at(path, "arguments"),
        "arguments must be a list of { name, description?, required? }."
      );
    } else {
      list.forEach((arg, i) => {
        const p = at(path, `arguments.${i}`);
        if (!c.entry(arg, p)) return;
        c.fields(arg, ARGUMENT_FIELDS, p);
        if (typeof arg.name !== "string" || arg.name === "") {
          c.add(
            "invalid_type",
            at(p, "name"),
            `${at(p, "name")} must be a non-empty string.`
          );
        }
        c.strings(arg, ["title", "description"], p);
        if ("required" in arg && typeof arg.required !== "boolean") {
          c.add(
            "invalid_type",
            at(p, "required"),
            `${at(p, "required")} must be true or false.`
          );
        }
      });
    }
  }
  if ("messages" in value) {
    const list = value.messages;
    if (!Array.isArray(list) || list.length === 0) {
      c.add(
        "invalid_type",
        at(path, "messages"),
        "messages must be a list with at least one { role, content } message."
      );
      return;
    }
    list.forEach((message, i) => {
      const p = at(path, `messages.${i}`);
      if (!c.entry(message, p)) return;
      c.fields(message, MESSAGE_FIELDS, p);
      if (message.role !== "user" && message.role !== "assistant") {
        c.add(
          "invalid_value",
          at(p, "role"),
          `${at(p, "role")} must be "user" or "assistant".`
        );
      }
      if (!isObj(message.content) || typeof message.content.type !== "string") {
        c.add(
          "invalid_type",
          at(p, "content"),
          `${at(p, "content")} must be one content block with a type, such as { "type": "text", "text": "..." }.`
        );
      }
    });
  }
}

function checkResource(
  c: ItemCheck,
  uri: string,
  value: unknown,
  path: string
) {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) {
    c.add(
      "invalid_value",
      path,
      `The resource key "${uri}" must be a URI with a scheme, such as file:///a.txt, skill://name/SKILL.md or ui://app/index.html.`
    );
  }
  if (!c.entry(value, path) || c.hidden(value, path, "resource")) return;
  c.fields(value, RESOURCE_FIELDS, path);
  c.common(value, path);
  c.strings(value, ["name", "mimeType"], path);
  if (
    "size" in value &&
    !(Number.isInteger(value.size) && (value.size as number) >= 0)
  ) {
    c.add(
      "invalid_type",
      at(path, "size"),
      `${at(path, "size")} must be a whole number of bytes.`
    );
  }
  if ("annotations" in value && !isObj(value.annotations)) {
    c.add(
      "invalid_type",
      at(path, "annotations"),
      "annotations must be an object."
    );
  }
  c.content(value, path);
  if (
    uri.startsWith("ui://") &&
    typeof value.mimeType === "string" &&
    value.mimeType !== MCP_APP_MIME_TYPE
  ) {
    c.add(
      "invalid_value",
      at(path, "mimeType"),
      `An MCP App at ${uri} is HTML with the mimeType "${MCP_APP_MIME_TYPE}". Remove mimeType to use it.`
    );
  }
  if (
    uri.startsWith("skill://") &&
    uri.toLowerCase().endsWith("/skill.md") &&
    !("hidden" in value) &&
    typeof value.text !== "string" &&
    "blob" in value
  ) {
    c.add(
      "invalid_type",
      path,
      `A skill's SKILL.md is text. Use "text" for ${uri}.`
    );
  }
}

function checkTemplate(
  c: ItemCheck,
  template: string,
  value: unknown,
  path: string
) {
  if (templateVariables(template) === undefined) {
    c.add(
      "invalid_value",
      path,
      `The template "${template}" is not a URI template this mock reads. Use simple variables such as file:///{path}, or {+path} for a value with slashes.`
    );
  }
  if (!c.entry(value, path) || c.hidden(value, path, "resource template"))
    return;
  c.fields(value, TEMPLATE_FIELDS, path);
  c.common(value, path);
  c.strings(value, ["name", "mimeType"], path);
  if ("annotations" in value && !isObj(value.annotations)) {
    c.add(
      "invalid_type",
      at(path, "annotations"),
      "annotations must be an object."
    );
  }
  c.content(value, path);
}

/** Adds an issue for each problem in the maps; the rest of the definition is checked elsewhere. */
export function checkItems(input: Obj, add: (issue: MockIssue) => void): void {
  const c = new ItemCheck((code, path, message) =>
    add({ code, path, message })
  );
  const maps: Array<
    [string, (c: ItemCheck, key: string, v: unknown, p: string) => void]
  > = [
    ["prompts", checkPrompt],
    ["resources", checkResource],
    ["resourceTemplates", checkTemplate],
  ];
  for (const [field, check] of maps) {
    if (!(field in input)) continue;
    const map = input[field];
    if (!isObj(map)) {
      c.add(
        "invalid_type",
        field,
        `${field} must be an object keyed by what a client sees.`
      );
      continue;
    }
    for (const [key, entry] of Object.entries(map))
      check(c, key, entry, at(field, key));
  }
  // Capabilities follow the content: asking to remove one while adding to it is a contradiction.
  const caps = isObj(input.capabilities) ? input.capabilities : {};
  const adds: Array<[string, boolean]> = [
    ["prompts", hasOwn(input.prompts, "messages")],
    [
      "resources",
      hasOwn(input.resources, "text", "blob") ||
        hasOwn(input.resourceTemplates, "text", "blob"),
    ],
  ];
  for (const [family, adding] of adds) {
    if (adding && caps[family] === null) {
      c.add(
        "param_conflict",
        `capabilities.${family}`,
        `The definition adds ${family} but sets capabilities.${family} to null, so no client could use them. Remove the null, or the ${family}.`
      );
    }
  }
}

/** Whether any entry of a map states one of these fields. */
function hasOwn(map: unknown, ...fields: string[]): boolean {
  return (
    isObj(map) &&
    Object.values(map).some(
      (entry) => isObj(entry) && fields.some((f) => f in entry)
    )
  );
}
