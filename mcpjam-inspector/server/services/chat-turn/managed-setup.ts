import { resolveHostedChatSetup } from "./resolve-hosted-chat-setup.js";
import {
  localHarnessIdOf,
  shouldUseLocalHarness,
} from "../../utils/harness/local/run-resources.js";
import {
  ensureLocalHarnessTarget,
  LOCAL_HARNESS_DISPLAY_NAMES,
} from "../../utils/harness/local/readiness.js";
import type { LocalHarnessExecutionTarget } from "../../utils/harness/local/local-turn.js";
import { apiSessionWriteAllowed } from "../../routes/web/api-session-write-guard";
import { BrowserSessionService } from "../browserd/session-service";
import { type Context } from "hono";
import { ranTurnSelection } from "../../utils/session-model-selection.js";
import type { ChatV2Request } from "@/shared/chat-v2";
import {
  decideTurnRail,
  resolveChatSelection,
  withSelectionRouting,
} from "../../utils/selection-rail.js";
import {
  listCloudRuntimeSkills,
  shouldEnableCloudSkillTools,
} from "../../utils/computers/cloud-skill-tools.js";
import { resolveHostModelDefinition } from "../../utils/org-model-config.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  parseChatReasoningEffort,
  resolveChatReasoningEffort,
} from "../../utils/chat-reasoning-effort.js";
import {
  checkAgentLoopGuard,
  refuseAgentLoop,
} from "../../utils/agent-loop-guard.js";
import { DEFAULT_TURN_MAX_STEPS } from "@/shared/turn-step-budget";
import {
  hostedChatSchema,
  authorizeProject,
  callerContextFromHono,
  parseWithSchema,
  ErrorCode,
  WebRouteError,
  extractMcpInitializeOptions,
} from "../../routes/web/auth.js";
import { createHostedRpcLogCollector } from "../../routes/web/hosted-rpc-logs.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import { isScenarioParticipant } from "../../utils/scenario-runtime-config.js";
import {
  applyHostConformanceKnobs,
  applyHostParamMirroring,
  parseXaaPolicyValue,
  conformanceKnobsFromMcpProfile,
  mirrorToolParamHeadersFromMcpProfile,
  xaaPolicyFromMcpProfile,
} from "../../utils/effective-auth.js";
import { type ExecutionScope } from "../../utils/execution-scope.js";
import {
  checkHarnessRuntimeAvailable,
  externalAccountHostModelRefusalReason,
  harnessUnavailableHttpStatus,
} from "../../utils/harness/harness-availability.js";
import { harnessUsesExternalAccount } from "../../utils/harness/registry.js";
import {
  LOCAL_HARNESS_GRANT_HEADER,
  parseHarnessExecutionTarget,
  type RawHarnessTargetInput,
} from "../../utils/harness/local/request-target.js";
import { harnessSupportsSkills } from "../../utils/harness/registry.js";
import { normalizeExecutionTarget } from "@/shared/execution-target";
import { createConvexClient } from "../evals/route-helpers.js";
import {
  runtimeServerIds,
  runtimeServerNames,
  runtimeSkills as environmentRuntimeSkills,
  turnSkillProvenance,
  type EnvironmentSkillDelivery,
} from "../environments/runtime.js";
import {
  buildLiveEffectiveCapabilities,
  pluginOriginByServerId,
  withLiveProjectSkills,
  type EffectiveCapabilitySet,
} from "../environments/effective-capabilities.js";
import { resolveExecutionContext } from "../../utils/host-execution-context.js";
import { resolveTurnBuiltInToolIds } from "../../utils/built-in-tools/built-in-tool-policy.js";
import { logger } from "../../utils/logger.js";
import { listLocalRuntimeSkills } from "../../utils/skill-tools.js";
import { readLocalBrowserSetting } from "../../utils/computers/local-browser-settings.js";
import { resolveLocalBrowserTools } from "../../../shared/local-browser-settings.js";

