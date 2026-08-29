import { Hono } from "hono";
import type { ChatV2Request } from "@/shared/chat-v2";
import { getCanonicalModelId } from "@/shared/types";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import {
  listCloudRuntimeSkills,
  shouldEnableCloudSkillTools,
} from "../../utils/computers/cloud-skill-tools.js";
import { isMCPAuthError, TaskCreatedSink } from "@mcpjam/sdk";
import { isCompatibleHostedTasksVersion } from "@/shared/hosted-task-created";
import { HostedTaskCreatedBridge } from "../../utils/hosted-task-created-bridge.js";
import { recordHostedTask } from "../../services/hosted-task-registry.js";
import { resolveToolTaskSeam } from "../../utils/task-seam.js";
import { resolveHostModelDefinition } from "../../utils/org-model-config.js";
import {
  ELICITATION_TIMEOUT_EXTENSION_MS,
  HOSTED_MODE,
  WEB_STREAM_TIMEOUT_MS,
} from "../../config.js";
import {
  HostedElicitationBridge,
  hostDeclaresElicitation,
  resolveElicitationGate,
} from "./hosted-elicitation.js";
import { HostedMrtrBridge } from "../../utils/mrtr-hosted-bridge.js";
import {
  resolveMrtrChatResume,
  type MrtrEngineResume,
} from "../../utils/mrtr-hosted-chat.js";
import {
  HOSTED_MRTR_VERSION,
  isMrtrResumeSubmission,
  type MrtrElicitationResponse,
} from "@/shared/mrtr-continuation";
import {
  parseScopeStepUpCancelRequest,
  parseScopeStepUpResumeRequest,
} from "@/shared/scope-step-up";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  validateAppToolEntries,
  AppToolValidationError,
  validateWidgetModelContextEntries,
  WidgetModelContextValidationError,
} from "../../utils/chat-v2-orchestration.js";
import { buildDirectHostConfig } from "../../utils/chat-ingestion.js";
import { streamWebChatTurn } from "../../utils/web-chat-turn.js";
import { captureServerEvent } from "../../utils/analytics.js";
import {
  hostedChatSchema,
  createAuthorizedManager,
  buildServerNamesById,
  callerContextFromHono,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  ErrorCode,
  WebRouteError,
  webError,
  webErrorFromRoute,
  mapTargetServerError,
  extractMcpInitializeOptions,
} from "./auth.js";
import { createHostedRpcLogCollector } from "./hosted-rpc-logs.js";
import { getClientIp } from "../../utils/client-ip.js";
import {
  fetchScenarioRuntimeConfig,
  planScenarioSandbox,
  readScenarioEnvironment,
  readComputerSandboxMode,
  type ScenarioEnvironmentRuntime,
} from "../../utils/scenario-runtime-config.js";
import { fetchHostRuntimeConfig } from "../../utils/host-runtime-config.js";
import {
  applyHostConformanceKnobs,
  applyHostParamMirroring,
  parseXaaPolicyValue,
  conformanceKnobsFromMcpProfile,
  mirrorToolParamHeadersFromMcpProfile,
  xaaPolicyFromMcpProfile,
} from "../../utils/effective-auth.js";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import { type ExecutionScope } from "../../utils/execution-scope.js";
import { checkHarnessRuntimeAvailable } from "../../utils/harness/harness-availability.js";
import { harnessSupportsSkills } from "../../utils/harness/registry.js";
import { normalizeExecutionTarget } from "@/shared/execution-target";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import {
  resolveEnvironmentForRuntime,
  runtimeServerIds,
  runtimeServerNames,
  runtimeServersAreOverridden,
  runtimeSkills as environmentRuntimeSkills,
  type ResolvedEnvironmentRuntime,
} from "../../services/environments/runtime.js";
import {
  fetchPluginRuntimeAttribution,
  type PluginRuntimeAttribution,
} from "../../services/environments/plugin-attribution.js";
import {
  buildLiveEffectiveCapabilities,
  pluginOriginByServerId,
  resolveEffectiveCapabilities,
  type EffectiveCapabilitySet,
} from "../../services/environments/effective-capabilities.js";
import { applyPluginVersionOverride } from "../../services/environments/plugin-override.js";
import { resolveExecutionContext } from "../../utils/host-execution-context.js";
import {
  resolveHostTools,
  type TrustedSandboxBinding,
} from "../../utils/built-in-tools/registry.js";
import {
  ackScenarioSandboxNotices,
  isScenarioSandboxNotice,
  isComputersDataPlaneConfigured,
  provisionScenarioSandbox,
} from "../../utils/computers/control-plane-client.js";
import {
  isSandboxNoticeReason,
  type SandboxNoticeReason,
} from "@/shared/sandbox-notice";
import { BASH_TOOL_NAME } from "../../utils/built-in-tools/bash.js";
import {
  appendSandboxNoticeContext,
  maybeAppendEnvironmentContext,
} from "../../utils/computers/environment-context.js";
import { buildMcpjamPlatformClient } from "./mcpjam-platform-client.js";
import {
  fetchRuntimeSecrets,
  toSecretEnv,
} from "../../utils/harness/runtime-secrets.js";
import { logger } from "../../utils/logger.js";
import { resolveMrtrAuthPrincipal } from "../../utils/mrtr-hosted-collector.js";

const chatV2 = new Hono();

/**
 * Parse + shape-validate the browser's `mrtrResume` descriptor (§12.5). Reads
 * `serverId` (which server the continuation is bound to; the browser has it
 * from the `data-mrtr-input-required` part) plus the resume submission. Returns
 * `null` on any structural problem so the route fails fast. Authorization
 * (ownership, binding, round fence, per-response schema) is re-enforced
 * server-side against the durable record — this only rejects a broken body.
 */
function parseMrtrResumeRequest(value: unknown): {
  toolCallId: string;
  serverId: string;
  continuationId: string;
  round: number;
  responses: Record<string, MrtrElicitationResponse>;
} | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.toolCallId !== "string" || !v.toolCallId) return null;
  if (typeof v.serverId !== "string" || !v.serverId) return null;
  const submissionCandidate = {
    continuationId: v.continuationId,
    round: v.round,
    responses: v.responses,
  };
  if (!isMrtrResumeSubmission(submissionCandidate)) return null;
  return {
    toolCallId: v.toolCallId,
    serverId: v.serverId,
    continuationId: submissionCandidate.continuationId as string,
    round: submissionCandidate.round as number,
    responses: submissionCandidate.responses as Record<
      string,
      MrtrElicitationResponse
    >,
  };
}

