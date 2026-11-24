/**
 * Turning one entry of "what you can change" and the text a person typed into
 * a mock definition. The patch is RFC 7396 against the best so far's
 * definition, so a round changes one thing and the rest stays as it was.
 */
import type { ChangeEntry } from "@mcpjam/sdk/climbs";

export type FieldKind = "text" | "hidden" | "json";

const TEXT_FIELDS = new Set(["description", "title", "instructions", "serverInfo.name", "params.description"]);

export function fieldKind(entry: ChangeEntry): FieldKind {
  if (entry.where.field === "hidden") return "hidden";
  return TEXT_FIELDS.has(entry.where.field) ? "text" : "json";
}

const FIELD_WORDS: Record<string, string> = {
  description: "description",
  title: "title",
  inputSchema: "input schema",
  outputSchema: "output schema",
  annotations: "annotations",
  icons: "icons",
  _meta: "metadata",
  hidden: "visibility",
  instructions: "instructions",
  "serverInfo.name": "name",
};

/** "list_projects · description", "the server · instructions", "list_projects · parameter project_id". */
export function entryLabel(entry: ChangeEntry): { name: string; field: string } {
  const { kind, tool, param, field } = entry.where;
  if (kind === "server") return { name: "The server", field: FIELD_WORDS[field] ?? field };
  if (kind === "param") return { name: tool ?? "", field: `parameter ${param ?? ""} description` };
  return { name: tool ?? "", field: FIELD_WORDS[field] ?? field };
}

export function initialText(entry: ChangeEntry): string {
  const { current } = entry;
  if (typeof current === "string") return current;
  if (current === undefined || current === null) return "";
  return JSON.stringify(current, null, 2);
}

export type ChangeValue = { ok: true; value: unknown } | { ok: false; error: string };

export function changeValue(entry: ChangeEntry, text: string, hide: boolean): ChangeValue {
  const kind = fieldKind(entry);
  if (kind === "hidden") return { ok: true, value: hide };
  if (kind === "text") {
    return text.trim() === ""
      ? { ok: false, error: "Write the new text before you run the round." }
      : { ok: true, value: text };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "This field takes JSON, and what you wrote is not valid JSON. Fix it, then run the round." };
  }
}

/** The merge patch for one entry, as an object of the mock definition's own shape. */
export function patchFor(entry: ChangeEntry, value: unknown): Record<string, unknown> {
  const { kind, tool = "", param = "", field } = entry.where;
  if (kind === "server") {
    return field === "serverInfo.name" ? { serverInfo: { name: value } } : { [field]: value };
  }
  if (kind === "param") return { tools: { [tool]: { params: { [param]: { description: value } } } } };
  return { tools: { [tool]: { [field]: value } } };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** RFC 7396: an object merges key by key, `null` removes a key, anything else replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const result: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

/** Whether a model can draft this entry: a tool's description or title, on a tool a steering case calls. */
export function canDraft(entry: ChangeEntry, steeringTools: readonly string[]): boolean {
  return (
    entry.where.kind === "tool" &&
    (entry.where.field === "description" || entry.where.field === "title") &&
    steeringTools.includes(entry.where.tool ?? "")
  );
}
