/**
 * Deduplicates request headers case-insensitively, normalizing `mcp-protocol-version`
 * to lowercase so it cleanly overrides SDK transport defaults without comma-separated
 * duplicates, and merges the Bearer accessToken into Authorization if provided.
 */
export function deduplicateRequestHeaders(
  headers: Record<string, string>,
  accessToken?: string,
  existingAuth?: string
): Record<string, string> {
  const deduplicated: Record<string, string> = {};
  const lowerKeyMap = new Map<string, string>();

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (accessToken && lower === "authorization") {
      continue;
    }
    const existing = lowerKeyMap.get(lower);
    if (existing !== undefined) {
      delete deduplicated[existing];
    }
    const targetKey =
      lower === "mcp-protocol-version" ? "mcp-protocol-version" : key;
    deduplicated[targetKey] = value;
    lowerKeyMap.set(lower, targetKey);
  }

  if (accessToken) {
    deduplicated["Authorization"] = existingAuth ?? `Bearer ${accessToken}`;
  }

  return deduplicated;
}
