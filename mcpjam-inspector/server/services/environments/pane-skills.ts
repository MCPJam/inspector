import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { listCloudRuntimeSkills } from "../../utils/computers/cloud-skill-tools.js";
import {
  getHarnessAdapter,
  harnessSupportsSkills,
} from "../../utils/harness/registry.js";
import { resolveAgentLoop } from "../../utils/harness/agent-loop-dispatch.js";
import { fetchRuntimeSkills } from "../../utils/harness/runtime-skills.js";
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
import {
  resolveEnvironmentForRuntime,
  runtimeSkills,
  type RuntimeSkillChannel,
} from "./runtime.js";

const id = z.string().min(1);
export const paneSkillsRequest = z.object({
  projectId: id,
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("client"),
      hostId: id,
      environmentId: id.optional(),
    }),
    z.object({ kind: z.literal("environment"), environmentId: id }),
  ]),
  serverIds: z.array(id).optional(),
  pluginVersionIds: z.array(id).optional(),
});

type Reason =
  | "unsupported-harness"
  | "server-skill-unsupported"
  | "plugin-disabled"
  | "name-collision"
  | "invalid-skill-name";
type Row = {
  skillId: string;
  name: string;
  description: string;
  channels: (RuntimeSkillChannel | "project")[];
  reason: Reason | null;
};

/** A read of the inputs to a turn. Do not compose an environment, start a box,
 * fetch supporting files, or return an artifact from the runtime spec. */
export async function previewPaneSkills(
  client: ConvexHttpClient,
  bearer: string,
  {
    projectId,
    target,
    pluginVersionIds,
    serverIds,
  }: z.infer<typeof paneSkillsRequest>,
  signal?: AbortSignal,
) {
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
  const rows = new Map<string, Row>();
  function add(
    skill: Pick<Row, "skillId" | "name" | "description">,
    channels: Row["channels"],
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
      ? await fetchRuntimeSkills(bearer, projectId)
      : undefined;
    if (live && !live.ok)
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "Couldn't load project skills.",
      );
    for (const skill of live?.skills ?? []) add(skill, ["project"]);
    const skills = live
      ? (composeLivePlusSkills(live.skills, pins).skills ?? [])
      : pins;
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
