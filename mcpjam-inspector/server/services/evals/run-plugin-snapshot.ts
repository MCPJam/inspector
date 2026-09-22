/**
 * INS-5 — a suite run's plugin surface, read from the RUN SNAPSHOT.
 *
 * An eval exists to answer "did this configuration behave?", so every input to
 * the answer has to be the one the run froze. BE-5 made that possible for
 * plugins: `configSnapshot.environmentPluginVersions` records exactly which
 * bundles the launch resolved, and the pinned-skill store now freezes a plugin
 * skill's SUPPORTING FILES alongside its SKILL.md. This module turns those two
 * frozen records into the object the turn already knows how to consume.
 *
 * It re-derives nothing:
 *
 *   - which versions ran        → the run snapshot, verbatim. Re-resolving a
 *                                 plugin to its ACTIVE version would quietly
 *                                 replace an in-flight run's bundle, which is
 *                                 the acceptance criterion this work exists for.
 *   - which servers may run     → `services/plugins/run-plugin-servers.ts` (D2),
 *                                 which re-gates lifecycle at execution.
 *   - the capability projection → `resolveEffectiveCapabilities` (INS-3),
 *                                 unchanged. Ref namespacing, the
 *                                 plugin/standalone split, and the `problems`
 *                                 reporting are INS-3's rules; a second copy
 *                                 here would be a second set of them.
 *
 * Address by `modelRef`, never by `name`. A plugin skill's `name` is its
 * declared name and two plugins may legitimately share one — BE-5 re-keyed the
 * backend's collision gate to `modelRef ?? name` for exactly that reason. The
 * pinned metadata carries `modelRef`, so it flows straight into INS-3's
 * attribution map and the model addresses `<plugin>/<skill>`.
 *
 * `aggregateHash` is the COMPLETE artifact (SKILL.md + every supporting file);
 * `contentHash` identifies only the SKILL.md envelope. Anything reasoning about
 * "is this the same skill the run used?" wants the former.
 */
import {
  resolveEffectiveCapabilities,
  type EffectiveCapabilitySet,
  type RuntimePluginVersion,
} from "../environments/effective-capabilities.js";
import type {
  AttributedPluginVersion,
  PluginRuntimeAttribution,
} from "../environments/plugin-attribution.js";
import type { RunPluginServer } from "../plugins/run-plugin-servers.js";
import type { RuntimeSkillChannel } from "../environments/runtime.js";

/**
 * One pinned supporting file, as BE-5's `joinPinnedSkillFileDelivery` serves it.
 *
 * `url` is a signed, time-limited blob URL. **`null` means the pinned blob is
 * UNREACHABLE** — see {@link assertPinnedSkillFilesReachable}.
 */
export interface RunPinnedSkillFile {
  path: string;
  contentHash: string;
  size: number;
  url: string | null;
}

/**
 * The full pinned-skill row `testSuites:getRunPinnedSkills` returns.
 *
 * Every field past `contentHash` is optional because the shipped backend served
 * the SKILL.md-only subset before BE-5, and a run started then must still
 * replay. Absent is read as absent — never synthesized.
 */
export interface RunPinnedSkill {
  skillId?: string;
  /** Exact immutable MCP-server capture provenance (not a project skill id). */
  serverSkillId?: string;
  serverSkillVersionId?: string;
  serverId?: string;
  serverLabel?: string;
  skillUri?: string;
  serverSkillVersionNumber?: number;
  serverSkillCapturedAt?: number;
  name: string;
  description: string;
  content: string;
  contentHash: string;
  /** Complete-artifact identity; absent ⇒ equal to `contentHash` (body-only). */
  aggregateHash?: string;
  /** `<plugin>/<skill>` for a plugin-channel entry; absent for the others. */
  modelRef?: string;
  sharing?: "user" | "project";
  channels?: RuntimeSkillChannel[];
  extraFrontmatter?: Record<string, unknown>;
  files?: RunPinnedSkillFile[];
}

/** The `configSnapshot.environmentPluginVersions` row shape. */
export interface RunPinnedPluginVersion {
  pluginId: string;
  pluginVersionId: string;
  name: string;
  /** Optional for deploy skew only; never synthesized when absent. */
  bundleHash?: string;
}

/**
 * Thrown when a run's frozen plugin surface cannot be delivered as recorded.
 *
 * Deliberately its own type and NOT a degradation: every caller finalizes the
 * run as a setup failure before a single model call. `component` names what
 * could not be delivered so the failure is attributable rather than a bare
 * "skills unavailable".
 */
export class RunPluginSnapshotError extends Error {
  readonly component: string;
  constructor(component: string, message: string) {
    super(message);
    this.name = "RunPluginSnapshotError";
    this.component = component;
  }
}

/**
 * Every pinned supporting file must be REACHABLE before the run executes.
 *
 * A `url: null` is not "this skill has no file". It is a blob the pin store
 * points at and storage can no longer serve — only possible for bytes deleted
 * before BE-5's retention rule existed, or by a direct dashboard delete.
 * Treating it as absence is the precise inversion that makes a replay run
 * silently script-less while still reporting the skill as delivered, which is
 * the failure the pin store was built to prevent. So it fails the run, and it
 * fails it HERE — before model execution — naming the skill and the path.
 *
 * Checked for standalone pins too, not just plugin ones: the same store backs
 * both, and an unreachable file is exactly as wrong either way.
 */
