/**
 * Launching a journey run, with no HTTP in it.
 *
 * WHY THIS IS A SERVICE. The launch used to live inline in
 * `routes/web/swarm-runs.ts`, and everything it needs was reachable from the
 * request `Context` sitting in scope — the delegated bearer, the XAA issuer,
 * the caller context threaded into every authorize batch. That is exactly what
 * made it un-callable from anywhere else: `POST /api/v1/projects/:p/journeys/
 * :id/runs` needs the same 200 lines, and a second copy of a fan-out launcher
 * is not a thing to maintain. So the four request-derived values are now
 * PARAMETERS, resolved by whichever route is calling, and the launch itself
 * knows nothing about Hono.
 *
 * THE ORDERING RULE, which the comments below repeat where it bites: once
 * `createJourneyRun` returns, a durable run row exists. Anything that throws
 * after that point orphans it — a run in the database with no runner, visible
 * in the UI, advancing to nothing until the backend's stale-run cron reaps it.
 * So validation happens BEFORE the create, and everything after it is either
 * infallible or explicitly deferred into the detached runner.
 *
 * THE BEARER IS A THUNK, not a string. The runner detaches after the caller
 * gets its 202 and can fan out for hours; a delegated JWT lives about two.
 * `deps.bearerToken` is for the create, which happens inside the request.
 * `deps.getRunBearer` is for everything the runner does afterwards, and it is
 * re-resolved per unit of work rather than per outbound call — see
 * `swarm-runner.ts`.
 */
import type { McpProtocolVersion } from "@mcpjam/sdk";
import { isKnownProtocolVersion } from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import {
  createAuthorizedManager,
  type ManagerCallerContext,
} from "../../routes/web/auth.js";
import { xaaPolicyFromMcpProfile } from "../../utils/effective-auth.js";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import {
  createJourneyRun,
  SwarmAgentError,
  type PinnedHostExecutionSpec,
} from "../swarm-agent.js";
import { startJourneyRun } from "./swarm-runner.js";
import { resolveTargetPluginServerIds } from "../journeys/plugin-servers.js";
import { createConvexClient } from "../evals/route-helpers.js";
import { logger } from "../../utils/logger.js";

/** The request-derived values a launch needs, resolved by the calling route. */
export interface LaunchJourneyRunDeps {
  /**
   * For the CREATE, which happens inside the request. `/journey-execution/*`
   * is JWT-only, so an `sk_` API-key caller needs the delegated JWT here — the
   * raw key would 401 downstream.
   */
  bearerToken: string;
  /**
   * For everything the DETACHED runner does. Must be the thunk, not a captured
   * string: the run outlives the token.
   */
  getRunBearer: () => Promise<string>;
  /**
   * MCPJam test-IdP issuer, resolved from the live request (it reads
   * `x-forwarded-proto`). `createAuthorizedManager` fails closed for a
   * Cross-App-Access server without it, so a pinned host with an XAA server
   * would 500 inside the manager factory — after the run row exists.
   */
  xaaIssuer: string;
  /** Threaded into every authorize batch the run's sessions drive. */
  callerContext: ManagerCallerContext;
}

export interface LaunchJourneyRunInput {
  projectId: string;
  journeyRefId: string;
  /**
   * Caller-supplied idempotency key. Replaying one returns the ORIGINAL run
   * with `deduped: true` and starts no second runner — see below for why that
   * matters more than it looks.
   */
  launchKey: string;
  /** Opaque id linking the sibling runs of one co-launched batch. */
  waveId?: string;
  /** Per-run environment fan-out; the backend does the real validation. */
  environmentIds?: string[];
}

export interface LaunchJourneyRunResult {
  runId: string;
  deduped?: boolean;
}

const MAX_PASSTHROUGH_REASON_LENGTH = 300;

/**
 * Every character a renderer may break a line on — not just `\n`. `String.trim`
 * strips these at the ends but not in the middle, so a body carrying `\r` or a
 * Unicode separator would otherwise pass as a "single sentence" and then render
 * as multiple lines in a toast.
 *
 * Form feed is in the set because the toast renders with `white-space:
 * pre-wrap`, and CSS Text converts U+000C to a segment break exactly as it does
 * U+000D — so it breaks lines on screen even though it looks inert in a string.
 */
