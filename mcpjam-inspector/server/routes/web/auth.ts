import { z } from "zod";
import type { Context } from "hono";
import {
  MCPClientManager,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  withSkillsExtensionCapability,
  type McpProtocolVersion,
} from "@mcpjam/sdk";
import type {
  ConfidentialCimdProvider,
  ElicitationCallback,
  HttpExchangeLogger,
  HttpServerConfig,
  MrtrInputCollector,
  RpcLogger,
  UnauthorizedRefreshHandler,
  XaaEnterprisePolicy,
} from "@mcpjam/sdk";
import { HOSTED_MODE, WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { HOSTED_TASK_BATCH_MAX as HOSTED_TASK_BATCH_MAX_SHARED } from "../../../shared/hosted-tasks.js";
import {
  attachHostedRpcLogs,
  createHostedRpcLogCollector,
} from "./hosted-rpc-logs.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";
import { negotiationTelemetryLogger } from "../../utils/negotiation-telemetry.js";
import { setRequestLogContext } from "../../utils/request-logger.js";
import { logger } from "../../utils/logger.js";
import {
  parseXaaPolicyValue,
  resolveEffectiveAuthMethod,
  withXaaExtensionCapability,
  xaaPolicyFromMcpProfile,
  xaaPolicyRequiresConfiguration,
} from "../../utils/effective-auth.js";
import type { EffectiveAuthMethod } from "../../utils/effective-auth.js";
import { fetchScenarioRuntimeConfig } from "../../utils/scenario-runtime-config.js";
import { resolveLocalStdioServerConfig } from "../../utils/local-server-resolver.js";
import {
  resolvePluginStdioHttpTarget,
  type PluginStdioHttpTarget,
} from "../../services/plugins/hosted-stdio-connect.js";
import type { ExecutionScope } from "../../utils/execution-scope.js";
import type { RequestLogContext } from "../../utils/log-events.js";
import {
  type InternalLogContext,
  mapInternalToRequestContext,
} from "../../utils/internal-log-context.js";
import {
  ErrorCode,
  WebRouteError,
  webError,
  parseErrorMessage,
  mapRuntimeError,
  mapTargetServerError,
  webErrorFromRoute,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
} from "./errors.js";
import {
  buildHostedOAuthUnauthorizedHandler,
  refreshHostedOAuthAccessTokenWithLocalFallback,
} from "../../utils/hosted-oauth-refresh.js";
import {
  fetchRuntimeServerSecrets,
  fetchServerClientSecret,
} from "../../utils/server-secrets.js";
import {
  buildXaaMintArgs,
  isXaaMintErrorReported,
  mintXaaAccessToken,
  resolveXaaConnectRegistrationMode,
  resolveXaaIssuer,
} from "../../services/xaa-mint.js";
import { toXaaConnectFailure } from "../../services/xaa-connect-error.js";
import { getConfidentialCimdProviderForOrg } from "../../services/xaa-confidential-cimd.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";

// ── Zod Schemas ──────────────────────────────────────────────────────

const clientCapabilitiesSchema = z.record(z.string(), z.unknown());
const clientInfoBatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
  })
  .passthrough()
  .optional();
const supportedProtocolVersionsBatchSchema = z
  .array(z.string().min(1))
  .optional();
const mcpProtocolVersionEnum = z.enum([
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
]);

function hasNonEmptyStringRecord(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).some(
      ([, recordValue]) => typeof recordValue === "string"
    )
  );
}

// Per-server `mcpProtocolVersion` map. Map entries are validated against
// the wire-mode enum so a typo in one server's pin doesn't tank the whole
// batch — Zod returns the typed enum union, and the route handler can
// still defensively re-check via `isKnownProtocolVersion` before passing
// to the SDK factory.
export const mcpProtocolVersionsByServerIdSchema = z
  .record(z.string().min(1), mcpProtocolVersionEnum)
  .optional();

export const projectServerSchema = z.object({
  projectId: z.string().min(1),
  serverId: z.string().min(1),
  serverName: z.string().min(1).optional(),
  clientCapabilities: clientCapabilitiesSchema.optional(),
  oauthAccessToken: z.string().optional(),
  accessScope: z.enum(["project_member", "chat_v2"]).optional(),
  // Callers identify scenarios by `scenarioId` (resolved via
  // /web/scenario/redeem) plus the backend-owned `accessVersion`. The
  // link token is consumed only at redemption; no read-path callsite
  // accepts it.
  scenarioId: z.string().min(1).optional(),
  accessVersion: z.number().int().nonnegative().optional(),
  // mcpProfile.initialize pins, resolved client-side from
  // `hostConfig.mcpProfile.initialize.*` and forwarded on every hosted
  // route call. Declared here (rather than per-route) so Zod doesn't
  // strip them — the inspector client now ALWAYS includes them on
  // /validate, /check-oauth, /doctor, /tools/*, /resources/*, /prompts/*
  // when the active hostConfig has a profile pinned. `passthrough()` on
  // clientInfo so forward-compat MCP spec additions (e.g. `title`,
  // future fields) survive to `toHttpConfig` without a schema bump.
  clientInfo: z
    .object({
      name: z.string().min(1).optional(),
      version: z.string().min(1).optional(),
    })
    .passthrough()
    .optional(),
  supportedProtocolVersions: z.array(z.string().min(1)).optional(),
  // Per-server pinned MCP protocol version. Resolved client-side from
  // `hostConfig.mcpProfile.mcpProtocolVersion` + per-server override.
  // Membership-gated via `MCP_PROTOCOL_VERSIONS` (mirror of the SDK +
  // backend constant); typo values are rejected at this trust boundary
  // and never reach the SDK's open-routing predicate. Absent means
  // "use SDK default (negotiates at request time)".
  mcpProtocolVersion: mcpProtocolVersionEnum.optional(),
  // SEP-2243 `Mcp-Param-*` mirroring, resolved client-side from
  // `hostConfig.mcpProfile.toolParamHeaderMirroring`. Declared here for the
  // same reason as the pins above — Zod strips undeclared fields, and the
  // client sends it on every hosted route call once the host opts in. Only
  // `false` is ever sent: `"mirror"` is the SDK's no-field default.
  mirrorToolParamHeaders: z.boolean().optional(),
  // Sibling client-conformance knobs. Declared for the SAME reason as the
  // field above: Zod strips what it does not declare, so a knob the client
  // faithfully sends would vanish here and the hosted session would execute
  // as a fully conforming client. Only the non-default value is ever sent.
  firstPageOnly: z.boolean().optional(),
  supportsMrtr: z.boolean().optional(),
  // Host enterprise-managed authorization policy, resolved client-side from
  // `hostConfig.mcpProfile.extensions`. Declared here (like the pins above)
  // so the wire contract documents it, but VALIDATED by
  // `parseXaaPolicyValue` from the pre-parse raw body in
  // `createManualHostedConnection` — enforcement must never be silently
  // stripped by a route schema that forgot to declare it (fail-open), and
  // the strict gate 409s with the standard xaa_policy_invalid shape rather
  // than a generic Zod 400.
  xaaPolicy: z.unknown().optional(),
});

export const toolsListSchema = projectServerSchema.extend({
  modelId: z.string().optional(),
  cursor: z.string().optional(),
});

// Legacy (2025-11-25) task augmentation: the concrete `{ttl?}` shape, not a
// free-form record — this is a write path that reaches the MCP server verbatim.
export const taskOptionsSchema = z
  .object({ ttl: z.number().int().positive().optional() })
  .strict();

export const toolsExecuteSchema = projectServerSchema
  .extend({
    toolName: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()).default({}),
    taskOptions: taskOptionsSchema.optional(),
    // Extension wire: the client only declares that a task response is
    // acceptable; the server decides whether to create one.
    allowTaskResult: z.boolean().optional(),
  })
  // The two are mutually exclusive wires: `taskOptions` is the 2025-11-25
  // `params.task` opt-in, `allowTaskResult` the SEP-2663 per-request
  // declaration. Sending both means the caller does not know which wire it is
  // on, so reject it at the edge instead of guessing.
  .refine((body) => !(body.taskOptions && body.allowTaskResult), {
    message:
      "taskOptions (2025-11-25) and allowTaskResult (io.modelcontextprotocol/tasks) are different wires; send at most one",
    path: ["allowTaskResult"],
  });

export { HOSTED_TASK_BATCH_MAX } from "../../../shared/hosted-tasks.js";

export const taskGetSchema = projectServerSchema.extend({
  taskId: z.string().min(1),
});

export const taskGetBatchSchema = projectServerSchema.extend({
  taskIds: z.array(z.string().min(1)).min(1).max(HOSTED_TASK_BATCH_MAX_SHARED),
});

export const taskListSchema = projectServerSchema.extend({
  cursor: z.string().optional(),
});

export const taskUpdateSchema = projectServerSchema.extend({
  taskId: z.string().min(1),
  inputResponses: z.record(z.string(), z.unknown()),
});

export const taskCapabilitiesSchema = projectServerSchema;

export const resourcesListSchema = projectServerSchema.extend({
  cursor: z.string().optional(),
});

export const resourcesReadSchema = projectServerSchema.extend({
  uri: z.string().min(1),
});

/**
 * Skills over MCP (SEP-2640). The skill URI is the IDENTITY, so it is required
 * wherever one skill is addressed — a name would not be unique.
 */
export const serverSkillsListSchema = projectServerSchema;

export const serverSkillsGetSchema = projectServerSchema.extend({
  uri: z.string().min(1),
});

export const serverSkillsReadFileSchema = projectServerSchema.extend({
  skillUri: z.string().min(1),
  resourceUri: z.string().min(1),
});

export const promptsListSchema = projectServerSchema.extend({
  cursor: z.string().optional(),
});

export const promptsListMultiSchema = z.object({
  projectId: z.string().min(1),
  serverIds: z.array(z.string().min(1)).min(1),
  serverNames: z.array(z.string().min(1)).optional(),
  clientCapabilities: clientCapabilitiesSchema.optional(),
  // mcpProfile.initialize pins, threaded from the active host profile so
  // multi-server prompts list connects honor the same protocol pins as
  // single-server calls. `clientInfo` and `supportedProtocolVersions` are
  // host-level (uniform per batch). `mcpProtocolVersionsByServerId` is
  // per-server so different servers in the batch can be on different
  // wire modes (e.g. one pinned to 2026-07-28 stateless, others on
  // legacy 2025-11-25 negotiation).
  clientInfo: clientInfoBatchSchema,
  supportedProtocolVersions: supportedProtocolVersionsBatchSchema,
  mcpProtocolVersionsByServerId: mcpProtocolVersionsByServerIdSchema,
  oauthTokens: z.record(z.string(), z.string()).optional(),
  accessScope: z.enum(["project_member", "chat_v2"]).optional(),
  // See projectServerSchema — scenario identity is `scenarioId` + `accessVersion`.
  scenarioId: z.string().min(1).optional(),
  accessVersion: z.number().int().nonnegative().optional(),
});

