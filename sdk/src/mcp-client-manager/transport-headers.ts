/**
 * Deduplicates request headers case-insensitively and merges the Bearer
 * accessToken into Authorization if provided. Key spelling is preserved:
 * the client SDK's transport sets protocol-version headers with `Headers.set`,
 * which already replaces any casing.
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
    deduplicated[key] = value;
    lowerKeyMap.set(lower, key);
  }

  if (accessToken) {
    deduplicated["Authorization"] = existingAuth ?? `Bearer ${accessToken}`;
  }

  return deduplicated;
}
