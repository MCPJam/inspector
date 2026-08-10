/**
 * Per-VERSION plugin attribution for a resolved environment turn (INS-3).
 *
 * `resolveEnvironmentForRuntime` tells us WHICH plugin versions are pinned and
 * WHICH server ids they contributed — but as two flat lists
 * (`pluginVersions`, `servers.pluginServerIds`), with no edge between them. It
 * also carries no `modelRef`, so a plugin skill arrives under its bare
 * materialized name. Two pinned plugins therefore look identical at the point
 * where a tool call or a skill load has to say where it came from.
 *
 * The edge lives backend-side (`pluginServerComponents` /
 * `pluginSkillComponents` both key on `pluginVersionId`), and the probe
 * `plugins.resolvePluginRuntimePreview` now returns it directly: full
 * `serverComponents` rows and per-skill `pluginVersionId`. So attribution is
 * ONE call for the whole pin set — the historical per-version fan-out (which
 * recovered the edge by asking about one version at a time) is gone.
 *
 * This is consumption, not reimplementation: every lifecycle rule (ready +
 * installed + enabled + same-project, never a fallback to `activeVersionId`)
 * still runs backend-side inside the probe, and the `modelRef` we read is the
 * one `pluginSkillComponents` stored at materialization — never a
 * `<name>/<name>` string we assembled here.
 *
 * ATTRIBUTION IS PROVENANCE, NEVER A GATE. Every failure mode returns `null`
 * (tri-state — never a half-filled map, which would label some plugin servers
 * as ordinary ones), and every caller must degrade to "origin unknown" rather
 * than dropping a capability. The environment resolution already decided what
 * runs; this only decides what we can honestly say about it. A deployed
 * backend old enough to omit `serverComponents` lands in the same `null`.
 */
import type { ConvexHttpClient } from "convex/browser";
import { logger } from "../../utils/logger.js";

const PREVIEW_FUNCTION_REF = "plugins:resolvePluginRuntimePreview" as const;

/** Identity + reproducibility anchor of one pinned version. */
export interface AttributedPluginVersion {
  pluginId: string;
  pluginVersionId: string;
  /** Normalized plugin name — the `modelRef` namespace. */
  name: string;
  /** Absent only under deploy skew; never synthesized. */
  bundleHash: string | null;
}

export interface AttributedPluginSkill {
  /** `<plugin-name>/<declared-skill-name>`, straight from the component row. */
  modelRef: string;
  plugin: AttributedPluginVersion;
}

export interface PluginRuntimeAttribution {
  /** Materialized server id → the pinned version that contributed it. */
  serverOrigins: Map<string, AttributedPluginVersion>;
  /** Materialized skill id → its namespaced ref + contributing version. */
  skillOrigins: Map<string, AttributedPluginSkill>;
  /**
   * Pinned versions the probe could not attribute — because they became
   * unavailable between the environment resolution and this read, or answered
   * in a shape we could not parse.
   *
   * NON-EMPTY MEANS THE MAPS ABOVE ARE INCOMPLETE. A caller must surface that
   * (as a capability problem), never treat a short map as a complete answer:
   * the affected servers and skills still run, and silently losing their
   * provenance is exactly the failure `problems` exists to prevent.
   */
  unattributedVersionIds: string[];
}

/**
 * How long the attribution read may take before we give up.
 *
 * `ConvexHttpClient.query` has no per-call deadline, so without this a Convex
 * read that never settles blocks the chat route BEFORE the turn starts — the
 * user's send hangs forever for the sake of a provenance LABEL. Five seconds is
 * far beyond a small indexed read and far below anything a person would wait
 * through; on expiry we return `null` and the turn runs with origin unreported,
 * the same as every other failure here.
 *
 * The timed-out query is left to settle on its own rather than aborted via
 * `setFetchOptions`: that setter mutates the SHARED client the route also uses
 * for the environment resolution, so an attribution deadline would silently
 * become that read's deadline too. A dangling read is harmless — it is a pure
 * query whose result we drop.
 */
