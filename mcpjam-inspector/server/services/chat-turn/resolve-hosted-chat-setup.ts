import type { ConvexHttpClient } from "convex/browser";
import type { InternalExecutionTarget } from "../../../shared/execution-target.js";
import { resolveChatTurn } from "./resolve-chat-turn.js";
import {
  fetchScenarioRuntimeConfig,
  readScenarioEnvironment,
  type ScenarioEnvironmentRuntime,
} from "../../utils/scenario-runtime-config.js";
import { makeFunctionReference } from "convex/server";
import type { ProjectDefaultToolConfig } from "../../utils/built-in-tools/built-in-tool-policy.js";
import { canProvisionHarnessBoxes } from "../../utils/harness/harness-box.js";
import {
  fetchPluginRuntimeAttribution,
  type PluginRuntimeAttribution,
} from "../environments/plugin-attribution.js";
import { resolveEffectiveCapabilities } from "../environments/effective-capabilities.js";
import {
  applyPluginVersionOverride,
  withoutGuestPlugins,
} from "../environments/plugin-override.js";
import type { ResolvedEnvironmentRuntime } from "../environments/runtime.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { logger } from "../../utils/logger.js";

type Access =
  | {
      kind: "project";
      projectId: string;
      guest: boolean;
      chatEnvironments: boolean;
    }
  | { kind: "scenario"; scenarioId: string; accessVersion?: number };

