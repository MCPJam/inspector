import { Hono } from "hono";
import type { ChatV2Request } from "@/shared/chat-v2";
import { getCanonicalModelId } from "@/shared/types";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import { shouldEnableCloudSkillTools } from "../../utils/computers/cloud-skill-tools.js";
import { isMCPAuthError } from "@mcpjam/sdk";
import { resolveHostModelDefinition } from "../../utils/org-model-config.js";
import {
  ELICITATION_TIMEOUT_EXTENSION_MS,
  HOSTED_MODE,
  WEB_STREAM_TIMEOUT_MS,
} from "../../config.js";
import {
  HostedElicitationBridge,
  resolveElicitationGate,
} from "./hosted-elicitation.js";
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
  mapRuntimeError,
  extractMcpInitializeOptions,
} from "./auth.js";
import { createHostedRpcLogCollector } from "./hosted-rpc-logs.js";
import { getClientIp } from "../../utils/client-ip.js";
import { fetchChatboxRuntimeConfig } from "../../utils/chatbox-runtime-config.js";
import { fetchHostRuntimeConfig } from "../../utils/host-runtime-config.js";
import {
  parseXaaPolicyValue,
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
import { resolveExecutionContext } from "../../utils/host-execution-context.js";
import { resolveHostTools } from "../../utils/built-in-tools/registry.js";
import { buildMcpjamPlatformClient } from "./mcpjam-platform-client.js";
import { logger } from "../../utils/logger.js";

const chatV2 = new Hono();

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
      // Clients call /api/web/chatboxes/redeem on mount and pass the
      // resolved `chatboxId` + `accessVersion` on every chatbox-aware
      // request thereafter. The link token is never forwarded on the
      // read path.
      chatboxId?: string;
      accessVersion?: number;
      accessScope?: "project_member" | "chat_v2";
      surface?: "preview" | "share_link";
      // Saved host being previewed (Playground / host-bound direct chat). When
      // present and NOT a chatbox session, the server re-fetches the host's
      // authoritative runtime config (incl. harness/computer) by this id — the
      // opaque pointer the client may forward; `harness` itself is never trusted
      // from the body.
      hostId?: string;
      // Phase 1.1 execution target. Normalized (together with the legacy
      // `hostId` and the access-bearing `chatboxId`) into one closed internal
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
      chatboxId,
      accessVersion,
      surface,
      hostId,
    } = body;
    // ONE closed execution target, resolved at ingress. `chatboxId` + an
    // explicit `executionTarget` (and `hostId` + `executionTarget`) are
    // REJECTED rather than resolved by branch precedence — see
    // `shared/execution-target.ts` for why silent shadowing is the failure mode
    // this normalizer exists to prevent.
    const normalizedTarget = normalizeExecutionTarget({
      chatboxId,
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
    // True when this turn flows through a chatbox surface. sourceType +
    // accessScope decisions hinge on this.
    const isChatboxSession = executionTarget.kind === "chatbox";
    // True when the execution context was RESOLVED SERVER-SIDE, so its host
    // config — not the request body — is authoritative for capability
    // declarations. Chatbox (a share-link visitor controls the body) and
    // Project Environment (the server decides what the environment resolves
    // to) both qualify.
    //
    // Deliberately narrower than "the environment wins everything": model,
    // prompt, temperature and approval stay body-overridable on an environment
    // turn, because those are ephemeral Playground tweaks. A capability
    // declaration is not a preference — it changes what the SDK advertises on
    // the initialize wire — so it follows the resolved host either way.
    const isHostAuthoritative =
      isChatboxSession || executionTarget.kind === "environment";

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

    // Host config is owned by the chatbox's host, not the request body.
    // When this turn is chatbox-bound, re-resolve the live values from
    // Convex so a stale client snapshot or tampered body can't route the
    // session through a different model or skip tool approval. The
    // helper is a no-op (returns body values) for non-chatbox surfaces.
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
    if (executionTarget.kind === "environment") {
      // One atomic member-read: host runtime config + closed server set +
      // composed skill union + pinned plugin versions, at one revision. The
      // browser never supplies any of it.
      environmentSpec = await resolveEnvironmentForRuntime(
        // `sk_…` API-key bearers can't query Convex directly; this resolves the
        // delegated JWT (and passes JWTs through untouched), same as the eval
        // launch path.
        createConvexClient(await getConvexBearerForRequest(c)),
        {
          projectId: hostedBody.projectId,
          environmentId: executionTarget.environmentId,
          ...(executionTarget.overrides
            ? { overrides: executionTarget.overrides }
            : {}),
        },
      );
      hostRuntimeConfig = environmentSpec.host.runtimeConfig;
    } else if (isChatboxSession && chatboxId) {
      const runtime = await fetchChatboxRuntimeConfig({
        chatboxId,
        bearer: bearerToken,
      });
      if (runtime.ok) {
        hostRuntimeConfig = runtime.config as unknown as Record<
          string,
          unknown
        >;
      } else {
        // FAIL CLOSED, matching the host-bound branch below. The fetched
        // config is the ONLY source of `harness`/`computer` (deliberately
        // excluded from ExecutionOverrides so the body can't set them) and of
        // every host-wins protection. Falling back to body values would (a)
        // silently run a harness-published chatbox on the emulated engine —
        // misrepresenting the runtime — and (b) let client-supplied
        // model/approval/server values govern a share-link-reachable turn,
        // the exact tampered-body window this fetch exists to close.
        logger.warn(
          "[chat-v2] runtime-config fetch failed; failing closed",
          {
            chatboxId,
            status: runtime.status,
            error: runtime.error,
          },
        );
        throw new WebRouteError(
          runtime.status >= 500 ? 502 : runtime.status,
          ErrorCode.INTERNAL_ERROR,
          `Couldn't load this chatbox's settings, so the turn was stopped to avoid running with the wrong configuration. ${runtime.error}`
        );
      }
    } else if (executionTarget.kind === "host") {
      const targetHostId = executionTarget.hostId;
      // Host-bound direct session (Playground). The host config — including the
      // server-authoritative `harness`/`computer` — is the source of truth for
      // execution shaping. Unlike the chatbox path, FAIL CLOSED here: if we
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
    // For an environment target this REPLACES the body's `selectedServerIds`
    // everywhere below — manager authorization/connection, name mapping and
    // elicitation, prepareChatV2, persistence/resume config, telemetry and the
    // tool snapshot. Resolving an environment and then still handing the raw
    // body list to the manager would connect a set the environment never
    // authorized, which is precisely the hole the atomic resolution closes.
    const effectiveServerIds = environmentSpec
      ? runtimeServerIds(environmentSpec)
      : selectedServerIds;
    // Names stay index-aligned with the ids. An empty array (older backend
    // without the name-carrying projection) makes `buildServerNamesById` return
    // undefined, and the manager falls back to showing the id — the same
    // degradation the legacy path already has when a client omits names.
    const environmentServerNameList = environmentSpec
      ? runtimeServerNames(environmentSpec)
      : undefined;
    const effectiveServerNames = environmentSpec
      ? environmentServerNameList && environmentServerNameList.length > 0
        ? environmentServerNameList
        : undefined
      : selectedServerNames;
    // The environment's composed skill union, in the shape both engines
    // consume. Presence — not length — is what makes it authoritative, so an
    // environment that resolves zero skills delivers zero, and never falls back
    // to the project-wide pool.
    const environmentSkills = environmentSpec
      ? environmentRuntimeSkills(environmentSpec)
      : undefined;

    // Enterprise-managed authorization policy. Server-authoritative wherever
    // a backend host config exists (chatbox / host-bound turns above — the
    // same fail-closed fetch that owns harness/computer): a tampered body
    // can neither add the policy (409 DoS on auto servers) nor drop it
    // (downgrading an unconfigured auto server from xaa to the discover/
    // OAuth ladder). The body value is honored ONLY on ad-hoc turns, where
    // the caller is tampering with their own session. Both reads fail
    // closed on a malformed/unsupported policy (409, never silently off).
    const xaaPolicy = hostRuntimeConfig
      ? xaaPolicyFromMcpProfile(
          (hostRuntimeConfig as { mcpProfile?: unknown }).mcpProfile
        )
      : parseXaaPolicyValue((body as Record<string, unknown>).xaaPolicy);

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
        hostStyle: body.hostStyle ?? (!isChatboxSession ? "claude" : undefined),
        builtInToolIds: body.builtInToolIds,
      },
      // Chatbox: the published host wins (a share-link client can't override).
      // Host preview (Playground): the owner's in-session tweaks win, while
      // `harness`/`computer` stay host-only (not in ExecutionOverrides, so
      // precedence can't leak them from the body).
      precedence: isChatboxSession ? "host-wins" : "override-wins",
    });
    for (const entry of resolvedExecution.drift) {
      if (entry.field === "requireToolApproval") {
        logger.warn(
          "[chat-v2] client requireToolApproval differs from host; using host value",
          {
            chatboxId,
            body: entry.overrideValue,
            host: entry.hostValue,
          },
        );
      } else if (entry.field === "progressiveToolDiscovery") {
        logger.warn(
          "[chat-v2] client progressiveToolDiscovery differs from host; using host value",
          {
            chatboxId,
            body: entry.overrideValue,
            host: entry.hostValue,
          },
        );
      } else if (entry.field === "respectToolVisibility") {
        logger.warn(
          "[chat-v2] client respectToolVisibility differs from host; using host value",
          {
            chatboxId,
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
            chatboxId,
            body: entry.overrideValue,
            host: entry.hostValue,
          }
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
      isChatboxSession &&
      hostRuntimeConfig &&
      resolvedExecution.modelId &&
      resolvedExecution.modelId !== modelDefinition.id
    ) {
      const hostModelId = resolvedExecution.modelId;
      const hostModel = await resolveHostModelDefinition({
        modelId: hostModelId,
        projectId: hostedBody.projectId ?? null,
        auth: { bearerToken, chatboxId },
      });
      logger.warn(
        "[chat-v2] client model differs from host; using host model",
        {
          chatboxId,
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
        hasSelectedMcpServers: environmentSpec
          ? effectiveServerIds.length > 0
          : (resolvedExecution.selectedServerIds ?? selectedServerIds).length >
            0,
        modelEligible: isHostedCatalogModel(
          String(modelDefinition.id),
          modelDefinition.provider,
        ),
        // Canonical id so the adapter's supportsModel check sees the prefixed
        // form (bare hosted ids like `gpt-5-nano` → `openai/gpt-5-nano`).
        modelId: getCanonicalModelId(
          String(modelDefinition.id),
          modelDefinition.provider,
        ),
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

    // Phase 3: the server-resolved runtime config (chatbox OR host-by-id) carries
    // an opaque executionScope; thread it into the computer-backed (bash) tool so
    // the reserve call re-resolves live access (per-swarm isolation/caps). Absent
    // (pre-Phase-3 backend) ⇒ the tools fall back to the legacy projectId reserve.
    const executionScope = (
      hostRuntimeConfig as
        | { executionScope?: ExecutionScope }
        | null
        | undefined
    )?.executionScope;

    const builtInTools = resolveHostTools(
      {
        builtInToolIds: resolvedExecution.builtInToolIds,
        // Computer comes exclusively from the server-resolved runtime config —
        // chatbox OR host-by-id — never the request body.
        computer: hostRuntimeConfig
          ? (hostRuntimeConfig as { computer?: unknown }).computer
          : undefined,
      },
      {
        authHeader: bearerToken,
        projectId: hostedBody.projectId,
        ...(executionScope ? { executionScope } : {}),
        ...(body.chatSessionId ? { chatSessionId: body.chatSessionId } : {}),
        isGuest: Boolean(c.get("guestId")),
        isChatboxSession,
        requireToolApproval,
        mcpjamPlatformClient: buildMcpjamPlatformClient(c),
      },
    );

    // COMP-16: the host-configured computer working directory — the SAME
    // `computer.workdir` the bash tool runs in — threaded into the harness path
    // so its Shell roots under the same directory. Server-resolved config only.
    const rawComputerWorkdir = (
      hostRuntimeConfig as { computer?: { workdir?: unknown } } | undefined
    )?.computer?.workdir;
    const harnessComputerWorkdir =
      typeof rawComputerWorkdir === "string" ? rawComputerWorkdir : undefined;

    // Cloud skills are a Convex-backed PROJECT resource (no computer needed), so
    // the emulated chat path wires the listSkills/loadSkill tools for any
    // signed-in member with a project. Gate only on:
    //   - not a guest (a share-link/chatbox guest gets no skill tools), and
    //   - the turn will NOT run a real harness runtime — Claude Code delivers
    //     skills via the adapter `skills` param instead (Codex delivers none),
    //     so advertising the tools here would be a prompt/tool mismatch.
    // The harness runs only for harness hosts on an MCPJam model; a BYOK model
    // on such a host is rejected by the availability preflight above, so gate
    // on the actual engine (harness id + canonicalized model), not host config
    // alone.
    // An environment target NEVER also enables the project-wide cloud skill
    // tools: its resolved union is authoritative and is delivered through
    // `runtimeSkillsOverride`. Wiring both would double-deliver — an
    // environment-scoped `loadSkill` alongside a project-wide one, with the
    // model free to pull skills the environment deliberately excluded.
    const cloudSkillsEnabled = !environmentSpec && shouldEnableCloudSkillTools({
      isGuest: Boolean(c.get("guestId")),
      harness: resolvedExecution.harness,
      modelId: String(modelDefinition.id),
      // Provider is required so bare hosted ids canonicalize — without it a
      // bare-id harness turn would be mis-detected as emulated and get the
      // emulated skill tools on top of adapter-delivered skills.
      provider: modelDefinition.provider,
      hasProjectId: Boolean(hostedBody.projectId),
    });

    // Registering the callback is what makes the SDK advertise `elicitation`,
    // so "who declares it" and "may we honor it" are one decision — see
    // `resolveElicitationGate` for why chatbox turns must not read the body.
    const {
      effectiveClientCapabilities,
      enabled: elicitationEnabled,
    } = resolveElicitationGate({
      hostAuthoritative: isHostAuthoritative,
      hostClientCapabilities: hostRuntimeConfig?.clientCapabilities,
      bodyClientCapabilities: hostedBody.clientCapabilities,
      clientVersion: hostedBody.hostedElicitationVersion,
    });

    const elicitationBridge = elicitationEnabled
      ? new HostedElicitationBridge({
          // NOT the raw Authorization header: for WorkOS API-key callers that
          // is an `sk_…` key Convex cannot verify. This resolves the delegated
          // JWT for those callers and passes JWTs through untouched.
          convexBearer: await getConvexBearerForRequest(c),
          projectId: hostedBody.projectId,
          chatSessionId: hostedBody.chatSessionId,
          serverNamesById:
            buildServerNamesById(effectiveServerIds, effectiveServerNames) ??
            {},
          abortSignal: c.req.raw.signal as AbortSignal | undefined,
        })
      : undefined;

    // Membership chat (no share/chatbox token) is the default — the backend
    // authorizes via project ownership for both guest and authed users.
    // accessScope is only set when a token is in play (shared chat / chatbox)
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
      // Chatbox: advertise the HOST's capabilities, not the body's, so the
      // wire matches what we're prepared to honor.
      effectiveClientCapabilities,
      {
        ...(isChatboxSession ? { accessScope: "chat_v2" } : {}),
        chatboxId,
        accessVersion,
        rpcLogger: rpcCollector.rpcLogger,
        serverNames: effectiveServerNames,
        initializePins,
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
      },
    );
    oauthServerUrls = urls;

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

    try {
      const sourceType = isChatboxSession ? "chatbox" : "direct";
      // Mirrors the sourceType branch — chatbox surface stays "chatbox", the
      // non-chatbox case is the inspector playground. The docs agent has its
      // own route (mcpjam-agent.ts) and never lands here.
      const origin = isChatboxSession ? "chatbox" : "playground";
      const isDirectChat = !isChatboxSession;

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
            }
          : {}),
      });

      return await streamWebChatTurn({
        manager,
        prepare: {
          selectedServerIds: effectiveServerIds,
          modelDefinition,
          systemPrompt,
          temperature,
          requireToolApproval,
          respectToolVisibility,
          modelVisibleMcpToolResults,
          customProviders: body.customProviders,
          uiMessages: messages,
          ...(resolvedExecution.harness
            ? { harness: resolvedExecution.harness }
            : {}),
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
          ...(cloudSkillsEnabled
            ? {
                cloudSkills: {
                  authHeader: `Bearer ${bearerToken}`,
                  projectId: hostedBody.projectId,
                },
              }
            : {}),
          // Emulated-engine delivery of the environment's resolved skills.
          // Mutually exclusive with `cloudSkills` above (gated on the same
          // `environmentSpec`), and ignored by the helper on a harness turn.
          ...(environmentSkills !== undefined
            ? { runtimeSkillsOverride: environmentSkills }
            : {}),
        },
        persist: {
          chatSessionId: body.chatSessionId,
          projectId: hostedBody.projectId,
          sourceType,
          origin,
          ...(isChatboxSession && surface ? { surface } : {}),
          chatboxId,
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
          ...(isDirectChat ? { directVisibility: body.directVisibility } : {}),
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
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined,
    );
  }
});

export default chatV2;