const ATTRIBUTION_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Build the server/skill → pinned-version edges for a turn, from ONE probe
 * call covering the whole pin set.
 *
 * `null` means "no attribution available" and MUST be treated as such by
 * callers — see the module note. An empty pin list short-circuits to empty maps
 * (a no-plugin environment costs zero extra reads, which is what keeps
 * `resolveEnvironmentForRuntime`'s one-atomic-read guarantee meaningful for the
 * overwhelmingly common case).
 */
export async function fetchPluginRuntimeAttribution(
  client: ConvexHttpClient,
  args: { projectId: string; pluginVersionIds: string[] }
): Promise<PluginRuntimeAttribution | null> {
  if (args.pluginVersionIds.length === 0) {
    return {
      serverOrigins: new Map(),
      skillOrigins: new Map(),
      unattributedVersionIds: [],
    };
  }
  let raw: unknown;
  try {
    raw = await Promise.race([
      client.query(PREVIEW_FUNCTION_REF as any, {
        projectId: args.projectId,
        pluginVersionIds: args.pluginVersionIds,
      } as any),
      // Rejects on expiry, landing in the same catch as any other failure.
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("attribution probe timed out")),
          ATTRIBUTION_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    // Includes the deploy-skew case (`Could not find public function`) and the
    // deadline above.
    logger.warn(
      "[plugin-attribution] probe failed; running without plugin origin",
      { error: error instanceof Error ? error.message : String(error) }
    );
    return null;
  }

  if (!isRecord(raw) || !Array.isArray(raw.serverComponents)) {
    // A backend old enough to omit the component rows cannot supply the
    // version edge. Reporting no origin is honest; guessing from the flat
    // `effectiveServerIds` list is not.
    logger.warn(
      "[plugin-attribution] probe response has no serverComponents; running without plugin origin"
    );
    return null;
  }

  const versionsById = new Map<string, AttributedPluginVersion>();
  for (const entry of Array.isArray(raw.pluginVersions)
    ? raw.pluginVersions
    : []) {
    if (!isRecord(entry)) continue;
    const pluginVersionId = readString(entry.pluginVersionId);
    const pluginId = readString(entry.pluginId);
    const name = readString(entry.name);
    if (!pluginVersionId || !pluginId || !name) continue;
    versionsById.set(pluginVersionId, {
      pluginId,
      pluginVersionId,
      name,
      bundleHash: readString(entry.bundleHash),
    });
  }

  const serverOrigins = new Map<string, AttributedPluginVersion>();
  for (const component of raw.serverComponents) {
    if (!isRecord(component)) continue;
    const serverId = readString(component.materializedServerId);
    const pluginVersionId = readString(component.pluginVersionId);
    if (!serverId || !pluginVersionId) continue;
    const plugin = versionsById.get(pluginVersionId);
    if (!plugin) continue;
    // First pin wins, matching the backend's dedupe of `effectiveServerIds`
    // in pin order. Two versions of the same plugin can materialize the same
    // component only across a re-import, which the environment's own dedupe
    // already collapsed.
    if (!serverOrigins.has(serverId)) {
      serverOrigins.set(serverId, plugin);
    }
  }

  const skillOrigins = new Map<string, AttributedPluginSkill>();
  for (const entry of Array.isArray(raw.pluginSkills) ? raw.pluginSkills : []) {
    if (!isRecord(entry)) continue;
    const skillId = readString(entry.materializedSkillId);
    const modelRef = readString(entry.modelRef);
    const pluginVersionId = readString(entry.pluginVersionId);
    if (!skillId || !modelRef || !pluginVersionId) continue;
    const plugin = versionsById.get(pluginVersionId);
    if (!plugin) continue;
    if (!skillOrigins.has(skillId)) {
      skillOrigins.set(skillId, { modelRef, plugin });
    }
  }

  // A pinned version absent from the resolved list is a torn read: it
  // resolved for the environment but not for this probe (disabled or
  // uninstalled in between). Its components still run; we just cannot name
  // their origin — and the short map must announce itself.
  const unattributedVersionIds = args.pluginVersionIds.filter(
    (id) => !versionsById.has(id)
  );

  return { serverOrigins, skillOrigins, unattributedVersionIds };
}