const LINE_BREAK = /[\r\n\f\u2028\u2029]/;

/**
 * A human-readable reason from a backend launch rejection.
 *
 * `bodyText` is the RAW response body and is never passed through unexamined.
 * It arrives in three shapes and only one of them is fit to show:
 *
 *   - a STRUCTURED rejection — a v1 envelope (`{"error":{"message":…}}`) or
 *     Convex `ConvexError` data (`{"code":…,"message":…}`). Unwrap it; the raw
 *     form renders as a wall of braces in a toast.
 *   - a PLAIN SENTENCE the backend wrote for a human ("journey exceeds the
 *     maximum host count"). This is the useful case and it survives — bounded
 *     by {@link showableReason}, because a "sentence" that is 8 KB or full of
 *     markup is not one. The SAME bound applies to a message unwrapped from a
 *     structured body.
 *   - anything else — an HTML error page from a proxy, a stack trace, an empty
 *     body. Replaced by a sentence of our own.
 *
 * Deliberately tolerant: every branch is best-effort, because the failure this
 * runs inside is already a failure and a parse error here would replace a
 * useful message with a 500.
 */
export function launchFailureMessage(err: SwarmAgentError): string {
  const fallback =
    err.status === 402
      ? "This launch would exceed your organization's credit limit."
      : "This journey can't be launched.";
  const raw = err.bodyText?.trim();
  if (!raw) return fallback;

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // v1 envelope: { error: { code, message } }
      const envelope = parsed.error;
      if (envelope && typeof envelope === "object") {
        const unwrapped = showableReason(
          (envelope as { message?: unknown }).message
        );
        if (unwrapped) return unwrapped;
      }
      // Convex structured ConvexError data: { code, message, details? }
      const unwrapped = showableReason(parsed.message);
      if (unwrapped) return unwrapped;
    } catch {
      // Not valid JSON despite the leading brace. Deliberately NOT re-tested as
      // prose: a truncated or malformed JSON body is a broken envelope, not a
      // sentence somebody wrote, and echoing its fragment would show braces.
    }
    return fallback;
  }

  return showableReason(raw) ?? fallback;
}

/**
 * `value` if it is a string fit to put in front of a user, else `null`.
 *
 * The SAME policy for a structured `message` and for a plain body: a backend
 * envelope is no more trustworthy than a bare one — it can just as easily carry
 * a stack trace, an HTML fragment, or an unbounded diagnostic — and applying
 * the bound to only one of the two would leave the "never passed through
 * unexamined" promise true of the less likely case and false of the more
 * likely one.
 */
function showableReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const showable =
    text.length <= MAX_PASSTHROUGH_REASON_LENGTH &&
    !LINE_BREAK.test(text) &&
    !text.includes("<");
  return showable ? text : null;
}

/** Preserve structured billing/environment metadata across the WebRouteError boundary. */
function launchFailureDetails(
  err: SwarmAgentError
): Record<string, unknown> | undefined {
  const raw = err.bodyText?.trim();
  if (!raw?.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const envelope = parsed.error;
    const source =
      envelope && typeof envelope === "object"
        ? (envelope as Record<string, unknown>)
        : parsed;
    const details = source.details;
    // `typeof [] === "object"`, and spreading an array yields `{0: …}` — index
    // keys masquerading as structured metadata. A list is not a details bag.
    const bag =
      details && typeof details === "object" && !Array.isArray(details)
        ? { ...(details as Record<string, unknown>) }
        : undefined;
    // Carry the backend's `code` alongside its details. The message is bounded
    // and prose-shaped by design, so it is the wrong thing to branch on; a
    // caller that needs to tell "this environment has no model"
    // (`ENV_MODEL_REQUIRED`) from a transient resolution failure has nothing
    // else to read. Cheap to forward, and the same code the eval and v1
    // environment surfaces already expose.
    const code = typeof source.code === "string" ? source.code : undefined;
    if (!bag && !code) return undefined;
    // The DETAILS bag wins when it carries its own `code`. A response can hold
    // both — an envelope code describing the transport failure and a domain
    // code inside `details` naming the specific refusal — and the domain one is
    // the branchable half. The envelope code only fills a gap.
    const hasDetailCode = typeof bag?.code === "string" && bag.code.length > 0;
    return { ...(bag ?? {}), ...(code && !hasDetailCode ? { code } : {}) };
  } catch {
    return undefined;
  }
}