export const promptsGetSchema = projectServerSchema.extend({
  promptName: z.string().min(1),
  arguments: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

export const hostedChatSchema = z
  .object({
    projectId: z.string().min(1),
    selectedServerIds: z.array(z.string().min(1)),
    selectedServerNames: z.array(z.string().min(1)).optional(),
    clientCapabilities: clientCapabilitiesSchema.optional(),
    /**
     * Client's hosted-elicitation protocol version. Absent ⇒ the client cannot
     * render an elicitation prompt, so the server must not register the
     * callback (and therefore must not advertise the capability).
     *
     * This handshake exists because catalog hosts ALREADY declare
     * `elicitation`: without it, deploying server support would make every
     * stale browser bundle hang for a full TTL on any server that elicits.
     * Bump only if the wire contract changes incompatibly.
     *
     * Accepts ANY non-negative integer, not `literal(1)`: a newer client
     * advertising v2 against this older server must degrade to
     * elicitation-disabled, not 400 the entire chat request. The exact-version
     * check lives in `resolveElicitationGate`, which is what actually decides
     * whether to honor it.
     */
    hostedElicitationVersion: z.number().int().nonnegative().optional(),
    chatSessionId: z.string().min(1).optional(),
    surface: z.enum(["preview", "share_link"]).optional(),
    oauthTokens: z.record(z.string(), z.string()).optional(),
    accessScope: z.enum(["project_member", "chat_v2"]).optional(),
    // See projectServerSchema — scenario identity is `scenarioId` + `accessVersion`.
    scenarioId: z.string().min(1).optional(),
    accessVersion: z.number().int().nonnegative().optional(),
    /**
     * Optimistic-concurrency baseline for a resumed history thread: the session
     * version the client believes it is continuing from. Validated here rather
     * than forwarded raw, so a malformed value is a 400 at this boundary
     * instead of an arg-validation failure deep inside the ingest action.
     */
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .passthrough();

// ── Helpers ──────────────────────────────────────────────────────────

export function buildSingleServerOAuthTokens(serverId: string, token?: string) {
  return token ? { [serverId]: token } : undefined;
}

export function buildServerNamesById(
  serverIds: string[],
  serverNames?: readonly string[]
): Record<string, string> | undefined {
  if (!Array.isArray(serverNames) || serverNames.length === 0) {
    return undefined;
  }

  const entries = serverIds.flatMap((serverId, index) => {
    const serverName = serverNames[index];
    if (typeof serverName !== "string") {
      return [];
    }

    const trimmedServerName = serverName.trim();
    if (!trimmedServerName) {
      return [];
    }

    return [[serverId, trimmedServerName] as const];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// ── Authorization ────────────────────────────────────────────────────

export type ConvexAuthorizeResponse = {
  authorized: boolean;
  role: "owner" | "admin" | "member";
  accessLevel: "project_member" | "shared_chat";
  oauthAccessToken?: string | null;
  permissions: {
    chatOnly: boolean;
  };
  serverConfig: {
    transportType: "stdio" | "http";
    url?: string;
    // Declared wire transport from a plugin manifest (parser `httpVariant`),
    // once the backend persists + serves it. Absent on every ordinary row
    // and on older backends — absence means "no declaration", never a
    // default.
    httpVariant?: "streamable-http" | "sse";
    headers?: Record<string, string>;
    hasHeaders?: boolean;
    useOAuth?: boolean;
    // Cross-App Access (XAA) discriminator + non-secret config, surfaced by the
    // hosted authorize endpoint. The confidential client secret + token endpoint
    // are resolved separately at mint time via the hardened reveal-secret path.
    useXaa?: boolean;
    oauthScopes?: string[];
    xaaSubject?: string;
    xaaEmail?: string;
    xaaAuthzIssuer?: string;
    xaaAllowPathScopedIssuer?: boolean;
    // Backend-resolved identity failure: a LEGACY partial per-server
    // override (one member stored) can't resolve an atomic identity, so the
    // backend omits BOTH identity fields and sends this actionable,
    // value-free message instead. The mint must fail with it — never
    // silently fall back to the demo identity.
    xaaIdentityError?: string;
    // Which IdP mints the XAA assertion — on the wire from the backend
    // projection; needed by the C2 effective-auth resolver's `auto` branch.
    authServerMode?: "mcpjam" | "own";
    // Unified canonical auth fields (the booleans above are their derived
    // compat mirrors). Absent on legacy rows.
    authMethod?: "auto" | "oauth" | "xaa" | "bearer" | "none";
    registrationMode?: "auto" | "preregistered" | "cimd" | "dcr";
    xaaClientAuth?: "none" | "private_key_jwt";
  };
  internalLogContext?: InternalLogContext;
};

export type ClientSafeAuthorizeResponse = Omit<
  ConvexAuthorizeResponse,
  "internalLogContext"
>;

type AuthorizedServerConfigHolder = {
  serverConfig: ConvexAuthorizeResponse["serverConfig"];
};

export type ConvexBatchAuthorizeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type ConvexBatchAuthorizeSuccess = {
  ok: true;
  role: "owner" | "admin" | "member";
  accessLevel: "project_member" | "shared_chat";
  oauthAccessToken?: string | null;
  /**
   * Why there is no `oauthAccessToken`, when the reason is actionable rather
   * than "nothing stored". Mirrored by hand from the backend
   * (`BatchAuthorizeSuccess.oauthUnavailableReason` in convex/http.ts); absent
   * on older backends, which is why every read treats absence as "no idea".
   */
  oauthUnavailableReason?: "private_authorization_server";
  permissions: {
    chatOnly: boolean;
  };
  serverConfig: Omit<
    ConvexAuthorizeResponse,
    "internalLogContext"
  >["serverConfig"];
  internalLogContext?: InternalLogContext;
};

export type ConvexBatchAuthorizeResult =
  | ConvexBatchAuthorizeFailure
  | ConvexBatchAuthorizeSuccess;

export type ConvexBatchAuthorizeResponse = {
  organizationId?: string | null;
  isAnonymous?: boolean;
  results: Record<string, ConvexBatchAuthorizeResult>;
};

// Defense-in-depth: hosted /web/authorize-batch is contractually meant to
// return an HTTP-only `serverConfig` — Convex strips command/args/env via
// `normalizeAuthorizeResult`. If a backend regression ever lets those fields
// through, we drop them here so they can never reach the hosted client or be
// fed into a transport. Local mode uses /web/authorize-batch-local instead,
// which is allowed to carry STDIO fields and goes through a different code
// path (`local-server-resolver.ts`).
const STDIO_ONLY_FIELDS = ["command", "args", "env"] as const;
function stripStdioFieldsFromHostedConfig<
  T extends { serverConfig?: Record<string, unknown> }
>(holder: T): T {
  const cfg = holder.serverConfig;
  if (!cfg || typeof cfg !== "object") return holder;
  let cleaned: Record<string, unknown> | undefined;
  for (const field of STDIO_ONLY_FIELDS) {
    if (field in cfg) {
      if (!cleaned) cleaned = { ...cfg };
      delete cleaned[field];
    }
  }
  if (!cleaned) return holder;
  return { ...holder, serverConfig: cleaned };
}

/**
 * Build the auth headers used by Inspector → Convex `/web/*` calls.
 *
 * - For session/guest JWTs (the default): forward the caller's bearer
 *   verbatim. Convex sees the same identity it always has.
 * - For WorkOS API keys (`authMethod === "workos_api_key"`): exchange
 *   the bearer for `INSPECTOR_SERVICE_TOKEN` and add
 *   `x-mcpjam-acting-as: <workosUserId>` (the user's Convex `externalId`)
 *   plus `x-mcpjam-acting-in-org: <mcpjamOrganizationId>` (the org the key
 *   is bound to). Convex never sees the `sk_` value — Inspector is the
 *   trust boundary that validated it once via WorkOS and now vouches for
 *   the resolved user, scoped to the key's organization. The backend
 *   `requestIdentity` resolver requires BOTH headers and re-checks that the
 *   user is a member of that org.
 *
 * Keeping this in one helper so every `/web/*` callsite picks up the
 * same exchange (currently `authorizeServer` and `authorizeBatch` in
 * this file). Other Convex-forwarding helpers under `server/utils/*`
 * (e.g. `chat-history.ts`, `hosted-oauth-refresh.ts`,
 * `local-server-resolver.ts`) are NOT on the `/api/v1/*` path today
 * and stay on the original-bearer path until they're either reached
 * by an API key request or refactored to receive Context.
 */
/**
 * The caller-identity inputs the authorize/manager helpers actually consume,
 * decoupled from Hono so background workers (scheduled evals) can call them
 * without faking a route context. Routes build one via
 * {@link callerContextFromHono}; workers pass explicit values (or the empty
 * object, which behaves exactly like a plain-JWT caller — locked by
 * `caller-context.test.ts`).
 */
export interface ManagerCallerContext {
  /** "workos_api_key" switches to the service-token + acting-as exchange. */
  authMethod?: string;
  /** WorkOS user id (Convex `externalId`) for the delegated exchange. */
  workosUserId?: string;
  /** Convex organization id scope for the delegated exchange. */
  mcpjamOrganizationId?: string;
  /** Sink for backend-attributed request log context; absent ⇒ no-op. */
  setLogContext?: (partial: Partial<RequestLogContext>) => void;
  /** Read-back of the same log context (authenticatedUserId); absent ⇒ null. */
  getLogContext?: () => RequestLogContext | undefined;
}

/** Adapt a live Hono request context to {@link ManagerCallerContext}. */
export function callerContextFromHono(c: Context): ManagerCallerContext {
  return {
    authMethod: c.get("authMethod") as string | undefined,
    workosUserId: c.get("workosUserId") as string | undefined,
    mcpjamOrganizationId: c.get("mcpjamOrganizationId") as string | undefined,
    setLogContext: (partial) => setRequestLogContext(c, partial),
    getLogContext: () => c.var.requestLogContext,
  };
}

export function buildConvexAuthHeaders(
  caller: ManagerCallerContext,
  originalBearer: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (caller.authMethod === "workos_api_key") {
    const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
    if (!serviceToken) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Server missing INSPECTOR_SERVICE_TOKEN for WorkOS API key auth"
      );
    }
    // `acting-as` is the WorkOS user id (the user's Convex `externalId`),
    // NOT the Convex user `_id`: the backend resolves the delegated user by
    // externalId. Sending the Convex id here would 404 as UNKNOWN_DELEGATED_USER.
    const actingAs = caller.workosUserId;
    if (!actingAs) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Missing workosUserId for WorkOS API key auth exchange"
      );
    }
    const actingInOrg = caller.mcpjamOrganizationId;
    if (!actingInOrg) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Missing mcpjamOrganizationId for WorkOS API key auth exchange"
      );
    }
    headers["Authorization"] = `Bearer ${serviceToken}`;
    headers["x-mcpjam-acting-as"] = actingAs;
    headers["x-mcpjam-acting-in-org"] = actingInOrg;
    return headers;
  }
  headers["Authorization"] = `Bearer ${originalBearer}`;
  return headers;
}

export async function authorizeServer(
  c: Context,
  bearerToken: string,
  projectId: string,
  serverId: string,
  options?: {
    accessScope?: "project_member" | "chat_v2";
    scenarioId?: string;
    accessVersion?: number;
  }
): Promise<ClientSafeAuthorizeResponse> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }

  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/authorize`, {
      method: "POST",
      headers: buildConvexAuthHeaders(callerContextFromHono(c), bearerToken),
      body: JSON.stringify({
        projectId,
        serverId,
        ...(options?.accessScope ? { accessScope: options.accessScope } : {}),
        ...(options?.scenarioId ? { scenarioId: options.scenarioId } : {}),
        ...(typeof options?.accessVersion === "number"
          ? { accessVersion: options.accessVersion }
          : {}),
      }),
    });
  } catch (error) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `Failed to reach authorization service: ${parseErrorMessage(error)}`
    );
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const code =
      typeof body?.code === "string" ? body.code : ErrorCode.INTERNAL_ERROR;
    const message =
      typeof body?.message === "string"
        ? body.message
        : `Authorization failed (${response.status})`;
    throw new WebRouteError(response.status, code as ErrorCode, message);
  }

  if (!body?.authorized || !body?.serverConfig) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Authorization denied for server"
    );
  }

  const { internalLogContext, ...clientSafe } = body as ConvexAuthorizeResponse;
  if (internalLogContext) {
    setRequestLogContext(c, mapInternalToRequestContext(internalLogContext));
  }
  return stripStdioFieldsFromHostedConfig(
    clientSafe
  ) as ClientSafeAuthorizeResponse;
}

export async function authorizeBatch(
  caller: ManagerCallerContext,
  bearerToken: string,
  projectId: string,
  serverIds: string[],
  options?: {
    accessScope?: "project_member" | "chat_v2";
    scenarioId?: string;
    accessVersion?: number;
  }
): Promise<ConvexBatchAuthorizeResponse> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }

  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/authorize-batch`, {
      method: "POST",
      headers: buildConvexAuthHeaders(caller, bearerToken),
      body: JSON.stringify({
        projectId,
        serverIds,
        ...(options?.accessScope ? { accessScope: options.accessScope } : {}),
        ...(options?.scenarioId ? { scenarioId: options.scenarioId } : {}),
        ...(typeof options?.accessVersion === "number"
          ? { accessVersion: options.accessVersion }
          : {}),
        // Skip Convex's hosted-mode HTTPS-only check on MCP server URLs
        // when this Inspector instance is running locally. Convex doesn't
        // open MCP server URLs itself (we do, from this Hono backend), so
        // an `http://localhost` URL is harmless metadata in that case.
        //
        // Convex only honors `localRuntime` when the request has no
        // browser Origin, so a hosted browser at app.mcpjam.com can't
        // smuggle it in to bypass the policy. The flag itself isn't
        // Inspector-specific — any non-browser caller can set it — see
        // the docstring on `normalizeAuthorizeResult` in
        // mcpjam-backend/convex/http.ts for the full rationale.
        ...(!HOSTED_MODE ? { localRuntime: true } : {}),
      }),
    });
  } catch (error) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `Failed to reach authorization service: ${parseErrorMessage(error)}`
    );
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const code =
      typeof body?.code === "string" ? body.code : ErrorCode.INTERNAL_ERROR;
    const message =
      typeof body?.message === "string"
        ? body.message
        : `Authorization failed (${response.status})`;
    throw new WebRouteError(response.status, code as ErrorCode, message);
  }

  if (!body?.results || typeof body.results !== "object") {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Authorization response is missing batch results"
    );
  }

  const raw = body as ConvexBatchAuthorizeResponse;

  // Project-level fields (auth/user/org/project/accessLevel/surface) are
  // identical across batch results by construction — same Convex auth call,
  // same project. Take them from the first successful result.
  //
  // Per-server fields (serverId, serverTransport, scenarioId) are only well-
  // defined when the batch authorizes a single server. For multi-server
  // batches they would non-deterministically attribute to whichever server
  // iterated last, so we null them out at the request envelope; per-server
  // attribution belongs on per-server child events.
  const successful = Object.entries(raw.results).filter(
    (entry): entry is [string, ConvexBatchAuthorizeSuccess] => entry[1].ok
  );
  // Use the first result that actually carries internalLogContext rather than
  // strictly successful[0]; during a backend rollout the field may be present
  // on some results and absent on others, and we'd rather log project
  // attribution than nothing.
  const sourceCtx = successful.find(([, r]) => r.internalLogContext)?.[1]
    .internalLogContext;
  if (sourceCtx) {
    const partial = mapInternalToRequestContext(sourceCtx);
    if (successful.length > 1) {
      partial.serverId = null;
      partial.serverTransport = null;
      partial.scenarioId = null;
    }
    caller.setLogContext?.(partial);
  }

  const strippedResults: Record<string, ConvexBatchAuthorizeResult> = {};
  for (const [serverId, result] of Object.entries(raw.results)) {
    if (result.ok) {
      const { internalLogContext: _omit, ...clientSafeResult } = result;
      strippedResults[serverId] = stripStdioFieldsFromHostedConfig(
        clientSafeResult
      ) as ConvexBatchAuthorizeSuccess;
    } else {
      strippedResults[serverId] = result;
    }
  }
  return {
    organizationId:
      typeof raw.organizationId === "string" ? raw.organizationId : null,
    isAnonymous:
      typeof raw.isAnonymous === "boolean" ? raw.isAnonymous : undefined,
    results: strippedResults,
  };
}

