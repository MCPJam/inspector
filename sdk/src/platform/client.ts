import { PlatformApiError } from "./errors.js";
import type {
  PlatformScenarioSummary,
  PlatformScenarioDetail,
  PlatformChatSession,
  PlatformChatSessionDetail,
  PlatformChatSessionTrace,
  PlatformChatTurn,
  PlatformToolMode,
  PlatformWidgetRender,
  PlatformDoctorReport,
  PlatformEvalIteration,
  PlatformEvalRun,
  PlatformEvalRunDecisionSummary,
  PlatformEvalStageAnalytics,
  PlatformGateWaiverRead,
  PlatformGateWaiverWriteResult,
  PlatformEvalRunInsightsRequested,
  PlatformAdhocEnvironmentBody,
  PlatformAdhocEnvironmentEnsured,
  PlatformEnvironmentNameBody,
  PlatformEvalSuiteEnvironmentAttached,
  PlatformEvalRunJudgeRequested,
  PlatformEvalCheckRepos,
  PlatformEvalCheckRepoConnected,
  PlatformEvalRunCreated,
  PlatformEvalRunDisclosure,
  PlatformEvalRunGroupCreated,
  PlatformEvalCase,
  PlatformEvalCaseBatchResult,
  PlatformEvalCaseDeleted,
  PlatformEvalCasesGenerated,
  PlatformEvalSuite,
  PlatformEvalSuiteCreated,
  PlatformEvalVerdictPolicyDefaults,
  PlatformFileOwnedEvalSuiteSynced,
  PlatformEvalSuiteDeleted,
  PlatformEvalSuiteDetail,
  PlatformEvalStepResult,
  PlatformComputerAttached,
  PlatformComputerReset,
  PlatformEnvironment,
  PlatformJourney,
  PlatformJourneyRun,
  PlatformJourneyRunSession,
  PlatformJourneyRunCanceled,
  PlatformJourneyRunLaunched,
  PlatformCapabilities,
  PlatformFindingDismissed,
  PlatformGenerationDrafts,
  PlatformJourneyArchived,
  PlatformPersona,
  PlatformPersonaDeleted,
  PlatformSecret,
  PlatformSecretDeleted,
  PlatformRunCompare,
  PlatformRunScorecard,
  PlatformGuestExecution,
  PlatformScenario,
  PlatformUserTestingInsightsRequested,
  PlatformUserTestingScenario,
  PlatformUserTestingScenarioDetail,
  PlatformUserTestingSession,
  PlatformUserTestingSessionDetail,
  PlatformSwarm,
  PlatformSwarmArchived,
  PlatformSwarmFinding,
  PlatformSwarmOverview,
  PlatformWaveInsights,
  PlatformWaveInsightsCanceled,
  PlatformWaveInsightsRequested,
  PlatformScenarioDeleted,
  PlatformEnvironmentCreateBody,
  PlatformEnvironmentCapabilities,
  PlatformEnvironmentResolved,
  PlatformEnvironmentUpdateBody,
  PlatformImage,
  PlatformImageBlueprintValidation,
  PlatformImageBuild,
  PlatformImageBuildStarted,
  PlatformImageDeleted,
  PlatformClient,
  PlatformClientDeleted,
  PlatformClientDetail,
  PlatformClientImpact,
  PlatformHost,
  PlatformHostDeleted,
  PlatformHostDetail,
  PlatformMe,
  PlatformModel,
  PlatformOrganization,
  PlatformPage,
  PlatformPlugin,
  PlatformProjectSkill,
  PlatformProjectSkillDetail,
  PlatformPluginVersion,
  PlatformProject,
  PlatformServerConnection,
  PlatformServerConnectionCreateBody,
  PlatformProjectServer,
  PlatformServerGroup,
  PlatformSessionsPage,
  PlatformTunnelClosed,
  PlatformTunnelGrant,
  PlatformOpenAIReadinessStartBody,
  PlatformReadinessKind,
  PlatformReadinessRun,
  PlatformReadinessRunReceipt,
  PlatformReadinessStartBody,
  PlatformConformanceReport,
  PlatformConformanceRun,
  PlatformConformanceRunReceipt,
  PlatformConformanceSuiteKind,
  PlatformCatalogServer,
  PlatformCatalogSourceStatus,
  PlatformDirectorySearchPage,
  PlatformRegistryServer,
  PlatformRegistryConnection,
  PlatformRegistryInstall,
} from "./types.js";

export const DEFAULT_PLATFORM_API_BASE_URL = "https://app.mcpjam.com/api/v1";

/**
 * Parse a request URL, tolerating a relative `baseUrl`.
 *
 * The default base and every Node caller pass an absolute origin, which
 * `new URL` parses on its own. Browser and Worker callers may instead pass a
 * same-origin prefix like `/api/v1` so the request rides the current origin's
 * session (see `mcpjam-inspector`'s directory-readiness client). That prefix is
 * not a valid URL by itself: `new URL("/api/v1/...")` throws "Failed to
 * construct 'URL': Invalid URL" and the call never reaches `fetch`. Resolving
 * against the document/worker origin fixes the relative case while leaving an
 * absolute spec untouched (a second `base` argument is ignored when the first
 * argument is already absolute).
 */
function resolvePlatformRequestUrl(spec: string): URL {
  const origin =
    typeof globalThis !== "undefined"
      ? (globalThis as { location?: { origin?: string } }).location?.origin
      : undefined;
  return origin ? new URL(spec, origin) : new URL(spec);
}

export interface PlatformApiClientOptions {
  /** API origin + version prefix. Defaults to the hosted production API. */
  baseUrl?: string;
  /**
   * Returns the bearer credential for each request: an `sk_` API key or a
   * WorkOS user JWT. Called per request so rotating/refreshing credentials
   * stay current.
   */
  getAuth: () => string | Promise<string>;
  /** Injectable fetch for tests and exotic runtimes. */
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Optional User-Agent; ignored by browsers (forbidden header). */
  userAgent?: string;
  /**
   * Extra headers sent on every request — for a deployment that sits behind an
   * edge authenticator (Cloudflare Access, a WAF, a corporate proxy) which
   * demands its own credential BEFORE the platform's bearer is ever seen.
   *
   * Applied FIRST, so the headers this client derives from its own contract
   * always win: `authorization` stays the credential `getAuth` resolved,
   * `idempotency-key` stays the retry key the caller passed, and
   * `content-type` stays what the body actually is. A caller cannot swap the
   * credential or the dedupe key through this door, whatever it passes.
   */
  extraHeaders?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

type QueryParams = Record<string, string | number | undefined>;

/**
 * The cursor-pagination query the v1 read routes take. `undefined` entries are
 * dropped by `request`, so a first page sends neither param.
 */
function pageQuery(params: { cursor?: string; limit?: number }): QueryParams {
  return { cursor: params.cursor, limit: params.limit };
}

type RequestOptions = {
  signal?: AbortSignal;
  /** Stable retry key forwarded to write routes. */
  idempotencyKey?: string;
};

type ServerScope = {
  projectId: string;
  serverId: string;
};

/**
 * Minimal fetch-based client for the MCPJam Platform API. Runtime-agnostic
 * by construction (Workers/browser/Node): native fetch only, no Node
 * built-ins, no ambient environment reads — credentials and base URL are
 * injected. Tolerant reader: unknown response fields pass through untouched,
 * and empty success bodies (204) resolve to `undefined`.
 */
/**
 * The two fields a readiness start body shares, and nothing else.
 *
 * Undefined entries are dropped rather than serialized as `null`: the
 * endpoint's schema types both as optional, and an explicit `null` is a value
 * it rejects rather than an absence it ignores.
 */
function pickReadinessStartBody(params: {
  idempotencyKey?: string;
  includeLlmObservations?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (params.idempotencyKey !== undefined) {
    body.idempotencyKey = params.idempotencyKey;
  }
  if (params.includeLlmObservations !== undefined) {
    body.includeLlmObservations = params.includeLlmObservations;
  }
  return body;
}

/**
 * Strip every trailing `/` from a base URL.
 *
 * `replace(/\/+$/, "")` is the shorter spelling and what the rest of the SDK
 * uses, but CodeQL rates it `js/polynomial-redos` (high): on input shaped like
 * `"a" + "/".repeat(n) + "b"` the engine retries `\/+$` from each position, so
 * the match is O(n²) in the length of a caller-supplied `baseUrl`. Not a
 * practical attack here — the caller owns the string — but this is the one
 * occurrence CodeQL surfaces on a PR that edits this file, and a linear scan
 * costs nothing.
 *
 * Behaviour is identical to the regex: every trailing slash removed, nothing
 * else touched, `"/"`-only input collapsing to `""`.
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

export class PlatformApiClient {
  private readonly baseUrl: string;
  private readonly getAuth: () => string | Promise<string>;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent?: string;
  private readonly extraHeaders?: Record<string, string>;

  constructor(options: PlatformApiClientOptions) {
    this.baseUrl = stripTrailingSlashes(
      options.baseUrl ?? DEFAULT_PLATFORM_API_BASE_URL
    );
    this.getAuth = options.getAuth;
    // Native fetch must run with `this` bound to the global scope. Storing the
    // bare reference and calling it as `this.fetchFn(...)` rebinds `this` to the
    // client instance, which throws "Illegal invocation" in Workers/browsers.
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent;
    // Lower-cased at construction so `request` cannot end up with two spellings
    // of one header — HTTP names are case-insensitive, but a plain object's
    // keys are not, and `{Authorization, authorization}` would send both.
    this.extraHeaders = options.extraHeaders
      ? Object.fromEntries(
          Object.entries(options.extraHeaders).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        )
      : undefined;
  }

  getMe(options?: RequestOptions): Promise<PlatformMe> {
    return this.request("GET", "/me", {}, options);
  }

  listModels(options?: RequestOptions): Promise<PlatformPage<PlatformModel>> {
    return this.request("GET", "/models", {}, options);
  }

  listOrganizations(
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformOrganization>> {
    return this.request("GET", "/organizations", {}, options);
  }

  listProjects(
    params: { organizationId?: string } = {},
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformProject>> {
    return this.request(
      "GET",
      "/projects",
      { query: { organizationId: params.organizationId } },
      options
    );
  }

  createProject(
    params: { body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformProject> {
    return this.request("POST", "/projects", { body: params.body }, options);
  }

  updateProject(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformProject> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(params.projectId)}`,
      { body: params.body },
      options
    );
  }

  deleteProject(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<{ id: string; deleted: boolean }> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(params.projectId)}`,
      {},
      options
    );
  }

  // ── Registry (directory + curated cards) ─────────────────────────────────

  searchRegistryDirectory(
    params: {
      q?: string;
      source?: string;
      rowType?: string;
      endpointKind?: string;
      verifiedTier?: string;
      connectableOnly?: boolean;
      cursor?: string;
      limit?: number;
    } = {},
    options?: RequestOptions
  ): Promise<PlatformDirectorySearchPage> {
    return this.request(
      "GET",
      "/registry/directory-servers",
      {
        query: {
          q: params.q,
          source: params.source,
          rowType: params.rowType,
          endpointKind: params.endpointKind,
          verifiedTier: params.verifiedTier,
          connectableOnly:
            params.connectableOnly === undefined
              ? undefined
              : params.connectableOnly
              ? "true"
              : "false",
          ...pageQuery({ cursor: params.cursor, limit: params.limit }),
        },
      },
      options
    );
  }

  getRegistryDirectoryServer(
    params: { catalogServerId: string } | { name: string; source?: string },
    options?: RequestOptions
  ): Promise<PlatformCatalogServer> {
    if ("catalogServerId" in params) {
      return this.request(
        "GET",
        `/registry/directory-servers/${encodeURIComponent(
          params.catalogServerId
        )}`,
        {},
        options
      );
    }
    return this.request(
      "GET",
      `/registry/directory-servers/${encodeURIComponent(params.name)}`,
      { query: { source: params.source } },
      options
    );
  }

  listRegistryDirectorySources(
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformCatalogSourceStatus>> {
    return this.request("GET", "/registry/directory-sources", {}, options);
  }

  listRegistryServers(
    params: { projectId: string; scope?: "global" | "organization" | "all" },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformRegistryServer>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/registry/servers`,
      { query: { scope: params.scope } },
      options
    );
  }

  listRegistryConnections(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformRegistryConnection>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/registry/connections`,
      {},
      options
    );
  }

  installRegistryDirectoryServer(
    params: {
      projectId: string;
      catalogServerId: string;
      endpointUrl?: string;
      expectedContentHash?: string;
    },
    options?: RequestOptions
  ): Promise<PlatformRegistryInstall> {
    // Explicit picks, not a rest spread — see `startClaudeReadinessRun`. The
    // route's body schema forbids additional properties.
    const { projectId, catalogServerId, endpointUrl, expectedContentHash } =
      params;
    const body: Record<string, unknown> = { catalogServerId };
    if (endpointUrl !== undefined) body.endpointUrl = endpointUrl;
    if (expectedContentHash !== undefined) {
      body.expectedContentHash = expectedContentHash;
    }
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/registry/directory-installs`,
      { body },
      options
    );
  }

  installRegistryServer(
    params: {
      projectId: string;
      registryServerId: string;
      expectedUpdatedAt?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformRegistryInstall> {
    const { projectId, registryServerId, expectedUpdatedAt } = params;
    const body: Record<string, unknown> = { registryServerId };
    if (expectedUpdatedAt !== undefined) {
      body.expectedUpdatedAt = expectedUpdatedAt;
    }
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/registry/installs`,
      { body },
      options
    );
  }

  uninstallRegistryServer(
    params: { projectId: string; registryServerId: string },
    options?: RequestOptions
  ): Promise<{ deleted?: boolean }> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/registry/installs/${encodeURIComponent(params.registryServerId)}`,
      {},
      options
    );
  }

  // ── Server connections ───────────────────────────────────────────────────
  //
  // The handoff-first flow: creating a request may answer with a `handoffUrl`
  // the user must open, rather than with a finished connection. Callers poll
  // `getServerConnection` until the status is terminal.

  /**
   * Start connecting an MCP server URL to a project.
   *
   * The response is the ONLY place a `handoffUrl` ever appears — the raw token
   * behind it is minted once and never stored, so it cannot be re-fetched.
   * Treat it as a private, single-person capability.
   */
  createServerConnection(
    params: { body: PlatformServerConnectionCreateBody },
    options?: RequestOptions
  ): Promise<PlatformServerConnection> {
    return this.request(
      "POST",
      "/server-connections",
      { body: params.body },
      options
    );
  }

  /** Poll one request. Safe to call on a short interval: this path is metered
   * on its own poll budget rather than the shared per-caller one, so polling
   * responsively does not spend the budget your other calls need. A 429 here
   * means the interval itself is too fast — honour `Retry-After`. */
  getServerConnection(
    params: { connectionRequestId: string },
    options?: RequestOptions
  ): Promise<PlatformServerConnection> {
    return this.request(
      "GET",
      `/server-connections/${encodeURIComponent(params.connectionRequestId)}`,
      {},
      options
    );
  }

  cancelServerConnection(
    params: { connectionRequestId: string },
    options?: RequestOptions
  ): Promise<PlatformServerConnection> {
    return this.request(
      "POST",
      `/server-connections/${encodeURIComponent(
        params.connectionRequestId
      )}/cancel`,
      {},
      options
    );
  }

  /**
   * Ask for another validation attempt now instead of waiting out the backoff.
   *
   * Does not revive a terminal request: after `failed`, `expired`, or
   * `cancelled`, the way forward is a new request.
   */
  retryServerConnectionValidation(
    params: { connectionRequestId: string },
    options?: RequestOptions
  ): Promise<PlatformServerConnection> {
    return this.request(
      "POST",
      `/server-connections/${encodeURIComponent(
        params.connectionRequestId
      )}/retry-validation`,
      {},
      options
    );
  }

  listProjectServers(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformProjectServer>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/servers`,
      {},
      options
    );
  }

  listServerGroups(
    params: { projectId: string },
    options?: RequestOptions,
  ): Promise<PlatformPage<PlatformServerGroup>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/server-groups`,
      {},
      options,
    );
  }