function requireConvexHttpUrl(): string {
  const url = process.env.CONVEX_HTTP_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  return url;
}

/**
 * Non-secret connection settings threaded into the manager for a pinned host
 * so a swarm run reconnects with the SAME transport behavior the snapshot
 * captured (per-request timeout + MCP protocol pins) rather than whatever the
 * host's CURRENT live config negotiates. Headers / credentials are deliberately
 * EXCLUDED — those stay live-resolved by the authorize batch (a run must use
 * fresh secrets, not a stale snapshot). Every field is read defensively: the
 * pinned `connectionDefaults` / `serverConnectionOverrides` are opaque
 * (`Record<string, unknown>`) snapshot blobs, so a malformed or absent value
 * simply falls back to the live default and never breaks the launch.
 */
interface PinnedConnectionSettings {
  timeoutMs: number;
  initializePins?: {
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    supportedProtocolVersions?: string[];
    mcpProtocolVersion?: McpProtocolVersion;
  };
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
  /**
   * Per-server request-timeout pins (ms) from the snapshot's
   * `serverConnectionOverrides[serverId].requestTimeoutOverride`. A server
   * absent from this map uses the host-level `timeoutMs`.
   */
  requestTimeoutByServerId?: Record<string, number>;
}

function coerceTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function coerceProtocolVersion(value: unknown): McpProtocolVersion | undefined {
  return typeof value === "string" && isKnownProtocolVersion(value)
    ? value
    : undefined;
}

function buildPinnedConnectionSettings(
  host: PinnedHostExecutionSpec,
  fallbackTimeoutMs: number
): PinnedConnectionSettings {
  const defaults = asRecord(host.connectionDefaults);

  // Timeout: read from the (scrubbed) `connectionDefaults` — the ONLY field the
  // backend retains there is `requestTimeout` (header values are stripped).
  // Accept either wire spelling defensively; require a positive finite number,
  // else fall back to the live default.
  const timeoutMs =
    coerceTimeoutMs(defaults?.timeoutMs ?? defaults?.requestTimeout) ??
    fallbackTimeoutMs;

  // INITIALIZE pins come from the pinned `mcpProfile`, NOT `connectionDefaults`.
  // The backend's `materializeHostSpec` copies the host's `mcpProfile` verbatim
  // (`mcpProtocolVersion` + `initialize.{clientInfo,supportedProtocolVersions}`)
  // and scrubs `connectionDefaults` down to just `{ requestTimeout }`, so reading
  // the pins from `connectionDefaults` (the old behavior) always found nothing.
  const initializePins: NonNullable<
    PinnedConnectionSettings["initializePins"]
  > = {};
  const initialize = asRecord(host.mcpProfile?.initialize);
  const clientInfo = asRecord(initialize?.clientInfo);
  if (clientInfo) {
    initializePins.clientInfo = clientInfo as {
      name?: string;
      version?: string;
    } & Record<string, unknown>;
  }
  if (Array.isArray(initialize?.supportedProtocolVersions)) {
    const versions = initialize.supportedProtocolVersions.filter(
      (v): v is string => typeof v === "string"
    );
    if (versions.length > 0) {
      initializePins.supportedProtocolVersions = versions;
    }
  }
  const batchProtocol = coerceProtocolVersion(
    host.mcpProfile?.mcpProtocolVersion
  );
  if (batchProtocol) {
    initializePins.mcpProtocolVersion = batchProtocol;
  }

  // Per-server protocol pins from the pinned overrides. Accept both the
  // resolver key (`mcpProtocolVersion`) and the project-config key
  // (`mcpProtocolVersionOverride`); createAuthorizedManager re-validates.
  const overrides = asRecord(host.serverConnectionOverrides);
  let mcpProtocolVersionsByServerId:
    | Record<string, McpProtocolVersion>
    | undefined;
  let requestTimeoutByServerId: Record<string, number> | undefined;
  if (overrides) {
    for (const [serverId, rawOverride] of Object.entries(overrides)) {
      const override = asRecord(rawOverride);
      if (!override) continue;
      const pin = coerceProtocolVersion(
        override.mcpProtocolVersion ?? override.mcpProtocolVersionOverride
      );
      if (pin) {
        mcpProtocolVersionsByServerId ??= {};
        mcpProtocolVersionsByServerId[serverId] = pin;
      }
      // Per-server request-timeout pin. Accept both the resolver spelling
      // (`requestTimeout`) and the project-config override spelling
      // (`requestTimeoutOverride`); a malformed value is simply skipped so the
      // server falls back to the host-level timeout.
      const perServerTimeout = coerceTimeoutMs(
        override.requestTimeoutOverride ?? override.requestTimeout
      );
      if (perServerTimeout !== undefined) {
        requestTimeoutByServerId ??= {};
        requestTimeoutByServerId[serverId] = perServerTimeout;
      }
    }
  }

  return {
    timeoutMs,
    ...(Object.keys(initializePins).length > 0 ? { initializePins } : {}),
    ...(mcpProtocolVersionsByServerId ? { mcpProtocolVersionsByServerId } : {}),
    ...(requestTimeoutByServerId ? { requestTimeoutByServerId } : {}),
  };
}

