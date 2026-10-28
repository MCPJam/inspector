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
  type EffectiveCapabilitySet,
} from "../environments/effective-capabilities.js";
import { resolveExecutionContext } from "../../utils/host-execution-context.js";
import { resolveTurnBuiltInToolIds } from "../../utils/built-in-tools/built-in-tool-policy.js";
import { logger } from "../../utils/logger.js";
export async function resolveManagedTurnSetup(args: {
  c: Context;
  rawBody: Record<string, unknown>;
  bearerToken: string;
  rpcCollector: ReturnType<typeof createHostedRpcLogCollector>;
}) {
  const { c, rawBody, bearerToken, rpcCollector } = args;
  const hostedBody = parseWithSchema(hostedChatSchema, rawBody);
  if (!c.get("guestId") && hostedBody.projectId && hostedBody.chatSessionId) {
    const allowed = await apiSessionWriteAllowed(
      rawBody.origin,
      async (signal) => {
        const service = new BrowserSessionService();
        if (!service.enabled) return { writable: true };
        return service.agentRequest<{ writable: boolean }>(
          "assert_web_writable",
          {
            bearer: bearerToken,
            projectId: hostedBody.projectId!,
            body: { conversationId: hostedBody.chatSessionId },
            signal: AbortSignal.any([signal, c.req.raw.signal]),
          },
        );
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
    // Clients call /api/web/scenarios/redeem on mount and pass the
    // resolved `scenarioId` + `accessVersion` on every scenario-aware
    scenarioId?: string;
    accessVersion?: number;
    accessScope?: "project_member" | "chat_v2";
    surface?: "preview" | "share_link";
    // Saved host being previewed (Playground / host-bound direct chat). When
    // present and NOT a scenario session, the server re-fetches the host's
    hostId?: string;
    // Phase 1.1 execution target. Normalized (together with the legacy
    // `hostId` and the access-bearing `scenarioId`) into one closed internal
    // union below; ambiguous combinations are rejected, never shadowed.
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
    selectedServerIds,
    selectedServerNames,
    scenarioId,
    accessVersion,
    surface,
    hostId,
  } = body;
  // ONE closed execution target, resolved at ingress. `scenarioId` + an
  // explicit `executionTarget` (and `hostId` + `executionTarget`) are
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
  // True when this turn flows through a scenario surface. sourceType +
  // accessScope decisions hinge on this.
  const isScenarioRequest = executionTarget.kind === "scenario";
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "messages are required",
    );
  }

  let modelDefinition = model;
  // The ID, not just the object. `model` arrives through an unvalidated body
  // cast (`hostedChatSchema` does not describe it), and `ModelDefinition.id`
  if (!modelDefinition || !String(modelDefinition.id ?? "").trim()) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "model is not supported",
    );
  }

  // The caller's `projectId` is checked here, before anything is resolved or
  // billed against it (MJ-013). The server batch below applies the same
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
    selectedServerIds,
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

  // ── The turn's effective server set ─────────────────────────────────────
  // For an environment target — or an environment-backed scenario turn — this
  const environmentServers = environmentSpec ?? scenarioEnvironment;
  const effectiveServerIds = environmentServers
    ? runtimeServerIds(environmentServers)
    : selectedServerIds;
  // Names stay index-aligned with the ids. An empty array (older backend
  // without the name-carrying projection) makes `buildServerNamesById` return
  const environmentServerNameList = environmentServers
    ? runtimeServerNames(environmentServers)
    : undefined;
  const effectiveServerNames = environmentServers
    ? environmentServerNameList && environmentServerNameList.length > 0
      ? environmentServerNameList
      : undefined
    : selectedServerNames;
  // The environment's composed skill union, in the shape both engines
  // consume. Presence — not length — is what makes it authoritative, so an
  const environmentSkills = environmentSpec
    ? environmentRuntimeSkills(environmentSpec)
    : scenarioEnvironment
      ? environmentRuntimeSkills({ skills: scenarioEnvironment.skills ?? [] })
      : undefined;

  // Enterprise-managed authorization policy. Server-authoritative wherever
  // a backend host config exists (scenario / host-bound turns above — the
  const xaaPolicy =
    authoritativeConnectionPolicy && hostRuntimeConfig
      ? xaaPolicyFromMcpProfile(
          (hostRuntimeConfig as { mcpProfile?: unknown }).mcpProfile,
        )
      : parseXaaPolicyValue(rawBody.xaaPolicy);

  // SEP-2243 mirroring, resolved the same way and for the same reason: a
  // scenario turn carries no pins in the body (the client never sends the
  const effectiveInitializePins =
    authoritativeConnectionPolicy && hostRuntimeConfig
      ? applyHostConformanceKnobs(
          applyHostParamMirroring(
            initializePins,
            mirrorToolParamHeadersFromMcpProfile(
              (hostRuntimeConfig as { mcpProfile?: unknown }).mcpProfile,
            ),
          ),
          conformanceKnobsFromMcpProfile(
            (hostRuntimeConfig as { mcpProfile?: unknown }).mcpProfile,
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
    // Scenario: the published host wins (a share-link client can't override).
    // Host preview (Playground): the owner's in-session tweaks win, while
    precedence: turnMode === "recorded" ? "host-wins" : "override-wins",
  });

  // A continuation whose step budget is already spent is refused here,
  // before any MCP server is connected (see `utils/agent-loop-guard.ts`).
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

  // What this turn will RECORD about the configuration it ran with. Computed
  // from the POST-narrowing spec (plugin overrides filtered `environmentSpec`
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
  // WHICH BUILT-IN TOOLS THIS TURN MAY HAVE (MJ-008). The body's list is
  // bounded by the host/project configuration, unknown ids are dropped, and
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
      )) as { projectRole?: string | null } | null,
  });
  if (builtInToolPolicy.dropped.length > 0) {
    getRequestLogger(c, "routes.web.chat-v2").event(
      "chat.builtin_tools.withheld",
      {
        // Catalog ids only. An unknown id is whatever the body said, so it
        // is counted and never echoed.
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
  const turnBuiltInToolIds = builtInToolPolicy.ids;
  // `modelId` stays a special case — the resolver yields the resolved
  // string, and `resolveHostModelDefinition` lifts it (catalog hit →
  const externalAccountHarnessTurn = Boolean(
    resolvedExecution.harness &&
    harnessUsesExternalAccount(resolvedExecution.harness),
  );
  // FAIL FAST on a mis-configured external-account host, BEFORE the promotion
  // below resolves anything. `resolveHostModelDefinition` asks the org's
  if (resolvedExecution.harness) {
    const hostModelRefusal = externalAccountHostModelRefusalReason({
      harnessId: resolvedExecution.harness,
      modelId: resolvedExecution.modelId ?? String(modelDefinition.id),
    });
    if (hostModelRefusal) {
      // 422, not 503: the request is well-formed and retrying it changes
      // nothing. This client's harness cannot run this turn.
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
  // THE SAVED SELECTION DECIDES THE RAIL (`selection-rail.ts`): the turn's
  // own `modelSelection` (a Playground card's), else the selected host's
  const selected = resolveChatSelection({
    raw: rawBody.modelSelection,
    inherited: resolvedExecution.routingSelection,
    inheritedOrigin: resolvedExecution.modelSelectionOrigin,
    model: modelDefinition,
    hostWins: turnMode === "recorded",
    allowLocal: false,
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
  // A picked selection owns its settings; scenarios force host settings.
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
  // Host-config tools (web_search, bash, …) — one resolver owns which
  // config field produces which tool and with which gates (see
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
      body: body as { harnessTarget?: RawHarnessTargetInput },
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
      // Refused before any spend when the adapter has not verified it.
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      requireToolApproval,
      // Use the SERVER-resolved host server list, not the request body — a
      // stale/tampered request mustn't send an empty array to bypass the
      hasSelectedMcpServers: environmentServers
        ? effectiveServerIds.length > 0
        : (resolvedExecution.selectedServerIds ?? selectedServerIds).length > 0,
      // The RESOLVED definition — eligibility and the canonical id are both
      // derived from it inside the gate, so no call site can compute the two
      // inconsistently.
      model: {
        id: String(modelDefinition.id),
        provider: modelDefinition.provider,
        // The picker's own-provider stamp. Without it the gate reads a
        // "Your providers" row whose bare id has a hosted twin as hosted,
        hosted: modelDefinition.hosted,
      },
      // The saved selection: an org connection on the harness's own vendor
      // runs the real runtime on the organization's key.
      ...(routingSelection ? { selection: routingSelection } : {}),
      // The HOST's own configured id, kept separate from the resolved model
      // above. Only the external-account rule reads it, and only that rule
      ...(resolvedExecution.modelId
        ? { hostModelId: resolvedExecution.modelId }
        : {}),
      // Fail closed rather than let a harness turn bypass the host's
      // enterprise-managed policy: the harness proxy token carries no
      // host, so that route can't enforce it (see the flag's docstring).
      xaaEnterprisePolicyOn: xaaPolicy != null,
      // Playground chat may run a harness × model pair the evidence table
      // has not verified (with a warning); a scenario session is an eval
      // surface and may not.
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
      // 422 when this turn's settings are the problem (retrying changes
      // nothing); 503 for an operator state — broker delivery off, or no
      // computers data plane — which works once the server is fixed.
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
          // Branch on the kind, never on the wording.
          kind: availability.kind,
        },
      );
    }
  }

  // Phase 3: the server-resolved runtime config (scenario OR host-by-id) carries
  // an opaque executionScope; thread it into the computer-backed (bash) tool so
  const executionScope = (
    hostRuntimeConfig as { executionScope?: ExecutionScope } | null | undefined
  )?.executionScope;
  // A non-member participant of this scenario: the refusals they see are
  // reworded so they never name the study's credits, budget, organization or
  // environment (`participantSafeStudyError`). Members keep the detail.
  const scenarioParticipant =
    turnMode === "recorded" && isScenarioParticipant(hostRuntimeConfig);

  // COMP-16: the host-configured computer working directory — the SAME
  // `computer.workdir` the bash tool runs in — threaded into the harness path
  // so its Shell roots under the same directory. Server-resolved config only.
  const rawComputerWorkdir = (
    hostRuntimeConfig as { computer?: { workdir?: unknown } } | undefined
  )?.computer?.workdir;
  const harnessComputerWorkdir =
    typeof rawComputerWorkdir === "string" ? rawComputerWorkdir : undefined;

  // Cloud skills are a Convex-backed PROJECT resource (no computer needed), so
  // the emulated chat path inlines the catalog and wires `loadSkill` (+ file
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
      // Provider is required so bare hosted ids canonicalize — without it a
      // bare-id harness turn would be mis-detected as emulated and get the
      // emulated skill tools on top of adapter-delivered skills.
      provider: modelDefinition.provider,
      hosted: modelDefinition.hosted,
      // A harness on the org's own key runs the real runtime too.
      ...(routingSelection ? { selection: routingSelection } : {}),
      hasProjectId: Boolean(hostedBody.projectId),
    });

  // The project pool as a live capability set. A catalog failure is logged
  // and dropped rather than raised: losing skills must not lose the turn,
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

  return {
    value: {
      hostedBody,
      initializePins,
      mcpProtocolVersionsByServerId,
      body,
      messages,
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