export function toHttpConfig(
  authResponse: AuthorizedServerConfigHolder,
  timeoutMs: number,
  oauthAccessToken?: string,
  clientCapabilities?: Record<string, unknown>,
  onUnauthorized?: UnauthorizedRefreshHandler,
  /**
   * Per-connection MCP `initialize.params.clientInfo` and
   * `supportedProtocolVersions` pins resolved from
   * `hostConfig.mcpProfile.initialize.*`. Forwarded verbatim to the SDK
   * Client config so hosted connects honor the same pin as the
   * local-resolver path.
   *
   * Without this, the client was sending the pins on the wire but the
   * hosted handler dropped them at the route boundary (codex P2): Zod
   * stripped fields not declared on the schema, and `toHttpConfig`
   * had no parameters that could place them on the SDK config.
   */
  initializePins?: {
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    supportedProtocolVersions?: string[];
    /**
     * Outbound wire mode (2026-07-28 stateless preview). Forwarded
     * onto `HttpServerConfig.mcpProtocolVersion` so the SDK factory branches
     * to `StatelessMcpHttpPreviewClient` when set. Without this,
     * the hosted handler dropped the pin at the route boundary and
     * hosted connects always ran the legacy `initialize` handshake
     * regardless of the client-level toggle.
     */
    mcpProtocolVersion?: McpProtocolVersion;
    /**
     * SEP-2243 `Mcp-Param-*` mirroring. `false` simulates a client that never
     * mirrors, so a server can be tested against one; absent is the
     * spec-conforming default. Forwarded onto
     * `BaseServerConfig.mirrorToolParamHeaders`.
     */
    mirrorToolParamHeaders?: boolean;
    /**
     * Client-conformance knobs (`mcpProfile.paginationTraversal` /
     * `mcpProfile.mrtrSupport`), forwarded onto
     * `BaseServerConfig.firstPageOnly` / `.supportsMrtr`.
     */
    firstPageOnly?: boolean;
    supportsMrtr?: boolean;
    suppressLegacyRequestCancellation?: boolean;
    suppressModernRequestCancellation?: boolean;
  },
  /**
   * A plugin stdio component that IS reachable: a live shim, recorded in
   * `pluginRuntimeSessions`, running the child inside the caller's own
   * computer. Present only when the session row exists, so it — not this
   * function — is the reachability gate.
   */
  pluginRuntime?: PluginStdioHttpTarget
): HttpServerConfig {
  if (authResponse.serverConfig.transportType !== "http") {
    if (pluginRuntime) {
      // Built from the runtime alone, never merged with the stdio row: that row
      // carries `env` (a child's secrets) and no headers, and the only
      // credential this connection may present is the shim's own bearer.
      return {
        url: pluginRuntime.url,
        capabilities: clientCapabilities,
        clientCapabilities: clientCapabilities,
        requestInit: {
          headers: { Authorization: `Bearer ${pluginRuntime.token}` },
        },
        timeout: timeoutMs,
        // The shim answers `405` on `GET /mcp` and speaks Streamable HTTP only.
        // Pinning both rules out the SDK's `/sse` URL-path heuristic and the
        // silent SSE downgrade, neither of which this endpoint implements.
        preferSSE: false,
        disableSseFallback: true,
        ...(initializePins?.clientInfo
          ? { clientInfo: initializePins.clientInfo }
          : {}),
        ...(initializePins?.supportedProtocolVersions &&
        initializePins.supportedProtocolVersions.length > 0
          ? {
              supportedProtocolVersions:
                initializePins.supportedProtocolVersions,
            }
          : {}),
        ...(initializePins?.mcpProtocolVersion
          ? { mcpProtocolVersion: initializePins.mcpProtocolVersion }
          : {}),
        ...(initializePins?.mirrorToolParamHeaders === false
          ? { mirrorToolParamHeaders: false }
          : {}),
        ...(initializePins?.firstPageOnly === true
          ? { firstPageOnly: true }
          : {}),
        ...(initializePins?.supportsMrtr === false
          ? { supportsMrtr: false }
          : {}),
        ...(initializePins?.suppressLegacyRequestCancellation === true
          ? { suppressLegacyRequestCancellation: true }
          : {}),
        ...(initializePins?.suppressModernRequestCancellation === true
          ? { suppressModernRequestCancellation: true }
          : {}),
      };
    }
    // Hosted web has no local process to spawn into, so a stdio server — an
    // ordinary one, or a plugin component with no live in-computer runtime —
    // is reported with the backend's own readiness vocabulary
    // (`getPluginSetupStatus` marks `placement: "local"` components
    // `local_runtime_required`) rather than attempted. Same word on both
    // surfaces means a client can render one "open the desktop app" affordance
    // without guessing from prose.
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "This server runs over stdio and requires the local runtime (desktop app); hosted mode cannot spawn local processes.",
      { readiness: "local_runtime_required", transport: "stdio" }
    );
  }

  if (!authResponse.serverConfig.url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Authorized server is missing URL"
    );
  }

  const headers: Record<string, string> = {
    ...(authResponse.serverConfig.headers ?? {}),
  };

  if (oauthAccessToken) {
    headers["Authorization"] = `Bearer ${oauthAccessToken}`;
  }

  return {
    url: authResponse.serverConfig.url,
    capabilities: clientCapabilities,
    clientCapabilities: clientCapabilities,
    requestInit: {
      headers,
    },
    timeout: timeoutMs,
    ...(onUnauthorized ? { onUnauthorized } : {}),
    // Plugin-declared transports are authoritative: `sse` skips the
    // Streamable HTTP attempt, `streamable-http` rules out the silent SSE
    // downgrade. Rows without a declaration keep the SDK's URL-heuristic +
    // fallback behavior.
    //
    // `preferSSE: false` is load-bearing on the streamable-http branch — see
    // the same mapping in `local-server-resolver.ts::toMCPServerConfig`: the
    // SDK falls back to a `/sse` URL-path heuristic when `preferSSE` is
    // undefined, which would bypass the Streamable HTTP attempt entirely.
    ...(authResponse.serverConfig.httpVariant === "sse"
      ? { preferSSE: true }
      : {}),
    ...(authResponse.serverConfig.httpVariant === "streamable-http"
      ? { preferSSE: false, disableSseFallback: true }
      : {}),
    // mcpProfile.initialize.* pins, forwarded to the SDK's
    // `BaseServerConfig.clientInfo` / `.supportedProtocolVersions` per
    // `sdk/src/mcp-client-manager/types.ts`. Undefined → SDK defaults.
    ...(initializePins?.clientInfo
      ? { clientInfo: initializePins.clientInfo }
      : {}),
    ...(initializePins?.supportedProtocolVersions &&
    initializePins.supportedProtocolVersions.length > 0
      ? {
          supportedProtocolVersions: initializePins.supportedProtocolVersions,
        }
      : {}),
    ...(initializePins?.mcpProtocolVersion
      ? { mcpProtocolVersion: initializePins.mcpProtocolVersion }
      : {}),
    // Only `false` is meaningful — `true` and absent both mean mirror.
    ...(initializePins?.mirrorToolParamHeaders === false
      ? { mirrorToolParamHeaders: false }
      : {}),
    // Same host-level treatment for the sibling conformance knobs: only the
    // non-default value is meaningful, and there is no per-server map to
    // resolve against.
    ...(initializePins?.firstPageOnly === true ? { firstPageOnly: true } : {}),
    ...(initializePins?.supportsMrtr === false ? { supportsMrtr: false } : {}),
    ...(initializePins?.suppressLegacyRequestCancellation === true
      ? { suppressLegacyRequestCancellation: true }
      : {}),
    ...(initializePins?.suppressModernRequestCancellation === true
      ? { suppressModernRequestCancellation: true }
      : {}),
  };
}

