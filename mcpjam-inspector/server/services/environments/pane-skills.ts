/**
 * The Skills previews, read off the turn's skill plan (`resolveTurnSkills`):
 * which skills the turn's engine is handed, and why it leaves the others out.
 *
 * The Compare pane previews its own next turn ({@link previewPaneSkills}): a
 * named environment, or a client in its hidden environment, resolved in the
 * client's skill selection as its turn resolves it. The Evaluate page previews
 * an eval run of each of a suite's environments ({@link previewSuiteSkills}),
 * which freezes their skills at start.
 *
 * A read of the inputs to a turn. Do not compose an environment, start a box,
 * fetch supporting files, or return an artifact from the runtime spec.
 */
import type { ConvexHttpClient } from "convex/browser";
import type {
  PaneSkillRow,
  PaneSkillsPreview,
  PaneSkillsRequest,
  SuiteSkillsPreview,
  SuiteSkillsPreviewRequest,
} from "../../../shared/pane-skills-preview.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { listCloudRuntimeSkills } from "../../utils/computers/cloud-skill-tools.js";
import { convexListSkillsForRuntime } from "../../utils/computers/convex-skills-client.js";
import { fetchHostRuntimeConfig } from "../../utils/host-runtime-config.js";
import type { RuntimeStandaloneSkill } from "./effective-capabilities.js";
import {
  fetchPluginRuntimeAttribution,
  type PluginRuntimeAttribution,
} from "./plugin-attribution.js";
import { applyPluginVersionOverride } from "./plugin-override.js";
import {
  resolveEnvironmentForRuntime,
  runtimeSelectors,
  type ResolvedEnvironmentRuntime,
} from "./runtime.js";
import {
  resolveTurnSkills,
  turnRuntime,
  type TurnRuntime,
  type TurnSkills,
} from "./turn-skills.js";

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
        ...(target.kind === "client" ? { skillScope: "visible" as const } : {}),
      })
    : undefined;
  let runtime: TurnRuntime = { kind: "agent" };
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
    runtime = turnRuntime(runtimeSelectors(spec.host.runtimeConfig));
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
    runtime = turnRuntime(host.config);
  }
  if (!spec && pluginVersionIds?.length) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "The plugin setup is still loading.",
    );
  }
  const attribution = spec
    ? await attributionOf(client, projectId, spec)
    : null;
  const narrowed =
    spec && pluginVersionIds !== undefined
      ? applyPluginVersionOverride({
          spec,
          attribution,
          retainedVersionIds: pluginVersionIds,
        })
      : undefined;
  // A client whose hidden environment is not composed yet has no spec to
  // resolve, so its preview reads the caller's skills: what that selection
  // resolves to once the turn composes it, up to the backend's cap.
  const pool =
    target.kind === "client" && !spec
      ? await readProjectSkills(runtime, { projectId, bearer, signal })
      : undefined;
  const dropped = new Set(narrowed?.droppedSkillIds);
  const skills = resolveTurnSkills({
    source: spec
      ? {
          kind: "environment",
          spec: narrowed?.spec ?? spec,
          attribution,
          pluginDisabled: (spec.skills ?? []).filter((skill) =>
            dropped.has(skill.skillId),
          ),
          ...(target.kind === "client" ? { liveExtras: {} } : {}),
        }
      : { kind: "live", projectSkills: pool ?? [] },
    runtime,
  });
  return previewOf(skills, rowsOf(spec, attribution, pool));
}

/**
 * Each of a suite's environments, as an eval run of it would deliver: the run
 * freezes the environment's skills at start and takes nothing live. An
 * environment the backend refuses to resolve is reported in its entry.
 */
export async function previewSuiteSkills(
  client: ConvexHttpClient,
  { projectId, environmentIds }: SuiteSkillsPreviewRequest,
): Promise<SuiteSkillsPreview> {
  const environments = await Promise.all(
    [...new Set(environmentIds)].map(async (environmentId) => {
      try {
        const spec = await resolveEnvironmentForRuntime(client, {
          projectId,
          environmentId,
        });
        const attribution = await attributionOf(client, projectId, spec);
        const skills = resolveTurnSkills({
          source: { kind: "environment", spec, attribution, frozen: true },
          runtime: turnRuntime(runtimeSelectors(spec.host.runtimeConfig)),
        });
        const preview = previewOf(skills, rowsOf(spec, attribution));
        return { environmentId, ok: true as const, preview };
      } catch (error) {
        // A refusal belongs to its environment; anything else fails the read.
        if (!(error instanceof WebRouteError) || error.status >= 500)
          throw error;
        const { status, message } = error;
        return {
          environmentId,
          ok: false as const,
          error: { status, message },
        };
      }
    }),
  );
  return { environments };
}

