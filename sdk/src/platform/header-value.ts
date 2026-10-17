export function trimmedOrUndefined(
  value: unknown,
  maxChars?: number
): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return maxChars === undefined ? trimmed : trimmed.slice(0, maxChars);
}
