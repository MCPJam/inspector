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
 * The edge exists backend-side (`pluginServerComponents` /
 * `pluginSkillComponents` both key on `pluginVersionId`), and
 * `lib/pluginRuntimeResolution.resolvePluginVersionsRuntime` returns it — but
 * the INS-facing probe `plugins.resolvePluginRuntimePreview` FLATTENS it into
 * `effectiveServerIds` / `pluginSkills` across every version it was asked
 * about. So we recover the edge the only way the deployed API allows: ask the
 * probe about ONE version at a time. Each response is then unambiguously that
 * version's components.
 *
 * That is deliberately a consumption trick, not a reimplementation: every
 * lifecycle rule (ready + installed + enabled + same-project, never a fallback
 * to `activeVersionId`) still runs backend-side inside the probe, and the
 * `modelRef` we read is the one `pluginSkillComponents` stored at
 * materialization — never a `<name>/<name>` string we assembled here.
 *
 * FOLLOW-UP: a probe that returned component rows (pluginVersionId +
 * componentKey per server) would collapse this to one call. Worth doing when
 * pin counts grow; today a pinned set is a handful of versions read in
 * parallel.
 *
 * ATTRIBUTION IS PROVENANCE, NEVER A GATE. Every failure mode returns `null`
 * (tri-state — never a half-filled map, which would label some plugin servers
 * as ordinary ones), and every caller must degrade to "origin unknown" rather
 * than dropping a capability. The environment resolution already decided what
 * runs; this only decides what we can honestly say about it.
 */
import type { ConvexHttpClient } from "convex/browser";
import { logger } from "../../utils/logger.js";

const PREVIEW_FUNCTION_REF = "plugins:resolvePluginRuntimePreview" as const;

/** Identity + reproducibility anchor of one pinned version. */
export interface AttributedPluginVersion {
  pluginId: string;
  pluginVersionId: string;
  /** Normalized kebab-case plugin name — the `modelRef` namespace. */
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
 * How long the whole attribution fan-out may take before we give up.
 *
 * `ConvexHttpClient.query` has no per-call deadline, so without this a Convex
 * read that never settles blocks the chat route BEFORE the turn starts — the
 * user's send hangs forever for the sake of a provenance LABEL. Five seconds is
 * far beyond a small indexed read and far below anything a person would wait
 * through; on expiry we return `null` and the turn runs with origin unreported,
 * the same as every other failure here.
 *
 * The timed-out queries are left to settle on their own rather than aborted via
 * `setFetchOptions`: that setter mutates the SHARED client the route also uses
 * for the environment resolution, so an attribution deadline would silently
 * become that read's deadline too. Dangling reads are harmless — they are pure
 * queries whose results we drop.
 */
const ATTRIBUTION_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One probe call, scoped to a single pinned version.
 *
 * Returns `null` when the probe reports the version as unavailable or answers
 * in a shape we cannot read. That is NOT an error: the environment resolution
 * and this probe are separate reads, so a plugin disabled between them is a
 * torn view, and the environment's answer is the one the turn already
 * committed to. Reporting no origin is honest; inventing one is not.
 */
async function probeOneVersion(
  client: ConvexHttpClient,
  projectId: string,
  pluginVersionId: string
): Promise<{
  plugin: AttributedPluginVersion;
  serverIds: string[];
  skills: Array<{ skillId: string; modelRef: string }>;
} | null> {
  const raw: unknown = await client.query(PREVIEW_FUNCTION_REF as any, {
    projectId,
    pluginVersionIds: [pluginVersionId],
  } as any);
  if (!isRecord(raw)) return null;

  const versions = Array.isArray(raw.pluginVersions) ? raw.pluginVersions : [];
  const version = versions.find(
    (entry) =>
      isRecord(entry) && readString(entry.pluginVersionId) === pluginVersionId
  );
  // Absent ⇒ the probe put it in `unavailableComponents`. Nothing to attribute.
  if (!isRecord(version)) return null;
  const pluginId = readString(version.pluginId);
  const name = readString(version.name);
  if (!pluginId || !name) return null;

  const plugin: AttributedPluginVersion = {
    pluginId,
    pluginVersionId,
    name,
    bundleHash: readString(version.bundleHash),
  };

  const serverIds = (
    Array.isArray(raw.effectiveServerIds) ? raw.effectiveServerIds : []
  )
    .map(readString)
    .filter((id): id is string => id !== null);

  const skills: Array<{ skillId: string; modelRef: string }> = [];
  for (const entry of Array.isArray(raw.pluginSkills) ? raw.pluginSkills : []) {
    if (!isRecord(entry)) continue;
    const skillId = readString(entry.materializedSkillId);
    const modelRef = readString(entry.modelRef);
    if (skillId && modelRef) skills.push({ skillId, modelRef });
  }

  return { plugin, serverIds, skills };
}

/**
 * Build the server/skill → pinned-version edges for a turn.
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
  let probed: Array<Awaited<ReturnType<typeof probeOneVersion>>>;
  try {
    probed = await Promise.race([
      Promise.all(
        args.pluginVersionIds.map((id) =>
          probeOneVersion(client, args.projectId, id)
        )
      ),
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
    // deadline above. One failed probe poisons the whole map: a partial map
    // would silently present an unattributed plugin server as an ordinary one.
    logger.warn(
      "[plugin-attribution] probe failed; running without plugin origin",
      { error: error instanceof Error ? error.message : String(error) }
    );
    return null;
  }

  const serverOrigins = new Map<string, AttributedPluginVersion>();
  const skillOrigins = new Map<string, AttributedPluginSkill>();
  const unattributedVersionIds: string[] = [];
  for (const [index, result] of probed.entries()) {
    if (!result) {
      // The version resolved for the environment but not for this probe — a
      // torn read. Its components still run; we just cannot name their origin.
      unattributedVersionIds.push(args.pluginVersionIds[index]);
      continue;
    }
    for (const serverId of result.serverIds) {
      // First pin wins, matching the backend's dedupe of `effectiveServerIds`
      // in pin order. Two versions of the same plugin can materialize the same
      // component only across a re-import, which the environment's own dedupe
      // already collapsed.
      if (!serverOrigins.has(serverId)) {
        serverOrigins.set(serverId, result.plugin);
      }
    }
    for (const skill of result.skills) {
      if (!skillOrigins.has(skill.skillId)) {
        skillOrigins.set(skill.skillId, {
          modelRef: skill.modelRef,
          plugin: result.plugin,
        });
      }
    }
  }
  return { serverOrigins, skillOrigins, unattributedVersionIds };
}