export interface AuthorizedManagerResult {
  manager: MCPClientManager;
  /** Maps serverId → serverUrl for servers that have useOAuth enabled */
  oauthServerUrls: Record<string, string>;
  /** Server-authenticated Convex user/guest id for this request, when known. */
  authenticatedUserId?: string | null;
}

function resolveEffectiveInitializePinsForServer(
  serverId: string,
  initializePins?: {
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    supportedProtocolVersions?: string[];
    mcpProtocolVersion?: McpProtocolVersion;
    mirrorToolParamHeaders?: boolean;
    firstPageOnly?: boolean;
    supportsMrtr?: boolean;
    suppressLegacyRequestCancellation?: boolean;
    suppressModernRequestCancellation?: boolean;
  },
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>
):
  | {
      clientInfo?: { name?: string; version?: string } & Record<
        string,
        unknown
      >;
      supportedProtocolVersions?: string[];
      mcpProtocolVersion?: McpProtocolVersion;
      mirrorToolParamHeaders?: boolean;
      firstPageOnly?: boolean;
      supportsMrtr?: boolean;
      suppressLegacyRequestCancellation?: boolean;
      suppressModernRequestCancellation?: boolean;
    }
  | undefined {
  const perServerPin = mcpProtocolVersionsByServerId?.[serverId];
  const mcpProtocolVersion =
    typeof perServerPin === "string" && isKnownProtocolVersion(perServerPin)
      ? perServerPin
      : initializePins?.mcpProtocolVersion;
  const supportedProtocolVersions =
    mcpProtocolVersion &&
    !isStatelessProtocolVersion(mcpProtocolVersion) &&
    initializePins?.supportedProtocolVersions?.includes(mcpProtocolVersion)
      ? [mcpProtocolVersion]
      : initializePins?.supportedProtocolVersions;

  const resolved = {
    ...(initializePins?.clientInfo
      ? { clientInfo: initializePins.clientInfo }
      : {}),
    ...(supportedProtocolVersions && supportedProtocolVersions.length > 0
      ? { supportedProtocolVersions }
      : {}),
    ...(mcpProtocolVersion ? { mcpProtocolVersion } : {}),
    // Host-level and per-server-invariant: mirroring conformance is a property
    // of the simulated CLIENT, so unlike the version pin there is nothing to
    // resolve against a per-server map.
    ...(initializePins?.mirrorToolParamHeaders === false
      ? { mirrorToolParamHeaders: false }
      : {}),
    // Same host-level treatment for the sibling conformance knobs: only the
    // non-default value is meaningful, and there is no per-server map to
    // resolve against.
    ...(initializePins?.firstPageOnly === true ? { firstPageOnly: true } : {}),
    ...(initializePins?.supportsMrtr === false ? { supportsMrtr: false } : {}),
    ...(initializePins?.suppressLegacyRequestCancellation === true
      ? { suppressLegacyRequestCancellation: true }
      : {}),
    ...(initializePins?.suppressModernRequestCancellation === true
      ? { suppressModernRequestCancellation: true }
      : {}),
  };

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export async function createAuthorizedManager(
  caller: ManagerCallerContext,
  bearerToken: string,
  projectId: string,
  serverIds: string[],
  timeoutMs: number,
  oauthTokens?: Record<string, string>,
  clientCapabilities?: Record<string, unknown>,
  options?: {
    accessScope?: "project_member" | "chat_v2";
    /**
     * Declare `io.modelcontextprotocol/skills` on this manager's DEFAULTS.
     *
     * Opt-in, and deliberately not the norm. Most hosted connections EMULATE a
     * third-party host, and the debugger's promise is that the wire shows what
     * that host would send — advertising skills on an emulated Cursor persona
     * would be a lie about Cursor. Surfaces that emulate no persona (MCPJam's
     * own agent turn) pass this, because they ship the fulfiller: the verified
     * read path in `server-skills.ts`, merged into the toolset by
     * `withServerSkills`.
     *
     * Set on DEFAULTS rather than per-server `clientCapabilities` on purpose.
     * The latter is advertised VERBATIM (see `MCPClientManager`'s exact-set
     * branch), so putting the extension there would replace a connection's
     * whole declaration — silently dropping elicitation — and would also
     * override a host config that pinned its own set. Defaults merge, and a
     * pinned exact set still wins.
     */
    advertiseSkillsExtension?: boolean;
    scenarioId?: string;
    accessVersion?: number;
    rpcLogger?: RpcLogger;
    /**
     * Headers-only HTTP-exchange channel, a SEPARATE SDK channel from
     * `rpcLogger`: from 2026-07-28 the mirrored `Mcp-*` headers a
     * `-32020 HeaderMismatch` is about are not in the JSON-RPC body at all.
     * Threaded wherever `rpcLogger` is so hosted Tracing sees the same wire
     * local mode does.
     */
    httpLogger?: HttpExchangeLogger;
    serverNames?: string[];
    /**
     * mcpProfile.initialize.* pins. `clientInfo` and
     * `supportedProtocolVersions` are host-profile-level — they apply
     * uniformly to every authorized server in the batch.
     * `mcpProtocolVersion` is the batch-uniform fallback wire mode;
     * `mcpProtocolVersionsByServerId` (sibling option below) overrides
     * it per server. This lets a batch contain one server pinned to
     * 2026-07-28 stateless alongside another on legacy
     * 2025-11-25 negotiation.
     */
    initializePins?: {
      clientInfo?: { name?: string; version?: string } & Record<
        string,
        unknown
      >;
      supportedProtocolVersions?: string[];
      mcpProtocolVersion?: McpProtocolVersion;
      /** SEP-2243 `Mcp-Param-*` mirroring; host-level, so batch-uniform. */
      mirrorToolParamHeaders?: boolean;
      /** Client-conformance knobs; host-level, so batch-uniform. */
      firstPageOnly?: boolean;
      supportsMrtr?: boolean;
      suppressLegacyRequestCancellation?: boolean;
      suppressModernRequestCancellation?: boolean;
    };
    /**
     * Per-server `mcpProtocolVersion` overrides keyed by serverId.
     * Values already passed `isKnownProtocolVersion` at the route
     * boundary (the schema validates each entry against the wire-mode
     * enum); we re-check here as a defense-in-depth so a future
     * caller bypassing the schema can't slip a typo to the SDK.
     *
     * Resolution: `mcpProtocolVersionsByServerId[serverId]` (if known)
     * → `initializePins.mcpProtocolVersion` (batch-uniform) →
     * undefined (SDK chooses at request time).
     */
    mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
    /**
     * Per-server request-timeout overrides keyed by serverId, in milliseconds.
     * Used by the swarm runner to honor each pinned server's
     * `requestTimeoutOverride` from the run snapshot instead of applying the
     * single host-level `timeoutMs` uniformly. Resolution per server:
     * `requestTimeoutByServerId[serverId]` (if a positive finite number) →
     * `timeoutMs` (the batch-uniform host default). The manager's
     * `defaultTimeout` stays `timeoutMs`.
     */
    requestTimeoutByServerId?: Record<string, number>;
    /**
     * Pre-resolved MCPJam test-IdP issuer (`resolveXaaIssuer(c, HOSTED_MODE)`)
     * for Cross-App Access servers. Supplied by callers that have the request
     * `Context`. Required whenever the batch contains a `useXaa` server — the
     * builder throws a 500 rather than connecting tokenless if it's missing.
     */
    xaaIssuer?: string;
    /**
     * The host's enterprise-managed authorization policy (validated `on`
     * value). Read from the BACKEND-PROJECTED host config wherever a
     * server-side host exists (scenario turns, host-bound turns, swarm
     * snapshots, eval host configs) — never trusted from a shareable
     * request body, because dropping the policy on an unconfigured `auto`
     * server would downgrade xaa→discover→OAuth. Under the policy every
     * HTTP `auto` server resolves to XAA (unconfigured ones fail 409
     * XAA_CONNECTION_NOT_CONFIGURED pre-mint), and the EMA extension is
     * advertised on every server of the batch. Callers passing this MUST
     * also pass `xaaIssuer`.
     */
    xaaPolicy?: XaaEnterprisePolicy;
    /**
     * Global elicitation callback for INTERACTIVE, streaming surfaces.
     *
     * Registration is what makes elicitation work at all: `buildCapabilities`
     * strips a host-declared `elicitation` capability unless a handler is
     * already registered at connect time, so passing this is simultaneously
     * "advertise it" and "honor it" — they cannot drift apart.
     *
     * MUST be registered here, not by the caller: the manager constructor kicks
     * off connects in a microtask, so a caller registering after
     * `await createAuthorizedManager(...)` loses the race and the capability is
     * silently stripped. Registering synchronously below always wins.
     *
     * Non-interactive surfaces (swarm, evals, scenario persona/simulation,
     * tools/execute) deliberately omit this: they have no human to answer, so
     * servers should fail fast rather than block on a prompt nobody sees.
     */
    elicitationCallback?: ElicitationCallback;
    /**
     * Total suspended-time budget per tool call while an elicitation is pending
     * (SDK-side watchdog). Only meaningful alongside `elicitationCallback`.
     */
    elicitationTimeoutExtensionMs?: number;
    /**
     * Per-server MRTR (`input_required`) input collector factory (MCP
     * 2026-07-28 §12.5). Returns the collector for a given serverId, or
     * `undefined` to leave that server on today's non-MRTR path.
     *
     * Registered SYNCHRONOUSLY below for the SAME reason as
     * `elicitationCallback`: a 2026-07-28 server only embeds an elicitation
     * when the client advertised the capability at connect, and the manager
     * constructor kicks off connects in a microtask — so a collector registered
     * after `await createAuthorizedManager(...)` loses the race and
     * `buildCapabilities` strips `elicitation` before the round can ever occur.
     * Registering here always wins.
     *
     * For HOSTED surfaces this collector SUSPENDS (persists an
     * `MrtrOperationState` to the continuation store, emits a
     * `data-mrtr-input-required` part, and throws `MrtrSuspendedSignal` to
     * return control) rather than blocking the worker on a human answer — the
     * whole point of the durable continuation transport (see
     * `server/utils/mrtr-hosted-collector.ts`).
     */
    mrtrInputCollectorForServer?: (
      serverId: string
    ) => MrtrInputCollector | undefined;
    /**
     * The turn's execution scope, forwarded to the computer reservation that
     * hosts a plugin's stdio component (`resolvePluginStdioHttpTarget`). Only
     * meaningful on hosted deployments that can colocate; absent falls back to
     * the legacy project-only reserve, which on a host-funded swarm or guest
     * turn would resolve a DIFFERENT machine than the one the turn is using.
     */
    executionScope?: ExecutionScope;
  }
): Promise<AuthorizedManagerResult> {
  const serverNamesById = buildServerNamesById(serverIds, options?.serverNames);
  const uniqueServerIds = Array.from(new Set(serverIds));
  if (uniqueServerIds.length === 0) {
    return {
      manager: new MCPClientManager(
        {},
        {
          defaultTimeout: timeoutMs,
          rpcLogger: options?.rpcLogger,
          httpLogger: options?.httpLogger,
          retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
          // Auto-negotiation outcome telemetry (always-on negotiation).
          negotiationOutcomeLogger: negotiationTelemetryLogger("hosted-direct"),
        }
      ),
      oauthServerUrls: {},
      authenticatedUserId: null,
    };
  }

  const oauthServerUrls: Record<string, string> = {};
  const batch = await authorizeBatch(
    caller,
    bearerToken,
    projectId,
    uniqueServerIds,
    {
      accessScope: options?.accessScope,
      scenarioId: options?.scenarioId,
      accessVersion: options?.accessVersion,
    }
  );

  // PASS 1 — validate the WHOLE batch before any server does side-effecting
  // work. The mint pass below runs concurrently (Promise.all), so a check
  // living inside it only fails *its own* server: a sibling's XAA mint (a
  // real token issued at the resource AS) would already be in flight by the
  // time this one rejects. Every purely-synchronous configuration verdict
  // therefore belongs here, so "fails before any side effects" holds for the
  // batch, not just per server.
  // Resolved once here and reused by PASS 2, so the two passes provably agree
  // on each server's flow (a re-resolution could drift if the predicate ever
  // gains an input one pass forgets to thread).
  const effectiveAuthByServerId = new Map<string, EffectiveAuthMethod>();
  // Servers whose authorization server only this machine can reach. Collected
  // in PASS 1, refreshed in PASS 1b, consumed by PASS 2.
  const privateAuthorizationServerRecoveries: Array<{
    serverId: string;
    displayServerName: string;
    required: boolean;
  }> = [];
  const recoveredOAuthTokens: Record<string, string> = {};
  let confidentialCimdProviderForOrg: ReturnType<
    typeof getConfidentialCimdProviderForOrg
  > = undefined;
  let confidentialCimdProviderForOrgResolved = false;
  for (const serverId of uniqueServerIds) {
    const auth = batch.results[serverId];
    if (!auth) {
      throw new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        `Authorization response is missing result for server "${serverId}"`
      );
    }
    if (!auth.ok) {
      throw new WebRouteError(
        auth.status,
        auth.code as ErrorCode,
        auth.message
      );
    }
    const displayServerName = serverNamesById?.[serverId] ?? serverId;
    const effectiveAuth = resolveEffectiveAuthMethod(
      auth.serverConfig,
      options?.xaaPolicy
    );
    effectiveAuthByServerId.set(serverId, effectiveAuth);
    const isHttp = auth.serverConfig.transportType === "http";

    // Enterprise policy, unconfigured `auto` server: never silently downgrade
    // to the discover ladder. "Not configured" (no stored client registration
    // at the resource authorization server), NOT "not enrolled" — enrollment
    // verdicts belong to the future issuer-policy evaluator.
    if (
      isHttp &&
      xaaPolicyRequiresConfiguration(auth.serverConfig, options?.xaaPolicy)
    ) {
      throw new WebRouteError(
        409,
        ErrorCode.XAA_CONNECTION_NOT_CONFIGURED,
        `Server "${displayServerName}" has no XAA client registration configured. This host requires enterprise-managed authorization — add the server's client registration in its auth settings, or set an explicit auth method to override the host policy.`,
        {
          serverId,
          serverName: serverNamesById?.[serverId] ?? null,
          reason: "xaa_connection_not_configured",
        }
      );
    }

    // Backend-resolved identity failure (legacy partial per-server override):
    // a distinct configuration error, surfaced before any mint AND before the
    // issuer guard — eval routes omit `xaaIssuer`, so checking that first
    // would mask this actionable 400 behind the caller-contract 500. Gated on
    // the same XAA selection the mint pass uses. No silent fallback to the
    // demo identity, no silent XAA→OAuth fallback.
    //
    // Framed like every other connect-time XAA failure: the backend's sentence
    // is written for the server's auth form, and on its own ("Complete or
    // clear the server identity override") it names neither the server nor the
    // surface. It is kept verbatim as the reason clause.
    if (
      isHttp &&
      effectiveAuth === "xaa" &&
      auth.serverConfig.xaaIdentityError
    ) {
      throw toXaaConnectFailure(
        new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          auth.serverConfig.xaaIdentityError
        ),
        {
          serverId,
          serverName: displayServerName,
          ...(auth.serverConfig.url
            ? { serverUrl: auth.serverConfig.url }
            : {}),
        }
      );
    }

    if (isHttp && effectiveAuth === "xaa") {
      const registrationMode = resolveXaaConnectRegistrationMode(
        auth.serverConfig.registrationMode
      );
      if (
        registrationMode === "cimd" &&
        auth.serverConfig.xaaClientAuth === "private_key_jwt"
      ) {
        if (batch.isAnonymous !== false) {
          throw new WebRouteError(
            403,
            ErrorCode.FORBIDDEN,
            "Confidential CIMD requires a signed-in organization member"
          );
        }
        if (!batch.organizationId) {
          throw new WebRouteError(
            409,
            ErrorCode.FEATURE_NOT_SUPPORTED,
            "Confidential CIMD requires an organization-owned project"
          );
        }
        if (!confidentialCimdProviderForOrgResolved) {
          confidentialCimdProviderForOrg = getConfidentialCimdProviderForOrg();
          confidentialCimdProviderForOrgResolved = true;
        }
        if (!confidentialCimdProviderForOrg) {
          throw new WebRouteError(
            409,
            ErrorCode.FEATURE_NOT_SUPPORTED,
            "Confidential CIMD is not enabled on this inspector deployment"
          );
        }
      }
    }

    // A credential EXISTS but the backend cannot refresh it: its authorization
    // server is on an address only this machine can reach. Not a verdict at
    // all — in local mode it is recoverable, so it is deferred to the recovery
    // pass below rather than decided here. Hosted, it is a real refusal, but
    // "complete the OAuth flow first" is the wrong thing to say to someone who
    // already did; the recovery pass raises the actionable message instead.
    const privateAuthorizationServer =
      auth.oauthUnavailableReason === "private_authorization_server" &&
      !(auth.oauthAccessToken ?? oauthTokens?.[serverId]);
    if (
      privateAuthorizationServer &&
      (effectiveAuth === "oauth" || effectiveAuth === "discover")
    ) {
      privateAuthorizationServerRecoveries.push({
        serverId,
        displayServerName,
        required: effectiveAuth === "oauth",
      });
      continue;
    }

    // Explicit-OAuth server with no stored token: also a synchronous verdict,
    // so it belongs here — leaving it in the concurrent pass let a configured
    // XAA sibling start minting a real token while this one rejected.
    if (
      effectiveAuth === "oauth" &&
      !(auth.oauthAccessToken ?? oauthTokens?.[serverId])
    ) {
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        `Server "${displayServerName}" requires OAuth authentication. Please complete the OAuth flow first.`,
        {
          oauthRequired: true,
          serverId,
          serverName: serverNamesById?.[serverId] ?? null,
          serverUrl: auth.serverConfig.url,
        }
      );
    }
  }

  // PASS 1b — recover the credentials PASS 1 deferred, still before PASS 2
  // does anything side-effecting, so "the batch fails before any server mints"
  // continues to hold.
  //
  // This is the same pre-connect refresh `resolveLocalServerForConnect`
  // performs for /api/mcp. Without it the local fallback only ever covered a
  // mid-session 401, and the FIRST connect after expiry still failed on every
  // surface routed through this builder.
  //
  // Sequential on purpose: the servers here share one force-refresh budget per
  // subject, and each recovery is a network round trip to the user's own
  // machine. There is rarely more than one.
  for (const recovery of privateAuthorizationServerRecoveries) {
    try {
      recoveredOAuthTokens[recovery.serverId] =
        await refreshHostedOAuthAccessTokenWithLocalFallback(
          bearerToken,
          projectId,
          recovery.serverId,
          {
            accessScope: options?.accessScope,
            scenarioId: options?.scenarioId,
            accessVersion: options?.accessVersion,
            serverName: recovery.displayServerName,
          }
        );
    } catch (error) {
      // A "discover" server was only ever going to try its luck: connecting
      // unauthenticated is the documented fallback, and a live 401 escalates
      // client-side from there. Only an explicit-OAuth server has to fail.
      if (!recovery.required) {
        logger.debug(
          "[connect] private authorization server refresh unavailable; connecting unauthenticated",
          {
            serverId: recovery.serverId,
            error: parseErrorMessage(error),
          }
        );
        continue;
      }
      throw error;
    }
  }

  // Plugin bundle leases acquired by the stdio divert below. Held per
  // MANAGER, not in the process-wide registry: two concurrent turns on the
  // same plugin server must each pin the bundle independently (the
  // registry's replace-on-retain would let the second turn unpin the
  // first's still-running child), and this batch releases its own leases at
  // teardown. Drained (not just iterated) so a double disconnect can't
  // double-release.
  const pluginLeaseReleases: Array<() => void> = [];
  const releasePluginLeases = () => {
    while (pluginLeaseReleases.length > 0) {
      pluginLeaseReleases.pop()!();
    }
  };

  // PASS 2 — connect/mint concurrently. Every server reaching this point has
  // already cleared the batch-wide validation above.
  const configEntries = await Promise.all(
    uniqueServerIds.map(async (serverId) => {
      // Non-null: PASS 1 threw for a missing or failed authorize result.
      const auth = batch.results[serverId] as Extract<
        (typeof batch.results)[string],
        { ok: true }
      >;

      // `recoveredOAuthTokens` first: it is the freshest, minted moments ago
      // by PASS 1b for a credential the backend could not refresh itself.
      const oauthToken =
        recoveredOAuthTokens[serverId] ??
        auth.oauthAccessToken ??
        oauthTokens?.[serverId];
      const displayServerName = serverNamesById?.[serverId] ?? serverId;
      // Resolved in PASS 1 (canonical authMethod wins; "auto" selects XAA
      // when configured or when the host policy forces it, "discover"
      // otherwise; legacy rows fall back to the boolean pair). Reused rather
      // than re-resolved so both passes agree by construction. Must match the
      // local resolver's dispatch (hosted/local/swarm parity).
      const effectiveAuth = effectiveAuthByServerId.get(
        serverId
      ) as EffectiveAuthMethod;

      const effectiveInitializePins = resolveEffectiveInitializePinsForServer(
        serverId,
        options?.initializePins,
        options?.mcpProtocolVersionsByServerId
      );
      // Per-server timeout: a pinned `requestTimeoutOverride` (threaded by the
      // swarm runner) wins over the batch-uniform host default. Guard against a
      // malformed snapshot value falling through to a non-positive timeout.
      const perServerTimeout = options?.requestTimeoutByServerId?.[serverId];
      const effectiveTimeoutMs =
        typeof perServerTimeout === "number" &&
        Number.isFinite(perServerTimeout) &&
        perServerTimeout > 0
          ? perServerTimeout
          : timeoutMs;

      // LOCAL RUNTIME stdio divert. When this /api/web deployment IS the
      // local binary (npx/desktop), a stdio server — an ordinary one or a
      // plugin's local component — CAN spawn here: this is the same process
      // the /api/mcp engine spawns stdio children from. The hosted authorize
      // batch strips command/args/env by contract, so the local resolver
      // re-reads the full config through /web/authorize-batch-local (same
      // bearer — authorization is re-checked, not assumed), applies runtime
      // secrets, and materializes plugin bundles before building the SDK
      // config. HOSTED deployments keep the `toHttpConfig` 400 below: there
      // is genuinely no local process to spawn into (until stdio-in-computer
      // execution lands).
      if (auth.serverConfig.transportType !== "http" && !HOSTED_MODE) {
        const config = await resolveLocalStdioServerConfig(
          bearerToken,
          projectId,
          serverId,
          {
            timeoutMs: effectiveTimeoutMs,
            clientCapabilities,
            serverDisplayName: displayServerName,
            clientInfo: effectiveInitializePins?.clientInfo,
            supportedProtocolVersions:
              effectiveInitializePins?.supportedProtocolVersions,
            firstPageOnly: effectiveInitializePins?.firstPageOnly,
            supportsMrtr: effectiveInitializePins?.supportsMrtr,
            xaaPolicy: options?.xaaPolicy,
            // The local reread + secret reveal must carry the same scope and
            // delegated identity as the hosted mint path below — a harness
            // caller's bearer is deliberately empty (workos_api_key supplies
            // the service-token exchange), and a scenario-scoped caller's
            // reveal is gated on scenarioId/accessVersion.
            accessScope: options?.accessScope,
            scenarioId: options?.scenarioId,
            accessVersion: options?.accessVersion,
            workosApiKeyActingAs:
              caller.authMethod === "workos_api_key" &&
              caller.workosUserId &&
              caller.mcpjamOrganizationId
                ? {
                    workosUserId: caller.workosUserId,
                    mcpjamOrganizationId: caller.mcpjamOrganizationId,
                  }
                : undefined,
            onPluginLease: (release) => pluginLeaseReleases.push(release),
          }
        );
        return [serverId, config] as const;
      }

      // HOSTED stdio divert. There is still no process here to spawn into, so
      // a plugin's local component runs inside the caller's OWN computer behind
      // the in-VM shim and this connection reaches it as an ordinary remote
      // Streamable-HTTP server. `null` covers every reason that cannot happen
      // (not a data plane, no box, an ordinary non-plugin stdio row, a bundle
      // that will not verify, a session record that did not land) and leaves
      // the `toHttpConfig` refusal below exactly as it was.
      let pluginRuntime: PluginStdioHttpTarget | undefined;
      if (auth.serverConfig.transportType !== "http") {
        pluginRuntime =
          (await resolvePluginStdioHttpTarget({
            bearerToken,
            projectId,
            serverId,
            serverDisplayName: displayServerName,
            accessScope: options?.accessScope,
            scenarioId: options?.scenarioId,
            accessVersion: options?.accessVersion,
            // From THIS batch's own authorize response, not from the request:
            // it is what decides whether the caller has a membership the spec
            // reread can run under.
            isAnonymous: batch.isAnonymous,
            // The turn's scope, so the computer reservation resolves the SAME
            // box the rest of the turn runs on. Without it a host-funded swarm
            // or guest turn would fall back to a project-only reserve and could
            // wake a second, unrelated machine purely because a plugin was
            // pinned.
            executionScope: options?.executionScope,
            workosApiKeyActingAs:
              caller.authMethod === "workos_api_key" &&
              caller.workosUserId &&
              caller.mcpjamOrganizationId
                ? {
                    workosUserId: caller.workosUserId,
                    mcpjamOrganizationId: caller.mcpjamOrganizationId,
                  }
                : undefined,
          })) ?? undefined;
      }

      const usesOAuthFlow = effectiveAuth === "oauth";
      // "discover" (non-XAA auto) rides the OAuth rails only when a stored
      // token exists; tokenless discover connects unauthenticated instead of
      // failing pre-connect — a live 401 then surfaces from the connect
      // itself (mapRuntimeError gives it a 401 status; only the interactive
      // validate route tags it oauthRequired for client escalation).
      const usesStoredTokenFlow =
        usesOAuthFlow || (effectiveAuth === "discover" && !!oauthToken);
      const onUnauthorized =
        usesStoredTokenFlow &&
        (auth.oauthAccessToken || recoveredOAuthTokens[serverId])
          ? buildHostedOAuthUnauthorizedHandler({
              bearerToken,
              projectId,
              serverId,
              serverName: displayServerName,
              accessScope: options?.accessScope,
              shareToken: (options as { shareToken?: string })?.shareToken,
              scenarioId: options?.scenarioId,
              accessVersion: options?.accessVersion,
              // Same reasoning as the local resolver's own handler: in local
              // mode THIS process is the one that can reach a private
              // authorization server. Without it every surface routed through
              // here — chat-v2, evals, environments, swarm runs, harness-mcp —
              // still dies at the first mid-session token expiry against a
              // localhost OAuth server, while the Servers tab (which goes
              // through /api/mcp) succeeds against the same server.
              allowPrivateAuthorizationServerFallback: !HOSTED_MODE,
            })
          : undefined;

      if (usesStoredTokenFlow && auth.serverConfig.url) {
        oauthServerUrls[serverId] = auth.serverConfig.url;
      }
      // (An explicit-OAuth server with no stored token is rejected batch-wide
      // in PASS 1 — before any sibling can mint.)

      // Cross-App Access: mint the resource access token server-side (MCPJam as
      // the test IdP) and inject it through the same `oauthAccessToken` channel
      // that sets the Bearer header. The effective method is a hard selection
      // (auto picked XAA because the server is XAA-configured, or the row says
      // xaa) — it can never collide with the OAuth branch above. The XAA token
      // always overrides whatever the authorize batch returned: a server
      // converted from OAuth still has a stored OAuth token, and reusing it
      // would inject the wrong credential.
      let connectToken = oauthToken;
      let connectOnUnauthorized = onUnauthorized;
      const useXaa =
        auth.serverConfig.transportType === "http" && effectiveAuth === "xaa";
      if (useXaa) {
        // (`xaaIdentityError` is validated batch-wide in PASS 1 — before any
        // sibling server can mint.)
        if (!options?.xaaIssuer) {
          // Caller-contract violation: a `useXaa` server reached a manager
          // builder that didn't thread the issuer (only callers holding the
          // request `Context` can resolve it). Fail loud here rather than
          // connecting tokenless and surfacing a confusing downstream 401.
          throw new WebRouteError(
            500,
            ErrorCode.INTERNAL_ERROR,
            `Missing XAA issuer for server "${displayServerName}". This connect surface must pass options.xaaIssuer.`
          );
        }
        let confidentialCimdProvider: ConfidentialCimdProvider | undefined;
        if (
          resolveXaaConnectRegistrationMode(
            auth.serverConfig.registrationMode
          ) === "cimd" &&
          auth.serverConfig.xaaClientAuth === "private_key_jwt"
        ) {
          try {
            confidentialCimdProvider = confidentialCimdProviderForOrg!(
              batch.organizationId!
            );
          } catch (error) {
            logger.error(
              "[XAA connect] confidential CIMD provider preparation failed",
              error,
              {
                serverId,
                serverName: displayServerName,
                resource: auth.serverConfig.url,
                projectId,
                organizationId: batch.organizationId,
              }
            );
            throw new WebRouteError(
              500,
              ErrorCode.INTERNAL_ERROR,
              "Could not prepare the confidential CIMD client identity"
            );
          }
        }
        const mintArgs = buildXaaMintArgs({
          issuer: options.xaaIssuer,
          hostedMode: HOSTED_MODE,
          serverConfig: auth.serverConfig,
          serverId,
          projectId,
          bearerToken,
          resolveServerSecret: fetchServerClientSecret,
          organizationId: batch.organizationId,
          isAnonymous: batch.isAnonymous,
          confidentialCimdProvider,
        });
        const xaaFailureTarget = {
          serverId,
          serverName: displayServerName,
          ...(auth.serverConfig.url
            ? { serverUrl: auth.serverConfig.url }
            : {}),
        };
        try {
          connectToken = (await mintXaaAccessToken(mintArgs)).accessToken;
        } catch (error) {
          if (!isXaaMintErrorReported(error)) {
            logger.error("[XAA connect] mint failed", error, {
              serverId,
              serverName: displayServerName,
              resource: auth.serverConfig.url,
            });
          }
          // Re-framed AFTER the log above, so the debugger-worded original is
          // what reaches Sentry/Axiom (as `cause`) while the caller gets the
          // connect-context sentence.
          throw toXaaConnectFailure(error, xaaFailureTarget);
        }
        // Bounded re-mint: the SDK invokes this once on a 401 and retries; a
        // second 401 surfaces rather than looping mint→401→mint.
        let reMinted = false;
        connectOnUnauthorized = async () => {
          if (reMinted) {
            throw new WebRouteError(
              401,
              ErrorCode.UNAUTHORIZED,
              `Server "${displayServerName}" rejected the cross-app access token. Reconnect to retry.`
            );
          }
          reMinted = true;
          try {
            return {
              accessToken: (await mintXaaAccessToken(mintArgs)).accessToken,
            };
          } catch (error) {
            throw toXaaConnectFailure(error, xaaFailureTarget);
          }
        };
      }

      // Tokenless "discover" (non-XAA auto): connect unauthenticated, and if
      // the target answers 401, convert it into the same tagged oauthRequired
      // shape the pre-connect throw produces. The SDK invokes onUnauthorized
      // exactly when a request 401s, which is the one moment we have both the
      // per-server identity and proof the server actually demands auth —
      // interactive clients escalate into the OAuth flow on this shape, and
      // the non-interactive chat surfaces already render it as their
      // "complete OAuth first" affordance.
      if (effectiveAuth === "discover" && !connectToken) {
        connectOnUnauthorized = async () => {
          throw new WebRouteError(
            401,
            ErrorCode.UNAUTHORIZED,
            `Server "${displayServerName}" requires authorization.`,
            {
              oauthRequired: true,
              serverId,
              serverName: serverNamesById?.[serverId] ?? null,
              serverUrl: auth.serverConfig.url,
            }
          );
        };
      }

      const authForConfig =
        auth.serverConfig.hasHeaders === true &&
        !hasNonEmptyStringRecord(auth.serverConfig.headers)
          ? {
              ...auth,
              serverConfig: {
                ...auth.serverConfig,
                headers: {
                  ...(auth.serverConfig.headers ?? {}),
                  ...((
                    await fetchRuntimeServerSecrets({
                      bearerToken,
                      projectId,
                      serverId,
                      accessScope: options?.accessScope,
                      scenarioId: options?.scenarioId,
                      accessVersion: options?.accessVersion,
                      // When the caller authed via WorkOS API key, secret
                      // reveal must use the same delegated-identity exchange
                      // as `authorizeBatch` — otherwise Convex would see the
                      // service token without an acting-as user.
                      workosApiKeyActingAs:
                        caller.authMethod === "workos_api_key" &&
                        caller.workosUserId &&
                        caller.mcpjamOrganizationId
                          ? {
                              workosUserId: caller.workosUserId,
                              mcpjamOrganizationId: caller.mcpjamOrganizationId,
                            }
                          : undefined,
                    })
                  ).headers ?? {}),
                },
              },
            }
          : auth;

      // Spec (MCP enterprise-managed authorization): a client whose access is
      // enterprise-managed MUST advertise the extension in initialize. Merged
      // — never overwriting — into the caller-configured capabilities.
      // Advertised when the connection actually uses XAA (the backstop) or
      // whenever the host's enterprise policy is on — declare-support is
      // host-wide, including on servers whose explicit auth method overrides
      // the policy.
      const perServerCapabilities =
        useXaa || options?.xaaPolicy != null
          ? withXaaExtensionCapability(clientCapabilities)
          : clientCapabilities;

      return [
        serverId,
        toHttpConfig(
          authForConfig,
          effectiveTimeoutMs,
          connectToken,
          perServerCapabilities,
          connectOnUnauthorized,
          effectiveInitializePins,
          pluginRuntime
        ),
      ] as const;
    })
  ).catch((error) => {
    // A sibling server's throw (OAuth-required, XAA mint failure, …) aborts
    // the whole batch — leases already acquired by other servers' diverts
    // must not outlive the manager that will now never exist.
    releasePluginLeases();
    throw error;
  });

  const manager = new MCPClientManager(Object.fromEntries(configEntries), {
    defaultTimeout: timeoutMs,
    rpcLogger: options?.rpcLogger,
    httpLogger: options?.httpLogger,
    retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
    ...(options?.advertiseSkillsExtension
      ? { defaultCapabilities: withSkillsExtensionCapability({}) }
      : {}),
    // Auto-negotiation outcome telemetry (always-on negotiation).
    negotiationOutcomeLogger: negotiationTelemetryLogger("hosted-direct"),
    ...(options?.elicitationTimeoutExtensionMs !== undefined
      ? { elicitationTimeoutExtensionMs: options.elicitationTimeoutExtensionMs }
      : {}),
  });
  if (pluginLeaseReleases.length > 0) {
    // Every ephemeral-manager teardown path (withManager, web-chat-turn
    // cleanup, manual-connection callers) funnels through
    // `disconnectAllServers`, so decorating the instance releases this
    // batch's plugin bundle leases on ALL of them without threading a new
    // return value to every caller. The drain makes a second call a no-op.
    const disconnect = manager.disconnectAllServers.bind(manager);
    manager.disconnectAllServers = async () => {
      try {
        await disconnect();
      } finally {
        releasePluginLeases();
      }
    };
  }
  // SYNCHRONOUS, before any `await` — the constructor above queued its connects
  // as microtasks, and `buildCapabilities` (which decides whether `elicitation`
  // survives onto the initialize wire) runs inside them. Registering here always
  // wins that race; registering after an await never does.
  if (options?.elicitationCallback) {
    manager.setElicitationCallback(options.elicitationCallback);
  }
  // ALSO synchronous, same microtask-race discipline: register each server's
  // MRTR collector before the constructor's connects run, so `buildCapabilities`
  // advertises `elicitation` on the initialize wire for MRTR-capable servers.
  if (options?.mrtrInputCollectorForServer) {
    for (const serverId of uniqueServerIds) {
      const collector = options.mrtrInputCollectorForServer(serverId);
      if (collector) {
        manager.setMrtrInputCollector(serverId, collector);
      }
    }
  }
  return {
    manager,
    oauthServerUrls,
    authenticatedUserId: caller.getLogContext?.()?.userId ?? null,
  };
}

