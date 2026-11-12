import { resolveAgentLoop } from "../../utils/harness/agent-loop-dispatch";
import { authorizeManagedProject } from "./turn-authorization.js";
import { resolveHostedChatSetup } from "./resolve-hosted-chat-setup.js";
import { buildHostConnectionPins } from "../host-connection-pins.js";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import {
  localHarnessIdOf,
  shouldUseLocalHarness,
} from "../../utils/harness/local/run-resources.js";
import {
  ensureLocalHarnessTarget,
  LOCAL_HARNESS_DISPLAY_NAMES,
  LocalAutoApproveConsentRequiredError,
} from "../../utils/harness/local/readiness.js";
import type { LocalHarnessExecutionTarget } from "../../utils/harness/local/local-turn.js";
import { readWebConversationState } from "../../routes/web/web-conversation-state.js";
import { enforceNativeDiscoverySessionPin } from "../../utils/harness/native-discovery.js";
import { BrowserSessionService } from "../browserd/session-service";
import { type Context } from "hono";
import { ranTurnSelection } from "../../utils/session-model-selection.js";
import type { ChatV2Request } from "@/shared/chat-v2";
import {
  decideTurnRail,
  resolveChatSelection,
  withSelectionRouting,
} from "../../utils/selection-rail.js";
import { resolveHostModelDefinition } from "../../utils/org-model-config.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  parseChatReasoningEffort,
  resolveChatReasoningEffort,
} from "../../utils/chat-reasoning-effort.js";
import { checkAgentLoopGuard, refuseAgentLoop } from "../../utils/agent-loop-guard.js";
import { DEFAULT_TURN_MAX_STEPS } from "@/shared/turn-step-budget";
import {
  hostedChatSchema,
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
import { orgKeyHarnessSurfaceError } from "../../utils/harness/org-key-surfaces.js";
import {
  LOCAL_HARNESS_GRANT_HEADER,
  parseHarnessExecutionTarget,
  type RawHarnessTargetInput,
} from "../../utils/harness/local/request-target.js";
import { normalizeExecutionTarget } from "@/shared/execution-target";
import { createConvexClient } from "../evals/route-helpers.js";
import {
  runtimeServerIds,
  runtimeServerNames,
} from "../environments/runtime.js";
import { pluginOriginByServerId } from "../environments/effective-capabilities.js";
import {
  environmentTurnSkills,
  studyLibraryTurnSkills,
} from "../environments/live-turn-skills.js";
import { resolveTurnSkills, turnRuntime } from "../environments/turn-skills.js";
import { resolveExecutionContext } from "../../utils/host-execution-context.js";
import { HOSTED_APP_HANDLERS, qualifyHarnessHostCapabilities } from "../../../shared/harness-host-capabilities.js";
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
  const {
    initializePins,
    mcpProtocolVersionsByServerId: requestedProtocolPins,
  } = extractMcpInitializeOptions(rawBody);
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
  const authorized = isScenarioRequest
    ? undefined
    : await authorizeManagedProject(c, bearerToken, {
        projectId: hostedBody.projectId,
        chatSessionId: hostedBody.chatSessionId,
        target: executionTarget,
        serverIds: selectedServerIds,
      });
  const {
    mode: turnMode,
    hostRuntimeConfig,
    environmentSpec,
    scenarioEnvironment,
    effectiveCapabilities: resolvedCapabilities,
    clientTurn,
    attribution,
    pluginDisabled,
    authoritativeConnectionPolicy,
    pinsEnvironment,
    authoritativeCapabilities: isHostAuthoritative,
    toolConfiguration,
    toolConfigurationUnavailable,
    workspaceToolsBarred,
  } = await resolveHostedChatSetup({
    prepareChatTurn: authorized?.chatPreparation,
    preparedChatTurn: authorized?.preparedChatTurn,
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
            chatEnvironments: authorized?.chatEnvironments ?? false,
          },
    projectId: hostedBody.projectId,
    selectedServerIds: requestedServerIds,
    bearer: bearerToken,
    signal: c.req.raw.signal,
    getClient: async () =>
      createConvexClient(await getConvexBearerForRequest(c), c.req.raw.signal),
    hiddenEnvironment: rawBody.includeProjectSkills === true,
  });
  let requiredNativeDiscoveryPin = false;
  if (turnMode === "interactive" && !c.get("guestId") && hostedBody.projectId && hostedBody.chatSessionId) {
    const service = new BrowserSessionService();
    if (service.enabled) {
      const state = authorized?.conversationState ?? await readWebConversationState(
        (signal) =>
          service.agentRequest<{
            writable: boolean;
            requireNativeToolDiscovery?: boolean;
          }>("assert_web_writable", {
            bearer: bearerToken,
            projectId: hostedBody.projectId,
            body: { conversationId: hostedBody.chatSessionId },
            signal,
          }),
        c.req.raw.signal,
      );
      requiredNativeDiscoveryPin = state.requireNativeToolDiscovery === true;
      if (!state.writable) {
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
    }
  }
  enforceNativeDiscoverySessionPin(hostRuntimeConfig, requiredNativeDiscoveryPin);
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
  const hostPins =
    authoritativeConnectionPolicy && hostRuntimeConfig
      ? buildHostConnectionPins(hostRuntimeConfig, WEB_STREAM_TIMEOUT_MS)
      : undefined;
  const mcpProtocolVersionsByServerId = hostPins
    ? hostPins.mcpProtocolVersionsByServerId
    : requestedProtocolPins;
  const xaaPolicy =
    authoritativeConnectionPolicy && hostRuntimeConfig
      ? xaaPolicyFromMcpProfile(hostRuntimeConfig.mcpProfile)
      : parseXaaPolicyValue(rawBody.xaaPolicy);
  const effectiveInitializePins =
    authoritativeConnectionPolicy && hostRuntimeConfig
      ? applyHostConformanceKnobs(
          applyHostParamMirroring<NonNullable<typeof initializePins>>(
            hostPins?.initializePins,
            mirrorToolParamHeadersFromMcpProfile(hostRuntimeConfig.mcpProfile),
          ),
          conformanceKnobsFromMcpProfile(hostRuntimeConfig.mcpProfile),
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
      authorized?.projectAccess ??
      ((await createConvexClient(await getConvexBearerForRequest(c)).query(
        "projects:getProjectCapabilities" as never,
        { projectId: hostedBody.projectId } as never,
      )) as {
        projectRole?: string | null;
      } | null),
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
    // User Testing boxes never receive the org's vendor key: refused first.
    if (externalAccountHarnessTurn && turnMode === "recorded") {
      throw orgKeyHarnessSurfaceError(resolvedExecution.harness, "study");
    }
    const hostModelRefusal = externalAccountHostModelRefusalReason({
      harnessId: resolvedExecution.harness,
      modelId: resolvedExecution.modelId ?? String(modelDefinition.id),
      requestedModelId: String(modelDefinition.id),
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
    turnMode === "recorded" &&
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
    harnessId: resolvedExecution.harness,
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
          requireToolApproval,
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
            // The client opens its consent prompt on this status.
            ...(error instanceof LocalAutoApproveConsentRequiredError
              ? { status: error.status }
              : {}),
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
      mcpClient: resolveAgentLoop(hostRuntimeConfig ?? { harness: resolvedExecution.harness }).mcpClient,
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
  // One skill plan for this turn's engine, from the environment the turn
  // resolved. A client's turn in the local app hands MCPJam's agent this
  // machine's skills too; a study whose scenario predates environments reads
  // its shared Library. Every project turn resolves an environment; a turn
  // with neither still gets its connected servers' own skills.
  const runtime = turnRuntime({ harness: resolvedExecution.harness });
  const environment = environmentSpec ?? scenarioEnvironment;
  const turnSkills = environment
    ? environmentTurnSkills({
        spec: environment,
        attribution,
        pluginDisabled,
        ...(clientTurn
          ? {
              liveExtras: {
                localSkills:
                  localIngress && !resolvedExecution.harness
                    ? await listLocalRuntimeSkills().catch((error) => {
                        logger.warn("[chat-v2] local skill scan failed", {
                          error:
                            error instanceof Error
                              ? error.message
                              : String(error),
                        });
                        return [];
                      })
                    : [],
              },
            }
          : {}),
        runtime,
        modelContextTokens: modelDefinition.contextLength,
      })
    : turnMode === "recorded"
      ? await studyLibraryTurnSkills({
          bearer: bearerToken,
          projectId: hostedBody.projectId,
          ...(executionScope ? { executionScope } : {}),
          runtime,
          modelContextTokens: modelDefinition.contextLength,
        })
      : {
          skills: resolveTurnSkills({
            source: { kind: "live", projectSkills: [] },
            runtime,
            modelContextTokens: modelDefinition.contextLength,
          }),
          live: true,
        };
  return {
    value: {
      authorizedOrganizationId: authorized?.organizationId,
      // Only the backend's own answer for this turn's conversation counts; the
      // `assert_web_writable` fallback and older backends never say bound.
      executionBound: authorized?.conversationState?.executionBound === true,
      harnessHostCapabilities:
        resolvedExecution.harness && hostRuntimeConfig
          ? qualifyHarnessHostCapabilities(hostRuntimeConfig, HOSTED_APP_HANDLERS)
          : undefined,
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
      xaaPolicy,
      effectiveInitializePins,
      resolvedExecution,
      turnSkills,
      clientTurn,
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
    },
  };
}