chatV2.post("/", async (c) => {
  // NOTE: This route does NOT use handleRoute() because handleMCPJamFreeChatModel
  // returns a streaming Response. Wrapping it in handleRoute → c.json() would
  // serialize the Response object as '{}' instead of forwarding the stream.
  // Track OAuth server URLs so we can enrich auth errors with redirect info
  let oauthServerUrls: Record<string, string> = {};
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;
  try {
    const bearerToken = assertBearerToken(c);
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    rpcCollector = createHostedRpcLogCollector(rawBody);

    // ── Convex authorization path: guest and signed-in actors ─────
    const hostedBody = parseWithSchema(hostedChatSchema, rawBody);
    const { initializePins, mcpProtocolVersionsByServerId } =
      extractMcpInitializeOptions(rawBody);
    const body = rawBody as unknown as ChatV2Request & {
      projectId: string;
      selectedServerIds: string[];
      selectedServerNames?: string[];
      // Clients call /api/web/scenarios/redeem on mount and pass the
      // resolved `scenarioId` + `accessVersion` on every scenario-aware
      // request thereafter. The link token is never forwarded on the
      // read path.
      scenarioId?: string;
      accessVersion?: number;
      accessScope?: "project_member" | "chat_v2";
      surface?: "preview" | "share_link";
      // Saved host being previewed (Playground / host-bound direct chat). When
      // present and NOT a scenario session, the server re-fetches the host's
      // authoritative runtime config (incl. harness/computer) by this id — the
      // opaque pointer the client may forward; `harness` itself is never trusted
      // from the body.
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
    // REJECTED rather than resolved by branch precedence — see
    // `shared/execution-target.ts` for why silent shadowing is the failure mode
    // this normalizer exists to prevent.
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
    const isScenarioSession = executionTarget.kind === "scenario";
    // True when the execution context was RESOLVED SERVER-SIDE, so its host
    // config — not the request body — is authoritative for capability
    // declarations. Scenario (a share-link visitor controls the body) and
    // Project Environment (the server decides what the environment resolves
    // to) both qualify.
    //
    // Deliberately narrower than "the environment wins everything": model,
    // prompt, temperature and approval stay body-overridable on an environment
    // turn, because those are ephemeral Playground tweaks. A capability
    // declaration is not a preference — it changes what the SDK advertises on
    // the initialize wire — so it follows the resolved host either way.
    const isHostAuthoritative =
      isScenarioSession || executionTarget.kind === "environment";

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "messages are required",
      );
    }

    let modelDefinition = model;
    if (!modelDefinition) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "model is not supported",
      );
    }

    // Host config is owned by the scenario's host, not the request body.
    // When this turn is scenario-bound, re-resolve the live values from
    // Convex so a stale client snapshot or tampered body can't route the
    // session through a different model or skip tool approval. The
    // helper is a no-op (returns body values) for non-scenario surfaces.
    //
    // PR 4c of the engine consolidation: this merge is now owned by the
    // shared `resolveExecutionContext` helper alongside `mcp/chat-v2.ts`
    // (chat surface) and PR 4d's eval rewire. Single contract for
    // body × hostConfig × precedence; per-field warnings preserved via
    // `result.drift`. Pure refactor — `host-execution-context.test.ts`
    // locks the shape.
    let hostRuntimeConfig: Record<string, unknown> | null = null;
    // Set for an environment target only. Once resolved it is the SINGLE
    // source for this turn's host config, server set, and skills — nothing
    // downstream may fall back to the body's `selectedServerIds`.
    let environmentSpec: ResolvedEnvironmentRuntime | null = null;
    // Phase 5: set ONLY for an environment-backed scenario turn — the additive
    // `environment` payload on the scenario runtime config (mcpjam-backend
    // #805). Once present it is authoritative for the turn's server set and
    // skills exactly like `environmentSpec` is for an environment target;
    // absent ⇒ host-backed scenario, today's behavior byte-identical.
    let scenarioEnvironment: ScenarioEnvironmentRuntime | null = null;
    // INS-3: the turn's one answer to "what may this run reach?" — the split
    // explicit/plugin server sets, ref-addressed skills, and plugin origin.
    // Derived from `environmentSpec`, never from the body or a HostConfig
    // (hosts are plugin-blind), and never persisted: it is provenance for this
    // launch, not a restorable pin.
    let effectiveCapabilities: EffectiveCapabilitySet | null = null;
    if (executionTarget.kind === "environment") {
      // `sk_…` API-key bearers can't query Convex directly; this resolves the
      // delegated JWT (and passes JWTs through untouched), same as the eval
      // launch path.
      const convexClient = createConvexClient(
        await getConvexBearerForRequest(c),
      );
      // One atomic member-read: host runtime config + closed server set +
      // composed skill union + pinned plugin versions, at one revision. The
      // browser never supplies any of it.
      environmentSpec = await resolveEnvironmentForRuntime(convexClient, {
        projectId: hostedBody.projectId,
        environmentId: executionTarget.environmentId,
        ...(executionTarget.overrides
          ? { overrides: executionTarget.overrides }
          : {}),
      });
      hostRuntimeConfig = environmentSpec.host.runtimeConfig;
      // Attribution is a SECOND read and deliberately cannot fail the turn:
      // the environment already decided what runs, and a probe blip must
      // degrade origin reporting, not stop a send. Costs nothing when the
      // environment pins no plugins.
      const attribution = await fetchPluginRuntimeAttribution(convexClient, {
        projectId: hostedBody.projectId,
        pluginVersionIds: (environmentSpec.pluginVersions ?? []).map(
          (plugin) => plugin.pluginVersionId,
        ),
      });
      // INS-4: the Playground's ephemeral plugin narrowing, applied to the
      // resolved spec (see `plugin-override.ts` for why it cannot be a query
      // argument). It runs BEFORE the capability projection so everything
      // downstream — connected servers, delivered skills, trace origin,
      // telemetry — sees one spec, and it can only ever remove.
      if (executionTarget.overrides?.pluginVersionIds !== undefined) {
        const narrowed = applyPluginVersionOverride({
          spec: environmentSpec,
          attribution,
          retainedVersionIds: executionTarget.overrides.pluginVersionIds,
        });
        environmentSpec = narrowed.spec;
        if (narrowed.droppedVersionIds.length > 0) {
          logger.info("[chat-v2] playground plugin override applied", {
            environmentId: environmentSpec.environmentRef.environmentId,
            droppedVersionIds: narrowed.droppedVersionIds,
            droppedServerCount: narrowed.droppedServerIds.length,
            droppedSkillCount: narrowed.droppedSkillIds.length,
          });
        }
      }
      effectiveCapabilities = resolveEffectiveCapabilities(
        environmentSpec,
        attribution,
      );
      if (effectiveCapabilities.problems.length > 0) {
        // Codes and ids only, never `problem.message` — those messages
        // interpolate the skill's own NAME, which is user-authored content and
        // is held out of the provenance telemetry below for the same reason.
        // One aggregated line, so a collision-heavy environment does not emit
        // an entry per problem per turn.
        logger.warn("[chat-v2] effective capability problems", {
          environmentId: environmentSpec.environmentRef.environmentId,
          codes: effectiveCapabilities.problems.map((problem) => problem.code),
          skillIds: effectiveCapabilities.problems.flatMap((problem) =>
            "skillId" in problem ? [problem.skillId] : [],
          ),
        });
      }
      // Plugin origin on every RPC frame this turn produces, so a trace answers
      // "which plugin revision served this tool call" without a second lookup.
      rpcCollector?.setPluginOriginByServerId(
        pluginOriginByServerId(effectiveCapabilities),
      );
    } else if (isScenarioSession && scenarioId) {
      const runtime = await fetchScenarioRuntimeConfig({
        scenarioId,
        bearer: bearerToken,
        // Opt this turn into backend version enforcement. A caller whose
        // cached version is behind the row's is running against a config
        // that has since moved (rebind, mode change, republish); it must
        // re-redeem rather than have its stale view honored.
        accessVersion,
      });
      if (runtime.ok) {
        // Environment-backed scenario (live-follow): the backend resolved the
        // environment FRESH and projected its closed server set + skill union
        // onto the config. A present-but-malformed payload is an UNKNOWN
        // environment, not a host-backed scenario — stop the turn (same
        // fail-closed rationale as the fetch-error branch below) rather than
        // fall through to the body's server list.
        const environmentRead = readScenarioEnvironment(runtime.config);
        if (environmentRead.kind === "invalid") {
          logger.warn(
            "[chat-v2] scenario environment payload malformed; failing closed",
            { scenarioId, detail: environmentRead.detail },
          );
          throw new WebRouteError(
            502,
            ErrorCode.INTERNAL_ERROR,
            "Couldn't load this scenario's environment, so the turn was stopped to avoid running with the wrong configuration.",
          );
        }
        if (environmentRead.kind === "present") {
          scenarioEnvironment = environmentRead.environment;
          // Phase 6.1: attribution for scenario turns, from the payload's own
          // pinned plugin versions. Guarded on their presence — a backend
          // that predates `pluginVersions` (or an environment pinning none)
          // costs zero extra reads — and FAIL-OPEN like the environment
          // target's probe: this turn is guest-reachable, and the probe is
          // member-gated backend-side, so a guest (or any probe failure)
          // degrades to "origin unknown" rather than stopping the send.
          let attribution: PluginRuntimeAttribution | null = null;
          const pinnedVersionIds = (
            scenarioEnvironment.pluginVersions ?? []
          ).map((plugin) => plugin.pluginVersionId);
          if (pinnedVersionIds.length > 0) {
            try {
              attribution = await fetchPluginRuntimeAttribution(
                createConvexClient(await getConvexBearerForRequest(c)),
                {
                  projectId: hostedBody.projectId,
                  pluginVersionIds: pinnedVersionIds,
                },
              );
            } catch (error) {
              // `fetchPluginRuntimeAttribution` already swallows probe
              // failures; this catches client construction (missing
              // CONVEX_URL on a deployment that never configured it).
              logger.warn(
                "[chat-v2] scenario attribution unavailable; running without plugin origin",
                {
                  scenarioId,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }
          }
          // Same projection the environment target uses, so the EMULATED
          // engine advertises the environment's skills (skillsSource:
          // "resolved") instead of silently delivering zero.
          effectiveCapabilities = resolveEffectiveCapabilities(
            scenarioEnvironment,
            attribution,
          );
          if (effectiveCapabilities.problems.length > 0) {
            // Codes and ids only — same redaction rationale as the
            // environment-target log above.
            logger.warn("[chat-v2] effective capability problems", {
              environmentId: scenarioEnvironment.environmentRef.environmentId,
              codes: effectiveCapabilities.problems.map(
                (problem) => problem.code,
              ),
              skillIds: effectiveCapabilities.problems.flatMap((problem) =>
                "skillId" in problem ? [problem.skillId] : [],
              ),
            });
          }
          // Plugin origin on this turn's RPC frames, exactly as the
          // environment target stamps it. Empty (no-op) until the backend
          // serves `pluginVersions` and the probe attributes them.
          rpcCollector?.setPluginOriginByServerId(
            pluginOriginByServerId(effectiveCapabilities),
          );
        }
        hostRuntimeConfig = runtime.config as unknown as Record<
          string,
          unknown
        >;
      } else {
        // FAIL CLOSED, matching the host-bound branch below. The fetched
        // config is the ONLY source of `harness`/`computer` (deliberately
        // excluded from ExecutionOverrides so the body can't set them) and of
        // every host-wins protection. Falling back to body values would (a)
        // silently run a harness-published scenario on the emulated engine —
        // misrepresenting the runtime — and (b) let client-supplied
        // model/approval/server values govern a share-link-reachable turn,
        // the exact tampered-body window this fetch exists to close.
        logger.warn("[chat-v2] runtime-config fetch failed; failing closed", {
          scenarioId,
          status: runtime.status,
          error: runtime.error,
        });
        // Two ACCESS verdicts, neither an internal fault, each with its own
        // recovery: STALE means "re-redeem and replay" (the client does it
        // transparently), DENIED means "you cannot run this turn".
        // Everything else keeps the generic classification (>=500 collapses
        // to a 502 upstream failure).
        const failClosedMessage = `Couldn't load this scenario's settings, so the turn was stopped to avoid running with the wrong configuration. ${runtime.error}`;
        if (runtime.code === "SCENARIO_ACCESS_STALE") {
          throw new WebRouteError(
            409,
            ErrorCode.SCENARIO_ACCESS_STALE,
            failClosedMessage,
          );
        }
        throw new WebRouteError(
          runtime.status >= 500 ? 502 : runtime.status,
          runtime.status === 403
            ? ErrorCode.SCENARIO_ACCESS_DENIED
            : ErrorCode.INTERNAL_ERROR,
          failClosedMessage,
        );
      }
    } else if (executionTarget.kind === "host") {
      const targetHostId = executionTarget.hostId;
      // Host-bound direct session (Playground). The host config — including the
      // server-authoritative `harness`/`computer` — is the source of truth for
      // execution shaping. Unlike the scenario path, FAIL CLOSED here: if we
      // can't resolve the authoritative config we must not silently run the
      // emulated engine, because the host may be a harness host and running
      // emulated would misrepresent it as the real Claude Code runtime.
      const runtime = await fetchHostRuntimeConfig({
        hostId: targetHostId,
        bearer: bearerToken,
        signal: c.req.raw.signal as AbortSignal | undefined,
      });
      if (runtime.ok) {
        hostRuntimeConfig = runtime.config as unknown as Record<
          string,
          unknown
        >;
      } else {
        logger.warn(
          "[chat-v2] host runtime-config fetch failed; failing closed",
          {
            hostId: targetHostId,
            status: runtime.status,
            error: runtime.error,
          },
        );
        throw new WebRouteError(
          runtime.status >= 500 ? 502 : runtime.status,
          ErrorCode.INTERNAL_ERROR,
          `Couldn't load this host's settings, so the turn was stopped to avoid running with the wrong engine. ${runtime.error}`,
        );
      }
    }

    // ── The turn's effective server set ─────────────────────────────────────
    // For an environment target — or an environment-backed scenario turn — this
    // REPLACES the body's `selectedServerIds`
    // everywhere below — manager authorization/connection, name mapping and
    // elicitation, prepareChatV2, persistence/resume config, telemetry and the
    // tool snapshot. Resolving an environment and then still handing the raw
    // body list to the manager would connect a set the environment never
    // authorized, which is precisely the hole the atomic resolution closes.
    const environmentServers = environmentSpec ?? scenarioEnvironment;
    const effectiveServerIds = environmentServers
      ? runtimeServerIds(environmentServers)
      : selectedServerIds;
    // Names stay index-aligned with the ids. An empty array (older backend
    // without the name-carrying projection) makes `buildServerNamesById` return
    // undefined, and the manager falls back to showing the id — the same
    // degradation the legacy path already has when a client omits names.
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
    // environment that resolves zero skills delivers zero, and never falls back
    // to the project-wide pool. For an env-backed scenario an ABSENT skills
    // array (older backend) also stays authoritative-empty: the environment
    // decided the channel set, not the project-wide pool.
    const environmentSkills = environmentSpec
      ? environmentRuntimeSkills(environmentSpec)
      : scenarioEnvironment
      ? environmentRuntimeSkills({ skills: scenarioEnvironment.skills ?? [] })
      : undefined;

    // Enterprise-managed authorization policy. Server-authoritative wherever
    // a backend host config exists (scenario / host-bound turns above — the
    // same fail-closed fetch that owns harness/computer): a tampered body
    // can neither add the policy (409 DoS on auto servers) nor drop it
    // (downgrading an unconfigured auto server from xaa to the discover/
    // OAuth ladder). The body value is honored ONLY on ad-hoc turns, where
    // the caller is tampering with their own session. Both reads fail
    // closed on a malformed/unsupported policy (409, never silently off).
    const xaaPolicy = hostRuntimeConfig
      ? xaaPolicyFromMcpProfile(
          (hostRuntimeConfig as { mcpProfile?: unknown }).mcpProfile,
        )
      : parseXaaPolicyValue((body as Record<string, unknown>).xaaPolicy);

    // SEP-2243 mirroring, resolved the same way and for the same reason: a
    // scenario turn carries no pins in the body (the client never sends the
    // host profile), so reading it from the projected host config is the only
    // way `toolParamHeaderMirroring: "omit"` reaches the connection — and it
    // keeps the published host authoritative over a share-link client.
    //
    // Authoritative in BOTH directions when a host config exists: the host
    // decides `omit`, and it equally decides `mirror` (which is also what an
    // absent field means). Honoring only the `omit` direction would let a
    // share-link caller post `mirrorToolParamHeaders: false` and make a
    // conforming host non-conforming — the same tampering the `xaaPolicy`
    // read above refuses, and a worse one here because the connection
    // silently stops sending headers the server cross-checks. On ad-hoc
    // turns the body value stands: the caller owns that session.
    const effectiveInitializePins = hostRuntimeConfig
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
          body.hostStyle ?? (!isScenarioSession ? "claude" : undefined),
        builtInToolIds: body.builtInToolIds,
      },
      // Scenario: the published host wins (a share-link client can't override).
      // Host preview (Playground): the owner's in-session tweaks win, while
      // `harness`/`computer` stay host-only (not in ExecutionOverrides, so
      // precedence can't leak them from the body).
      precedence: isScenarioSession ? "host-wins" : "override-wins",
    });
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
    // `modelId` stays a special case — the resolver yields the resolved
    // string, and `resolveHostModelDefinition` lifts it (catalog hit →
    // full def; miss → org provider config lookup, then id-shape
    // inference). The provider must come from the host id + org config,
    // never the body model: org-only ids (Bedrock, custom:NAME, OpenRouter
    // selections with vendor-prefixed ids) would otherwise inherit the
    // body's provider and route to the wrong runtime.
    if (
      isScenarioSession &&
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
      logger.warn(
        "[chat-v2] client model differs from host; using host model",
        {
          scenarioId,
          body: modelDefinition.id,
          host: hostModelId,
          provider: hostModel.provider,
        },
      );
      modelDefinition = hostModel;
    }
    const systemPrompt = resolvedExecution.systemPrompt;
    const temperature = resolvedExecution.temperature;
    const requireToolApproval = resolvedExecution.requireToolApproval;
    const respectToolVisibility = resolvedExecution.respectToolVisibility;
    const resolvedProgressiveToolDiscovery =
      resolvedExecution.progressiveToolDiscovery;
    const { modelVisibleMcpToolResults, mcpToolResultImageRendering } =
      resolvedExecution.hostPolicy;
    // Host-config tools (web_search, bash, …) — one resolver owns which
    // config field produces which tool and with which gates (see
    // built-in-tools/registry.ts). `computer` comes exclusively from the
    // server-resolved runtime config — never the request body — so a
    // tampered client can't attach a shell the host didn't authorize; the
    // resolver skips bash for anonymous guests unless the turn carries a
    // host-funded swarm executionScope (personal-project guest reserves are
    // rejected backend-side).
    // Harness preflight: a host-bound turn whose resolved host runs a harness
    // (claude-code | codex) must fail closed with a clear message when the
    // runtime isn't available on this server — never silently degrade to the
    // emulated engine. Capability-driven (computer / approval / MCP / model
    // eligibility), so a new harness gets the right gates for free.
    if (resolvedExecution.harness) {
      const availability = checkHarnessRuntimeAvailable({
        harnessId: resolvedExecution.harness,
        requireToolApproval,
        // Use the SERVER-resolved host server list, not the request body — a
        // stale/tampered request mustn't send an empty array to bypass the
        // "no MCP servers" fail-closed gate. An environment target's resolved
        // set outranks even the host config's own list: it IS the set we are
        // about to connect.
        hasSelectedMcpServers: environmentServers
          ? effectiveServerIds.length > 0
          : (resolvedExecution.selectedServerIds ?? selectedServerIds).length >
            0,
        // The RESOLVED definition — eligibility and the canonical id are both
        // derived from it inside the gate, so no call site can compute the two
        // inconsistently.
        model: {
          id: String(modelDefinition.id),
          provider: modelDefinition.provider,
        },
        // Fail closed rather than let a harness turn bypass the host's
        // enterprise-managed policy: the harness proxy token carries no
        // host, so that route can't enforce it (see the flag's docstring).
        xaaEnterprisePolicyOn: xaaPolicy != null,
      });
      if (!availability.ok) {
        throw new WebRouteError(
          503,
          ErrorCode.INTERNAL_ERROR,
          `This host runs the ${resolvedExecution.harness} harness, which isn't available: ${availability.reason}.`,
        );
      }
    }

    // Phase 3: the server-resolved runtime config (scenario OR host-by-id) carries
    // an opaque executionScope; thread it into the computer-backed (bash) tool so
    // the reserve call re-resolves live access (per-swarm isolation/caps). Absent
    // (pre-Phase-3 backend) ⇒ the tools fall back to the legacy projectId reserve.
    const executionScope = (
      hostRuntimeConfig as
        | { executionScope?: ExecutionScope }
        | null
        | undefined
    )?.executionScope;

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
    // tools) for any signed-in member with a project that has skills. Gate only on:
    //   - not a guest (a share-link/scenario guest gets no skill tools), and
    //   - the turn will NOT run a real harness runtime — Claude Code delivers
    //     skills via the adapter `skills` param instead (Codex delivers none),
    //     so advertising the tools here would be a prompt/tool mismatch.
    // The harness runs only for harness hosts on an MCPJam model; a BYOK model
    // on such a host is rejected by the availability preflight above, so gate
    // on the actual engine (harness id + canonicalized model), not host config
    // alone.
    // An environment target — or an environment-backed scenario — NEVER also
    // enables the project-wide cloud skill tools: its resolved union is
    // authoritative and is delivered through
    // `runtimeSkillsOverride`. Wiring both would double-deliver — an
    // environment-scoped `loadSkill` alongside a project-wide one, with the
    // model free to pull skills the environment deliberately excluded.
    const cloudSkillsEnabled =
      !environmentServers &&
      shouldEnableCloudSkillTools({
        isGuest: Boolean(c.get("guestId")),
        harness: resolvedExecution.harness,
        modelId: String(modelDefinition.id),
        // Provider is required so bare hosted ids canonicalize — without it a
        // bare-id harness turn would be mis-detected as emulated and get the
        // emulated skill tools on top of adapter-delivered skills.
        provider: modelDefinition.provider,
        hasProjectId: Boolean(hostedBody.projectId),
      });

    // The project pool as a live capability set. A catalog failure is logged
    // and dropped rather than raised: losing skills must not lose the turn,
    // and `listCloudRuntimeSkills` throwing is still distinguishable from a
    // project that genuinely has none.
    let liveProjectCapabilities: EffectiveCapabilitySet | undefined;
    if (cloudSkillsEnabled && hostedBody.projectId) {
      try {
        liveProjectCapabilities = buildLiveEffectiveCapabilities({
          standaloneSkills: await listCloudRuntimeSkills({
            authHeader: `Bearer ${bearerToken}`,
            projectId: hostedBody.projectId,
          }),
        });
      } catch (error) {
        logger.warn(
          "[chat-v2] project skill catalog fetch failed; turn proceeds without them",
          {
            projectId: hostedBody.projectId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    // Registering the callback is what makes the SDK advertise `elicitation`,
    // so "who declares it" and "may we honor it" are one decision — see
    // `resolveElicitationGate` for why scenario turns must not read the body.
    const { effectiveClientCapabilities, enabled: elicitationEnabled } =
      resolveElicitationGate({
        hostAuthoritative: isHostAuthoritative,
        hostClientCapabilities: hostRuntimeConfig?.clientCapabilities,
        bodyClientCapabilities: hostedBody.clientCapabilities,
        clientVersion: hostedBody.hostedElicitationVersion,
      });

    // ── Tasks (`com.mcpjam/tasks`) ──────────────────────────────────────────
    // Read from the RESOLVED host, never the body. Same authority rule as the
    // elicitation gate above: a share-link visitor owns the request body, so a
    // body-supplied opt-in must not be able to turn tasks on against a host
    // that said off. `tasksPolicy` is absent from `ExecutionOverrides`
    // entirely, so this holds at every precedence rather than by a check here.
    const tasksSink = new TaskCreatedSink();
    const tasksSeam = resolveToolTaskSeam({
      tasksPolicy: resolvedExecution.tasksPolicy,
      surface: "chat",
      scope: hostedBody.projectId,
      sink: tasksSink,
    });

    // ── Hosted MRTR (input_required, §12.5) gate + resume parse ─────────────
    // MRTR suspend/resume rides the SAME elicitation capability (a round embeds
    // `elicitation/create`), so it is enabled only alongside elicitation (both
    // handlers present → legacy + MRTR both work) AND on its own version
    // handshake so a stale browser fails fast. Emulated MCPJam engine only:
    // BYOK (AI-SDK-owned loop) and harness (separate MCP plane) do not route a
    // suspend through this manager, so registering the collector there could
    // strand a round. `respectToolVisibility` is preserved across the retry
    // because the SAME manager (same advertised/gated tool set) drives it.
    const isEmulatedMcpjam =
      Boolean(modelDefinition.id) &&
      isHostedCatalogModel(
        String(modelDefinition.id),
        modelDefinition.provider,
      ) &&
      !resolvedExecution.harness;
    const rawMrtrVersion = (rawBody as Record<string, unknown>)
      .hostedMrtrVersion;
    const mrtrEnabled =
      isEmulatedMcpjam &&
      elicitationEnabled &&
      hostDeclaresElicitation(effectiveClientCapabilities) &&
      rawMrtrVersion === HOSTED_MRTR_VERSION;

    const rawMrtrResume = (rawBody as Record<string, unknown>).mrtrResume;
    const mrtrResumeRequest = parseMrtrResumeRequest(rawMrtrResume);
    if (rawMrtrResume !== undefined && !mrtrResumeRequest) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Malformed mrtrResume descriptor",
      );
    }
    if (mrtrResumeRequest && !mrtrEnabled) {
      // A resume for a continuation this turn cannot drive (version mismatch /
      // wrong engine) must fail fast rather than silently drop it.
      throw new WebRouteError(
        409,
        ErrorCode.VALIDATION_ERROR,
        "This turn cannot resume an MRTR continuation (version or engine mismatch)",
      );
    }
    const rawScopeStepUpResume = (rawBody as Record<string, unknown>)
      .scopeStepUpResume;
    const scopeStepUpResumeRequest =
      parseScopeStepUpResumeRequest(rawScopeStepUpResume);
    if (rawScopeStepUpResume !== undefined && !scopeStepUpResumeRequest) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Malformed scopeStepUpResume descriptor",
      );
    }
    const rawScopeStepUpCancel = (rawBody as Record<string, unknown>)
      .scopeStepUpCancel;
    const scopeStepUpCancelRequest =
      parseScopeStepUpCancelRequest(rawScopeStepUpCancel);
    if (rawScopeStepUpCancel !== undefined && !scopeStepUpCancelRequest) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Malformed scopeStepUpCancel descriptor",
      );
    }
    if (scopeStepUpResumeRequest && scopeStepUpCancelRequest) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Only one scope step-up continuation action is allowed",
      );
    }
    const scopeStepUpEnabled =
      typeof hostedBody.chatSessionId === "string" &&
      hostedBody.chatSessionId.length > 0;

    // Resolve the Convex-valid bearer once for both bridges (NOT the raw
    // Authorization header: WorkOS API-key callers send an `sk_…` key Convex
    // cannot verify; this resolves the delegated JWT and passes JWTs through).
    // `tasksSeam` is in the condition because the hosted task registry needs
    // the same bearer: the backend derives the row's owner from it. Without
    // this, a host with Tasks on but elicitation and MRTR off would resolve no
    // bearer, silently skip the registry consumer, and lose the cross-device
    // recovery index for exactly the ordinary task-only turns it is meant to
    // cover.
    const convexBearer =
      elicitationEnabled ||
      mrtrEnabled ||
      mrtrResumeRequest ||
      scopeStepUpEnabled ||
      scopeStepUpResumeRequest ||
      scopeStepUpCancelRequest ||
      tasksSeam
        ? await getConvexBearerForRequest(c)
        : undefined;
    const mrtrAuthPrincipal = resolveMrtrAuthPrincipal(c);

    const elicitationBridge = elicitationEnabled
      ? new HostedElicitationBridge({
          convexBearer: convexBearer!,
          projectId: hostedBody.projectId,
          chatSessionId: hostedBody.chatSessionId,
          serverNamesById:
            buildServerNamesById(effectiveServerIds, effectiveServerNames) ??
            {},
          abortSignal: c.req.raw.signal as AbortSignal | undefined,
        })
      : undefined;

    const mrtrBridge =
      mrtrEnabled && convexBearer
        ? new HostedMrtrBridge({
            bearer: convexBearer,
            projectId: hostedBody.projectId,
            ...(hostedBody.chatSessionId
              ? { chatSessionId: hostedBody.chatSessionId }
              : {}),
            serverNamesById:
              buildServerNamesById(selectedServerIds, selectedServerNames) ??
              {},
            authPrincipal: mrtrAuthPrincipal,
          })
        : undefined;

    // Delivery to the browser is a SEPARATE decision from whether tasks run.
    // A stale bundle that cannot render the part must not stop the host's
    // policy from taking effect — the task still gets created, it just isn't
    // pushed live. Absent or mismatched version ⇒ no bridge, and the turn
    // proceeds normally. Never a 409: see `HOSTED_TASKS_VERSION`.
    const taskCreatedBridge =
      tasksSeam &&
      isCompatibleHostedTasksVersion(
        (rawBody as Record<string, unknown>).hostedTasksVersion,
      )
        ? new HostedTaskCreatedBridge({
            serverNamesById:
              buildServerNamesById(effectiveServerIds, effectiveServerNames) ??
              {},
          })
        : undefined;
    if (taskCreatedBridge) {
      // Functional, not best-effort: this is the path the user's next page
      // load depends on to know the task exists.
      tasksSink.register({
        name: "hosted-task-created-bridge",
        handle: taskCreatedBridge.handle,
      });
    }
    if (tasksSeam && convexBearer) {
      // Best-effort, and registered AFTER the bridge so the durable local
      // handle always lands first — a slow registry write can never cost the
      // user the thing they need to find the task again.
      //
      // Dark until the backend's owner-binding gate is switched on, at which
      // point this starts writing rows with no change here: the disabled state
      // answers with the same 404 envelope as "not deployed" and degrades to a
      // single log line.
      tasksSink.register({
        name: "hosted-task-registry",
        bestEffort: true,
        handle: (event) =>
          recordHostedTask(event, {
            bearer: convexBearer,
            projectId: hostedBody.projectId,
          }).then(() => undefined),
      });
    }

    // Membership chat (no share/scenario token) is the default — the backend
    // authorizes via project ownership for both guest and authed users.
    // accessScope is only set when a token is in play (shared chat / scenario)
    // since that's an orthogonal access path keyed on the token, not the actor.
    const {
      manager,
      oauthServerUrls: urls,
      authenticatedUserId,
    } = await createAuthorizedManager(
      callerContextFromHono(c),
      bearerToken,
      hostedBody.projectId,
      effectiveServerIds,
      WEB_STREAM_TIMEOUT_MS,
      hostedBody.oauthTokens,
      // Scenario: advertise the HOST's capabilities, not the body's, so the
      // wire matches what we're prepared to honor.
      effectiveClientCapabilities,
      {
        ...(isScenarioSession ? { accessScope: "chat_v2" } : {}),
        scenarioId,
        accessVersion,
        rpcLogger: rpcCollector.rpcLogger,
        httpLogger: rpcCollector.httpLogger,
        serverNames: effectiveServerNames,
        initializePins: effectiveInitializePins,
        mcpProtocolVersionsByServerId,
        xaaPolicy,
        // Required for any XAA server in the batch (policy-forced or
        // per-server configured) — without it the builder 500s rather than
        // connecting tokenless.
        xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
        ...(elicitationBridge
          ? {
              elicitationCallback: elicitationBridge.callback,
              elicitationTimeoutExtensionMs: ELICITATION_TIMEOUT_EXTENSION_MS,
            }
          : {}),
        // Registered SYNCHRONOUSLY inside createAuthorizedManager (before the
        // connect microtask) so `buildCapabilities` advertises `elicitation`
        // for MRTR-capable servers — same race discipline as elicitation.
        ...(mrtrBridge
          ? {
              mrtrInputCollectorForServer:
                mrtrBridge.mrtrInputCollectorForServer,
            }
          : {}),
        // Same scope the bash tool reserves under, so a plugin's stdio
        // component colocates into THIS turn's machine rather than waking the
        // member's personal one alongside it.
        ...(executionScope ? { executionScope } : {}),
      },
    );
    oauthServerUrls = urls;
    // Inject the live manager so the collector's fingerprint/era thunks can
    // read the negotiated identity at suspend time (post-connect).
    mrtrBridge?.setManager(manager);

    // Build the engine resume descriptor: on a fresh resume request the engine
    // drives one retry leg (with reconstructed output-schema validation) before
    // the first model call and splices the result. `resolve` closes over the
    // freshly-authorized manager for the bound server.
    const mrtrEngineResume: MrtrEngineResume | undefined =
      mrtrResumeRequest && convexBearer
        ? {
            toolCallId: mrtrResumeRequest.toolCallId,
            resolve: (emit) =>
              resolveMrtrChatResume({
                manager,
                bearer: convexBearer,
                serverId: mrtrResumeRequest.serverId,
                ...(buildServerNamesById(
                  selectedServerIds,
                  selectedServerNames,
                )?.[mrtrResumeRequest.serverId]
                  ? {
                      serverName: buildServerNamesById(
                        selectedServerIds,
                        selectedServerNames,
                      )![mrtrResumeRequest.serverId],
                    }
                  : {}),
                toolCallId: mrtrResumeRequest.toolCallId,
                submission: {
                  continuationId: mrtrResumeRequest.continuationId,
                  round: mrtrResumeRequest.round,
                  responses: mrtrResumeRequest.responses,
                },
                authPrincipal: mrtrAuthPrincipal,
                ...(modelVisibleMcpToolResults
                  ? { modelVisibleMcpToolResults }
                  : {}),
                emit,
              }),
          }
        : undefined;

    // SEP-1865 App-Provided Tools: validate the client snapshot at the
    // boundary. Oversize / malformed entries 400 with a clean message
    // before prepareChatV2 ever sees them.
    let validatedAppTools;
    try {
      validatedAppTools = validateAppToolEntries(body.appTools);
    } catch (error) {
      if (error instanceof AppToolValidationError) {
        throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
      }
      throw error;
    }

    // `body.uiTools` is intentionally ignored here, not rejected: MCPJam UI
    // tools are agent-route-only (server/routes/web/mcpjam-agent.ts), but
    // cached pre-cutover clients may still send the field. MCP server tools
    // whose names happen to match `ui_*` come from MCPClientManager and stay
    // ordinary executable tools.

    let validatedWidgetModelContext;
    try {
      validatedWidgetModelContext = validateWidgetModelContextEntries(
        body.widgetModelContext,
      );
    } catch (error) {
      if (error instanceof WidgetModelContextValidationError) {
        throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
      }
      throw error;
    }

    // ── Phase 4: the scenario's own EPHEMERAL sandbox ────────────────────────
    // An env-backed scenario whose backend says `computerSandbox: 'ephemeral'`
    // runs bash on a per-CONVERSATION disposable box booted from the
    // ENVIRONMENT's pinned image — not on the acting member's persistent
    // personal computer, which every conversation that member opened used to
    // share (with their project files already in it).
    //
    // Get-or-create, so the first bash-advertising turn boots it and every
    // later turn of the same conversation gets the SAME box back. There is
    // deliberately NO release here: the box belongs to the conversation, not
    // the turn, and the backend's idle reaper (20 min since last use, 4h
    // ceiling) owns its teardown. Releasing per turn would break every
    // multi-step `cd`/write/run workflow a shell exists for.
    //
    // ABSENT marker ⇒ old backend (or an environment with no image pinned) ⇒
    // today's personal-computer behaviour, untouched.
    // Only a SCENARIO runtime config ever carries the marker (`computerSandbox`
    // is projected by `buildEnvironmentScenarioRuntimeConfig` alone), so a
    // host-bound Playground turn never reads it.
    //
    // HARNESS TURNS ARE EXCLUDED, and not merely because harness-on-scenario is
    // Phase 6. `run-harness-turn.ts` resolves its OWN machine through
    // `resolveHarnessSandbox` — the acting member's personal computer — and
    // `prepare.builtInTools` is forwarded to it verbatim alongside the MCP
    // plane. Provisioning here would therefore produce a MIXED-MACHINE turn:
    // the model's `bash` on the ephemeral box, the harness's own Shell and file
    // edits on the personal one, with no relationship between the two
    // filesystems. It would also suppress the image context that IS correct for
    // the harness's machine. Leaving harness turns entirely alone is the only
    // coherent state until Phase 6 moves the harness onto the same box.
    //
    // ORDERING: this block sits AFTER the manager authorization and the body
    // validations on purpose. Provisioning is the step that spends money, so a
    // turn that is going to be rejected (malformed `appTools`, an MCP auth
    // failure) must be rejected BEFORE it can acquire a paid box. Nothing
    // between here and the `streamWebChatTurn` call reads `builtInTools` or
    // `effectiveSystemPrompt`, which is what makes the late placement free.
    // MATERIALIZED PROJECT SECRETS for this turn, resolved ONCE, here, because
    // three separate things consume the SAME list and must not disagree:
    //
    //   1. the emulated engine's `bash` tool, which exports them into every
    //      command's environment (sandbox bindings only — see the registry);
    //   2. the harness turn, which puts them in its sandbox session's env bag;
    //   3. the transcript scrubber, which replaces those same values with
    //      `[secret:NAME]` in everything the turn persists.
    //
    // Three fetches would be three KMS decrypts per turn, and — worse — a
    // window where the scrubber's registry is missing a value the box already
    // has. Values delivered but unregistered are values written to the
    // transcript verbatim, which is the one way this feature leaks by accident.
    //
    // Tri-state: on failure this is `null`, and every consumer treats that as
    // "leave whatever state exists alone" rather than "there are no secrets".
    //
    // `environmentServers` — not `environmentSpec` — because an ENV-BACKED
    // SCENARIO turn resolves its environment into `scenarioEnvironment`
    // instead, exactly as the server set and the skill union above already
    // account for. Reading only `environmentSpec` would hand those turns no
    // secrets at all, and it would do it silently: the box simply would not
    // have the credential, and the failure would surface as a `stripe` command
    // exiting non-zero with nothing to connect it back to.
    const secretsFetch = await fetchRuntimeSecrets(bearerToken, {
      projectId: hostedBody.projectId,
      ...(environmentServers
        ? { environmentId: environmentServers.environmentRef.environmentId }
        : {}),
      ...(body.chatSessionId ? { chatSessionId: body.chatSessionId } : {}),
    });
    const runtimeSecrets = secretsFetch.ok ? secretsFetch.secrets : null;
    const secretEnv = runtimeSecrets ? toSecretEnv(runtimeSecrets) : undefined;

    const computerSandboxMode =
      isScenarioSession && scenarioId && !resolvedExecution.harness
        ? readComputerSandboxMode(hostRuntimeConfig)
        : null;
    let sandboxBinding: TrustedSandboxBinding | undefined;
    let sandboxNotices: SandboxNoticeReason[] | undefined;
    // Set only when the backend PEEKED (returned notices still pending). The
    // stream layer calls this right after writing the SSE parts; until it does,
    // the notices stay pending server-side and are re-delivered next turn.
    let ackSandboxNotices:
      | ((delivered: SandboxNoticeReason[]) => void)
      | undefined;
    // Drop the personal-computer resource for every suppressing plan, so
    // `bash` is not advertised at all rather than falling back to the member's
    // own box — which is precisely the behaviour this feature replaces:
    //   - `ephemeral` + no box   → we asked and failed; no fallback.
    //   - `not_a_data_plane`     → we never ask: `provisionScenarioSandbox` is
    //     bearer-authed and would SUCCEED from a server that cannot exec in
    //     the box (`sandbox-bash` has no remote delegation), stranding a
    //     billable sandbox whose every command fails. The tester gets a
    //     notice instead of an opaque broken shell.
    //   - `unavailable`          → the backend has already dropped `computer`,
    //     but that is its promise, not ours to depend on. Enforcing the marker
    //     locally means a payload that ever carried both (a backend regression,
    //     a proxy that merges configs) still cannot expose the member's
    //     personal shell to a share-link-reachable scenario turn.
    const sandboxPlan = planScenarioSandbox({
      mode: computerSandboxMode,
      bashRequested: (resolvedExecution.builtInToolIds ?? []).includes(
        BASH_TOOL_NAME,
      ),
      ephemeralCloudAvailable: isComputersDataPlaneConfigured(),
      hasChatSessionId: Boolean(body.chatSessionId),
    });
    let suppressComputerResource = sandboxPlan.action === "suppress";
    if (sandboxPlan.suppressReason === "no_chat_session_id") {
      // The conversation id IS the isolation boundary (`scopeKey =
      // scenario:<chatSessionId>`). Without one there is nothing to key a box
      // to, and binding anyway would put every session that omits it on one
      // shared box. No shell beats the wrong shell.
      logger.warn(
        "[chat-v2] ephemeral scenario sandbox requested without a chatSessionId; bash suppressed",
        { scenarioId },
      );
    } else if (sandboxPlan.suppressReason === "not_a_data_plane") {
      logger.warn(
        "[chat-v2] ephemeral scenario sandbox requested but this server is not a computers data plane; bash suppressed without provisioning",
        { scenarioId },
      );
      if (sandboxPlan.notice) sandboxNotices = [sandboxPlan.notice];
    }
    if (
      sandboxPlan.action === "provision" &&
      scenarioId &&
      body.chatSessionId
    ) {
      const provisioned = await provisionScenarioSandbox({
        bearer: bearerToken,
        scenarioId,
        chatSessionId: body.chatSessionId,
        signal: c.req.raw.signal as AbortSignal | undefined,
      });
      if (provisioned.ok) {
        sandboxBinding = {
          sandboxId: provisioned.value.sandboxId,
          ...(provisioned.value.workdir
            ? { workdir: provisioned.value.workdir }
            : {}),
          // Tell the model the truth about the box's lifetime. The default
          // (`run`) copy says it is destroyed after this session — a scenario
          // box is not, and a model that believes otherwise won't build work
          // up across turns, which is the whole point of a persistent shell.
          lifetime: "conversation",
        };
        const notices = (provisioned.value.notices ?? []).filter(
          isSandboxNoticeReason,
        );
        if (notices.length > 0) sandboxNotices = notices;
        // PEEK/ACK (mcpjam-backend #829). The control plane hands the notice
        // over WITHOUT consuming it and waits for us to confirm it reached
        // the wire, because the SSE writer does not exist yet — provisioning
        // happens here, streaming starts several steps later. Anything that
        // throws in between used to destroy the notice, and did so exactly
        // when a reset was most likely to have happened (flaky setup and "the
        // box was idle long enough to be reaped" share a cause).
        //
        // Unacked ⇒ re-delivered next turn. That makes duplicate display the
        // worst case instead of silent loss, which is the right way round for
        // "earlier files are gone": a repeated toast is noise, a missing one
        // makes the model confabulate about a filesystem it can't see.
        //
        // `noticeAckPending: false` means the backend already consumed them
        // (a deploy that predates #829) — leave `ackSandboxNotices` unset and
        // behave exactly as before.
        const sandboxRowId = provisioned.value.sandboxRowId;
        if (provisioned.value.noticeAckPending && notices.length > 0) {
          ackSandboxNotices = (delivered) => {
            // Only BACKEND-mintable notices enter the ack protocol —
            // inspector-minted reasons (`sandbox_unavailable`) have no
            // backend row to ack against.
            const ackable = delivered.filter(isScenarioSandboxNotice);
            if (ackable.length === 0) return;
            void ackScenarioSandboxNotices({
              bearer: bearerToken,
              sandboxRowId,
              notices: ackable,
            });
          };
        }
      } else {
        // Degrade to a turn with no shell rather than failing the turn: the
        // conversation is still useful, and 503 (at capacity / a sibling call
        // still booting) resolves on its own by the next turn.
        logger.warn(
          "[chat-v2] scenario sandbox provision failed; running without bash",
          {
            scenarioId,
            status: provisioned.status,
            error: provisioned.error,
          },
        );
        suppressComputerResource = true;
      }
    }

    const builtInTools = resolveHostTools(
      {
        builtInToolIds: resolvedExecution.builtInToolIds,
        // Computer comes exclusively from the server-resolved runtime config —
        // scenario OR host-by-id — never the request body.
        computer:
          hostRuntimeConfig && !suppressComputerResource
            ? (hostRuntimeConfig as { computer?: unknown }).computer
            : undefined,
      },
      {
        authHeader: bearerToken,
        projectId: hostedBody.projectId,
        ...(executionScope ? { executionScope } : {}),
        ...(body.chatSessionId ? { chatSessionId: body.chatSessionId } : {}),
        isGuest: Boolean(c.get("guestId")),
        isScenarioSession,
        // Lets a spend inside a shared scenario bill the scenario OWNER instead
        // of the visitor, who has no wallet to charge. Only web search reads
        // it today; the model turn and voice already send their own.
        ...(isScenarioSession && scenarioId ? { scenarioId } : {}),
        requireToolApproval,
        // Out-of-band and in-process ONLY. Never on `config.computer`:
        // `narrowHostComputer` runs at the top of `resolveHostTools` and
        // rejects anything that isn't `personal`, so a union on the config
        // would be either rejected or — worse — wire-forgeable.
        ...(sandboxBinding ? { sandboxBinding } : {}),
        // Read by the registry ONLY inside its `sandboxBinding` branch: a
        // project's credential reaches a box the project provisioned, never the
        // user's own machine (local runner) or a remote data plane.
        ...(secretEnv && Object.keys(secretEnv).length > 0
          ? { secretEnv }
          : {}),
        mcpjamPlatformClient: buildMcpjamPlatformClient(c),
      },
    );

    // Blueprint knowledge/maintenance: when this turn advertises bash, append
    // the pinned image's model-facing context to the system prompt. Tri-state
    // fetch inside — a Convex blip degrades to "no extra context", never a
    // broken turn. No-op (and no fetch) when bash isn't advertised.
    //
    // SUPPRESSED entirely on an ephemeral binding. That context is derived from
    // the ACTING MEMBER'S computer row — a different machine, booted from a
    // different image, than the box this turn's bash actually runs in. A prompt
    // that confidently describes the wrong filesystem ("your bash runs on
    // <image>; run `make setup` if deps look stale") is worse than no prompt:
    // it invents packages, paths and maintenance commands the box does not have.
    const withEnvironmentContext = await maybeAppendEnvironmentContext({
      systemPrompt,
      hasBashTool: Boolean(builtInTools?.[BASH_TOOL_NAME]) && !sandboxBinding,
      bearer: bearerToken,
      projectId: hostedBody.projectId,
      ...(executionScope ? { executionScope } : {}),
    });

    // The sandbox notices must reach the MODEL, not only the user's toast.
    //
    // The SSE part warns the human; the model meanwhile still receives the old
    // transcript, in which it says it wrote `report.py` and installed three
    // packages. Without this block it keeps reasoning from that transcript
    // against a filesystem that no longer contains any of it — which is exactly
    // the confabulation the notice exists to prevent, just moved from the user
    // to the model. Warning only the human is half a fix.
    //
    // TURN-INJECTED, never persisted: `persist.systemPrompt` keeps the raw host
    // prompt, so a resumed turn does not replay a stale "your sandbox was
    // reset" long after the fact. Same rule as the blueprint image block above.
    // Notices exist in exactly two states: derived from a provisioned box
    // (binding present) or minted by the preflight that refused to provision
    // (binding absent, `sandbox_unavailable`). Both carry model-facing copy in
    // the exhaustive SANDBOX_NOTICE_MODEL_CONTEXT record, so no binding gate.
    const effectiveSystemPrompt = appendSandboxNoticeContext(
      withEnvironmentContext,
      sandboxNotices,
    );

    try {
      const sourceType = isScenarioSession ? "scenario" : "direct";
      // Mirrors the sourceType branch — scenario surface stays "scenario", the
      // non-scenario case is the inspector playground. The docs agent has its
      // own route (mcpjam-agent.ts) and never lands here.
      const origin = isScenarioSession ? "scenario" : "playground";
      const isDirectChat = !isScenarioSession;

      // Server twin of the client's `send_message` — fires even when the
      // browser can't reach PostHog. Identity: guests always resolve (the
      // bearer-auth middleware sets c.get("guestId") before this handler,
      // independent of the authorize exchange); signed-in identity comes from
      // the authorize exchange above. One slice is intentionally not twinned:
      // a signed-in user chatting with ZERO MCP servers selected, where
      // createAuthorizedManager short-circuits before the exchange so no
      // client-matching WorkOS id is available — capturing with the Convex
      // internal id would split the person from their client events. That
      // slice is small (model-only chats are dominated by guests, who are
      // covered) and captureServerEvent drops it rather than mis-attribute;
      // the client `send_message` still fires, so the block-rate ratio stays
      // directionally correct.
      // Environment-target telemetry rides the same event. Recorded here rather
      // than at resolve time so it describes a turn that actually STARTED, and
      // so `skill_delivery` can name the engine that will carry the skills:
      // `harness_unsupported` is the honest answer for a skills-incapable
      // adapter (Codex today) — the skills resolved, and nothing delivered them.
      const skillDelivery = environmentSpec
        ? resolvedExecution.harness
          ? harnessSupportsSkills(resolvedExecution.harness)
            ? "harness"
            : "harness_unsupported"
          : "emulated"
        : undefined;
      captureServerEvent(c, "send_message_server", {
        origin,
        source_type: sourceType,
        ...(environmentSpec
          ? {
              environment_id: environmentSpec.environmentRef.environmentId,
              environment_name: environmentSpec.environmentRef.name,
              environment_revision: environmentSpec.environmentRef.revision,
              environment_host_id: environmentSpec.host.hostId,
              environment_host_config_id:
                environmentSpec.host.hostConfigId ?? null,
              environment_overridden:
                runtimeServersAreOverridden(environmentSpec),
              environment_base_server_count:
                environmentSpec.servers.baseEffectiveServerIds?.length ??
                environmentSpec.servers.effectiveServerIds.length,
              environment_effective_server_count: effectiveServerIds.length,
              environment_skill_count: environmentSkills?.length ?? 0,
              environment_skill_delivery: skillDelivery,
              environment_plugin_version_ids: (
                environmentSpec.pluginVersions ?? []
              ).map((plugin) => plugin.pluginVersionId),
              // INS-3 provenance. Bundle hashes are content addresses, not
              // user data, and are what makes a run attributable to an exact
              // revision. Plugin NAMES are deliberately not emitted (telemetry
              // must carry no user-authored strings).
              environment_plugin_bundle_hashes: (
                environmentSpec.pluginVersions ?? []
              ).map((plugin) => plugin.bundleHash ?? null),
              environment_plugin_server_count:
                effectiveCapabilities?.pluginServerIds.length ?? 0,
              environment_plugin_skill_count:
                effectiveCapabilities?.pluginSkills.length ?? 0,
              environment_capability_problems: (
                effectiveCapabilities?.problems ?? []
              ).map((problem) => problem.code),
            }
          : {}),
        // Environment-BACKED SCENARIO turn (live-follow). A deliberately
        // smaller slice than the environment-target block above: the payload
        // carries no host/plugin provenance (the backend already re-gated
        // plugins before serving it), and `environment_name` is user-authored
        // so it is not emitted from a share-link-reachable turn.
        ...(scenarioEnvironment
          ? {
              scenario_environment_backed: true,
              environment_id: scenarioEnvironment.environmentRef.environmentId,
              environment_revision: scenarioEnvironment.environmentRef.revision,
              environment_effective_server_count: effectiveServerIds.length,
              environment_skill_count: environmentSkills?.length ?? 0,
            }
          : {}),
      });

      return await streamWebChatTurn({
        manager,
        prepare: {
          selectedServerIds: effectiveServerIds,
          modelDefinition,
          systemPrompt: effectiveSystemPrompt,
          temperature,
          requireToolApproval,
          respectToolVisibility,
          modelVisibleMcpToolResults,
          customProviders: body.customProviders,
          uiMessages: messages,
          ...(resolvedExecution.harness
            ? { harness: resolvedExecution.harness }
            : {}),
          ...(tasksSeam ? { tasks: tasksSeam } : {}),
          ...(resolvedProgressiveToolDiscovery !== undefined
            ? {
                progressiveToolDiscovery: {
                  enabled: resolvedProgressiveToolDiscovery,
                },
              }
            : {}),
          appTools: validatedAppTools,
          widgetModelContext: validatedWidgetModelContext,
          ...(builtInTools ? { builtInTools } : {}),
          // COMP-16: root the harness Shell at the host-configured working
          // directory — the same `computer.workdir` the bash tool runs in.
          ...(harnessComputerWorkdir
            ? { computerWorkdir: harnessComputerWorkdir }
            : {}),
          // The project's skills as a capability set, for a target that
          // resolves no environment (host / adhoc). Same gate as before, same
          // laziness as before — a body is fetched for the skill the model
          // loads, not for the catalog — but delivered through the one merged
          // surface instead of a parallel branch of the orchestrator.
          ...(liveProjectCapabilities
            ? {
                effectiveCapabilities: liveProjectCapabilities,
                liveSkillSurface: true,
              }
            : {}),
          // Emulated-engine delivery of the environment's resolved skills.
          // Mutually exclusive with the live set above (gated on the same
          // `environmentSpec`), and ignored by the helper on a harness turn.
          //
          // Both are set for an environment turn: the capability set drives the
          // emulated ref-addressed tools (INS-3), the flat list stays for the
          // harness adapter, which writes name/description/content to disk.
          ...(environmentSkills !== undefined
            ? { runtimeSkillsOverride: environmentSkills }
            : {}),
          ...(effectiveCapabilities ? { effectiveCapabilities } : {}),
        },
        persist: {
          chatSessionId: body.chatSessionId,
          projectId: hostedBody.projectId,
          sourceType,
          origin,
          ...(isScenarioSession && surface ? { surface } : {}),
          scenarioId,
          accessVersion,
          // Phase 3: forward the runtime-config scope into the harness path
          // (alongside the bash-tool path threaded above).
          ...(executionScope ? { executionScope } : {}),
          authenticatedUserId,
          originalMessages: messages,
          ...(resolvedExecution.harness
            ? { harness: resolvedExecution.harness }
            : {}),
          // Harness-engine delivery of the environment's resolved skills.
          // Presence (even empty) is what makes it authoritative downstream.
          ...(environmentSkills !== undefined
            ? { runtimeSkillsOverride: environmentSkills }
            : {}),
          // INS-7: the same resolution, unflattened, for Computer delivery —
          // supporting files (the flat list drops them, and the project-wide
          // file query cannot return a plugin skill's) and the pinned plugin
          // versions that fork an incompatible resumed sandbox.
          ...(effectiveCapabilities ? { effectiveCapabilities } : {}),
          // PROJECT SECRETS: the id only, never the resolved spec. The harness
          // turn fetches this environment's materialized secrets from Convex
          // with the END USER'S OWN bearer, so the backend decides which of
          // them that user's session receives — this process cannot ask for
          // somebody else's. Absent ⇒ no grant.
          ...(environmentSpec
            ? { environmentId: environmentSpec.environmentRef.environmentId }
            : {}),
          // Already resolved above, so the turn helper does not re-fetch:
          // presence is semantic, and one fetch is what keeps the scrubber's
          // registry and the box's environment describing the same set.
          ...(runtimeSecrets !== null ? { runtimeSecrets } : {}),
          ...(isDirectChat ? { directVisibility: body.directVisibility } : {}),
          ...(isDirectChat && body.rewind ? { rewind: body.rewind } : {}),
          // Hosted sessions finally honor the CAS the client already sends.
          // Read from the SCHEMA-VALIDATED body, not the raw cast one.
          ...(hostedBody.expectedVersion !== undefined
            ? { expectedVersion: hostedBody.expectedVersion }
            : {}),
          // Closure receives `resolvedTemperature` from inside the helper,
          // preserving the legacy behavior where chat-v2 fed the post-
          // prepare resolved temperature into `buildDirectHostConfig`.
          hostConfig: isDirectChat
            ? ({ resolvedTemperature }) =>
                buildDirectHostConfig({
                  modelId: String(modelDefinition.id),
                  // Phase 3: real host style flows from the chat tab; old
                  // inspector builds omit it and the backend defaults to
                  // 'claude' (no more legacy 'direct' hostStyle in new traces).
                  hostStyle: body.hostStyle,
                  systemPrompt,
                  requestedTemperature: temperature,
                  resolvedTemperature,
                  requireToolApproval,
                  respectToolVisibility,
                  modelVisibleMcpToolResults:
                    resolvedExecution.modelVisibleMcpToolResults,
                  mcpToolResultImageRendering:
                    resolvedExecution.mcpToolResultImageRendering,
                  selectedServerIds: effectiveServerIds,
                })
            : null,
          selectedServerNames: effectiveServerNames,
          selectedServerIds: effectiveServerIds,
          // Plugin-contributed servers ran this turn but are never written
          // into the durable resume instruction: a plugin's membership is
          // decided by its environment at LAUNCH (lifecycle re-checked), so a
          // stored id would outlive a disable/uninstall — and a Playground's
          // ephemeral plugin narrowing would become the session's permanent
          // server set. See `resumableServers`.
          ...(effectiveCapabilities &&
          effectiveCapabilities.pluginServerIds.length > 0
            ? { nonResumableServerIds: effectiveCapabilities.pluginServerIds }
            : {}),
          // Persisted resume config keeps the RAW user prompt; the blueprint
          // env block is turn-injected (added to `prepare` above), not user
          // configuration — otherwise a resumed turn would carry stale image
          // context and re-append it. Matches the mcp chat-v2 route.
          systemPrompt,
          temperature,
          requireToolApproval,
          mcpToolResultImageRendering,
          respectToolVisibility,
        },
        runtime: {
          authHeader: c.req.header("authorization"),
          clientIp: getClientIp(c),
          abortSignal: c.req.raw.signal as AbortSignal | undefined,
          rpcCollector,
          elicitationBridge,
          // One-time sandbox notices PEEKED from the control plane above (the
          // stream writer doesn't exist yet at provision time). Flushed once
          // the writer is ready, and acked only for the chunks that actually
          // made it out — an unacked notice is re-delivered, never lost.
          ...(sandboxNotices ? { sandboxNotices } : {}),
          ...(ackSandboxNotices ? { ackSandboxNotices } : {}),
          ...(mrtrBridge ? { mrtrBridge } : {}),
          ...(taskCreatedBridge ? { taskCreatedBridge } : {}),
          ...(mrtrEngineResume ? { mrtrResume: mrtrEngineResume } : {}),
          ...(scopeStepUpEnabled && convexBearer
            ? {
                scopeStepUp: {
                  bearer: convexBearer,
                  authPrincipal: mrtrAuthPrincipal,
                  ...(scopeStepUpResumeRequest
                    ? { resumeRequest: scopeStepUpResumeRequest }
                    : {}),
                  ...(scopeStepUpCancelRequest
                    ? { cancelRequest: scopeStepUpCancelRequest }
                    : {}),
                },
              }
            : {}),
          c,
        },
      });
    } catch (error) {
      // The bridge can hold rows created before the throw (e.g. an elicitation
      // during a tool call that then failed); withdraw them so no answerable
      // prompt outlives the turn.
      await elicitationBridge?.dispose();
      await manager.disconnectAllServers();
      throw error;
    }
  } catch (error) {
    // Enrich MCPAuthError with OAuth server URL so the client can initiate OAuth
    if (isMCPAuthError(error) && Object.keys(oauthServerUrls).length > 0) {
      const firstUrl = Object.values(oauthServerUrls)[0];
      const msg = error instanceof Error ? error.message : String(error);
      return webError(
        c,
        401,
        ErrorCode.UNAUTHORIZED,
        msg,
        {
          oauthRequired: true,
          serverUrl: firstUrl,
        },
        rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined,
      );
    }
    // `webErrorFromRoute`, not `webError` — this call dropped
    // `routeError.normalized`, so the envelope carried no `origin` and no
    // `x-mcpjam-error-origin` header. This is the ORG-AWARE hosted chat path,
    // the one the client actually selects, and the client's reporter has
    // nothing but the status by the time it runs: without the verdict it
    // guesses `mcpjam` from the 500 and pages us for the user's own MCP
    // server.
    //
    // `mapTargetServerError`, because that header is exactly what a 5xx loses:
    // Cloudflare swaps an origin 5xx for its own error page, so a connection
    // failure to the user's MCP server arrived at the browser as a bare 502
    // and was reported as an MCPJam outage anyway.
    //
    // Declared HERE and not in the shared mapper because a chat turn's
    // outbound connections are to the user's own servers — that is what the
    // route exists to do, and it is the path the misattribution was measured
    // on. Not a proof: this catch also spans the turn's Convex work, so an
    // MCPJam-side failure inside it is downgraded too. That residue is
    // accepted deliberately — it is one route rather than every `/api/web/*`
    // route (including `server-secrets`, which reaches nothing but Convex, and
    // the router-wide `onError`, where the hop is unknown), so a real Convex
    // outage still pages us from everywhere else.
    return webErrorFromRoute(
      c,
      mapTargetServerError(error),
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined,
    );
  }
});

export default chatV2;