/** Resolve authorized setup before acquiring turn-owned resources. */
export async function resolveManagedTurnSetup(args: {
  c: Context;
  rawBody: Record<string, unknown>;
  bearerToken: string;
  localIngress: boolean;
  rpcCollector: ReturnType<typeof createHostedRpcLogCollector>;
}) {
  const { c, rawBody, bearerToken, localIngress, rpcCollector } = args;
  const hostedBody = parseWithSchema(hostedChatSchema, rawBody);
  if (!c.get("guestId") && hostedBody.projectId && hostedBody.chatSessionId) {
    const allowed = await apiSessionWriteAllowed(
      rawBody.origin,
      async (signal) => {
        const service = new BrowserSessionService();
        if (!service.enabled) return { writable: true };
        return service.agentRequest<{
          writable: boolean;
        }>("assert_web_writable", {
          bearer: bearerToken,
          projectId: hostedBody.projectId!,
          body: { conversationId: hostedBody.chatSessionId },
          signal: AbortSignal.any([signal, c.req.raw.signal]),
        });
      },
    );
    if (!allowed)
      return {
        response: c.json(
          {
            code: "API_SESSION_READ_ONLY",
            error:
              "This API session is view-only in Playground. Continue it through the session API.",
          },
          409,
        ),
      };
  }
  const { initializePins, mcpProtocolVersionsByServerId } =
    extractMcpInitializeOptions(rawBody);
  const body = rawBody as unknown as ChatV2Request & {
    projectId: string;
    selectedServerIds: string[];
    selectedServerNames?: string[];
    scenarioId?: string;
    accessVersion?: number;
    accessScope?: "project_member" | "chat_v2";
    surface?: "preview" | "share_link";
    hostId?: string;
    executionTarget?: unknown;
    environmentOverrides?: unknown;
  };
  const {
    messages,
    model,
    systemPrompt: bodySystemPrompt,
    temperature: bodyTemperature,
    requireToolApproval: bodyRequireToolApproval,
    respectToolVisibility: bodyRespectToolVisibility,
    selectedServerIds: requestedServerIds,
    selectedServerNames,
    scenarioId,
    accessVersion,
    surface,
    hostId,
  } = body;
  const selectedServerIds = requestedServerIds ?? [];
  const normalizedTarget = normalizeExecutionTarget({
    scenarioId,
    executionTarget: body.executionTarget,
    environmentOverrides: body.environmentOverrides,
    hostId,
    projectId: hostedBody.projectId,
  });
  if (!normalizedTarget.ok) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      normalizedTarget.error,
    );
  }
  const executionTarget = normalizedTarget.target;
  const isScenarioRequest = executionTarget.kind === "scenario";
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "messages are required",
    );
  }
  let modelDefinition = model;
  if (!modelDefinition || !String(modelDefinition.id ?? "").trim()) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "model is not supported",
    );
  }
  let chatEnvironmentsSupported = false;
  if (!isScenarioRequest) {
    const authorized = await authorizeProject(
      callerContextFromHono(c),
      bearerToken,
      hostedBody.projectId,
    );
    chatEnvironmentsSupported = authorized.chatEnvironments;
  }
  const {
    mode: turnMode,
    hostRuntimeConfig,
    environmentSpec,
    scenarioEnvironment,
    effectiveCapabilities: resolvedCapabilities,
    usesLiveSkills,
    authoritativeConnectionPolicy,
    pinsEnvironment,
    authoritativeCapabilities: isHostAuthoritative,
    toolConfiguration,
    toolConfigurationUnavailable,
    workspaceToolsBarred,
  } = await resolveHostedChatSetup({
    target: executionTarget,
    access:
      executionTarget.kind === "scenario"
        ? {
            kind: "scenario",
            scenarioId: executionTarget.scenarioId,
            accessVersion,
          }
        : {
            kind: "project",
            projectId: hostedBody.projectId,
            guest: Boolean(c.get("guestId")),
            chatEnvironments: chatEnvironmentsSupported,
          },
    projectId: hostedBody.projectId,
    selectedServerIds: requestedServerIds,
    bearer: bearerToken,
    signal: c.req.raw.signal,
    getClient: async () =>
      createConvexClient(await getConvexBearerForRequest(c)),
  });
  let effectiveCapabilities = resolvedCapabilities;
  if (effectiveCapabilities) {
    rpcCollector?.setPluginOriginByServerId(
      pluginOriginByServerId(effectiveCapabilities),
    );
  }
  const environmentServers = environmentSpec ?? scenarioEnvironment;
  const effectiveServerIds = environmentServers
    ? runtimeServerIds(environmentServers)
    : selectedServerIds;
  const environmentServerNameList = environmentServers
    ? runtimeServerNames(environmentServers)
    : undefined;
  const effectiveServerNames = environmentServers
    ? environmentServerNameList && environmentServerNameList.length > 0
      ? environmentServerNameList
      : undefined
    : selectedServerNames;
  const environmentSkills = environmentSpec
    ? environmentRuntimeSkills(environmentSpec)
    : scenarioEnvironment
      ? environmentRuntimeSkills({ skills: scenarioEnvironment.skills ?? [] })
      : undefined;
  const xaaPolicy =
    authoritativeConnectionPolicy && hostRuntimeConfig
      ? xaaPolicyFromMcpProfile(
          (
            hostRuntimeConfig as {
              mcpProfile?: unknown;
            }
          ).mcpProfile,
        )
      : parseXaaPolicyValue(rawBody.xaaPolicy);
  const effectiveInitializePins =
    authoritativeConnectionPolicy && hostRuntimeConfig
      ? applyHostConformanceKnobs(
          applyHostParamMirroring(
            initializePins,
            mirrorToolParamHeadersFromMcpProfile(
              (
                hostRuntimeConfig as {
                  mcpProfile?: unknown;
                }
              ).mcpProfile,
            ),
          ),
          conformanceKnobsFromMcpProfile(
            (
              hostRuntimeConfig as {
                mcpProfile?: unknown;
              }
            ).mcpProfile,
          ),
        )
      : initializePins;
  const resolvedExecution = resolveExecutionContext({
    hostConfig: hostRuntimeConfig,
    overrides: {
      systemPrompt: bodySystemPrompt,
      temperature: bodyTemperature,
      requireToolApproval: bodyRequireToolApproval,
      respectToolVisibility: bodyRespectToolVisibility,
      progressiveToolDiscovery: body.progressiveToolDiscovery,
      modelVisibleMcpToolResults: body.modelVisibleMcpToolResults,
      mcpToolResultImageRendering: body.mcpToolResultImageRendering,
      hostStyle:
        body.hostStyle ?? (turnMode === "interactive" ? "claude" : undefined),
      builtInToolIds: turnMode === "recorded" ? undefined : body.builtInToolIds,
    },
    precedence: turnMode === "recorded" ? "host-wins" : "override-wins",
  });
  const explicitContinuation =
    rawBody.mrtrResume !== undefined ||
    rawBody.scopeStepUpResume !== undefined ||
    rawBody.scopeStepUpCancel !== undefined;
  if (!resolvedExecution.harness && !explicitContinuation) {
    const loopVerdict = checkAgentLoopGuard({
      messages,
      maxSteps: DEFAULT_TURN_MAX_STEPS,
    });
    if (loopVerdict)
      return { response: refuseAgentLoop(c, loopVerdict, "chat_v2") };
  }
  const skillDeliveryMode: EnvironmentSkillDelivery = !resolvedExecution.harness
    ? "emulated"
    : harnessSupportsSkills(resolvedExecution.harness)
      ? "harness"
      : "unsupported";
  const turnProvenance = environmentSpec
    ? turnSkillProvenance(environmentSpec, { delivery: skillDeliveryMode })
    : scenarioEnvironment
      ? turnSkillProvenance(
          {
            environmentRef: scenarioEnvironment.environmentRef,
            skills: scenarioEnvironment.skills ?? [],
          },
          { delivery: skillDeliveryMode },
        )
      : undefined;
  for (const entry of resolvedExecution.drift) {
    if (entry.field === "requireToolApproval") {
      logger.warn(
        "[chat-v2] client requireToolApproval differs from host; using host value",
        {
          scenarioId,
          body: entry.overrideValue,
          host: entry.hostValue,
        },
      );
    } else if (entry.field === "progressiveToolDiscovery") {
      logger.warn(
        "[chat-v2] client progressiveToolDiscovery differs from host; using host value",
        {
          scenarioId,
          body: entry.overrideValue,
          host: entry.hostValue,
        },
      );
    } else if (entry.field === "respectToolVisibility") {
      logger.warn(
        "[chat-v2] client respectToolVisibility differs from host; using host value",
        {
          scenarioId,
          body: entry.overrideValue,
          host: entry.hostValue,
        },
      );
    } else if (
      entry.field === "modelVisibleMcpToolResults" ||
      entry.field === "mcpToolResultImageRendering"
    ) {
      logger.warn(
        `[chat-v2] client ${entry.field} differs from host; using host value`,
        {
          scenarioId,
          body: entry.overrideValue,
          host: entry.hostValue,
        },
      );
    }
  }
  const builtInToolPolicy = await resolveTurnBuiltInToolIds({
    requested: resolvedExecution.builtInToolIds,
    configuration: toolConfiguration,
    configurationUnavailable: toolConfigurationUnavailable,
    workspaceToolsBarred,
    requestedToolApproval: resolvedExecution.requireToolApproval,
    loadProjectAccess: async () =>
      (await createConvexClient(await getConvexBearerForRequest(c)).query(
        "projects:getProjectCapabilities" as never,
        { projectId: hostedBody.projectId } as never,
      )) as {
        projectRole?: string | null;
      } | null,
  });
  if (builtInToolPolicy.dropped.length > 0) {
    getRequestLogger(c, "routes.web.chat-v2").event(
      "chat.builtin_tools.withheld",
      {
        toolIds: builtInToolPolicy.dropped
          .filter((entry) => entry.reason !== "unknown")
          .map((entry) => entry.id),
        unknownCount: builtInToolPolicy.dropped.filter(
          (entry) => entry.reason === "unknown",
        ).length,
        reasons: [
          ...new Set(builtInToolPolicy.dropped.map((entry) => entry.reason)),
        ],
        targetKind: turnMode === "recorded" ? "scenario" : "environment",
      },
    );
  }
  let localBrowserSettingsUnavailable = false;
  let turnBuiltInToolIds = builtInToolPolicy.ids;
  if (
    localIngress &&
    turnMode === "interactive" &&
    rawBody.browserEngine === "local"
  ) {
    let enabled =
      typeof hostRuntimeConfig?.localBrowserEnabled === "boolean"
        ? hostRuntimeConfig.localBrowserEnabled
        : undefined;
    if (!hostRuntimeConfig && !c.get("guestId")) {
      try {
        enabled = await readLocalBrowserSetting(
          await getConvexBearerForRequest(c),
          hostedBody.projectId,
        );
      } catch (error) {
        localBrowserSettingsUnavailable = true;
        logger.warn("[chat-v2] local Browser settings unavailable", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    turnBuiltInToolIds = resolveLocalBrowserTools(
      builtInToolPolicy.ids,
      enabled,
      true,
    );
  }
  const externalAccountHarnessTurn = Boolean(
    resolvedExecution.harness &&
    harnessUsesExternalAccount(resolvedExecution.harness),
  );
  if (resolvedExecution.harness) {
    const hostModelRefusal = externalAccountHostModelRefusalReason({
      harnessId: resolvedExecution.harness,
      modelId: resolvedExecution.modelId ?? String(modelDefinition.id),
    });
    if (hostModelRefusal) {
      throw new WebRouteError(
        422,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        hostModelRefusal,
        {
          reason: "HARNESS_UNAVAILABLE",
          harness: resolvedExecution.harness,
          kind: "model-unsupported",
        },
      );
    }
  }
  if (
    (turnMode === "recorded" || externalAccountHarnessTurn) &&
    hostRuntimeConfig &&
    resolvedExecution.modelId &&
    resolvedExecution.modelId !== modelDefinition.id
  ) {
    const hostModelId = resolvedExecution.modelId;
    const hostModel = await resolveHostModelDefinition({
      modelId: hostModelId,
      projectId: hostedBody.projectId ?? null,
      auth: { bearerToken, scenarioId },
    });
    logger.warn("[chat-v2] client model differs from host; using host model", {
      scenarioId,
      body: modelDefinition.id,
      host: hostModelId,
      provider: hostModel.provider,
      externalAccountHarness: externalAccountHarnessTurn,
    });
    modelDefinition = hostModel;
  }
  const selected = resolveChatSelection({
    raw: rawBody.modelSelection,
    inherited: resolvedExecution.routingSelection,
    inheritedOrigin: resolvedExecution.modelSelectionOrigin,
    model: modelDefinition,
    hostWins: turnMode === "recorded",
    allowLocal: localIngress,
  });
  if (!selected.ok) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, selected.error);
  }
  let routingSelection = selected.selection;
  const selectedTemperature =
    routingSelection?.source === "legacy"
      ? undefined
      : routingSelection?.settings?.temperature;
  const temperature =
    (selected.requestSelection ? body.temperature : undefined) ??
    selectedTemperature ??
    resolvedExecution.temperature;
  modelDefinition = withSelectionRouting(modelDefinition, routingSelection);
  const turnRail = decideTurnRail({
    selection: routingSelection,
    model: modelDefinition,
  });
  const systemPrompt = resolvedExecution.systemPrompt;
  const bodyEffort = parseChatReasoningEffort(body.reasoningEffort);
  if (!bodyEffort.ok) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, bodyEffort.error);
  }
  const reasoningEffort = resolveChatReasoningEffort({
    bodyEffort: bodyEffort.effort,
    hostSelection:
      routingSelection?.source === "legacy" ? undefined : routingSelection,
    requestSelection: selected.requestSelection,
    hostWins: turnMode === "recorded",
  });
  if (routingSelection) {
    routingSelection = ranTurnSelection({
      selection: routingSelection,
      model: modelDefinition,
      reasoningEffort,
      ...(reasoningEffort === undefined ? { temperature } : {}),
    });
  }
  const requireToolApproval = resolvedExecution.requireToolApproval;
  const respectToolVisibility = resolvedExecution.respectToolVisibility;
  const resolvedProgressiveToolDiscovery =
    resolvedExecution.progressiveToolDiscovery;
  const { modelVisibleMcpToolResults, mcpToolResultImageRendering } =
    resolvedExecution.hostPolicy;
  let harnessExecutionTarget: LocalHarnessExecutionTarget | undefined;
  if (
    (await shouldUseLocalHarness(
      resolvedExecution.harness,
      bearerToken,
      hostedBody.projectId,
    )) &&
    !c.get("guestId") &&
    turnMode === "interactive"
  ) {
    const localHarnessId =
      localHarnessIdOf(resolvedExecution.harness) ?? "claude-code";
    const localHarnessName = LOCAL_HARNESS_DISPLAY_NAMES[localHarnessId];
    if (!hostedBody.projectId)
      return {
        response: c.json(
          { error: `A project is required for local ${localHarnessName}` },
          400,
        ),
      };
    try {
      harnessExecutionTarget = (
        await ensureLocalHarnessTarget({
          bearer: bearerToken,
          projectId: hostedBody.projectId,
          scope: "attended",
          harnessId: localHarnessId,
        })
      ).target;
    } catch (error) {
      return {
        response: c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : `${localHarnessName} is not ready`,
          },
          409,
        ),
      };
    }
  } else {
    const parsed = parseHarnessExecutionTarget({
      body: body as {
        harnessTarget?: RawHarnessTargetInput;
      },
      grantTokenHeader: c.req.header(LOCAL_HARNESS_GRANT_HEADER),
      serverEnabled: false,
      actorEligible: false,
      actingUserId: null,
    });
    if (parsed.kind === "refused")
      return { response: c.json({ error: parsed.reason }, 400) };
  }
  if (resolvedExecution.harness) {
    const availability = checkHarnessRuntimeAvailable({
      harnessId: resolvedExecution.harness,
      localExecution: Boolean(harnessExecutionTarget),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      requireToolApproval,
      hasSelectedMcpServers: environmentServers
        ? effectiveServerIds.length > 0
        : (resolvedExecution.selectedServerIds ?? selectedServerIds).length > 0,
      model: {
        id: String(modelDefinition.id),
        provider: modelDefinition.provider,
        hosted: modelDefinition.hosted,
      },
      ...(routingSelection ? { selection: routingSelection } : {}),
      ...(resolvedExecution.modelId
        ? { hostModelId: resolvedExecution.modelId }
        : {}),
      xaaEnterprisePolicyOn: xaaPolicy != null,
      purpose: turnMode === "recorded" ? "eval" : "chat",
    });
    if (availability.ok && availability.warning) {
      getRequestLogger(c, "routes.web.chat-v2").event(
        "chat.harness_model_unverified",
        {
          harness: resolvedExecution.harness,
          modelId: String(modelDefinition.id),
          reason: availability.warning,
        },
      );
    }
    if (!availability.ok) {
      const status = harnessUnavailableHttpStatus(availability.kind);
      throw new WebRouteError(
        status,
        status === 503
          ? ErrorCode.INTERNAL_ERROR
          : ErrorCode.FEATURE_NOT_SUPPORTED,
        availability.reason,
        {
          reason: "HARNESS_UNAVAILABLE",
          harness: resolvedExecution.harness,
          kind: availability.kind,
        },
      );
    }
  }
  const executionScope = (
    hostRuntimeConfig as
      | {
          executionScope?: ExecutionScope;
        }
      | null
      | undefined
  )?.executionScope;
  const scenarioParticipant =
    turnMode === "recorded" && isScenarioParticipant(hostRuntimeConfig);
  const rawComputerWorkdir = (
    hostRuntimeConfig as
      | {
          computer?: {
            workdir?: unknown;
          };
        }
      | undefined
  )?.computer?.workdir;
  const harnessComputerWorkdir =
    typeof rawComputerWorkdir === "string" ? rawComputerWorkdir : undefined;
  const requestedProjectSkills =
    turnMode === "interactive" &&
    (usesLiveSkills ||
      (rawBody as Record<string, unknown>).includeProjectSkills === true);
  const includeProjectSkills =
    requestedProjectSkills && environmentSpec?.environmentOrigin === "adhoc";
  if (requestedProjectSkills && !includeProjectSkills) {
    logger.warn(
      "[chat-v2] includeProjectSkills ignored: not an ad-hoc environment",
      {
        environmentId: environmentSpec?.environmentRef.environmentId ?? null,
        projectId: hostedBody.projectId ?? null,
        environmentOrigin: environmentSpec?.environmentOrigin ?? null,
      },
    );
  }
  const cloudSkillsEnabled =
    (!environmentServers || includeProjectSkills) &&
    shouldEnableCloudSkillTools({
      isGuest: Boolean(c.get("guestId")),
      harness: resolvedExecution.harness,
      modelId: String(modelDefinition.id),
      provider: modelDefinition.provider,
      hosted: modelDefinition.hosted,
      ...(routingSelection ? { selection: routingSelection } : {}),
      hasProjectId: Boolean(hostedBody.projectId),
    });
  let liveProjectCapabilities: EffectiveCapabilitySet | undefined;
  let projectSkillReadFailed = false;
  if (cloudSkillsEnabled && hostedBody.projectId) {
    try {
      liveProjectCapabilities = buildLiveEffectiveCapabilities({
        standaloneSkills: await listCloudRuntimeSkills({
          authHeader: `Bearer ${bearerToken}`,
          projectId: hostedBody.projectId,
        }),
      });
    } catch (error) {
      projectSkillReadFailed = true;
      logger.warn(
        "[chat-v2] project skill catalog fetch failed; turn proceeds without them",
        {
          projectId: hostedBody.projectId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  if (
    localIngress &&
    !resolvedExecution.harness &&
    (usesLiveSkills || includeProjectSkills)
  ) {
    const localSkills = await listLocalRuntimeSkills().catch((error) => {
      logger.warn("[chat-v2] local skill scan failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
    const localCapabilities = buildLiveEffectiveCapabilities({ localSkills });
    liveProjectCapabilities = liveProjectCapabilities
      ? withLiveProjectSkills(liveProjectCapabilities, localCapabilities)
      : localCapabilities;
  }
  return {
    value: {
      hostedBody,
      initializePins,
      mcpProtocolVersionsByServerId,
      body,
      messages,
      model,
      bodyTemperature,
      selectedServerIds,
      selectedServerNames,
      scenarioId,
      accessVersion,
      surface,
      hostId,
      executionTarget,
      modelDefinition,
      turnMode,
      hostRuntimeConfig,
      environmentSpec,
      scenarioEnvironment,
      authoritativeConnectionPolicy,
      pinsEnvironment,
      isHostAuthoritative,
      effectiveCapabilities,
      environmentServers,
      effectiveServerIds,
      effectiveServerNames,
      environmentSkills,
      xaaPolicy,
      effectiveInitializePins,
      resolvedExecution,
      turnProvenance,
      builtInToolPolicy,
      turnBuiltInToolIds,
      localBrowserSettingsUnavailable,
      externalAccountHarnessTurn,
      selected,
      routingSelection,
      temperature,
      turnRail,
      systemPrompt,
      bodyEffort,
      reasoningEffort,
      requireToolApproval,
      respectToolVisibility,
      resolvedProgressiveToolDiscovery,
      modelVisibleMcpToolResults,
      mcpToolResultImageRendering,
      harnessExecutionTarget,
      executionScope,
      scenarioParticipant,
      harnessComputerWorkdir,
      includeProjectSkills,
      liveProjectCapabilities,
      projectSkillReadFailed,
    },
  };
}