function attributionOf(
  client: ConvexHttpClient,
  projectId: string,
  spec: ResolvedEnvironmentRuntime,
): Promise<PluginRuntimeAttribution | null> {
  return fetchPluginRuntimeAttribution(client, {
    projectId,
    pluginVersionIds: (spec.pluginVersions ?? []).map((p) => p.pluginVersionId),
  });
}

/** The project's skills, read the way the turn's engine reads them. */
async function readProjectSkills(
  runtime: TurnRuntime,
  ctx: { projectId: string; bearer: string; signal?: AbortSignal },
): Promise<RuntimeStandaloneSkill[]> {
  if (runtime.kind === "agent") {
    return listCloudRuntimeSkills({
      projectId: ctx.projectId,
      authHeader: ctx.bearer,
      signal: ctx.signal,
    });
  }
  const skills = await convexListSkillsForRuntime(ctx.bearer, ctx.projectId);
  return skills.map((skill) => ({
    skillId: skill.skillId,
    ref: skill.name,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    aggregateHash: skill.aggregateHash,
    files: [],
    channels: [],
  }));
}

type Row = Omit<PaneSkillRow, "reason" | "omittedFromCatalog">;

/** One row per skill the turn's inputs name, in their order. */
function rowsOf(
  spec: ResolvedEnvironmentRuntime | undefined,
  attribution: PluginRuntimeAttribution | null,
  pool?: readonly RuntimeStandaloneSkill[],
): Row[] {
  const rows = new Map<string, Row>();
  const add = (row: Row) => {
    if (!rows.has(row.skillId)) rows.set(row.skillId, row);
  };
  for (const skill of spec?.skills ?? []) {
    const channels = skill.channels ?? [];
    // The resolved entry carries its revision only in its provenance row.
    const version = revision(skill.provenance?.projectSkillVersionNumber);
    add({
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      channels,
      origin: {
        kind:
          channels.includes("plugin") ||
          attribution?.skillOrigins.has(skill.skillId)
            ? "plugin"
            : "library",
      },
      ...(version
        ? {
            version: {
              number: version,
              pinned: skill.provenance?.versionPinned === true,
            },
          }
        : {}),
    });
  }
  for (const skill of spec?.serverSkills ?? []) {
    const version = revision(skill.versionNumber);
    add({
      skillId: skill.serverSkillId,
      name: skill.ref,
      description: skill.description,
      channels: ["mcp-server"],
      origin: { kind: "mcp-server", server: skill.serverLabel },
      ...(version ? { version: { number: version } } : {}),
    });
  }
  for (const skill of pool ?? []) {
    add({
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      channels: ["project"],
      origin: { kind: "library" },
    });
  }
  return [...rows.values()];
}

/** A revision number an older backend may leave out. */
function revision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function previewOf(skills: TurnSkills, rows: Row[]): PaneSkillsPreview {
  const verdicts = new Map<
    string,
    Pick<PaneSkillRow, "reason" | "omittedFromCatalog">
  >();
  for (const ref of skills.delivered) {
    verdicts.set(ref.skillId, {
      reason: null,
      ...(ref.omittedFromCatalog ? { omittedFromCatalog: true } : {}),
    });
  }
  for (const { ref, reason } of skills.excluded) {
    // No plan applies a cap, and the wire has no reason to show for one.
    if (reason !== "over-cap") verdicts.set(ref.skillId, { reason });
  }
  const shown = rows.flatMap((row) => {
    const verdict = verdicts.get(row.skillId);
    return verdict ? [{ ...row, ...verdict }] : [];
  });
  return {
    skills: shown,
    deliveredCount: shown.filter((row) => row.reason === null).length,
  };
}
