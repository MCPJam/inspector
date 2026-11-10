export const WARM_BRIDGE_WINDOW_MS = 15 * 60_000;

/** Linux field 22 follows a comm field that can itself contain spaces or ')'. */
export function processBirthIdentity(stat: string): string | undefined {
  const end = stat.lastIndexOf(")");
  if (end < 0) return undefined;
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
}
