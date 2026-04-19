/**
 * Small formatting helpers shared across tiles. Kept here so the relative-
 * time formula doesn't drift between components — "34d ago" on one tile and
 * "a month ago" on another would be genuinely confusing on a delivery
 * dashboard.
 */

export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs >= day) return `${Math.floor(diffMs / day)}d ago`;
  if (diffMs >= hour) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs >= minute) return `${Math.floor(diffMs / minute)}m ago`;
  return "just now";
}

/** Short elapsed duration between two ISO timestamps, e.g. "2m 14s". */
export function formatElapsed(
  startIso: string | null,
  endIso: string | null
): string {
  if (!startIso) return "";
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const diffMs = Math.max(0, end - new Date(startIso).getTime());
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Truncate a string to `max` characters, appending "…" when cut. Used to
 * fit long commit subjects into the tile's single-line commit feed
 * without wrapping. `max` counts the ellipsis as one character.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
