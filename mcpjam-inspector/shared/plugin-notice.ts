/**
 * Transient SSE data part: which installed plugins a Playground turn did not
 * load, and why. Emitted by the hosted chat route for host-target turns that
 * add the project's active plugins; rendered once per chat as a plain line and
 * mirrored into the right-rail Logs.
 *
 * Carries plugin ids, names and a categorical reason only.
 */
export type PluginNoticeReason =
  | "not_ready"
  | "no_active_version"
  | "over_cap"
  | "server_missing"
  | "placement"
  | "needs_auth"
  | "needs_setup"
  | "skill_unpinnable"
  /** The server could not connect this turn (minted by the Inspector). */
  | "connect_failed";

export interface PluginNoticePlugin {
  pluginId: string;
  name: string;
  displayName: string | null;
  reason: PluginNoticeReason;
}

export type PluginNoticeData =
  /** Some plugins were skipped; the rest of the turn ran. */
  | { kind: "skipped"; plugins: PluginNoticePlugin[] }
  /** The active-plugin read failed; the turn ran without plugins. */
  | { kind: "unavailable"; plugins: [] };

export interface PluginNoticeDataPart {
  type: "data-plugin-notice";
  transient: true;
  data: PluginNoticeData;
}

export function isPluginNoticeDataPart(
  part: unknown,
): part is PluginNoticeDataPart {
  if (!part || typeof part !== "object") return false;
  const candidate = part as { type?: unknown; data?: unknown };
  if (candidate.type !== "data-plugin-notice") return false;
  const data = candidate.data as { kind?: unknown; plugins?: unknown } | null;
  return (
    !!data &&
    (data.kind === "skipped" || data.kind === "unavailable") &&
    Array.isArray(data.plugins)
  );
}
