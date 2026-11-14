/**
 * The environment variable a warm bridge reads its idle window from. Set at
 * spawn from the box's `idleMs`, never written into the bridge's source, so
 * changing the window never changes the baked agent install.
 */
export const WARM_BRIDGE_WINDOW_ENV = "MCPJAM_WARM_WINDOW_MS";

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