/**
 * Create the run, then start its fan-out runner fire-and-forget.
 *
 * Returns as soon as the run row exists — the caller answers 202 and the work
 * continues in the background. Throws a `WebRouteError` for anything the
 * caller can act on (a journey with no hosts, a backend 4xx); anything the
 * runner hits later is logged, because there is no longer a caller to tell.
 */
export async function launchJourneyRun(
  deps: LaunchJourneyRunDeps,
  input: LaunchJourneyRunInput
): Promise<LaunchJourneyRunResult> {
  const convexHttpUrl = requireConvexHttpUrl();

  // Create the run over the journey's full pinned host set (no maxHosts
  // cap). A backend rejection (a hard host-count ceiling, a journey with no
  // hosts, a duplicate launchKey, …) surfaces as a clear 4xx instead of a
  // bare 500.
  let created;
  try {
    created = await createJourneyRun(convexHttpUrl, deps.bearerToken, {
      projectId: input.projectId,
      journeyRefId: input.journeyRefId,
      launchKey: input.launchKey,
      ...(input.waveId ? { swarmRunGroupId: input.waveId } : {}),
      ...(input.environmentIds?.length
        ? { environmentIds: input.environmentIds }
        : {}),
    });
  } catch (err) {
    if (
      err instanceof SwarmAgentError &&
      err.status >= 400 &&
      err.status < 500
    ) {
      // Keep the backend's MEANING, not just its status. Collapsing every 4xx
      // to VALIDATION_ERROR tells a caller that branches on `code` to go fix
      // its request — wrong advice for a launch refused on permissions, aimed
      // at a journey that does not exist, replaying a conflicting key, or
      // rejected on quota. The status was already distinct; the code should be
      // too. Anything else 4xx really is "your request was not acceptable".
      //
      // 429 matters most of the five: it is the only RETRYABLE one, and
      // reading it as invalid input turns "wait and try again" into "this
      // request can never work".
      //
      // 402 is the SIXTH and the other one that changes what a caller should
      // do: the organization is out of credit, so retrying is pointless and
      // every sibling launch in the same wave will fail identically. The
      // swarm fan-out reads this code to stop scheduling rather than fire N
      // more doomed requests.
      const CODE_BY_STATUS: Record<number, ErrorCode> = {
        401: ErrorCode.UNAUTHORIZED,
        402: ErrorCode.BILLING_LIMIT_REACHED,
        403: ErrorCode.FORBIDDEN,
        404: ErrorCode.NOT_FOUND,
        409: ErrorCode.CONFLICT,
        429: ErrorCode.RATE_LIMITED,
      };
      const code = CODE_BY_STATUS[err.status] ?? ErrorCode.VALIDATION_ERROR;
      const routeError = new WebRouteError(
        err.status,
        code,
        launchFailureMessage(err),
        launchFailureDetails(err)
      );
      // The wave fan-out and every generic client read `Retry-After` to decide
      // WHEN to come back; the 429 alone only says "not now". The backend's
      // daily launch cap sends the UTC roll and its burst brake sends the
      // bucket refill, so this is the one number nobody downstream can derive.
      throw err.retryAfter
        ? routeError.withHeaders({ "Retry-After": err.retryAfter })
        : routeError;
    }
    throw err;
  }

  // The backend derives + authorizes projectId from the journey (and is
  // LAUNCHER + project-member gated) — that is the authoritative gate. We do
  // NOT re-check the client-supplied `body.projectId` here: a post-create
  // reject would leave a durable run row with no runner (an orphan). Trust
  // the backend's gating and always proceed to start the runner on a
  // successful create.
  const { runId, projectId, snapshot } = created;

  // Deduped launch (launchKey replay onto an EXISTING run): the ORIGINAL
  // launch's runner owns that run. Starting a second runner here would
  // race it — duplicate claims (suppressed per-attempt by `applied:false`)
  // and, worse, the duplicate's shutdown/cleanup (finalize-pending, abort
  // finalizers, heartbeat stop) can kill attempts the owner is still
  // executing. Acknowledge idempotently with the SAME runId and start
  // nothing. If the original runner is dead, the backend stale-run cron
  // finalizes the run; a retry then needs a FRESH launchKey.
  if (created.deduped) {
    logger.info("[swarm-runs] deduped launch — runner already owns run", {
      runId,
      projectId,
    });
    return { runId, deduped: true };
  }

  if (!Array.isArray(snapshot.hosts) || snapshot.hosts.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "This journey has no pinned hosts to run"
    );
  }
  const hosts = snapshot.hosts;

  // Client for the run's D2 re-gates. Constructed PER CALL and deliberately
  // not memoized: a client bakes its auth token in at construction, so a
  // whole-run singleton would carry the launch-time bearer for hours and start
  // 401ing partway through a long fan-out. The cost is one client object per
  // session; the alternative was a re-gate that stops working mid-run.
  //
  // Lazy for a second reason: `createConvexClient` throws when `CONVEX_URL` is
  // unset, and we are past `createJourneyRun` — a throw here would orphan a
  // durable run row with no runner. A journey that pins no plugins never calls
  // this at all.
  const getPluginRegateClient = async () =>
    createConvexClient(await deps.getRunBearer());

  setImmediate(() => {
    startJourneyRun({
      runId,
      projectId,
      hosts,
      personaSnapshot: snapshot.personaSnapshot,
      sessionsPerTarget: snapshot.sessionsPerTarget,
      maxTurns: snapshot.maxTurns,
      // Whether this run is rubric-graded at all. The runner only needs
      // the yes/no — the criteria themselves come back from the claim, so
      // the authoritative list is always the backend's pinned copy and
      // never a value that rode along in process memory.
      hasRubric: (snapshot.rubric?.length ?? 0) > 0,
      convexHttpUrl,
      getBearer: deps.getRunBearer,
      // Host-aware: each host connects ONLY its own pinned required servers
      // (optionalServerIds stay off, matching a real no-opt-in visitor).
      managerFactory: async (host) => {
        // Decision D2 — re-gate the target's pinned plugin servers against
        // the LIVE plugin, here at connect time, rather than trusting the
        // snapshot's `pluginServerIds`. That stored list records what was
        // PINNED; a plugin disabled or uninstalled since launch must stop
        // contributing servers even though the snapshot still names them.
        // Throwing fails this target's sessions as a config error — the
        // same treatment an invalid stored xaaPolicy gets — because a
        // silently shrunken server set runs an environment nobody
        // configured.
        //
        // Re-gated per SESSION, not once per target: `managerFactory` is
        // invoked per session attempt, so a plugin uninstalled mid-run
        // stops contributing to the very next session rather than at the
        // next launch. Deliberate — revocation should not wait for a run
        // to finish — at the cost of one query per session.
        const pluginServerIds = await resolveTargetPluginServerIds(
          getPluginRegateClient,
          {
            runId,
            targetId: host.targetId,
            snapshotPluginServerIds: host.pluginServerIds,
          }
        );
        // Deduped union: the backend keeps plugin ids out of `serverIds`,
        // but an overlap would double-connect rather than fail, so guard it.
        const hostServerIds = new Set(host.serverIds);
        const pluginOnlyServerIds = pluginServerIds.filter(
          (id) => !hostServerIds.has(id)
        );
        const serverIds =
          pluginOnlyServerIds.length > 0
            ? [...host.serverIds, ...pluginOnlyServerIds]
            : host.serverIds;
        // Reconnect with THIS host's non-secret connection settings
        // (per-request timeout + MCP protocol pins) so the run reproduces
        // the pinned snapshot rather than the host's current live config.
        // Secrets/headers stay live-resolved by the authorize batch.
        const connection = buildPinnedConnectionSettings(
          host,
          WEB_STREAM_TIMEOUT_MS
        );
        const { manager } = await createAuthorizedManager(
          deps.callerContext,
          // Per-SESSION: `managerFactory` runs once per session attempt,
          // and the authorize batch it drives resolves live credentials —
          // so it must not carry a bearer minted at launch.
          await deps.getRunBearer(),
          projectId,
          serverIds,
          connection.timeoutMs,
          undefined,
          // Pinned MCP client capabilities from the snapshot — negotiate
          // INITIALIZE with the SAME capabilities the host declared at
          // run-create time (mirrors the scenario path), not the current
          // live config's.
          host.clientCapabilities,
          {
            accessScope: "project_member",
            // XAA servers fail closed without the issuer; resolved above
            // from the live request Context.
            xaaIssuer: deps.xaaIssuer,
            // Enterprise-managed policy from the PINNED host snapshot
            // (server-side, mcpProfile copied verbatim at run-create) —
            // the run reproduces the snapshot's policy, and an invalid
            // stored policy fails the host's sessions as a config error
            // rather than silently un-enforcing.
            xaaPolicy: xaaPolicyFromMcpProfile(host.mcpProfile),
            ...(connection.initializePins
              ? { initializePins: connection.initializePins }
              : {}),
            ...(connection.mcpProtocolVersionsByServerId
              ? {
                  mcpProtocolVersionsByServerId:
                    connection.mcpProtocolVersionsByServerId,
                }
              : {}),
            ...(connection.requestTimeoutByServerId
              ? {
                  requestTimeoutByServerId: connection.requestTimeoutByServerId,
                }
              : {}),
          }
        );
        // `MCPClientManager` starts eager connections in the background. Do
        // not hand that manager to a session while its servers are still only
        // "registered": the first model turn can otherwise race initialization
        // and report that an MCP server is not connected (or give the model no
        // tools, which looks like the server is unavailable).
        //
        // `listTools` is deliberately used as the readiness barrier instead
        // of reaching into the manager's private connection state. It waits
        // for the initial connection, exercises the same retry/reconnect path
        // used by normal requests, and populates the SDK's tool cache before
        // `prepareChatV2` runs. The manager remains owned by this session and
        // is disposed only after the session finishes.
        try {
          await Promise.all(
            serverIds.map((serverId) => manager.listTools(serverId))
          );
        } catch (error) {
          // The factory has not returned yet, so the runner cannot call its
          // dispose hook. Clean up any sibling connections before propagating
          // the failure and letting the session classify it.
          await manager.disconnectAllServers().catch(() => {});
          throw error;
        }
        return {
          manager,
          connectedServerIds: serverIds,
          // The session connects these, but `resumeConfig` must never tell
          // a later viewer to reconnect them without re-gating the plugin.
          //
          // Subtract anything ALSO in the host's own `serverIds`: D1 keeps
          // plugin ids out of that list so the overlap should be empty, but
          // the union above already guards for it, and marking such an id
          // non-resumable would strip a legitimately host-pinned server
          // from resume. An id that stands on its own in the host config
          // does not need the plugin to justify reconnecting it.
          ...(pluginOnlyServerIds.length > 0
            ? { nonResumableServerIds: pluginOnlyServerIds }
            : {}),
          dispose: async () => {
            await manager.disconnectAllServers();
          },
        };
      },
    }).catch((err) => {
      logger.error("[swarm-runs] startJourneyRun failed", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  return { runId };
}