export async function withManager<T>(
  managerPromise: Promise<MCPClientManager> | Promise<AuthorizedManagerResult>,
  fn: (manager: MCPClientManager) => Promise<T>
): Promise<T> {
  const result = await managerPromise;
  const manager =
    "manager" in result ? result.manager : (result as MCPClientManager);
  try {
    return await fn(manager);
  } finally {
    await manager.disconnectAllServers();
  }
}

export async function handleRoute<T>(
  c: any,
  handler: () => Promise<T>,
  successStatus = 200
) {
  try {
    const result = await handler();
    return c.json(result, successStatus);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webErrorFromRoute(c, routeError);
  }
}

// ── Ephemeral Connection Helper ──────────────────────────────────────

/**
 * Resolve server IDs and OAuth tokens from parsed request body.
 *
 * Supports two shapes:
 *   - Single-server: { serverId, serverName?, oauthAccessToken? }
 *   - Multi-server:  { serverIds, serverNames?, oauthTokens? }
 */
function resolveConnectionParams(body: Record<string, unknown>): {
  serverIds: string[];
  oauthTokens: Record<string, string> | undefined;
  serverNames: string[] | undefined;
} {
  if (Array.isArray(body.serverIds)) {
    return {
      serverIds: body.serverIds as string[],
      oauthTokens: body.oauthTokens as Record<string, string> | undefined,
      serverNames: Array.isArray(body.serverNames)
        ? (body.serverNames as string[])
        : undefined,
    };
  }
  return {
    serverIds: [body.serverId as string],
    oauthTokens: buildSingleServerOAuthTokens(
      body.serverId as string,
      body.oauthAccessToken as string | undefined
    ),
    serverNames:
      typeof body.serverName === "string" && body.serverName.trim()
        ? [body.serverName]
        : undefined,
  };
}

