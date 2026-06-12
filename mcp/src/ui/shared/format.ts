/** Display formatting for platform payload fields (epoch ms, rates, counts). */

export function formatTimestamp(
  ms: number | null | undefined
): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }

  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDurationMs(
  ms: number | null | undefined
): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return undefined;
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  // Derive every unit from one rounded total so a subordinate unit can never
  // display as 60 (e.g. "59m 60s" or "2h 60m").
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${totalSeconds % 60}s`;
  }
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/**
 * Pass rates arrive on two scales depending on the producer (0–1 fractions
 * and 0–100 percentages); normalize to a 0–1 fraction the same way the
 * backend's own prompt formatting does.
 */
export function normalizeRate(
  rate: number | null | undefined
): number | undefined {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
    return undefined;
  }

  return Math.min(rate <= 1 ? rate : rate / 100, 1);
}

export function formatPercent(
  rate: number | null | undefined
): string | undefined {
  const normalized = normalizeRate(rate);
  return normalized === undefined
    ? undefined
    : `${Math.round(normalized * 100)}%`;
}

export function formatInteger(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "—";
}

/** "in_progress" → "In progress" for statuses without a curated label. */
export function humanizeStatus(status: string): string {
  const words = status.replaceAll(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}
