/**
 * What a mock's saved definition changes, as the list the details panel shows.
 * A change is one tool, prompt, resource or template entry, or one server-wide
 * setting. The count on the card is the length of this list, so the two always
 * agree. Read from the definition's own keys rather than from dotted paths,
 * because a tool or resource name may itself contain dots.
 */

export type MockChange = {
  kind: "Server" | "Tool" | "Prompt" | "Resource" | "Template";
  /** The entry's name, or what changed for a server-wide setting. */
  label: string;
  /** The fields the entry states, such as `description, answer`. */
  detail?: string;
};

const SERVER_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ["instructions", "Instructions revised"],
  ["serverInfo", "Server info changed"],
  ["capabilities", "Capabilities changed"],
  ["pageSize", "Page size changed"],
];

const FAMILIES: ReadonlyArray<readonly [string, MockChange["kind"]]> = [
  ["tools", "Tool"],
  ["prompts", "Prompt"],
  ["resources", "Resource"],
  ["resourceTemplates", "Template"],
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The changes in a definition, server-wide settings first. Not a definition at all yields none. */
export function changesOf(definition: unknown): MockChange[] {
  if (!isRecord(definition)) return [];
  const changes: MockChange[] = [];
  for (const [key, label] of SERVER_SETTINGS) {
    if (definition[key] !== undefined) changes.push({ kind: "Server", label });
  }
  for (const [key, kind] of FAMILIES) {
    const entries = definition[key];
    if (!isRecord(entries)) continue;
    for (const [name, entry] of Object.entries(entries)) {
      const fields = isRecord(entry) ? Object.keys(entry) : [];
      changes.push({
        kind,
        label: name,
        ...(fields.length > 0 && { detail: fields.join(", ") }),
      });
    }
  }
  return changes;
}

/** "3 changes", "1 change", "0 changes". */
export function changeCountLabel(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}