export function extractMcpInitializeOptions(raw: Record<string, unknown>): {
  initializePins?: {
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    supportedProtocolVersions?: string[];
    mcpProtocolVersion?: McpProtocolVersion;
    mirrorToolParamHeaders?: boolean;
    firstPageOnly?: boolean;
    supportsMrtr?: boolean;
    suppressLegacyRequestCancellation?: boolean;
    suppressModernRequestCancellation?: boolean;
  };
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
} {
  // Extract mcpProfile.initialize.* pins so they flow into every
  // HttpServerConfig created by createAuthorizedManager. Defensive shape
  // gating: malformed fields silently fall back to SDK defaults rather
  // than failing the whole route.
  const rawClientInfo = raw.clientInfo;
  const initializeClientInfo =
    rawClientInfo &&
    typeof rawClientInfo === "object" &&
    !Array.isArray(rawClientInfo)
      ? (rawClientInfo as { name?: string; version?: string } & Record<
          string,
          unknown
        >)
      : undefined;
  const rawSupportedVersions = raw.supportedProtocolVersions;
  const initializeSupportedVersions =
    Array.isArray(rawSupportedVersions) &&
    rawSupportedVersions.every((v) => typeof v === "string" && v.length > 0)
      ? (rawSupportedVersions as string[])
      : undefined;
  const rawProtocolVersion = raw.mcpProtocolVersion;
  const initializeWireMode: McpProtocolVersion | undefined =
    typeof rawProtocolVersion === "string" &&
    isKnownProtocolVersion(rawProtocolVersion)
      ? rawProtocolVersion
      : undefined;
  // Only an explicit `false` opts into the non-conforming simulation; every
  // other value (including a stray `true`) falls back to mirroring.
  const suppressParamMirroring = raw.mirrorToolParamHeaders === false;
  // Same one-explicit-value rule for the sibling knobs.
  const truncatePagination = raw.firstPageOnly === true;
  const disableMrtr = raw.supportsMrtr === false;
  const disableLegacyCancellation =
    raw.suppressLegacyRequestCancellation === true;
  const disableModernCancellation =
    raw.suppressModernRequestCancellation === true;
  const initializePins =
    initializeClientInfo ||
    initializeSupportedVersions ||
    initializeWireMode ||
    suppressParamMirroring ||
    truncatePagination ||
    disableMrtr ||
    disableLegacyCancellation ||
    disableModernCancellation
      ? {
          ...(initializeClientInfo ? { clientInfo: initializeClientInfo } : {}),
          ...(initializeSupportedVersions
            ? { supportedProtocolVersions: initializeSupportedVersions }
            : {}),
          ...(initializeWireMode
            ? { mcpProtocolVersion: initializeWireMode }
            : {}),
          ...(truncatePagination ? { firstPageOnly: true } : {}),
          ...(disableMrtr ? { supportsMrtr: false } : {}),
          ...(disableLegacyCancellation
            ? { suppressLegacyRequestCancellation: true }
            : {}),
          ...(disableModernCancellation
            ? { suppressModernRequestCancellation: true }
            : {}),
          ...(suppressParamMirroring ? { mirrorToolParamHeaders: false } : {}),
        }
      : undefined;

  const rawProtocolVersionsByServerId = raw.mcpProtocolVersionsByServerId;
  const mcpProtocolVersionsByServerId:
    | Record<string, McpProtocolVersion>
    | undefined =
    rawProtocolVersionsByServerId &&
    typeof rawProtocolVersionsByServerId === "object" &&
    !Array.isArray(rawProtocolVersionsByServerId)
      ? (() => {
          const filtered: Record<string, McpProtocolVersion> = {};
          for (const [serverId, value] of Object.entries(
            rawProtocolVersionsByServerId as Record<string, unknown>
          )) {
            if (
              typeof serverId === "string" &&
              serverId.length > 0 &&
              typeof value === "string" &&
              isKnownProtocolVersion(value)
            ) {
              filtered[serverId] = value;
            }
          }
          return Object.keys(filtered).length > 0 ? filtered : undefined;
        })()
      : undefined;

  return {
    ...(initializePins ? { initializePins } : {}),
    ...(mcpProtocolVersionsByServerId ? { mcpProtocolVersionsByServerId } : {}),
  };
}