  createServerGroup(
    params: {
      projectId: string;
      body: { name: string; description?: string; serverIds: string[] };
    },
    options?: RequestOptions,
  ): Promise<PlatformServerGroup> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/server-groups`,
      { body: params.body },
      options,
    );
  }

  createProjectServer(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformProjectServer> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/servers`,
      { body: params.body },
      options
    );
  }

  getProjectServer(
    params: { projectId: string; serverId: string },
    options?: RequestOptions
  ): Promise<PlatformProjectServer> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/servers/${encodeURIComponent(params.serverId)}`,
      {},
      options
    );
  }

  updateProjectServer(
    params: {
      projectId: string;
      serverId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformProjectServer> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/servers/${encodeURIComponent(params.serverId)}`,
      { body: params.body },
      options
    );
  }

  deleteProjectServer(
    params: { projectId: string; serverId: string },
    options?: RequestOptions
  ): Promise<{ id: string; deleted: boolean }> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/servers/${encodeURIComponent(params.serverId)}`,
      { body: {} },
      options
    );
  }

  listEvalSuites(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalSuite>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/eval-suites`,
      {},
      options
    );
  }

  listChatSessions(
    params: {
      projectId?: string;
      status?: string;
      limit?: number;
      before?: string;
    } = {},
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformChatSession>> {
    return this.request(
      "GET",
      "/chat-sessions",
      {
        query: {
          projectId: params.projectId,
          status: params.status,
          limit: params.limit,
          before: params.before,
        },
      },
      options
    );
  }

  /**
   * Send ONE message to a project's MCP servers and get the model's reply plus
   * the telemetry a participant in the conversation could not see: which tools
   * were called, with what arguments, what came back, and what it cost.
   *
   * Omit `sessionId` to start a session; pass the one this returns to
   * continue it. The PINNED configuration is `modelId`, `environmentId`,
   * `serverIds`, `systemPrompt`, `temperature` and `toolMode`: those pin on the
   * FIRST turn, and a continuation that resends any of them is refused rather
   * than silently repinning. `hostId` is NOT among them — it is per-turn, and a
   * continuation is expected to resend it (see below), as are the other
   * per-turn fields (`allowedTools`, `allowedServerIds`, `maxToolCalls`,
   * `maxSteps`).
   *
   * `idempotencyKey` is REQUIRED and must be stable for the triggering intent,
   * NOT freshly minted per HTTP attempt. This call spends model credits, and a
   * per-attempt key deduplicates nothing: a timeout-and-retry would run and
   * bill the turn twice. With a stable key, a retry replays the completed
   * turn instead.
   *
   * `hostId` names the saved host (client) the turn executes as, which is what
   * decides between MCPJam's emulated engine and a real agent harness. It is
   * PER-TURN, not pinned: re-send it on every turn — a continuation of a
   * session that named only a host is REFUSED without it, rather than run on
   * the other engine. The response's `engine` field always names what ran.
   */
  sendChatMessage(
    params: {
      idempotencyKey: string;
      message: string;
      projectId?: string;
      sessionId?: string;
      modelId?: string;
      hostId?: string;
      environmentId?: string;
      serverIds?: string[];
      systemPrompt?: string;
      temperature?: number;
      maxSteps?: number;
      toolMode?: PlatformToolMode;
      allowedServerIds?: string[];
      allowedTools?: string[];
      maxToolCalls?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformChatTurn> {
    // Built field by field rather than forwarded wholesale. The route's body
    // schema is STRICT, so any extra key a caller happens to carry on its own
    // params object would turn a valid request into a 400 — and forwarding an
    // unknown key is exactly how a client starts depending on a field the
    // contract never promised.
    return this.request(
      "POST",
      "/chat-sessions/messages",
      {
        body: {
          idempotencyKey: params.idempotencyKey,
          message: params.message,
          ...(params.projectId !== undefined
            ? { projectId: params.projectId }
            : {}),
          ...(params.sessionId !== undefined
            ? { sessionId: params.sessionId }
            : {}),
          ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
          ...(params.hostId !== undefined ? { hostId: params.hostId } : {}),
          ...(params.environmentId !== undefined
            ? { environmentId: params.environmentId }
            : {}),
          ...(params.serverIds !== undefined
            ? { serverIds: params.serverIds }
            : {}),
          ...(params.systemPrompt !== undefined
            ? { systemPrompt: params.systemPrompt }
            : {}),
          ...(params.temperature !== undefined
            ? { temperature: params.temperature }
            : {}),
          ...(params.maxSteps !== undefined
            ? { maxSteps: params.maxSteps }
            : {}),
          ...(params.toolMode !== undefined
            ? { toolMode: params.toolMode }
            : {}),
          ...(params.allowedServerIds !== undefined
            ? { allowedServerIds: params.allowedServerIds }
            : {}),
          ...(params.allowedTools !== undefined
            ? { allowedTools: params.allowedTools }
            : {}),
          ...(params.maxToolCalls !== undefined
            ? { maxToolCalls: params.maxToolCalls }
            : {}),
        },
      },
      options
    );
  }

  /**
   * Session metadata plus a bounded window of raw transcript messages.
   *
   * The companion to {@link getChatSessionTrace}: spans reference messages by
   * absolute index, so resolving a span to the payload that produced it needs
   * both reads.
   */
  getChatSession(
    params: {
      sessionId: string;
      projectId?: string;
      afterMessageIndex?: number;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformChatSessionDetail> {
    return this.request(
      "GET",
      `/chat-sessions/${encodeURIComponent(params.sessionId)}`,
      {
        query: {
          projectId: params.projectId,
          afterMessageIndex: params.afterMessageIndex,
          limit: params.limit,
        },
      },
      options
    );
  }

  /**
   * Per-turn execution spans: tool latency, token usage, message indices.
   *
   * INCREMENTAL BY DEFAULT — returns the LATEST turn, not the whole session.
   * Reach older turns with `turnId` or `afterPromptIndex`, and use
   * `includeSpans: false` for cheap summaries when deciding which turn to pull.
   */
  getChatSessionTrace(
    params: {
      sessionId: string;
      projectId?: string;
      turnId?: string;
      afterPromptIndex?: number;
      limit?: number;
      includeSpans?: boolean;
    },
    options?: RequestOptions
  ): Promise<PlatformChatSessionTrace> {
    return this.request(
      "GET",
      `/chat-sessions/${encodeURIComponent(params.sessionId)}/trace`,
      {
        query: {
          projectId: params.projectId,
          turnId: params.turnId,
          afterPromptIndex: params.afterPromptIndex,
          limit: params.limit,
          // Serialized explicitly: the query builder takes string|number, and
          // `false` is the value that MATTERS here (it selects the cheap
          // summary), so it must not be dropped as falsy.
          includeSpans:
            params.includeSpans === undefined
              ? undefined
              : String(params.includeSpans),
        },
      },
      options
    );
  }

  /**
   * The unified, cross-surface sessions feed for one project.
   *
   * `q` is optional HERE (omitted = the recency feed) even though the
   * `search_sessions` operation requires it: a client method is the general
   * transport, and list-mode is a legitimate use of the endpoint. The
   * operation narrows that on purpose — an agent asking for "the sessions"
   * unfiltered is almost never what its user meant.
   *
   * `sourceTypes` is CSV-joined because the endpoint takes a repeated-value
   * `sourceType` param as one comma-separated string; an empty array is sent
   * as nothing at all rather than as `sourceType=`, which the backend would
   * reject.
   *
   * `cursor` passes through unrenamed — it is an opaque Convex cursor, so echo
   * back exactly what the previous page returned and never construct one.
   */
  listSessions(
    params: {
      projectId: string;
      q?: string;
      scope?: "titles" | "transcripts";
      sourceTypes?: string[];
      status?: string;
      limit?: number;
      cursor?: string;
    },
    options?: RequestOptions
  ): Promise<PlatformSessionsPage> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/sessions`,
      {
        query: {
          q: params.q,
          scope: params.scope,
          sourceType: params.sourceTypes?.length
            ? params.sourceTypes.join(",")
            : undefined,
          status: params.status,
          limit: params.limit,
          cursor: params.cursor,
        },
      },
      options
    );
  }

  listScenarios(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformScenarioSummary>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/scenarios`,
      {},
      options
    );
  }

  getScenario(
    params: { projectId: string; scenarioId: string },
    options?: RequestOptions
  ): Promise<PlatformScenarioDetail> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/scenarios/${encodeURIComponent(params.scenarioId)}`,
      {},
      options
    );
  }

  // ── Clients ──────────────────────────────────────────────────────────
  //
  // A **Client** is the product noun. The `listHosts`…`deleteHost` methods
  // below these are DEPRECATED compatibility delegates: they keep calling the
  // `/hosts` alias and keep returning its `PlatformHost*` shapes, so existing
  // callers are unaffected. They are not thin wrappers over the client methods
  // — the two surfaces return different fields.

  listClients(
    params: { projectId: string; includePrivateBacking?: boolean },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformClient>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/clients`,
      {
        query: params.includePrivateBacking
          ? { includePrivateBacking: "true" }
          : undefined,
      },
      options
    );
  }

  /**
   * `GET /projects/{p}/clients/{client}` — `client` is a NAME or an ID.
   *
   * Name resolution happens server-side, where one implementation owns the
   * eligibility and ambiguity rules. A client-side list-and-scan would be a
   * second answer to "is this name ambiguous?", and would also have to
   * re-implement the private-backing filter to avoid resolving a name the
   * server would not.
   */
  getClient(
    params: {
      projectId: string;
      client: string;
      includePrivateBacking?: boolean;
    },
    options?: RequestOptions
  ): Promise<PlatformClientDetail> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/clients/${encodeURIComponent(params.client)}`,
      {
        query: params.includePrivateBacking
          ? { includePrivateBacking: "true" }
          : undefined,
      },
      options
    );
  }

  /**
   * `POST /projects/{p}/clients` — create a client either from a built-in
   * template (`{ name, template, theme? }`) or from a full config
   * (`{ name, config }`). Returns the created client detail.
   */
  createClient(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformClientDetail> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/clients`,
      { body: params.body },
      options
    );
  }

  /**
   * `PATCH /projects/{p}/clients/{client}` — rename and/or edit the config.
   *
   * The body carries the compare-and-set tokens the canonical route requires
   * (`expectedConfigId` for a config edit, `expectedName` for a rename); a
   * stale one comes back as a 409 whose `details` names the current value.
   */
  updateClient(
    params: {
      projectId: string;
      client: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformClientDetail> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/clients/${encodeURIComponent(params.client)}`,
      { body: params.body },
      options
    );
  }

  setClientServers(
    params: {
      projectId: string;
      client: string;
      serverIds: string[];
      optionalServerIds?: string[];
      expectedConfigId: string;
      expectedImpact?: PlatformClientImpact;
    },
    options?: RequestOptions
  ): Promise<PlatformClientDetail> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/clients/${encodeURIComponent(params.client)}/servers`,
      {
        body: {
          serverIds: params.serverIds,
          ...(params.optionalServerIds
            ? { optionalServerIds: params.optionalServerIds }
            : {}),
          expectedConfigId: params.expectedConfigId,
          ...(params.expectedImpact
            ? { expectedImpact: params.expectedImpact }
            : {}),
        },
      },
      options
    );
  }

  duplicateClient(
    params: { projectId: string; client: string; name?: string },
    options?: RequestOptions
  ): Promise<PlatformClientDetail> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/clients/${encodeURIComponent(params.client)}/duplicate`,
      { body: params.name === undefined ? {} : { name: params.name } },
      options
    );
  }

  deleteClient(
    params: {
      projectId: string;
      client: string;
      body?: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformClientDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/clients/${encodeURIComponent(params.client)}`,
      { body: params.body ?? {} },
      options
    );
  }

  // ── Hosts (deprecated compatibility surface) ─────────────────────────

  /** @deprecated Use {@link listClients}. Calls the deprecated `/hosts` alias. */
  listHosts(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformHost>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/hosts`,
      {},
      options
    );
  }

  /** @deprecated Use {@link getClient}. Calls the deprecated `/hosts` alias. */
  getHost(
    params: { projectId: string; hostId: string },
    options?: RequestOptions
  ): Promise<PlatformHostDetail> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/hosts/${encodeURIComponent(params.hostId)}`,
      {},
      options
    );
  }

  /**
   * `POST /projects/{p}/hosts` — create a host either from a built-in template
   * (`{ name, template, theme? }`) or from a full host config
   * (`{ name, config }`). Returns the created host detail.
   *
   * @deprecated Use {@link createClient}. Calls the deprecated `/hosts` alias.
   */
  createHost(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformHostDetail> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/hosts`,
      { body: params.body },
      options
    );
  }

  /** @deprecated Use {@link updateClient}. Calls the deprecated `/hosts` alias. */
  updateHost(
    params: {
      projectId: string;
      hostId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformHostDetail> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/hosts/${encodeURIComponent(params.hostId)}`,
      { body: params.body },
      options
    );
  }

  /** @deprecated Use {@link setClientServers}. Calls the deprecated `/hosts` alias. */
  setHostServers(
    params: {
      projectId: string;
      hostId: string;
      serverIds: string[];
      optionalServerIds?: string[];
    },
    options?: RequestOptions
  ): Promise<{ hostId: string; hostConfigId: string }> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/hosts/${encodeURIComponent(params.hostId)}/servers`,
      {
        body: {
          serverIds: params.serverIds,
          ...(params.optionalServerIds
            ? { optionalServerIds: params.optionalServerIds }
            : {}),
        },
      },
      options
    );
  }

  /** @deprecated Use {@link duplicateClient}. Calls the deprecated `/hosts` alias. */
  duplicateHost(
    params: { projectId: string; hostId: string; name?: string },
    options?: RequestOptions
  ): Promise<PlatformHostDetail> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/hosts/${encodeURIComponent(params.hostId)}/duplicate`,
      { body: params.name === undefined ? {} : { name: params.name } },
      options
    );
  }

  /** @deprecated Use {@link deleteClient}. Calls the deprecated `/hosts` alias. */
  deleteHost(
    params: {
      projectId: string;
      hostId: string;
      body?: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformHostDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/hosts/${encodeURIComponent(params.hostId)}`,
      { body: params.body ?? {} },
      options
    );
  }

  // ── Project Environments ─────────────────────────────────────────────
  //
  // Named execution bundles (host + optional server group + optional pinned
  // skills/plugins) that eval suites and journeys run against. Distinct from
  // the sandbox images below.
  //
  // Reads need project membership; every write needs project ADMIN. All
  // mutations take the `expectedRevision` you last read — a stale value is a
  // 409 CONFLICT, never a silent overwrite.

  listEnvironments(
    params: { projectId: string; includeArchived?: boolean },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEnvironment>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/environments`,
      {
        query: params.includeArchived ? { includeArchived: "true" } : undefined,
      },
      options
    );
  }

  /**
   * What this deployment's environment surface supports.
   *
   * CALL THIS BEFORE SENDING `modelId`. The SDK ships independently of the
   * backend, and a field an older deployment does not know is a hard validator
   * error there rather than a silently ignored one. A deployment too old to
   * answer reports `false` for everything, which is the correct assumption.
   */
  getEnvironmentCapabilities(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformEnvironmentCapabilities> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/capabilities`,
      {},
      options
    );
  }

  getEnvironment(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}`,
      {},
      options
    );
  }

  /**
   * The launch preview: the host config, closed server set, and pinned plugin
   * versions this environment resolves to right now. A resolvable-today
   * failure (a disabled pinned plugin, an empty server set) is a 409 whose
   * `details.code` carries the specific `ENV_*` reason.
   */
  resolveEnvironment(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformEnvironmentResolved> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}/resolve`,
      {},
      options
    );
  }

  createEnvironment(
    params: { projectId: string; body: PlatformEnvironmentCreateBody },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/environments`,
      { body: params.body },
      options
    );
  }

  /**
   * `POST /projects/{p}/environments/ensure-adhoc` — GET-OR-CREATE an UNNAMED,
   * content-addressed environment for a composed stack.
   *
   * Distinct from `createEnvironment`, which mints a NAMED row that lands in
   * the project's environment list forever. A composed stack is a throwaway:
   * the caller wants to run this exact combination, not to add a permanent
   * entry someone else has to reason about.
   *
   * Deduped server-side by a fingerprint of the stack, so the same stack
   * always returns the same environment (`created: false` after the first
   * call) and a retried launch converges instead of accumulating rows.
   */
  ensureAdhocEnvironment(
    params: { projectId: string; body: PlatformAdhocEnvironmentBody },
    options?: RequestOptions
  ): Promise<PlatformAdhocEnvironmentEnsured> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/ensure-adhoc`,
      { body: params.body },
      options
    );
  }

  /**
   * `POST /projects/{p}/environments/{id}/name` — PROMOTE an ad-hoc
   * environment to a named one, in place.
   *
   * The ONLY promotion path: `updateEnvironment` cannot do it. The platform
   * keeps the two apart because its rename is admin-gated and refuses a row
   * that already has a name, while promotion is member-gated and refuses one
   * that already has a name. Routing promotion through the rename would either
   * open it to members or leave ad-hoc rows unnameable.
   */
  nameEnvironment(
    params: {
      projectId: string;
      environmentId: string;
      body: PlatformEnvironmentNameBody;
    },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}/name`,
      { body: params.body },
      options
    );
  }

  /**
   * Only the fields you pass change. Pass `null` for `serverAttachmentId`,
   * `modelId`, `skillSelection`, `secretSelection`, `pluginVersionIds`, or
   * `sandboxImageId` to CLEAR them; omitting a field leaves it alone.
   */
  updateEnvironment(
    params: {
      projectId: string;
      environmentId: string;
      body: PlatformEnvironmentUpdateBody;
    },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}`,
      { body: params.body },
      options
    );
  }

  /**
   * Archive (not delete): the row is kept and can be restored. Archiving frees
   * the name for a new live environment.
   */
  archiveEnvironment(
    params: {
      projectId: string;
      environmentId: string;
      expectedRevision: number;
    },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}/archive`,
      { body: { expectedRevision: params.expectedRevision } },
      options
    );
  }

  /**
   * Restore an archived environment. Fails with 409 if the name was taken
   * while it was archived. Plugin pins whose version rows no longer exist at
   * all are dropped — compare the returned `pluginVersionIds` against what you
   * archived to detect that.
   */
  restoreEnvironment(
    params: {
      projectId: string;
      environmentId: string;
      expectedRevision: number;
    },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}/restore`,
      { body: { expectedRevision: params.expectedRevision } },
      options
    );
  }

  // ── Cloud Skills ─────────────────────────────────────────────────────
  //
  // Read-only: the skills visible to the caller in a project, and one skill's
  // detail including its SKILL.md body. Authoring stays on the app surface.

  listProjectSkills(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformProjectSkill>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/skills`,
      {},
      options
    );
  }

  getProjectSkill(
    params: { projectId: string; skillId: string },
    options?: RequestOptions
  ): Promise<PlatformProjectSkillDetail> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/skills/${encodeURIComponent(params.skillId)}`,
      {},
      options
    );
  }

  // ── Agent Plugins ────────────────────────────────────────────────────
  //
  // Read-only: the live plugins installed in a project, and one imported
  // version's detail. Import/enable/disable/uninstall stay in the app.

  listProjectPlugins(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformPlugin>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/plugins`,
      {},
      options
    );
  }

  /**
   * One imported plugin version with its component projections. Addressed by
   * the version id alone — access is the version's own project membership,
   * and historical versions of uninstalled plugins stay readable (eval
   * snapshots and stale environment pins reference them).
   */
  getPluginVersion(
    params: { pluginVersionId: string },
    options?: RequestOptions
  ): Promise<PlatformPluginVersion> {
    return this.request(
      "GET",
      `/plugin-versions/${encodeURIComponent(params.pluginVersionId)}`,
      {},
      options
    );
  }

  // ── Sandbox images ───────────────────────────────────────────────────
  //
  // A project's custom Computer base images. "Image", not "environment": a
  // Project Environment is an unrelated concept and owns that word.

  listImages(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformImage>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/images`,
      {},
      options
    );
  }

  getImage(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformImage> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}`,
      {},
      options
    );
  }

  createImage(
    params: { projectId: string; body: { name: string; blueprint: string } },
    options?: RequestOptions
  ): Promise<PlatformImage> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/images`,
      { body: params.body },
      options
    );
  }

  updateImage(
    params: {
      projectId: string;
      imageId: string;
      body: { name?: string; blueprint?: string };
    },
    options?: RequestOptions
  ): Promise<PlatformImage> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}`,
      { body: params.body },
      options
    );
  }

  /** Lint blueprint YAML without saving it. Always resolves (200); an
   * invalid blueprint is a successful lint with structured errors. */
  validateImageBlueprint(
    params: { projectId: string; body: { blueprint: string } },
    options?: RequestOptions
  ): Promise<PlatformImageBlueprintValidation> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/images/validate`,
      { body: params.body },
      options
    );
  }

  deleteImage(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformImageDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}`,
      {},
      options
    );
  }

  listImageBuilds(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformImageBuild>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}/builds`,
      {},
      options
    );
  }

  /** `POST …/build` — async (202); poll `listImageBuilds` for status. */
  buildImage(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformImageBuildStarted> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}/build`,
      {},
      options
    );
  }

  promoteImage(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformImage> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}/promote`,
      {},
      options
    );
  }

  /** Attach the sandbox image to the caller's computer (re-provisions from the
   * pinned image). */
  useImage(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformComputerAttached> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}/use`,
      {},
      options
    );
  }

  /** Reset the caller's computer to its image (wipes mutable state). */
  resetComputer(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformComputerReset> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/computer/reset`,
      {},
      options
    );
  }

  /**
   * `POST /projects/{p}/eval-runs` — validates and creates the run, then
   * detaches execution and responds 202. Poll `getEvalRun` until terminal.
   */
  createEvalRun(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformEvalRunCreated> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/eval-runs`,
      { body: params.body },
      options
    );
  }

  /**
   * `GET /projects/{p}/eval-suites/{id}/run-disclosure` — the pre-run
   * disclosure for a launch plan: what happens to the run's content, keyed by
   * the SAME destination-affecting subset `createEvalRun` uses
   * (`caseIds`/`environmentId`/`environmentIds`). Deliberately NOT the
   * estimator's full arg set — `iterationOverride`/`planCount` only scale
   * volume, which is not part of this contract, and the inspector server
   * rejects them rather than silently ignoring them.
   *
   * Throws `PlatformApiError` with code `FEATURE_NOT_SUPPORTED` and
   * `details.reason === "contract_unavailable"` against an inspector
   * deployment too old to compute this — never treat a missing disclosure as
   * "nothing to disclose". This is a GUARANTEE only when the deployment's
   * missing-function error reaches the client unredacted (every non-production
   * Convex environment, and a production one whose redaction the route can
   * unambiguously identify as a missing function). Production Convex can
   * redact that same failure to a generic "Server Error" indistinguishable
   * from a genuine handler crash; the route disambiguates what it safely can
   * (a caller who cannot see the suite at all still gets a 404, never this
   * code), but an ambiguous redacted failure on a suite the caller CAN see
   * surfaces as a 502 `SERVER_UNREACHABLE` instead — this route has no way to
   * independently confirm "not deployed yet" over "deployed and broken" in
   * that one case, and guessing `contract_unavailable` would risk hiding a
   * real incident. A caller cannot rely on this code alone to detect an
   * old deployment in production; a 502 does not imply the contract is
   * available either.
   */
  getEvalRunDisclosure(
    params: {
      projectId: string;
      suiteId: string;
      caseIds?: string[];
      environmentId?: string;
      environmentIds?: string[];
      /**
       * Disclose for a HOST-axis launch — the attached host a run would be
       * stamped with (G4c). Mutually exclusive with `environmentId`/
       * `environmentIds`: a launch plan resolves on exactly one axis, and the
       * route rejects the combination with a 400 rather than letting it reach
       * the backend as an ambiguous query.
       *
       * `runnerCapabilities` is deliberately NOT a parameter here. The
       * inspector route asserts it from the executing process, which is the
       * only honest source for what that process can run; a client-supplied
       * value could claim a harness capability the runner does not have.
       */
      namedHostId?: string;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalRunDisclosure> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/run-disclosure`,
      {
        query: {
          caseIds: params.caseIds?.length
            ? params.caseIds.join(",")
            : undefined,
          environmentId: params.environmentId,
          environmentIds: params.environmentIds?.length
            ? params.environmentIds.join(",")
            : undefined,
          host: params.namedHostId,
        },
      },
      options
    );
  }

  /**
   * `POST /projects/{p}/eval-suites/{id}/environments` — APPEND one
   * environment to the suite's attachments, atomically.
   *
   * Distinct from `updateEvalSuite({ environmentIds })`, which REPLACES the
   * whole list: an append built on that is a read-modify-write across two
   * round trips, and a concurrent attach landing in between is silently
   * detached. Idempotent — attaching an already-attached environment reports
   * `attached: false` and changes nothing.
   */
  attachEvalSuiteEnvironment(
    params: { projectId: string; suiteId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteEnvironmentAttached> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/environments`,
      { body: { environmentId: params.environmentId } },
      options
    );
  }

  /**
   * `POST /projects/{p}/eval-run-groups` — launch ONE run per target (attached
   * environments, or attached named hosts) under a single server-minted group
   * id, and respond 202 with a per-target receipt.
   *
   * The ONLY endpoint with grouped-launch semantics: the server bounds the
   * fan-out, validates every target before launching any of them, and holds
   * ONE organization concurrency slot for the whole group. `createEvalRun`
   * accepts a `runGroupId` too, but purely as a display label — it gives N
   * separate launches no group treatment, which is why a fan-out has to come
   * through here.
   *
   * A per-target failure does not abort its siblings, so read `outcome` rather
   * than treating the 202 as "everything started".
   */
  createEvalRunGroup(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformEvalRunGroupCreated> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/eval-run-groups`,
      { body: params.body },
      options
    );
  }

  /**
   * `POST /projects/{p}/eval-suites` — author a runnable suite from test-case
   * definitions and return the new suite id. Synchronous (does NOT run the
   * suite; execute it with `createEvalRun`). The same path serves `GET` for
   * `listEvalSuites`.
   */
  createEvalSuite(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteCreated> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/eval-suites`,
      { body: params.body },
      options
    );
  }

  /**
   * `POST /projects/{p}/eval-suites/from-file` — resolve or create a
   * file-owned suite by declared id. Lookup is by declared id within the
   * project, never by name. A UI-authored suite has no declared id and
   * cannot be claimed.
   *
   * `verdictPolicyDefaults` is pinned to its type rather than left inside the
   * untyped bag. It is the one member of this body whose in-memory
   * counterpart has a DIFFERENT shape — the suite-file loader resolves
   * `validity.minEligibleTrials` into a `coverage` union — and an untyped body
   * let the resolved shape reach a strict route validator, which rejected
   * every hosted `eval run --file` upload. Typing the field makes that
   * substitution a compile error instead of a runtime rejection.
   */
  syncFileOwnedEvalSuite(
    params: {
      projectId: string;
      body: Record<string, unknown> & {
        verdictPolicyDefaults?: PlatformEvalVerdictPolicyDefaults;
      };
    },
    options?: RequestOptions
  ): Promise<PlatformFileOwnedEvalSuiteSynced> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/eval-suites/from-file`,
      { body: params.body },
      options
    );
  }

  getEvalRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalRun> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}`,
      {},
      options
    );
  }

  /**
   * `GET /projects/{p}/eval-runs/{runId}/decision-summary` — the canonical run
   * decision contract: the verdict, the unit its counts are in, the run's own
   * `EvalVerdictDecision` when it has one, and one page of per-trial
   * diagnostics.
   *
   * ADDITIVE, and newer than most deployments: an API that predates it answers
   * `404`. A caller that must work against both should use the exported
   * `readEvalRunDecisionSummary` helper, which falls back over
   * `listEvalRunIterations` and the same contract assembler rather than
   * creating a summary of its own.
   *
   * `cursor`/`limit` page the DIAGNOSTICS, using the same cursors
   * `listEvalRunIterations` issues. The response says whether the page it
   * returned is the whole non-passing set.
   */
  getEvalRunDecisionSummary(
    params: {
      projectId: string;
      runId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalRunDecisionSummary> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/decision-summary`,
      { query: { cursor: params.cursor, limit: params.limit } },
      options
    );
  }

  /**
   * One page of a suite's materialized stage analytics, newest run-completion
   * first — one complete `EvalStageAnalyticsV1` document per RUN.
   *
   * Each item stands alone: the overall funnel plus the intent, model and host
   * MARGINAL slices for that one run. There is deliberately no cross-run merge
   * here or anywhere in the SDK — two funnels averaged together describe no run
   * — so a caller that wants a comparison renders runs side by side under
   * `stageAnalyticsParityBlockers`, never by summing these documents.
   *
   * `from`/`to` are INCLUSIVE epoch MILLISECONDS over the run's completion
   * stamp (not ISO strings), matching the storage boundary exactly; `from`
   * greater than `to` is a `400`. Runs that never completed carry no stamp and
   * are excluded by any `from` bound. `runGroupId` narrows to one comparison
   * group. `limit` is 1..100 and defaults to 25 — these documents are large.
   *
   * NEWER than most deployments, and NOT backfilled: an API that predates it
   * answers `404`, and a run that finished before the materializer shipped has
   * no row at all. Both mean UNMEASURED and neither is a zeroed funnel — there
   * is no client-side reconstruction to fall back to, by design.
   */
  listEvalSuiteStageAnalytics(
    params: {
      projectId: string;
      suiteId: string;
      from?: number;
      to?: number;
      runGroupId?: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalStageAnalytics>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/stage-analytics`,
      {
        query: {
          from: params.from,
          to: params.to,
          runGroupId: params.runGroupId,
          cursor: params.cursor,
          limit: params.limit,
        },
      },
      options
    );
  }

  /**
   * ONE run's materialized stage-analytics document — the same
   * `EvalStageAnalyticsV1` the suite listing returns, addressed by run.
   *
   * Not a convenience wrapper around the listing. `listEvalSuiteStageAnalytics`
   * pages a suite newest-first, so reaching a specific run through it means
   * walking pages until that run appears — unbounded work whose cost grows with
   * how long ago the run finished, and which cannot answer at all once the run
   * falls outside the caller's window. A reader that already knows the run
   * asks for the run.
   *
   * `404` means one of two different things, and the API does not distinguish
   * them on purpose: the run is not visible to this caller, or it has no
   * document. Both are UNMEASURED to a reader, and separating them would leak
   * the existence of runs in projects the caller cannot see.
   *
   * NOT backfilled, same as the listing: a run that terminalized before the
   * materializer shipped has no row, and that absence is the honest answer. No
   * client-side reconstruction exists to fall back on, by design.
   */
  getEvalRunStageAnalytics(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalStageAnalytics> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/stage-analytics`,
      {},
      options
    );
  }

  /**
   * Request (or with `force`, regenerate) the eval run's insights —
   * serverQuality behind the common envelope. SPENDS the org's model budget;
   * poll `getEvalRun().insights` rather than re-requesting.
   */
  requestEvalRunInsights(
    params: { projectId: string; runId: string; force?: boolean },
    options?: RequestOptions
  ): Promise<PlatformEvalRunInsightsRequested> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/insights`,
      { body: params.force ? { force: true } : {} },
      options
    );
  }

  /**
   * Request (or with `force`, re-request) LLM-as-judge grading of a finished
   * run. SPENDS the org's model budget; poll `getEvalRun().judges` rather than
   * re-requesting.
   *
   * `enable` grades a run whose config snapshot has the judge OFF. It is a
   * per-run answer, not a suite edit — grading reads the snapshot pinned when
   * the run was created, so turning the judge on for the suite does not reach
   * an already-recorded run.
   */
  requestEvalRunJudge(
    params: {
      projectId: string;
      runId: string;
      force?: boolean;
      enable?: boolean;
      model?: string;
      threshold?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalRunJudgeRequested> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/judge`,
      {
        body: {
          ...(params.force === true ? { force: true } : {}),
          ...(params.enable !== undefined ? { enable: params.enable } : {}),
          ...(params.model !== undefined ? { model: params.model } : {}),
          ...(params.threshold !== undefined
            ? { threshold: params.threshold }
            : {}),
        },
      },
      options
    );
  }

  /**
   * The repositories in an organization whose pull requests run an eval suite,
   * plus what the MCPJam GitHub App can reach.
   */
  listEvalCheckRepos(
    params: { organizationId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalCheckRepos> {
    return this.request(
      "GET",
      `/organizations/${encodeURIComponent(
        params.organizationId
      )}/eval-check-repos`,
      {},
      options
    );
  }

  /**
   * Connect a repository so its pull requests run one eval suite.
   *
   * `outagePolicy` is required rather than defaulted: it decides what a check
   * reports when MCPJam cannot conclude, and a surface that picks silently is
   * the one that produces repositories nobody chose a policy for.
   */
  connectEvalCheckRepo(
    params: {
      organizationId: string;
      projectId: string;
      suiteId: string;
      repo: string;
      outagePolicy: "fail_open" | "fail_closed";
    },
    options?: RequestOptions
  ): Promise<PlatformEvalCheckRepoConnected> {
    return this.request(
      "POST",
      `/organizations/${encodeURIComponent(
        params.organizationId
      )}/eval-check-repos`,
      {
        body: {
          projectId: params.projectId,
          suiteId: params.suiteId,
          repo: params.repo,
          outagePolicy: params.outagePolicy,
        },
      },
      options
    );
  }

  listEvalRunIterations(
    params: {
      projectId: string;
      runId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalIteration>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/iterations`,
      { query: { cursor: params.cursor, limit: params.limit } },
      options
    );
  }

  /** Full trace envelope (messages + analysis) for one iteration. */
  getEvalIterationTrace(
    params: { projectId: string; runId: string; iterationId: string },
    options?: RequestOptions
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(
        params.runId
      )}/iterations/${encodeURIComponent(params.iterationId)}/trace`,
      {},
      options
    );
  }

  /** Cancel an in-flight run; returns the run in its (now cancelled) state. */
  cancelEvalRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalRun> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/cancel`,
      {},
      options
    );
  }

  // ── Gate waivers ──────────────────────────────────────────────────────
  //
  // An audited, time-boxed override of a run's gate. Three calls, and the
  // asymmetry between them is deliberate: WAIVING is manage-tier, while
  // READING is available to anyone who can see the run — a waiver only its
  // grantors can see is not a visible waiver, and visibility is half the
  // requirement.
  //
  // None of these decide authorization; the platform mutation owns that. The
  // client does not pre-judge whether the caller may waive, because a client
  // that guesses wrong either blocks a legitimate override or lets an
  // illegitimate one look accepted until the write fails.

  /**
   * Grant a waiver over a failing run's gate.
   *
   * `reason` is stored UNREDACTED for the life of the suite: any surface
   * collecting one must warn the human first (`GATE_WAIVER_REASON_NOTICE`).
   * `expiresAt` is epoch ms, must be in the future, and is capped at 30 days
   * out by the platform — there is no way to ask for a permanent waiver.
   *
   * Re-waiving an already-waived run answers `status: "conflict"` with the
   * EXISTING waiver. That is a normal result, not an error: two active waivers
   * over one run would make "which reason is on the check" a race.
   */
  createGateWaiver(
    params: {
      projectId: string;
      runId: string;
      reason: string;
      expiresAt: number;
    },
    options?: RequestOptions
  ): Promise<PlatformGateWaiverWriteResult> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/gate-waivers`,
      { body: { reason: params.reason, expiresAt: params.expiresAt } },
      options
    );
  }

  /**
   * The waiver in force over a run, or `null`.
   *
   * `eval gate` does NOT need this — the run projection already carries
   * `gateWaiver`, so the gating path folds a waiver in without a second round
   * trip. This is the explicit read, for asking the question on its own.
   */
  getGateWaiver(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformGateWaiverRead> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/gate-waivers`,
      {},
      options
    );
  }

  /**
   * Revoke a waiver, putting the gate back.
   *
   * IDEMPOTENT: revoking an already-revoked waiver answers
   * `status: "already_revoked"` and is a SUCCESS, not an error — restamping it
   * would rewrite who actually ended the waiver.
   */
  revokeGateWaiver(
    params: { projectId: string; runId: string; waiverId: string },
    options?: RequestOptions
  ): Promise<PlatformGateWaiverWriteResult> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(
        params.runId
      )}/gate-waivers/${encodeURIComponent(params.waiverId)}`,
      {},
      options
    );
  }

  // ── Directory readiness ───────────────────────────────────────────────
  //
  // Asynchronous by design: a readiness run dials somebody else's server,
  // walks its redirect chain, discovers its authorization metadata and lists
  // its tools. A start answers `202` with a run id and everything after it is
  // a separate call.
  //
  // The TARGET comes from the saved server the path names, never from a body.
  // These methods have no URL parameter for the same reason the endpoint has
  // no URL field: a caller cannot point a hosted run at an arbitrary host.

  /**
   * Start a Claude connector-directory readiness run.
   *
   * Deterministic grading is FREE. `includeLlmObservations` is the only field
   * that can spend, and it defaults off.
   */
  startClaudeReadinessRun(
    params: {
      projectId: string;
      serverId: string;
    } & PlatformReadinessStartBody,
    options?: RequestOptions
  ): Promise<PlatformReadinessRunReceipt> {
    // Explicit picks, not a rest spread. The endpoint's body schema is
    // `strictObject`, and TypeScript's structural typing lets a caller hand a
    // WIDER object to this parameter — so a spread would forward whatever else
    // that object carries and turn a valid start into a 400. Worse, the
    // rejected request never reaches the idempotency key, so the caller's
    // retry dedupes against nothing. `publishScenario` picks for the same
    // reason.
    const { projectId, serverId } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/servers/${encodeURIComponent(
        serverId
      )}/readiness-runs/claude`,
      { body: pickReadinessStartBody(params) },
      options
    );
  }

  /**
   * Start an OpenAI plugin-directory readiness run.
   *
   * `submissionMode` is required by the TYPE as well as by the endpoint,
   * because it is never inferred: a run with no declared shape reads as
   * `mcp-only`, which reports the package lane not-applicable and turns a
   * missing input into a clean bill of health.
   */
  startOpenAIReadinessRun(
    params: {
      projectId: string;
      serverId: string;
    } & PlatformOpenAIReadinessStartBody,
    options?: RequestOptions
  ): Promise<PlatformReadinessRunReceipt> {
    // Explicit picks — see `startClaudeReadinessRun`.
    const { projectId, serverId, submissionMode } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/servers/${encodeURIComponent(
        serverId
      )}/readiness-runs/openai`,
      { body: { ...pickReadinessStartBody(params), submissionMode } },
      options
    );
  }

  /** Lane statuses, coverage and the observation axis. Poll this. */
  getReadinessRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformReadinessRun> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/readiness-runs/${encodeURIComponent(params.runId)}`,
      {},
      options
    );
  }

  listReadinessRuns(
    params: {
      projectId: string;
      readinessKind?: PlatformReadinessKind;
      serverId?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformReadinessRun>> {
    const { projectId, ...query } = params;
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/readiness-runs`,
      { query },
      options
    );
  }

  /**
   * Cancel an in-flight run.
   *
   * The executing node learns about this on its next heartbeat and aborts the
   * run in flight — which matters more than the row's status, because the
   * thing being stopped is traffic to somebody else's server.
   */
  cancelReadinessRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<{ runId: string; projectId: string; status: string }> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/readiness-runs/${encodeURIComponent(params.runId)}/cancel`,
      {},
      options
    );
  }

  /**
   * The full report: every finding, with its class, provenance, citation and
   * remediation.
   *
   * Returned as `unknown` deliberately. The report's shape is the SDK's
   * `ClaudeReadinessResult` / `OpenAIReadinessResult`, and importing either
   * here would pull the whole readiness result model into the platform entry —
   * which is loaded by surfaces that only ever render a lane status. A caller
   * that wants the narrow type imports it from `@mcpjam/sdk/browser` and
   * narrows on `readinessKind`.
   */
  getReadinessReport(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/readiness-runs/${encodeURIComponent(params.runId)}/report`,
      {},
      options
    );
  }

  /**
   * Start a persisted conformance run against a saved server.
   *
   * The target is the saved server the path names — never a caller URL.
   * OAuth is not startable here. Returns a receipt; poll `getConformanceRun`.
   */
  startConformanceRun(
    params: {
      projectId: string;
      serverId: string;
      suites?: PlatformConformanceSuiteKind[];
      idempotencyKey?: string;
      protocolVersion?: string;
      engineVersion?: string;
    },
    options?: RequestOptions
  ): Promise<PlatformConformanceRunReceipt> {
    const {
      projectId,
      serverId,
      suites,
      idempotencyKey,
      protocolVersion,
      engineVersion,
    } = params;
    const body: Record<string, unknown> = {};
    if (suites !== undefined) body.suites = suites;
    if (idempotencyKey !== undefined) body.idempotencyKey = idempotencyKey;
    if (protocolVersion !== undefined) body.protocolVersion = protocolVersion;
    if (engineVersion !== undefined) body.engineVersion = engineVersion;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/servers/${encodeURIComponent(
        serverId
      )}/conformance-runs`,
      { body },
      options
    );
  }

  getConformanceRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformConformanceRun> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/conformance-runs/${encodeURIComponent(params.runId)}`,
      {},
      options
    );
  }

  listConformanceRuns(
    params: {
      projectId: string;
      serverId?: string;
      limit?: number;
      cursor?: string;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformConformanceRun>> {
    const { projectId, ...query } = params;
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(projectId)}/conformance-runs`,
      { query },
      options
    );
  }

  getConformanceReport(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformConformanceReport> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/conformance-runs/${encodeURIComponent(params.runId)}/report`,
      {},
      options
    );
  }

  /** One row per authored step (status + reason + evidence) for one iteration. */
  getEvalRunSteps(
    params: { projectId: string; runId: string; iterationId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalStepResult>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(
        params.runId
      )}/iterations/${encodeURIComponent(params.iterationId)}/steps`,
      {},
      options
    );
  }

  /**
   * `GET /projects/{p}/eval-runs/{runId}/compare` — this run against a
   * baseline.
   *
   * Omitting `baseRunId` selects the nearest earlier COMPLETED run in the same
   * suite. Baseline resolution is server-side on purpose: `listEvalSuiteRuns`
   * has no cursor, so a client-side walk cannot be bounded-correct, and the
   * policy belongs beside the backend's other baseline resolvers.
   *
   * THROWS `PlatformApiError` (404, `details.reason === "BASELINE_NOT_FOUND"`)
   * when no baseline resolves — a suite's first run, or one whose whole lookup
   * window never completed. That is an incomplete comparison, not a failing
   * one; callers must not map it to a regression.
   */
  compareEvalRun(
    params: {
      projectId: string;
      runId: string;
      baseRunId?: string;
      /**
       * Pin the baseline by SOURCE SHA instead of run id. Mutually exclusive
       * with `baseRunId` — sending both is a 400. A SHA that resolves to no
       * completed run in the suite is the ordinary BASELINE_NOT_FOUND 404, not
       * this error: "we looked and established nothing" stays distinct from
       * "you asked for something impossible".
       */
      baseCommitSha?: string;
      previewChars?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformRunCompare> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/compare`,
      {
        query: {
          baseRunId: params.baseRunId,
          baseCommitSha: params.baseCommitSha,
          previewChars: params.previewChars,
        },
      },
      options
    );
  }

  listEvalSuiteRuns(
    params: { projectId: string; suiteId: string; limit?: number },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalRun>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/runs`,
      { query: { limit: params.limit } },
      options
    );
  }

  // ── Eval suite/case editing ──────────────────────────────────────────

  getEvalSuite(
    params: { projectId: string; suiteId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteDetail> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}`,
      {},
      options
    );
  }

  updateEvalSuite(
    params: {
      projectId: string;
      suiteId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteDetail> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}`,
      { body: params.body },
      options
    );
  }

  deleteEvalSuite(
    params: { projectId: string; suiteId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}`,
      {},
      options
    );
  }

  setEvalSuiteSchedule(
    params: {
      projectId: string;
      suiteId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteDetail> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/schedule`,
      { body: params.body },
      options
    );
  }

  listEvalCases(
    params: { projectId: string; suiteId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalCase>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/cases`,
      {},
      options
    );
  }

  getEvalCase(
    params: { projectId: string; suiteId: string; caseId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalCase> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(
        params.suiteId
      )}/cases/${encodeURIComponent(params.caseId)}`,
      {},
      options
    );
  }

  createEvalCase(
    params: {
      projectId: string;
      suiteId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalCase> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/cases`,
      { body: params.body },
      options
    );
  }

  /**
   * Author several cases in one call. The bulk form of {@link createEvalCase} —
   * same case body, same identity rules — so an import writes one request per
   * chunk instead of one per case.
   */
  createEvalCases(
    params: {
      projectId: string;
      suiteId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalCaseBatchResult> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/cases/batch`,
      { body: params.body },
      options
    );
  }

  updateEvalCase(
    params: {
      projectId: string;
      suiteId: string;
      caseId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalCase> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(
        params.suiteId
      )}/cases/${encodeURIComponent(params.caseId)}`,
      { body: params.body },
      options
    );
  }

  deleteEvalCase(
    params: { projectId: string; suiteId: string; caseId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalCaseDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(
        params.suiteId
      )}/cases/${encodeURIComponent(params.caseId)}`,
      {},
      options
    );
  }

  generateEvalCases(
    params: {
      projectId: string;
      suiteId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalCasesGenerated> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/cases/generate`,
      { body: params.body },
      options
    );
  }

  validateServer(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "validate", options);
  }

  doctorServer(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformDoctorReport> {
    return this.serverOp(params, "doctor", options);
  }

  exportServer(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "export", options);
  }

  listServerTools(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.serverOp(params, "tools", options);
  }

  listServerResources(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.serverOp(params, "resources", options);
  }

  listServerPrompts(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.serverOp(params, "prompts", options);
  }

  /**
   * `POST /projects/{p}/servers/{s}/tools/call` — execute one tool and return
   * the MCP CallToolResult. Tool-level failures (`isError: true`) are
   * successful calls; only transport/auth errors throw.
   */
  callServerTool(
    params: ServerScope & {
      body: { toolName: string; parameters?: Record<string, unknown> };
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "tools/call", options);
  }

  /**
   * `POST /projects/{p}/servers/{s}/widgets/render` — render an MCP App
   * widget headlessly and describe what it produced.
   *
   * Defaults return the widget as an ACCESSIBILITY TREE and omit the
   * screenshot. That is the reverse of the local Inspector route, and
   * deliberate: the caller here is usually a model, for which a base64 image
   * it may not be able to see is the most expensive possible way to say
   * nothing.
   */
  renderServerWidget(
    params: ServerScope & {
      body: {
        toolName: string;
        parameters?: Record<string, unknown>;
        includeSnapshot?: boolean;
        includeScreenshot?: boolean;
        injectOpenAiCompat?: boolean;
        viewport?: { width: number; height: number };
      };
    },
    options?: RequestOptions
  ): Promise<PlatformWidgetRender> {
    return this.serverOp(
      params,
      "widgets/render",
      options
    ) as Promise<PlatformWidgetRender>;
  }

  /** `POST /projects/{p}/servers/{s}/prompts/get` — render one prompt. */
  getServerPrompt(
    params: ServerScope & {
      body: {
        promptName: string;
        arguments?: Record<string, string | number | boolean>;
      };
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "prompts/get", options);
  }

  /** `POST /projects/{p}/servers/{s}/resources/read` — read one resource. */
  readServerResource(
    params: ServerScope & { body: { uri: string } },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "resources/read", options);
  }

  /**
   * `POST /projects/{p}/servers/{s}/skills` — the server's Agent Skills
   * catalog (SEP-2640).
   *
   * Not a page: the catalog is drained server-side, because duplicate-URI
   * detection spans the whole listing and a page boundary would make a
   * contradiction depend on where the caller stopped reading.
   */
  listServerSkills(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "skills", options);
  }

  /**
   * `POST /projects/{p}/servers/{s}/skills/get` — one verified skill by uri.
   *
   * Reaches skills a partial listing never mentioned, which is the reason
   * `skills/get` exists in the SEP at all. Answers with `{ skill }` or with a
   * `{ refusal }` naming the check that failed.
   */
  getServerSkill(
    params: ServerScope & { body: { uri: string } },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "skills/get", options);
  }

  /**
   * `POST /projects/{p}/servers/{s}/skills/read-file` — one verified
   * supporting file, checked against the skill's own manifest.
   */
  readServerSkillFile(
    params: ServerScope & { body: { skillUri: string; resourceUri: string } },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "skills/read-file", options);
  }

  /**
   * `POST /projects/{p}/tunnels` — register (or revive) a relay tunnel for a
   * named project server and return the grant the caller hosts the tunnel
   * WebSocket with. Each call rotates the tunnel secret and revokes any
   * previous grant, so this is also the rotation path.
   */
  createTunnel(
    params: { projectId: string; name: string },
    options?: RequestOptions
  ): Promise<PlatformTunnelGrant> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/tunnels`,
      { body: { name: params.name } },
      options
    );
  }

  /**
   * `POST /projects/{p}/tunnels/{s}/close` — revoke the live tunnel grant.
   * The server record (and its slug) is kept so the tunnel revives on the
   * next `createTunnel`.
   */
  closeTunnel(
    params: { projectId: string; serverId: string },
    options?: RequestOptions
  ): Promise<PlatformTunnelClosed> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/tunnels/${encodeURIComponent(params.serverId)}/close`,
      {},
      options
    );
  }

  // ── Journeys (the Swarms product's API surface) ─────────────────────────
  //
  // Reads need project membership. LAUNCH and AUTHORING writes are behind the
  // `sandboxes-enabled` beta flag, enforced server-side per organization — an
  // unflagged caller gets FEATURE_UNAVAILABLE from those.
  //
  // `cancelJourneyRun` is NOT gated, deliberately: cancelling reduces exposure
  // and spend, so it has to keep working for an organization that has just lost
  // the flag with a run already in flight. Do not have callers pre-suppress it
  // on a flag check — losing access to the feature is exactly when stopping it
  // matters most.
  //
  // Every route is project-scoped in the PATH and re-checked server-side, so a
  // journey or run id belonging to another of your projects reads as 404
  // rather than crossing over.

  listJourneys(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformJourney>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/journeys`,
      {},
      options
    );
  }

  listJourneyRuns(
    params: {
      projectId: string;
      journeyId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformJourneyRun>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journeys/${encodeURIComponent(params.journeyId)}/runs`,
      { query: pageQuery(params) },
      options
    );
  }

  getJourneyRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformJourneyRun> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-runs/${encodeURIComponent(params.runId)}`,
      {},
      options
    );
  }

  listJourneyRunSessions(
    params: {
      projectId: string;
      runId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformJourneyRunSession>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-runs/${encodeURIComponent(params.runId)}/sessions`,
      { query: pageQuery(params) },
      options
    );
  }

  /**
   * Launch a journey. Returns as soon as the run exists — **202**, not a
   * finished run: a fan-out can take hours, so poll `getJourneyRun` or watch
   * `listJourneyRunSessions`.
   *
   * IDEMPOTENT ON `options.idempotencyKey`, and you want to pass one. A launch
   * spends model credits, so a retry after a dropped response must not run the
   * journey twice; replaying a key returns the ORIGINAL run with
   * `deduped: true`. Omit it and every call starts a new run — the server has
   * nothing to match a retry against, so it treats each as a new launch.
   *
   * Behind the `sandboxes-enabled` beta flag — launching creates exposure and
   * spend, so an unflagged organization gets a 403 here.
   */
  launchJourneyRun(
    params: {
      projectId: string;
      journeyId: string;
      waveId?: string;
      environmentIds?: string[];
    },
    options?: RequestOptions
  ): Promise<PlatformJourneyRunLaunched> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journeys/${encodeURIComponent(params.journeyId)}/runs`,
      {
        body: {
          ...(params.waveId ? { waveId: params.waveId } : {}),
          ...(params.environmentIds?.length
            ? { environmentIds: params.environmentIds }
            : {}),
        },
      },
      options
    );
  }

  /**
   * Stop a running journey run.
   *
   * Idempotent: cancelling an already-cancelled run succeeds with
   * `alreadyCanceled: true` rather than conflicting. A run that finished on
   * its own is a 409 — reporting success there would tell you that you stopped
   * something that had already completed.
   *
   * NOT behind the beta flag, unlike launching: stopping a run must keep
   * working for an organization that has lost it.
   */
  cancelJourneyRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformJourneyRunCanceled> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-runs/${encodeURIComponent(params.runId)}/cancel`,
      {},
      options
    );
  }

  // ── Personas, swarms, generation (Swarms authoring) ─────────────────────
  //
  // The half of the loop that was missing: `/api/v1` could launch a journey
  // and read its results but could not create one, because a journey needs a
  // persona and there was no way to make a persona outside the app.
  //
  // Creates and updates are behind the `sandboxes-enabled` beta flag. Reads
  // and the soft deletes are not — an org that has just lost the flag must
  // still be able to see and clean up what it authored.

  listPersonas(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformPersona>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/personas`,
      {},
      options
    );
  }

  getPersona(
    params: { projectId: string; personaId: string },
    options?: RequestOptions
  ): Promise<PlatformPersona> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/personas/${encodeURIComponent(params.personaId)}`,
      {},
      options
    );
  }

  /**
   * IDEMPOTENT ON `options.idempotencyKey`, and worth passing even though
   * creating a persona spends nothing: the server replays the key BEFORE it
   * uniquifies the slug, so a retry without one leaves you with a second,
   * near-identical persona named `…-2` rather than the row you already made.
   */
  createPersona(
    params: {
      projectId: string;
      name: string;
      role: string;
      notes?: string;
      avatarShape?: number;
      avatarPalette?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPersona> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/personas`,
      { body },
      options
    );
  }

  updatePersona(
    params: {
      projectId: string;
      personaId: string;
      name?: string;
      role?: string;
      notes?: string;
      avatarShape?: number;
      avatarPalette?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPersona> {
    const { projectId, personaId, ...body } = params;
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(projectId)}/personas/${encodeURIComponent(
        personaId
      )}`,
      { body },
      options
    );
  }

  /**
   * SOFT delete. The persona leaves the roster and cannot be used for new
   * journeys, but historical runs and sessions keep resolving it — a finished
   * run does not lose the character it ran as. A second call answers 404,
   * which cleanup should read as success.
   */
  deletePersona(
    params: { projectId: string; personaId: string },
    options?: RequestOptions
  ): Promise<PlatformPersonaDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/personas/${encodeURIComponent(params.personaId)}`,
      {},
      options
    );
  }

  // ── Project secrets ───────────────────────────────────────────────────────
  //
  // WRITE-ONLY. Every method below returns metadata; none returns a value, and
  // there is deliberately no method that could. A secret is written and
  // delivered into a run, never read back.

  /**
   * List the project's secrets — METADATA ONLY.
   *
   * Returns project-shared secrets plus the CALLER'S OWN personal ones. Another
   * member's personal secret is absent entirely: not redacted, not listed with
   * a hidden value — its name never appears.
   */
  listSecrets(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformSecret>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/secrets`,
      {},
      options
    );
  }

  /** One secret's metadata. Never its value. */
  getSecret(
    params: { projectId: string; secretId: string },
    options?: RequestOptions
  ): Promise<PlatformSecret> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/secrets/${encodeURIComponent(params.secretId)}`,
      {},
      options
    );
  }

  /**
   * Create a secret.
   *
   * THE VALUE BECOMES VISIBLE TO WHATEVER CARRIES THIS CALL. It is in the
   * request body, so it passes through whatever process, log, shell history or
   * transcript the call is made from. Prefer reading it from a file, an
   * environment variable, or stdin rather than pasting it into an argument.
   *
   * `delivery` is required, with no default, because it decides whether the
   * value ends up INSIDE the sandbox:
   *   - `"brokered"` — injected by the egress proxy outside the VM. The box
   *     never holds it. Prevents extraction, not use, and works for HTTPS APIs
   *     only.
   *   - `"materialized"` — a real environment variable in the box, so a CLI can
   *     read it. Extractable by design.
   *
   * `sharing` defaults to `"project"`. A non-admin asking for it is refused,
   * not silently downgraded to personal — a downgrade would look like success
   * and then not reach anyone else's sessions.
   *
   * IDEMPOTENT ON `options.idempotencyKey`, and worth passing: a retried create
   * without one fails as a name conflict with the row the first attempt already
   * made, which is indistinguishable from a genuine collision.
   */
  createSecret(
    params: {
      projectId: string;
      name: string;
      value: string;
      description?: string;
      delivery: "brokered" | "materialized";
      brokerHosts?: string[];
      brokerHeader?: string;
      brokerTemplate?: string;
      sharing?: "user" | "project";
    },
    options?: RequestOptions
  ): Promise<PlatformSecret> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/secrets`,
      { body },
      options
    );
  }

  /**
   * Rotate a secret's value and/or edit its delivery binding.
   *
   * ROTATION REACHES NEW RUNS ONLY. A session already running holds the old
   * value — materialized in its box's environment, or inside an egress
   * transform that cannot be read back — and there is no safe way to replace it
   * mid-run.
   *
   * `name` and `sharing` are absent on purpose: both are immutable. Renaming
   * would break the workflows that reference the environment variable, and
   * re-sharing would change who has been handed the value without changing the
   * value. Delete and recreate for either.
   */
  updateSecret(
    params: {
      projectId: string;
      secretId: string;
      value?: string;
      /** `null` clears the description; omit to leave it unchanged. */
      description?: string | null;
      delivery?: "brokered" | "materialized";
      brokerHosts?: string[];
      brokerHeader?: string;
      brokerTemplate?: string;
    },
    options?: RequestOptions
  ): Promise<PlatformSecret> {
    const { projectId, secretId, ...body } = params;
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(
        secretId
      )}`,
      { body },
      options
    );
  }

  /**
   * Delete a secret — HARD. The row and the ciphertext both go.
   *
   * Not blocked when an environment still selects it: the selection resolver
   * drops ids that no longer resolve, and refusing would make a leaked
   * credential un-revokable until someone edited every environment naming it.
   * Revocation is never gated on cleanup.
   */
  deleteSecret(
    params: { projectId: string; secretId: string },
    options?: RequestOptions
  ): Promise<PlatformSecretDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/secrets/${encodeURIComponent(params.secretId)}`,
      {},
      options
    );
  }

  getJourney(
    params: { projectId: string; journeyId: string },
    options?: RequestOptions
  ): Promise<PlatformJourney> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journeys/${encodeURIComponent(params.journeyId)}`,
      {},
      options
    );
  }

  /** IDEMPOTENT ON `options.idempotencyKey`. */
  createJourney(
    params: {
      projectId: string;
      goal: string;
      personaId: string;
      sessionsPerTarget: number;
      maxTurns: number;
      name?: string;
      swarmId?: string;
      environmentIds?: string[];
      serverAttachmentId?: string;
      hostIds?: string[];
    },
    options?: RequestOptions
  ): Promise<PlatformJourney> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/journeys`,
      { body },
      options
    );
  }

  /**
   * `null` CLEARS a field; omitting it leaves it alone. That tri-state is the
   * only way to say "stop fanning this journey out across environments".
   *
   * `sessionsPerTarget` and `maxTurns` must move together — they are one
   * config object upstream, so a partial update would need a read-modify-write
   * that could silently clobber a concurrent edit.
   */
  updateJourney(
    params: {
      projectId: string;
      journeyId: string;
      name?: string;
      goal?: string;
      environmentIds?: string[] | null;
      serverAttachmentId?: string | null;
      hostIds?: string[];
      sessionsPerTarget?: number;
      maxTurns?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformJourney> {
    const { projectId, journeyId, ...body } = params;
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(projectId)}/journeys/${encodeURIComponent(
        journeyId
      )}`,
      { body },
      options
    );
  }

  /**
   * ARCHIVES the journey. Its runs, sessions and scorecards stay readable —
   * deleting the results of work that already happened is not what anyone
   * means by removing a journey from their list.
   */
  archiveJourney(
    params: { projectId: string; journeyId: string },
    options?: RequestOptions
  ): Promise<PlatformJourneyArchived> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journeys/${encodeURIComponent(params.journeyId)}`,
      {},
      options
    );
  }

  listSwarms(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformSwarm>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/swarms`,
      {},
      options
    );
  }

  getSwarm(
    params: { projectId: string; swarmId: string },
    options?: RequestOptions
  ): Promise<PlatformSwarm> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/swarms/${encodeURIComponent(params.swarmId)}`,
      {},
      options
    );
  }

  /** IDEMPOTENT ON `options.idempotencyKey`. */
  createSwarm(
    params: {
      projectId: string;
      name: string;
      sessionsPerTarget: number;
      maxTurns: number;
      description?: string;
      environmentIds?: string[];
    },
    options?: RequestOptions
  ): Promise<PlatformSwarm> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/swarms`,
      { body },
      options
    );
  }

  updateSwarm(
    params: {
      projectId: string;
      swarmId: string;
      name?: string;
      description?: string | null;
      environmentIds?: string[] | null;
      sessionsPerTarget?: number;
      maxTurns?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformSwarm> {
    const { projectId, swarmId, ...body } = params;
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(projectId)}/swarms/${encodeURIComponent(
        swarmId
      )}`,
      { body },
      options
    );
  }

  /**
   * ARCHIVES the container. Journeys authored under it keep working and keep
   * their `swarmId` — the reference is authoring provenance, not ownership.
   */
  archiveSwarm(
    params: { projectId: string; swarmId: string },
    options?: RequestOptions
  ): Promise<PlatformSwarmArchived> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/swarms/${encodeURIComponent(params.swarmId)}`,
      {},
      options
    );
  }

  /**
   * Draft personas with an LLM. NOTHING IS SAVED — feed what you want to keep
   * to `createPersona`. That is also why there is no idempotency key: a call
   * with no effect has no duplicate to prevent, and offering one would imply
   * the drafts are stable across retries, which they are not.
   *
   * Exactly one grounding source: `serverAttachmentId` or `environmentId`.
   */
  generatePersonas(
    params: {
      projectId: string;
      serverAttachmentId?: string;
      environmentId?: string;
      journeyCount?: number;
      personaCount?: number;
      description?: string;
      existingPersonas?: Array<{ name: string; role: string }>;
    },
    options?: RequestOptions
  ): Promise<PlatformGenerationDrafts> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/personas/generate`,
      { body },
      options
    );
  }

  /**
   * Draft journeys for a persona. The persona is passed BY VALUE, not by id:
   * the create flow drafts a persona and its journeys before either exists,
   * so requiring a saved persona would force you to keep a draft you may
   * discard. Nothing is saved here either.
   */
  generateJourneys(
    params: {
      projectId: string;
      persona: { name: string; role: string; notes?: string };
      serverAttachmentId?: string;
      environmentId?: string;
      journeyCount?: number;
      description?: string;
    },
    options?: RequestOptions
  ): Promise<PlatformGenerationDrafts> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/journeys/generate`,
      { body },
      options
    );
  }

  // ── Swarm insights ──────────────────────────────────────────────────────
  //
  // Three different kinds of evidence, deliberately not merged into one run
  // payload. The scorecard is deterministic and free; findings aggregate it
  // across waves; wave insights are LLM prose that SPENDS against the org's
  // shared daily ledger. Reach for the scorecard first — it is usually the
  // whole answer.

  getSwarmOverview(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformSwarmOverview> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/journeys-overview`,
      {},
      options
    );
  }

  getJourneyRunScorecard(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformRunScorecard> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-runs/${encodeURIComponent(params.runId)}/scorecard`,
      {},
      options
    );
  }

  listSwarmFindings(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformSwarmFinding>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/journey-findings`,
      {},
      options
    );
  }

  dismissSwarmFinding(
    params: { projectId: string; findingId: string },
    options?: RequestOptions
  ): Promise<PlatformFindingDismissed> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-findings/${encodeURIComponent(params.findingId)}/dismiss`,
      {},
      options
    );
  }

  undismissSwarmFinding(
    params: { projectId: string; findingId: string },
    options?: RequestOptions
  ): Promise<PlatformFindingDismissed> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-findings/${encodeURIComponent(params.findingId)}/undismiss`,
      {},
      options
    );
  }

  getWaveInsights(
    params: { projectId: string; waveId: string },
    options?: RequestOptions
  ): Promise<PlatformWaveInsights> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/waves/${encodeURIComponent(params.waveId)}/insights`,
      {},
      options
    );
  }

  /**
   * Request an LLM pass over a wave. Answers **202** — generation is
   * scheduled, not done; poll `getWaveInsights`.
   *
   * SPENDS against the org's `insightsPerDay` ledger, which is SHARED with
   * user-testing window insights. `force` regenerates over a wave that already
   * has insights and spends again; the usual reason to reach for it is a
   * caller that did not poll.
   */
  requestWaveInsights(
    params: { projectId: string; waveId: string; force?: boolean },
    options?: RequestOptions
  ): Promise<PlatformWaveInsightsRequested> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/waves/${encodeURIComponent(params.waveId)}/insights`,
      { body: params.force ? { force: true } : {} },
      options
    );
  }

  /**
   * Cancel an in-flight generation. The recovery path when a request was made
   * by mistake or its runner went silent — without it a wave stuck `pending`
   * can only be re-requested with `force`, which spends again.
   */
  cancelWaveInsights(
    params: { projectId: string; waveId: string },
    options?: RequestOptions
  ): Promise<PlatformWaveInsightsCanceled> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/waves/${encodeURIComponent(params.waveId)}/insights`,
      {},
      options
    );
  }

  /**
   * What this caller may do in the project — role, beta-gate state, plan
   * limits, and the derived booleans to branch on.
   *
   * Ask this BEFORE planning work on a static surface (MCP catalog, CLI, agent
   * registry), none of which can advertise a per-organization beta. It is
   * descriptive: the write paths enforce independently, so a stale answer
   * costs a clean 403 rather than an incorrect success.
   */
  getCapabilities(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformCapabilities> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/capabilities`,
      {},
      options
    );
  }

  // ── Scenarios (user testing) ────────────────────────────────────────────
  //
  // Both require project ADMIN. Publishing is additionally behind the
  // `sandboxes-enabled` beta flag; UNPUBLISHING deliberately is not, so an org
  // that loses the flag can still take a live scenario down.

  /**
   * `name`, `description` and `mode` are CREATE-TIME overrides applied in the
   * same call, so the scenario is never briefly live in a wider mode than the
   * caller asked for. They are ignored on a republish (the response says
   * `overridesIgnored: true`) — changing an existing scenario is
   * `updateUserTestingScenario`.
   */
  publishScenario(
    params: {
      projectId: string;
      environmentId: string;
      name?: string;
      description?: string;
      mode?: "project_members" | "invited_only" | "anyone_with_link";
    },
    options?: RequestOptions
  ): Promise<PlatformScenario> {
    const { projectId, environmentId } = params;
    // Explicit picks, not a rest spread: TypeScript's structural typing lets a
    // wider object through, and the route's schema is strict — an unknown key
    // forwarded here turns a valid publish into a 400.
    const body = Object.fromEntries(
      Object.entries({
        name: params.name,
        description: params.description,
        mode: params.mode,
      }).filter(([, value]) => value !== undefined)
    );
    return this.request(
      "PUT",
      `/projects/${encodeURIComponent(
        projectId
      )}/environments/${encodeURIComponent(environmentId)}/scenario`,
      // Bodyless when there is nothing to send — the common case, and what
      // existing callers already put on the wire.
      Object.keys(body).length > 0 ? { body } : {},
      options
    );
  }

  unpublishScenario(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformScenarioDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}/scenario`,
      {},
      options
    );
  }

  // ── User testing ────────────────────────────────────────────────────────
  //
  // What a published scenario produced, and who may reach it. `publishScenario`
  // above creates one (keyed by environment, because the scenario does not
  // exist yet); everything here is keyed by the scenario.
  //
  // AUTHORIZATION DIFFERS from the rest of this client: these gate on the
  // WORKSPACE role rather than the project role, and workspace MEMBERSHIP is
  // enough for most of them — mode changes, renames, member edits and link
  // rotation included. Only guest execution and rebinding need project
  // ADMIN. A legacy
  // workspace with no organization hard-denies delegated (`sk_`) callers
  // entirely — a documented limitation, not a bug you can grant your way out
  // of.

  /**
   * Publish an environment as a scenario.
   *
   * `name`, `description` and `mode` are CREATE-TIME overrides applied in the
   * same call, so the scenario is never briefly live in a wider mode than you
   * asked for. They are ignored on a republish (the response says
   * `overridesIgnored: true`), because re-applying `mode` would let a routine
   * idempotent publish widen a scenario someone had narrowed by hand.
   */
  publishUserTestingScenario(
    params: {
      projectId: string;
      environmentId: string;
      name?: string;
      description?: string;
      mode?: "project_members" | "invited_only" | "anyone_with_link";
    },
    options?: RequestOptions
  ): Promise<PlatformScenario> {
    const { projectId, environmentId, ...body } = params;
    return this.request(
      "PUT",
      `/projects/${encodeURIComponent(
        projectId
      )}/environments/${encodeURIComponent(environmentId)}/scenario`,
      { body },
      options
    );
  }

  /**
   * Scenario detail, with the common insights envelope when the caller may
   * have it. `insights` is OPTIONAL: the envelope is gated on workspace
   * membership while the scenario is visible more widely, so a
   * lower-privilege viewer — and any server predating the envelope — gets the
   * scenario without it rather than an error. Treat absence as
   * `not_available`, never as "no findings".
   */
  getUserTestingScenario(
    params: { projectId: string; scenarioId: string },
    options?: RequestOptions
  ): Promise<PlatformUserTestingScenarioDetail> {
    return this.request(
      "GET",
      this.userTestingPath(params.projectId, params.scenarioId),
      {},
      options
    );
  }

  /**
   * Edit a scenario. SINGLE-CONCERN: send `mode` on its own, or `name` and
   * `description` together — never both. Identity and exposure are separate
   * mutations upstream, so a mixed request would have to apply them in
   * sequence, and a failure between the two leaves the scenario half-updated
   * on the half that decides who can reach it.
   */
  updateUserTestingScenario(
    params: {
      projectId: string;
      scenarioId: string;
      name?: string;
      description?: string;
      mode?: "project_members" | "invited_only" | "anyone_with_link";
    },
    options?: RequestOptions
  ): Promise<PlatformUserTestingScenario> {
    const { projectId, scenarioId, ...body } = params;
    return this.request(
      "PATCH",
      this.userTestingPath(projectId, scenarioId),
      { body },
      options
    );
  }

  /** Session SUMMARIES. Transcripts are a separate, explicit read. */
  listUserTestingSessions(
    params: {
      projectId: string;
      scenarioId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformUserTestingSession>> {
    return this.request(
      "GET",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/sessions`,
      { query: pageQuery(params) },
      options
    );
  }

  /**
   * One session's transcript, PAGED and projected to role + text + timing.
   *
   * These are real people's conversations with your product. The API never
   * hands back the stored blob URL, so a caller cannot pass "read this
   * transcript" onward as an unrevocable capability.
   */
  getUserTestingSession(
    params: {
      projectId: string;
      scenarioId: string;
      sessionId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformUserTestingSessionDetail> {
    return this.request(
      "GET",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/sessions/${encodeURIComponent(params.sessionId)}`,
      { query: pageQuery(params) },
      options
    );
  }

  getUserTestingMetrics(
    params: { projectId: string; scenarioId: string; population?: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/metrics`,
      {
        query: params.population ? { population: params.population } : {},
      },
      options
    );
  }

  /**
   * Usage breakdown. Read `scan.truncated` before quoting any rate from this:
   * true means the rates were computed over the most recent N sessions rather
   * than all of them, and dropping the flag turns a conditional statistic into
   * an unconditional claim.
   */
  getUserTestingUsage(
    params: { projectId: string; scenarioId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/usage`,
      {},
      options
    );
  }

  listUserTestingFindings(
    params: { projectId: string; scenarioId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.request(
      "GET",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/findings`,
      {},
      options
    );
  }

  /** Also how you learn the CURRENT window id, which the insights read takes. */
  getUserTestingSignals(
    params: { projectId: string; scenarioId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/signals`,
      {},
      options
    );
  }

  getUserTestingInsights(
    params: { projectId: string; scenarioId: string; windowId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/windows/${encodeURIComponent(params.windowId)}/insights`,
      {},
      options
    );
  }

  /**
   * Ask a model to analyze the scenario's current window. **202** — scheduled,
   * not done. SPENDS against the organization's daily insights budget, which
   * is SHARED with swarm wave insights.
   */
  requestUserTestingInsights(
    params: { projectId: string; scenarioId: string; force?: boolean },
    options?: RequestOptions
  ): Promise<PlatformUserTestingInsightsRequested> {
    return this.request(
      "POST",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/insights`,
      { body: params.force ? { force: true } : {} },
      options
    );
  }

  cancelUserTestingInsights(
    params: { projectId: string; scenarioId: string; windowId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/insights`,
      { body: { windowId: params.windowId } },
      options
    );
  }

  dismissUserTestingFinding(
    params: { projectId: string; scenarioId: string; findingId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.userTestingFindingAction(params, "dismiss", options);
  }

  undismissUserTestingFinding(
    params: { projectId: string; scenarioId: string; findingId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.userTestingFindingAction(params, "undismiss", options);
  }

  /**
   * Replace the guest-execution caps.
   *
   * A full replacement, not a patch: these only mean something as a SET, and
   * raising one while leaving a stale sibling behind produces a combination
   * nobody chose. Project ADMIN.
   */
  setUserTestingGuestExecution(
    params: {
      projectId: string;
      scenarioId: string;
      guestExecution: PlatformGuestExecution;
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "PUT",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/guest-execution`,
      { body: params.guestExecution },
      options
    );
  }

  /**
   * Rotate the share link. DESTRUCTIVE and immediate: the old link stops
   * working and every session on it dies. There is no rotating back.
   */
  rotateUserTestingLink(
    params: { projectId: string; scenarioId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/rotate-link`,
      {},
      options
    );
  }

  /** Upsert by email, so re-inviting someone is not an error. */
  upsertUserTestingMember(
    params: {
      projectId: string;
      scenarioId: string;
      email: string;
      sendInviteEmail?: boolean;
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    const { projectId, scenarioId, ...body } = params;
    return this.request(
      "PUT",
      `${this.userTestingPath(projectId, scenarioId)}/members`,
      { body },
      options
    );
  }

  removeUserTestingMember(
    params: { projectId: string; scenarioId: string; member: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/members/${encodeURIComponent(params.member)}`,
      {},
      options
    );
  }

  /**
   * Point a scenario at a DIFFERENT environment, keeping its link, members and
   * session history. The alternative — unpublish and republish — mints a new
   * link, which means re-sharing it with everyone who had the old one.
   */
  rebindUserTestingScenario(
    params: { projectId: string; scenarioId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/rebind`,
      { body: { environmentId: params.environmentId } },
      options
    );
  }

  private userTestingPath(projectId: string, scenarioId: string): string {
    return `/projects/${encodeURIComponent(
      projectId
    )}/user-testing/scenarios/${encodeURIComponent(scenarioId)}`;
  }

  private userTestingFindingAction(
    params: { projectId: string; scenarioId: string; findingId: string },
    action: "dismiss" | "undismiss",
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/findings/${encodeURIComponent(params.findingId)}/${action}`,
      {},
      options
    );
  }

  private sharePath(
    projectId: string,
    resourceType: string,
    resourceId: string
  ): string {
    return `/projects/${encodeURIComponent(
      projectId
    )}/shares/${encodeURIComponent(resourceType)}/${encodeURIComponent(
      resourceId
    )}`;
  }

  getShareSettings(
    params: {
      projectId: string;
      resourceType: "scenario" | "conformanceRun" | "evalRun";
      resourceId: string;
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      this.sharePath(params.projectId, params.resourceType, params.resourceId),
      {},
      options
    );
  }

  setShareMode(
    params: {
      projectId: string;
      resourceType: "scenario" | "conformanceRun" | "evalRun";
      resourceId: string;
      mode: "project_members" | "invited_only" | "anyone_with_link";
      allowGuestAccess?: boolean;
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    const { projectId, resourceType, resourceId, mode, allowGuestAccess } =
      params;
    return this.request(
      "PATCH",
      this.sharePath(projectId, resourceType, resourceId),
      {
        body: {
          mode,
          ...(allowGuestAccess !== undefined ? { allowGuestAccess } : {}),
        },
      },
      options
    );
  }

  /**
   * Rotate the share link. Immediate: holders of the old URL can no longer
   * redeem it. Agent-excluded; available on REST/CLI/MCP.
   */
  rotateShareLink(
    params: {
      projectId: string;
      resourceType: "scenario" | "conformanceRun" | "evalRun";
      resourceId: string;
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `${this.sharePath(
        params.projectId,
        params.resourceType,
        params.resourceId
      )}/rotate-link`,
      {},
      options
    );
  }

  private serverOp<T>(
    params: ServerScope & { body?: Record<string, unknown> },
    op: string,
    options?: RequestOptions
  ): Promise<T> {
    const path = `/projects/${encodeURIComponent(
      params.projectId
    )}/servers/${encodeURIComponent(params.serverId)}/${op}`;
    return this.request("POST", path, { body: params.body ?? {} }, options);
  }

  private async request<T>(
    // PUT is here for idempotent creates — `publishScenario` is the first:
    // publishing an environment that is already published returns the existing
    // scenario rather than minting a second, which is PUT's semantics and not
    // POST's.
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    init: { query?: QueryParams; body?: unknown },
    options?: RequestOptions
  ): Promise<T> {
    const url = resolvePlatformRequestUrl(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

    // Spread FIRST: every assignment below is a contract header this client
    // owns, and each must survive whatever the caller supplied.
    const headers: Record<string, string> = {
      ...(this.extraHeaders ?? {}),
      authorization: `Bearer ${await this.getAuth()}`,
    };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.userAgent) {
      headers["user-agent"] = this.userAgent;
    }
    if (options?.idempotencyKey) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    const controller = new AbortController();
    const externalSignal = options?.signal;
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, {
          once: true,
        });
      }
    }
    const timeoutHandle = setTimeout(
      () =>
        controller.abort(
          new Error(`Request timed out after ${this.timeoutMs}ms`)
        ),
      this.timeoutMs
    );

    // BOTH THE FETCH AND THE BODY READ ARE INSIDE THIS `try`, and that is the
    // point. Headers arriving is not the end of the request: a server can send
    // them and then stall the body indefinitely. Releasing the deadline and the
    // caller's signal at the end of the fetch — as this did — left
    // `response.text()` bounded by NOTHING. Not `timeoutMs`, which had just been
    // cleared; not the caller's abort, whose listener had just been removed. A
    // stalling server held the caller forever, and a Ctrl-C could not take it
    // back.
    let response: Response;
    let raw: string;
    try {
      try {
        response = await this.fetchFn(url, {
          method,
          headers,
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        if (externalSignal?.aborted) {
          // Caller-initiated abort: propagate, don't dress it up as an API error.
          throw error;
        }
        const aborted = controller.signal.aborted;
        throw new PlatformApiError(
          aborted
            ? `Request to ${path} timed out after ${this.timeoutMs}ms`
            : `Failed to reach the MCPJam API at ${url.origin}: ${errorMessage(
                error
              )}`,
          aborted ? "TIMEOUT" : "NETWORK_ERROR",
          { status: 0, endpoint: path, cause: error }
        );
      }

      try {
        raw = await response.text();
      } catch (error) {
        // Same taxonomy as the fetch arm above, for the same reasons: a caller's
        // abort is theirs to see, and our own deadline is a TIMEOUT rather than
        // an unexplained read failure. Reporting a stalled body as
        // INTERNAL_ERROR sends someone looking for a bug on our side.
        if (externalSignal?.aborted) throw error;
        if (controller.signal.aborted) {
          throw new PlatformApiError(
            `Request to ${path} timed out after ${this.timeoutMs}ms`,
            "TIMEOUT",
            { status: 0, endpoint: path, cause: error }
          );
        }
        throw new PlatformApiError(
          `Failed to read the MCPJam API response (${response.status}) for ${path}`,
          "INTERNAL_ERROR",
          { status: response.status, endpoint: path, cause: error }
        );
      }
    } finally {
      clearTimeout(timeoutHandle);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    let parsed: unknown;
    let parseError: unknown;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        parseError = error;
      }
    }

    if (!response.ok) {
      // Empty and non-JSON error bodies (bare 429s, proxy HTML) still map to
      // a PlatformApiError keyed off the status, with Retry-After preserved.
      throw this.toApiError(response, parsed, path);
    }

    if (parseError !== undefined) {
      throw new PlatformApiError(
        `The MCPJam API returned a non-JSON response (${response.status}) for ${path}`,
        "INTERNAL_ERROR",
        { status: response.status, endpoint: path, cause: parseError }
      );
    }

    // Empty success bodies (204 / no content) resolve to undefined.
    return parsed as T;
  }

  private toApiError(
    response: Response,
    body: unknown,
    path: string
  ): PlatformApiError {
    const envelope =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { code?: unknown; message?: unknown; details?: unknown })
        : undefined;
    // Track whether the server supplied a code. A status-derived 404 can mean
    // an undeployed route, while an envelope code identifies a missing
    // resource; callers need to distinguish those cases.
    const sentCode =
      typeof envelope?.code === "string" && envelope.code.length > 0
        ? envelope.code
        : undefined;
    const code = sentCode ?? fallbackCodeForStatus(response.status);
    const message =
      typeof envelope?.message === "string" && envelope.message.length > 0
        ? envelope.message
        : `Request to ${path} failed (${response.status})`;
    const details =
      envelope?.details &&
      typeof envelope.details === "object" &&
      !Array.isArray(envelope.details)
        ? (envelope.details as Record<string, unknown>)
        : undefined;

    return new PlatformApiError(message, code, {
      status: response.status,
      details,
      retryAfter: parseRetryAfter(response.headers.get("retry-after")),
      endpoint: path,
      codeSource: sentCode !== undefined ? "envelope" : "status",
    });
  }
}

// Wire codes assumed when an error response carries no `{ code }` envelope
// (empty bodies, upstream proxy HTML). Statuses without an unambiguous v1
// code fall back to INTERNAL_ERROR.
const STATUS_FALLBACK_CODES: Record<number, string> = {
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  429: "RATE_LIMITED",
};

function fallbackCodeForStatus(status: number): string {
  return STATUS_FALLBACK_CODES[status] ?? "INTERNAL_ERROR";
}

function parseRetryAfter(
  header: string | null,
  now: number = Date.now()
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  // RFC 9110 also allows an HTTP-date form.
  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
