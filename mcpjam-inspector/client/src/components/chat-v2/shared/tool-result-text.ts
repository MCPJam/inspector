function collectTextParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const block = item as Record<string, unknown>;
      if (block.type !== "text" || typeof block.text !== "string") return null;
      return block.text.trim() ? block.text : null;
    })
    .filter((text): text is string => Boolean(text));
}

function parseStructuredJsonText(
  text: string,
): Record<string, unknown> | unknown[] | null {
  try {
    const parsed = JSON.parse(text);
    if (
      Array.isArray(parsed) ||
      (!!parsed && typeof parsed === "object" && !Array.isArray(parsed))
    ) {
      return parsed as Record<string, unknown> | unknown[];
    }
  } catch {
    // Not valid JSON text; treat as plain text instead.
  }

  return null;
}

function getNonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() ? value : null;
}

function isEmptyToolResultEnvelope(record: Record<string, unknown>): boolean {
  if (!Array.isArray(record.content) || record.content.length > 0) return false;
  if (record.structuredContent !== undefined) return false;

  return Object.keys(record).every((key) =>
    ["content", "_meta", "meta", "isError"].includes(key),
  );
}

export type DisplayValue =
  | { kind: "text"; text: string }
  | { kind: "json"; value: Record<string, unknown> | unknown[] };

export type ToolResultDisplay = DisplayValue;

export function extractDisplayFromValue(value: unknown): DisplayValue | null {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return { kind: "json", value };
  }

  if (typeof value === "string") {
    const text = getNonEmptyText(value);
    if (!text) return null;

    const structuredJson = parseStructuredJsonText(text);
    return structuredJson
      ? { kind: "json", value: structuredJson }
      : { kind: "text", text };
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "text", text: String(value) };
  }

  if (typeof value !== "object") return null;

  return { kind: "json", value: value as Record<string, unknown> };
}

export function extractDisplayFromToolResult(
  result: unknown,
): ToolResultDisplay | null {
  if (result === null || result === undefined) return null;

  if (typeof result !== "object" || Array.isArray(result)) {
    return extractDisplayFromValue(result);
  }

  const record = result as Record<string, unknown>;
  if (isEmptyToolResultEnvelope(record)) return null;
  const directText = getNonEmptyText(record.text);
  if (directText) {
    return extractDisplayFromValue(directText);
  }

  const directTextParts = collectTextParts(record.content);
  if (directTextParts.length > 0) {
    return extractDisplayFromValue(directTextParts.join("\n\n"));
  }

  const nestedValue =
    record.value && typeof record.value === "object"
      ? (record.value as Record<string, unknown>)
      : null;
  const nestedTextParts = collectTextParts(nestedValue?.content);
  if (nestedTextParts.length > 0) {
    return extractDisplayFromValue(nestedTextParts.join("\n\n"));
  }

  return extractDisplayFromValue(record);
}

export function extractTextFromToolResult(result: unknown): string | null {
  if (!result) return null;

  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed || null;
  }

  if (typeof result !== "object") return null;

  const record = result as Record<string, unknown>;

  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.trim();
  }

  const directTextParts = collectTextParts(record.content);
  if (directTextParts.length > 0) {
    return directTextParts.join("\n\n");
  }

  const nestedValue =
    record.value && typeof record.value === "object"
      ? (record.value as Record<string, unknown>)
      : null;
  const nestedTextParts = collectTextParts(nestedValue?.content);
  return nestedTextParts.length > 0 ? nestedTextParts.join("\n\n") : null;
}