/**
 * Stateless per-request lifecycle: authorize → connect → execute → disconnect.
 *
 * Creates an ephemeral MCPClientManager scoped to a single request. Connections
 * are always torn down in `finally`, even on error. This is the hosted-mode
 * counterpart to the persistent singleton manager used by local /api/mcp routes.
 *
 * Handles the full request pipeline:
 *   1. Extract bearer token from Authorization header
 *   2. Parse + validate request body against the given Zod schema
 *   3. Resolve server IDs and OAuth tokens from the parsed body
 *   4. Authorize each server via Convex and create ephemeral MCP connections
 *   5. Execute `fn` with the live manager and parsed body
 *   6. Disconnect all servers (finally)
 *   7. Return JSON response (or structured error)
 *
 * Guest users and signed-in users both flow through Convex authorization. The
 * bearer token determines which backend actor owns the requested project.
 *
 * Not suitable for streaming routes (chat-v2) — those need manual lifecycle
 * management via `onStreamComplete` because the Response is returned before
 * the stream finishes.
 */
/**
 * Connection-layer core, extracted from `withEphemeralConnection` so the
 * public `/v1/*` adapters can reuse the exact same authorize -> connect -> run
 * pipeline against a body they synthesize from path params, then format the
 * result/error into the public envelope themselves. Takes an already-read
 * `rawBody`, runs `fn` against the live manager, and returns the raw result (or
 * throws a `WebRouteError`). It does NOT touch the HTTP response — callers own
 * success/error formatting (internal `webError` vs the v1 envelope).
 */