export function assertPinnedSkillFilesReachable(
  pins: readonly RunPinnedSkill[]
): void {
  for (const pin of pins) {
    for (const file of pin.files ?? []) {
      if (typeof file.url === "string" && file.url.length > 0) continue;
      const ref = pin.modelRef ?? pin.name;
      throw new RunPluginSnapshotError(
        ref,
        `This run pinned the skill "${ref}", but its supporting file "${file.path}" is no longer readable from the run snapshot. The run was stopped rather than executed with the file missing. Re-import the plugin (or re-create the skill) and start a new run.`
      );
    }
  }
}

/** A pin the model must address by its namespaced plugin ref. */
function isPluginPin(pin: RunPinnedSkill): boolean {
  return (
    pin.serverSkillId === undefined &&
    (pin.modelRef !== undefined || (pin.channels ?? []).includes("plugin"))
  );
}

function isServerSkillPin(pin: RunPinnedSkill): boolean {
  return (
    pin.serverSkillId !== undefined ||
    (pin.channels ?? []).includes("mcp-server")
  );
}

/**
 * Rebuild INS-3's attribution map from FROZEN records instead of a live probe.
 *
 * `fetchPluginRuntimeAttribution` exists because an interactive turn has to ask
 * the plugin registry which component contributed what. A run does not: its
 * snapshot already recorded the version list, its pins already carry
 * `modelRef`, and D2 already returned per-server plugin identity. Probing live
 * would reintroduce exactly the drift the snapshot removes.
 *
 * `unattributedVersionIds` keeps its meaning — a pinned version we could not
 * connect to any server or skill — so INS-3 reports the same
 * `plugin_origin_unavailable` problem it would for a live turn.
 */
function attributionFromSnapshot(args: {
  pluginVersions: readonly RunPinnedPluginVersion[];
  pluginServers: readonly RunPluginServer[];
  pins: readonly RunPinnedSkill[];
}): PluginRuntimeAttribution {
  const byVersionId = new Map<string, AttributedPluginVersion>();
  for (const version of args.pluginVersions) {
    byVersionId.set(version.pluginVersionId, {
      pluginId: version.pluginId,
      pluginVersionId: version.pluginVersionId,
      name: version.name,
      // Deploy skew only. `null` is INS-3's "we do not know", and it renders as
      // an omitted revision rather than a made-up one.
      bundleHash: version.bundleHash ?? null,
    });
  }

  const attributedVersionIds = new Set<string>();
  const serverOrigins = new Map<string, AttributedPluginVersion>();
  for (const server of args.pluginServers) {
    const version = byVersionId.get(server.pluginVersionId);
    // A D2 row naming a version the snapshot never recorded is a torn view, not
    // an origin: label nothing rather than inventing a pin the run never made.
    if (!version) continue;
    serverOrigins.set(server.serverId, version);
    attributedVersionIds.add(version.pluginVersionId);
  }

  const skillOrigins = new Map<
    string,
    { modelRef: string; plugin: AttributedPluginVersion }
  >();
  for (const pin of args.pins) {
    if (isServerSkillPin(pin) || !pin.skillId || !pin.modelRef) continue;
    // The pin records the ref but not which VERSION minted it. Recover it from
    // the plugin-name namespace the ref carries — the same namespace the
    // backend builds `modelRef` from — and only when it is unambiguous.
    const namespace = pin.modelRef.split("/")[0];
    const matches = args.pluginVersions.filter(
      (version) => version.name === namespace
    );
    if (matches.length !== 1) continue;
    const version = byVersionId.get(matches[0].pluginVersionId);
    if (!version) continue;
    skillOrigins.set(pin.skillId, { modelRef: pin.modelRef, plugin: version });
    attributedVersionIds.add(version.pluginVersionId);
  }

  return {
    serverOrigins,
    skillOrigins,
    unattributedVersionIds: args.pluginVersions
      .map((version) => version.pluginVersionId)
      .filter((id) => !attributedVersionIds.has(id)),
  };
}

/**
 * Project a suite run's frozen plugin surface into the capability set a turn
 * consumes.
 *
 * `effectiveServerIds` is the set the run actually connected, in connection
 * order; `pluginServers` is D2's verified subset of it. Classification comes
 * from the D2 answer, never from the snapshot's own server list — the snapshot
 * says what was pinned, D2 says what may run.
 */
