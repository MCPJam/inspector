import type { ConvexHttpClient } from "convex/browser";
import type {
  PaneSkillRow,
  PaneSkillsRequest,
  PaneSkillsPreview,
} from "../../../shared/pane-skills-preview.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { listCloudRuntimeSkills } from "../../utils/computers/cloud-skill-tools.js";
import {
  getHarnessAdapter,
  harnessSupportsSkills,
} from "../../utils/harness/registry.js";
import { resolveAgentLoop } from "../../utils/harness/agent-loop-dispatch.js";
import { convexListSkillsForRuntime } from "../../utils/computers/convex-skills-client.js";
import { composeLivePlusSkills } from "../../utils/harness/skill-delivery.js";
import { fetchHostRuntimeConfig } from "../../utils/host-runtime-config.js";
import {
  allEffectiveSkills,
  buildLiveEffectiveCapabilities,
  resolveEffectiveCapabilities,
  withLiveProjectSkills,
} from "./effective-capabilities.js";
import { fetchPluginRuntimeAttribution } from "./plugin-attribution.js";
import { applyPluginVersionOverride } from "./plugin-override.js";
import { resolveEnvironmentForRuntime, runtimeSkills } from "./runtime.js";

/** A read of the inputs to a turn. Do not compose an environment, start a box,
 * fetch supporting files, or return an artifact from the runtime spec. */
export async function previewPaneSkills(
  client: ConvexHttpClient,
  bearer: string,
  { projectId, target, pluginVersionIds, serverIds }: PaneSkillsRequest,
  signal?: AbortSignal,
): Promise<PaneSkillsPreview> {
  const environmentId = target.environmentId;
  const spec = environmentId
    ? await resolveEnvironmentForRuntime(client, {
        projectId,
        environmentId,
        overrides: { serverIds },
      })
    : undefined;
  let config;
  if (spec) {
    if (
      target.kind === "client" &&
      (spec.environmentOrigin !== "adhoc" || spec.host.hostId !== target.hostId)
    ) {
      throw new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        "The client setup changed. Reopen its settings.",
      );
    }
    config = spec.host.runtimeConfig;
  } else if (target.kind === "client") {
    const host = await fetchHostRuntimeConfig({
      hostId: target.hostId,
      bearer,
      signal,
    });
    if (!host.ok) {
      throw new WebRouteError(
        host.status >= 500 ? 502 : host.status,
        ErrorCode.SERVER_UNREACHABLE,
        "Couldn't load this client.",
      );
    }
    config = host.config;
  }
  const { harnessId: harness } = resolveAgentLoop({
    agentLoop: config?.agentLoop,
    harness: config?.harness,
  });
  const attribution = spec
    ? await fetchPluginRuntimeAttribution(client, {
        projectId,
        pluginVersionIds: (spec.pluginVersions ?? []).map(
          (p) => p.pluginVersionId,
        ),
      })
    : null;
  if (!spec && pluginVersionIds?.length) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "The plugin setup is still loading.",
    );
  }
  const narrowed =
    spec && pluginVersionIds !== undefined
      ? applyPluginVersionOverride({
          spec,
          attribution,
          retainedVersionIds: pluginVersionIds,
        })
      : undefined;
  const effective = narrowed?.spec ?? spec;
  const rows = new Map<string, PaneSkillRow>();
  function add(
    skill: Pick<PaneSkillRow, "skillId" | "name" | "description">,
    channels: PaneSkillRow["channels"],
  ) {
    if (!rows.has(skill.skillId)) {
      rows.set(skill.skillId, {
        skillId: skill.skillId,
        name: skill.name,
        description: skill.description,
        channels,
        reason: null,
      });
    }
  }
  for (const skill of spec?.skills ?? []) add(skill, skill.channels ?? []);
  for (const skill of spec?.serverSkills ?? [])
    add(
      {
        skillId: skill.serverSkillId,
        name: skill.ref,
        description: skill.description,
      },
      ["mcp-server"],
    );

  const withPool = target.kind === "client";
  const unsupported = harness !== undefined && !harnessSupportsSkills(harness);
  const delivered = new Set<string>();
  const invalid = new Set<string>();
  if (harness && !unsupported) {
    const adapter = getHarnessAdapter(harness);
    const pins = effective ? runtimeSkills(effective) : [];
    const live = withPool
      ? await convexListSkillsForRuntime(bearer, projectId)
      : undefined;
    for (const skill of live ?? []) add(skill, ["project"]);
    // Only composed client turns merge by folder. A bare native turn gives
    // its adapter the unmodified live catalog.
    const skills =
      live && effective
        ? (composeLivePlusSkills(live, pins).skills ?? [])
        : (live ?? pins);
    const prepared = adapter.prepareSkills(skills);
    for (const skill of prepared.delivered) delivered.add(skill.skillId);
    const skipped = new Set(prepared.skipped.map((skill) => skill.name));
    for (const skill of skills)
      if (skipped.has(skill.name)) invalid.add(skill.skillId);
  } else {
    const pool = withPool
      ? await listCloudRuntimeSkills({ projectId, authHeader: bearer, signal })
      : [];
    for (const skill of pool) add(skill, ["project"]);
    if (!unsupported) {
      const live = buildLiveEffectiveCapabilities({ standaloneSkills: pool });
      const set = effective
        ? withLiveProjectSkills(
            resolveEffectiveCapabilities(effective, attribution),
            live,
          )
        : live;
      for (const skill of allEffectiveSkills(set)) delivered.add(skill.skillId);
    }
  }
  const disabled = new Set(narrowed?.droppedSkillIds);
  for (const row of rows.values()) {
    if (delivered.has(row.skillId)) continue;
    row.reason = disabled.has(row.skillId)
      ? "plugin-disabled"
      : unsupported
        ? "unsupported-harness"
        : harness && row.channels.includes("mcp-server")
          ? "server-skill-unsupported"
          : invalid.has(row.skillId)
            ? "invalid-skill-name"
            : "name-collision";
  }
  return { skills: [...rows.values()], deliveredCount: delivered.size };
}
