function collectTextParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const block = item as Record<string, unknown>;
      if (block.type !== "text" || typeof block.text !== "string") return null;
      const text = block.text.trim();
      return text || null;
    })
    .filter((text): text is string => Boolean(text));
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
