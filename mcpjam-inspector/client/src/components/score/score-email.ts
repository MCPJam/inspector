/** Keep the browser and orchestration tests on the same email contract. */
export function normalizeScoreEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 320) return null;
  if (/\s/.test(trimmed)) return null;

  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1 || trimmed.indexOf("@") !== at) {
    return null;
  }
  const domain = trimmed.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) {
    return null;
  }
  return trimmed;
}