export async function runEphemeralConnection<S extends z.ZodTypeAny, T>(
  c: any,
  rawBody: Record<string, unknown>,
  schema: S,
  fn: (
    manager: InstanceType<typeof MCPClientManager>,
    body: z.infer<S>
  ) => Promise<T>,
  options?: {
    timeoutMs?: number;
    guestUnsupportedMessage?: string;
    rpcLogger?: ReturnType<typeof createHostedRpcLogCollector>["rpcLogger"];
    httpLogger?: ReturnType<typeof createHostedRpcLogCollector>["httpLogger"];
  }
): Promise<T> {
  const { manager, body } = await createManualHostedConnection(
    c,
    rawBody,
    schema,
    options
  );

  try {
    return await fn(manager, body);
  } finally {
    await manager.disconnectAllServers();
  }
}

/**
 * Authorize and create a hosted ephemeral MCP manager without binding it to the
 * HTTP response lifecycle. Use only when the caller will keep the manager alive
 * after returning a Response, and will explicitly disconnect it when background
 * work settles.
 */
export async function createManualHostedConnection<S extends z.ZodTypeAny>(
  c: any,
  rawBody: Record<string, unknown>,
  schema: S,
  options?: {
    timeoutMs?: number;
    guestUnsupportedMessage?: string;
    rpcLogger?: ReturnType<typeof createHostedRpcLogCollector>["rpcLogger"];
    httpLogger?: ReturnType<typeof createHostedRpcLogCollector>["httpLogger"];
    /**
     * Per-server MRTR (`input_required`) collector factory (MCP 2026-07-28
     * §12.5). Threaded to `createAuthorizedManager` so a hosted DIRECT op
     * (tools/execute, prompts/get, resources/read) can suspend a modern
     * `input_required` round to the durable continuation store instead of
     * blocking the worker. Registered SYNCHRONOUSLY at construction (same
     * microtask discipline as `elicitationCallback`) so `buildCapabilities`
     * advertises `elicitation` on the initialize wire. Omit to leave the
     * connection on today's non-MRTR path.
     */
    mrtrInputCollectorForServer?: (
      serverId: string
    ) => MrtrInputCollector | undefined;
    /** See `createAuthorizedManager`'s option of the same name. */
    advertiseSkillsExtension?: boolean;
  }
): Promise<{
  manager: InstanceType<typeof MCPClientManager>;
  body: z.infer<S>;
  convexAuthToken: string;
}> {
  // Both guest and signed-in actors flow through the same Convex
  // authorization path: the bearer token (guest JWT or WorkOS bearer) is
  // forwarded to /web/authorize-batch, which dispatches to the right
  // authorize* query based on the JWT issuer. Routes that legitimately
  // gate guests out (e.g. evals) opt in via `guestUnsupportedMessage`.
  if (options?.guestUnsupportedMessage && c.get("guestId")) {
    throw new WebRouteError(
      403,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      options.guestUnsupportedMessage
    );
  }

  // Under WorkOS API-key auth the raw `sk_` bearer is useless against
  // Convex's JWT-only surfaces (`/web/oauth/force-refresh` inside the
  // 401-refresh closure, reveal-secrets fallback). Swap in the short-lived
  // delegated JWT so every bearer-forwarding path downstream of
  // `createAuthorizedManager` works for API-key callers. JWT callers get
  // their original bearer back unchanged. `authorizeBatch` is unaffected
  // either way — `buildConvexAuthHeaders` branches on `authMethod`, not on
  // this value.
  const bearerToken = await getConvexBearerForRequest(c);
  const body = parseWithSchema(schema, rawBody);
  // Cast for internal plumbing — all web schemas include projectId + serverId(s).
  // The strongly-typed `body` is passed through to `fn` unchanged.
  const raw = body as Record<string, unknown>;
  const { serverIds, oauthTokens, serverNames } = resolveConnectionParams(raw);
  const timeoutMs = options?.timeoutMs ?? WEB_CALL_TIMEOUT_MS;
  const accessScope =
    raw.accessScope === "project_member" || raw.accessScope === "chat_v2"
      ? raw.accessScope
      : undefined;
  const scenarioId =
    typeof raw.scenarioId === "string" && raw.scenarioId.trim()
      ? raw.scenarioId
      : undefined;
  const accessVersion =
    typeof raw.accessVersion === "number" && Number.isFinite(raw.accessVersion)
      ? raw.accessVersion
      : undefined;
  const { initializePins, mcpProtocolVersionsByServerId } =
    extractMcpInitializeOptions(raw);

  // Enterprise-managed authorization policy. Scenario-scoped connections are
  // share-token-reachable, so the policy is read from the SERVER-side
  // scenario host config (fail closed on fetch failure — connecting with an
  // unknown policy could downgrade an unconfigured auto server onto the
  // discover/OAuth ladder). All other manual connections are the caller's
  // own session; the strictly-validated body value is self-tampering only.
  let xaaPolicy: XaaEnterprisePolicy | undefined;
  if (scenarioId) {
    const runtime = await fetchScenarioRuntimeConfig({
      scenarioId,
      bearer: bearerToken,
    });
    if (!runtime.ok) {
      throw new WebRouteError(
        runtime.status >= 500 ? 502 : runtime.status,
        ErrorCode.INTERNAL_ERROR,
        `Couldn't load this scenario's settings, so the connection was stopped to avoid running with the wrong authorization policy. ${runtime.error}`
      );
    }
    xaaPolicy = xaaPolicyFromMcpProfile(runtime.config.mcpProfile);
  } else {
    // Read from the PRE-PARSE raw body, not the schema-parsed `raw`: most
    // route schemas are stripping z.objects, and a schema that forgot to
    // declare xaaPolicy would silently drop enforcement (fail-open). The
    // strict gate below still 409s on anything malformed.
    xaaPolicy = parseXaaPolicyValue(rawBody.xaaPolicy);
  }

  const { manager } = await createAuthorizedManager(
    callerContextFromHono(c),
    bearerToken,
    raw.projectId as string,
    serverIds,
    timeoutMs,
    oauthTokens,
    (raw.clientCapabilities as Record<string, unknown> | undefined) ??
      undefined,
    {
      accessScope,
      scenarioId,
      accessVersion,
      ...(options?.advertiseSkillsExtension
        ? { advertiseSkillsExtension: true }
        : {}),
      rpcLogger: options?.rpcLogger,
      httpLogger: options?.httpLogger,
      serverNames,
      initializePins,
      mcpProtocolVersionsByServerId,
      xaaPolicy,
      // Resolve the XAA issuer here (we hold the request `Context`) so the
      // manager builder can mint Cross-App Access tokens for `useXaa` servers.
      xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
      // MRTR direct-op suspend collector (PR4). Registered synchronously with
      // the same microtask discipline as `elicitationCallback` so `elicitation`
      // is advertised before the constructor's connects run.
      ...(options?.mrtrInputCollectorForServer
        ? { mrtrInputCollectorForServer: options.mrtrInputCollectorForServer }
        : {}),
    }
  );

  return { manager, body: body as z.infer<S>, convexAuthToken: bearerToken };
}

/**
 * Opts a single server into per-request `"debug"` logging for the duration of
 * one ephemeral operation, so its `notifications/message` records land in the
 * hosted RPC log collector.
 *
 * Direct hosted ops (tools/execute, prompts/get, resources/read, ...) are a
 * single request/response — there is no persistent session for a human to
 * flip a log level on later, so per §11.3 "surfacing" this opts the server
 * into the SAME default the legacy auto-`debug` connect gate already applies
 * (`MCPClientManager.connectToServer`): request `"debug"` for this op only
 * (torn down with the ephemeral connection in the route's `finally`, so it
 * never persists).
 *
 * `setPerRequestLogLevel` is called UNCONDITIONALLY — no `getLoggingMechanism`
 * guard — because that guard races the connect lifecycle: the manager
 * constructor kicks off connects in a microtask, so `getLoggingMechanism`
 * evaluated here (before the first manager op) can observe an unpopulated
 * `liveClientStates` and return `"none"`, silently skipping the opt-in for a
 * modern server. Calling unconditionally is safe: `setPerRequestLogLevel` only
 * stores the level (read live once the client exists), so it works before
 * connect, and it is inert on the legacy era — the `LogLevelMetaClient`
 * decorator injects the `_meta` level only when `getProtocolEra() === "modern"`
 * (legacy servers stream via the connect-time gate instead).
 *
 * We do NOT tee `onLogMessage` into the collector: the manager's configured
 * `rpcLogger` (the logging transport wrapper) already records every received
 * `notifications/message` as `{ serverId, direction: "receive", message }`
 * into this same collector, so a tee here would double every log record in
 * `_rpcLogs`. For the modern era those records are delivered inline within the
 * originating request's response, so by the time the route's manager call
 * resolves they have already reached the collector — BEFORE
 * `runEphemeralConnection`'s `finally` disconnects the server.
 */
function forwardLogMessagesInto(
  manager: InstanceType<typeof MCPClientManager>,
  rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined
) {
  return (serverId: string) => {
    if (!rpcCollector) return;
    manager.setPerRequestLogLevel(serverId, "debug");
  };
}

export async function withEphemeralConnection<S extends z.ZodTypeAny, T>(
  c: any,
  schema: S,
  fn: (
    manager: InstanceType<typeof MCPClientManager>,
    body: z.infer<S>,
    /**
     * Registers log-notification forwarding for one server into this
     * request's hosted RPC log collector. Call before the manager op that
     * may trigger server-side logging (tool execute, resource read, prompt
     * get, ...). No-op when RPC log collection is disabled for this route.
     */
    forwardLogMessages: (serverId: string) => void
  ) => Promise<T>,
  options?: {
    timeoutMs?: number;
    rpcLogs?: boolean;
    guestUnsupportedMessage?: string;
  }
) {
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;

  try {
    // Read body once — Hono streams can only be consumed once
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    if (options?.rpcLogs !== false) {
      rpcCollector = createHostedRpcLogCollector(rawBody);
    }

    const result = await runEphemeralConnection(
      c,
      rawBody,
      schema,
      (manager, body) =>
        fn(manager, body, forwardLogMessagesInto(manager, rpcCollector)),
      {
        timeoutMs: options?.timeoutMs,
        guestUnsupportedMessage: options?.guestUnsupportedMessage,
        rpcLogger: rpcCollector?.rpcLogger,
        httpLogger: rpcCollector?.httpLogger,
      }
    );

    return c.json(attachHostedRpcLogs(result, rpcCollector), 200);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webErrorFromRoute(
      c,
      routeError,
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined
    );
  }
}

// Re-export commonly used error utilities for convenience
export {
  ErrorCode,
  WebRouteError,
  webError,
  parseErrorMessage,
  mapRuntimeError,
  mapTargetServerError,
  webErrorFromRoute,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
};