export function buildRunCapabilitySet(args: {
  pins: readonly RunPinnedSkill[];
  pluginVersions: readonly RunPinnedPluginVersion[];
  pluginServers: readonly RunPluginServer[];
  effectiveServerIds: readonly string[];
  /** Display names index-aligned with `effectiveServerIds`; may be empty. */
  serverNames?: readonly string[];
}): EffectiveCapabilitySet {
  const serverPins = args.pins.filter(isServerSkillPin);
  const regularPins = args.pins.filter((pin) => !isServerSkillPin(pin));
  const pluginServerIds = new Set(args.pluginServers.map((s) => s.serverId));
  const nameById = new Map(args.pluginServers.map((s) => [s.serverId, s.name]));
  args.effectiveServerIds.forEach((serverId, index) => {
    const name = args.serverNames?.[index];
    if (name && !nameById.has(serverId)) nameById.set(serverId, name);
  });

  return resolveEffectiveCapabilities(
    {
      servers: {
        effectiveServerIds: [...args.effectiveServerIds],
        pluginServerIds: [...pluginServerIds],
        connectable: args.effectiveServerIds.map((serverId) => ({
          serverId,
          // Absence of a name is semantic (the manager shows the id); never
          // guess one.
          name: nameById.get(serverId) ?? serverId,
          source: pluginServerIds.has(serverId)
            ? ("plugin" as const)
            : ("host_or_group" as const),
        })),
      },
      skills: regularPins.map((pin) => ({
        // A pre-BE-5 pin may carry no `skillId`. INS-3 keys attribution and
        // collision reporting by it, so mint a stable stand-in from the ref
        // rather than colliding every such pin on `undefined`.
        skillId: pin.skillId ?? `pin:${pin.modelRef ?? pin.name}`,
        name: pin.name,
        description: pin.description,
        content: pin.content,
        // Body-only pins legitimately have no aggregate hash; it equals the
        // content hash by definition there.
        aggregateHash: pin.aggregateHash ?? pin.contentHash,
        ...(pin.extraFrontmatter
          ? { extraFrontmatter: pin.extraFrontmatter }
          : {}),
        // Channels drive INS-3's plugin/standalone split. A pin that carries a
        // `modelRef` but no channels (deploy skew) is still a plugin skill.
        channels: pin.channels ?? (isPluginPin(pin) ? ["plugin" as const] : []),
        files: (pin.files ?? []).map((file) => ({
          path: file.path,
          size: file.size,
          url: file.url,
        })),
      })),
      pluginVersions: args.pluginVersions.map((version) => ({
        pluginId: version.pluginId,
        pluginVersionId: version.pluginVersionId,
        name: version.name,
        ...(version.bundleHash ? { bundleHash: version.bundleHash } : {}),
      })),
      serverSkills: serverPins.map((pin) => {
        if (
          !pin.serverSkillId ||
          !pin.serverSkillVersionId ||
          !pin.serverId ||
          !pin.modelRef ||
          !pin.serverLabel ||
          !pin.skillUri ||
          pin.serverSkillVersionNumber === undefined ||
          pin.serverSkillCapturedAt === undefined
        ) {
          throw new RunPluginSnapshotError(
            pin.modelRef ?? pin.name,
            `This run's captured MCP server skill is missing immutable provenance metadata. The run was stopped rather than delivering an ambiguous skill.`
          );
        }
        return {
          serverSkillId: pin.serverSkillId,
          versionId: pin.serverSkillVersionId,
          serverId: pin.serverId,
          serverSlug: pin.modelRef.split("/")[0] ?? pin.serverId,
          serverLabel: pin.serverLabel,
          ref: pin.modelRef,
          skillUri: pin.skillUri,
          name: pin.name,
          description: pin.description,
          content: pin.content,
          contentSha256: pin.contentHash,
          versionHash: pin.aggregateHash ?? pin.contentHash,
          versionNumber: pin.serverSkillVersionNumber,
          capturedAt: pin.serverSkillCapturedAt,
          files: (pin.files ?? []).map((file) => ({
            path: file.path,
            size: file.size,
            url: file.url,
          })),
        };
      }),
    },
    attributionFromSnapshot({
      pluginVersions: args.pluginVersions,
      pluginServers: args.pluginServers,
      pins: args.pins,
    })
  );
}

/**
 * Does this run's pinned set need the ref-addressed skill surface?
 *
 * Body-only, bare-name pins — every eval run that existed before plugins — keep
 * the legacy pinned tool set byte for byte: same tool names, same prompt
 * stanza, no supporting-file tools to advertise for files that cannot exist.
 * Changing that surface for every eval user in order to serve plugin runs would
 * be a behaviour change nobody asked for, measured by suites that have been
 * running against the old one.
 *
 * A pin with a plugin ref or a supporting file cannot be served by that surface
 * at all, so those runs get INS-3's.
 */
export function runNeedsEffectiveSkillSurface(
  pins: readonly RunPinnedSkill[]
): boolean {
  return pins.some(
    (pin) =>
      isPluginPin(pin) || isServerSkillPin(pin) || (pin.files ?? []).length > 0
  );
}

/**
 * The versions a run actually executed with, for provenance display and the
 * submission report. Straight from the snapshot, in pin order.
 */
export function runPluginVersions(
  pluginVersions: readonly RunPinnedPluginVersion[]
): RuntimePluginVersion[] {
  return pluginVersions.map((version) => ({
    pluginId: version.pluginId,
    pluginVersionId: version.pluginVersionId,
    name: version.name,
    bundleHash: version.bundleHash ?? null,
  }));
}