/** Normalize authorized ingress variants before the shared execution pipeline. */
export async function resolveHostedChatSetup(args: {
  target: InternalExecutionTarget;
  access: Access;
  projectId: string;
  selectedServerIds?: string[];
  bearer: string;
  signal?: AbortSignal;
  getClient: () => Promise<ConvexHttpClient>;
}) {
  const { target, access } = args;
  if (
    (target.kind === "scenario") !== (access.kind === "scenario") ||
    (target.kind === "adhoc" && target.projectId !== args.projectId) ||
    (target.kind === "scenario" &&
      access.kind === "scenario" &&
      target.scenarioId !== access.scenarioId) ||
    (access.kind === "project" && access.projectId !== args.projectId)
  ) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "The target does not match this turn's access.",
    );
  }
  let hostRuntimeConfig: Record<string, unknown> | null = null;
  let environmentSpec: ResolvedEnvironmentRuntime | null = null;
  let scenarioEnvironment: ScenarioEnvironmentRuntime | null = null;
  let attribution: PluginRuntimeAttribution | null = null;
  if (access.kind === "scenario") {
    // Keep the scenario's grant and accessVersion resolver. Testers are not
    // project members and must never be sent through member composition.
    const runtime = await fetchScenarioRuntimeConfig({
      scenarioId: access.scenarioId,
      accessVersion: access.accessVersion,
      bearer: args.bearer,
      harnessBox: canProvisionHarnessBoxes(),
    });
    if (!runtime.ok) {
      logger.warn("[chat-v2] runtime-config fetch failed; failing closed", {
        scenarioId: access.scenarioId,
        status: runtime.status,
        error: runtime.error,
      });
      const message = `Couldn't load this scenario's settings, so the turn was stopped to avoid running with the wrong configuration. ${runtime.error}`;
      if (runtime.code === "SCENARIO_SIGN_IN_REQUIRED") {
        throw new WebRouteError(401, ErrorCode.UNAUTHORIZED, runtime.error, {
          code: runtime.code,
        });
      }
      if (runtime.code === "SCENARIO_ACCESS_STALE") {
        throw new WebRouteError(409, ErrorCode.SCENARIO_ACCESS_STALE, message);
      }
      throw new WebRouteError(
        runtime.status >= 500 ? 502 : runtime.status,
        runtime.status === 403
          ? ErrorCode.SCENARIO_ACCESS_DENIED
          : ErrorCode.INTERNAL_ERROR,
        message,
      );
    }
    const read = readScenarioEnvironment(runtime.config);
    if (read.kind === "invalid") {
      logger.warn(
        "[chat-v2] scenario environment payload malformed; failing closed",
        {
          scenarioId: access.scenarioId,
          detail: read.detail,
        },
      );
      throw new WebRouteError(
        502,
        ErrorCode.INTERNAL_ERROR,
        "Couldn't load this scenario's environment, so the turn was stopped to avoid running with the wrong configuration.",
      );
    }
    hostRuntimeConfig = { ...runtime.config };
    if (read.kind === "present") {
      scenarioEnvironment = read.environment;
      const pluginVersionIds = (scenarioEnvironment.pluginVersions ?? []).map(
        (p) => p.pluginVersionId,
      );
      if (pluginVersionIds.length) {
        try {
          attribution = await fetchPluginRuntimeAttribution(
            await args.getClient(),
            {
              projectId: args.projectId,
              pluginVersionIds,
            },
          );
        } catch (error) {
          // Client construction can fail on deployments without Convex; origin
          // reporting is optional after the scenario has authorized its setup.
          logger.warn(
            "[chat-v2] scenario attribution unavailable; running without plugin origin",
            {
              scenarioId: access.scenarioId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }
  } else {
    if (!access.chatEnvironments)
      throw new WebRouteError(
        422,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        "Chat requires a backend with saved setup support. Upgrade the backend before sending messages.",
      );
    if (target.kind === "scenario")
      throw new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        "Scenario access is required.",
      );
    const client = await args.getClient();
    const turn = await resolveChatTurn({
      target,
      access: { kind: "project", projectId: access.projectId },
      client,
      selection:
        target.kind === "environment"
          ? target.overrides?.serverIds !== undefined
            ? { kind: "explicit", serverIds: target.overrides.serverIds }
            : { kind: "environment-default" }
          : { kind: "explicit", serverIds: args.selectedServerIds ?? [] },
      bearer: args.bearer,
      signal: args.signal,
    });
    environmentSpec = access.guest
      ? withoutGuestPlugins(turn.environment)
      : turn.environment;
    hostRuntimeConfig = environmentSpec.host.runtimeConfig;
    attribution = access.guest
      ? null
      : await fetchPluginRuntimeAttribution(client, {
          projectId: access.projectId,
          pluginVersionIds: (environmentSpec.pluginVersions ?? []).map(
            (p) => p.pluginVersionId,
          ),
        });
    const retainedVersionIds =
      !access.guest && target.kind === "environment"
        ? target.overrides?.pluginVersionIds
        : undefined;
    if (retainedVersionIds !== undefined) {
      const narrowed = applyPluginVersionOverride({
        spec: environmentSpec,
        attribution,
        retainedVersionIds,
      });
      environmentSpec = narrowed.spec;
      if (narrowed.droppedVersionIds.length)
        logger.info("[chat-v2] playground plugin override applied", {
          environmentId: environmentSpec.environmentRef.environmentId,
          droppedVersionIds: narrowed.droppedVersionIds,
          droppedServerCount: narrowed.droppedServerIds.length,
          droppedSkillCount: narrowed.droppedSkillIds.length,
        });
    }
  }
  const environment = environmentSpec ?? scenarioEnvironment;
  const effectiveCapabilities = environment
    ? resolveEffectiveCapabilities(environment, attribution)
    : null;
  if (effectiveCapabilities?.problems.length)
    logger.warn("[chat-v2] effective capability problems", {
      environmentId: environment?.environmentRef.environmentId,
      codes: effectiveCapabilities.problems.map((p) => p.code),
      skillIds: effectiveCapabilities.problems.flatMap((p) =>
        "skillId" in p ? [p.skillId] : [],
      ),
    });
  // Plain chat uses the project's live skill pool and default tool bounds.
  // An explicit environment retains its own selections, even when it is ad hoc.
  const usesLiveSkills = target.kind !== "environment";
  let toolConfiguration: ProjectDefaultToolConfig | null = null;
  let toolConfigurationUnavailable = false;
  if (target.kind === "adhoc" && access.kind === "project" && !access.guest) {
    try {
      const projectDefault = await (
        await args.getClient()
      ).query(
        makeFunctionReference<
          "query",
          { projectId: string },
          ProjectDefaultToolConfig | null
        >("hostConfigsV2:getProjectDefault"),
        { projectId: access.projectId },
      );
      toolConfiguration = projectDefault
        ? {
            ...projectDefault,
            builtInToolIds: projectDefault.builtInToolIds ?? [],
          }
        : null;
    } catch (error) {
      // An unreadable default must never establish access to workspace tools.
      toolConfigurationUnavailable = true;
      logger.warn("[chat-v2] project tool configuration unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (target.kind === "host" || target.kind === "environment") {
    toolConfiguration = {
      builtInToolIds: hostRuntimeConfig?.builtInToolIds ?? [],
      requireToolApproval: hostRuntimeConfig?.requireToolApproval,
    };
  } else if (access.kind === "scenario") {
    toolConfiguration = {
      requireToolApproval: hostRuntimeConfig?.requireToolApproval,
    };
  }
  return {
    mode:
      access.kind === "scenario"
        ? ("recorded" as const)
        : ("interactive" as const),
    usesLiveSkills,
    authoritativeConnectionPolicy: target.kind !== "adhoc",
    pinsEnvironment: target.kind === "environment",
    authoritativeCapabilities:
      target.kind === "environment" || access.kind === "scenario",
    toolConfiguration,
    toolConfigurationUnavailable,
    workspaceToolsBarred: access.kind === "scenario" || access.guest,
    hostRuntimeConfig,
    environmentSpec,
    scenarioEnvironment,
    effectiveCapabilities,
  };
}
