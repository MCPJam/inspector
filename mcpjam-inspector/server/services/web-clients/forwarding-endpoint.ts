/**
 * The forwarding endpoint for Claude web and ChatGPT web, at
 * `/mcp/<connectorId>`. The vendor's own MCP client connects here, and every
 * request goes to the project's server with its body unchanged and the
 * project's credential in place of the vendor's, so the server sees the
 * vendor's client as it is. Every answer, JSON or SSE, comes back unchanged.
 *
 * On the way through:
 *  - the turn gate: a `tools/call` reaches the server only while an MCPJam
 *    turn is running on the connector and its approval hook allows the call.
 *    Everything else (initialize, server/discover, lists, reads, prompts,
 *    notifications, ping) passes at any time;
 *  - the ledger: every forwarded call is written down before it is sent and
 *    settled from the server's answer, so recovery never runs a tool twice;
 *  - the record: every frame under its turn, and the client's identity.
 *
 * It answers before the Inspector's global middleware (see
 * `mountWebConnectorEndpoint`): claude.ai stopped after `initialize` when the
 * app's security, CORS and indexing headers rode along on the answers.
 */
import { Hono, type Context } from "hono";
import {
  WEB_CONNECTOR_PATH_PREFIX,
  webConnectorPath,
} from "../../../shared/web-clients.js";
import {
  NativeWireError,
  nativeRequestHeaders,
  nativeResponseHeaders,
} from "../../utils/harness/forwarding/native-wire.js";
import { configuredInspectorPublicUrl } from "../../utils/inspector-public-url.js";
import { logger } from "../../utils/logger.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import type {
  UpstreamTarget,
  WebConnector,
  WebConnectorResolver,
} from "./connectors.js";
import {
  authkitAuthorizationServers,
  connectorOriginAllowed,
  verifyAuthKitBearer,
  webClientsEnabledFor,
} from "./endpoint-auth.js";
import {
  connectorTag,
  webClientRecorder,
  webClientScope,
  type WebClientRecorder,
} from "./forwarding-recorder.js";
import {
  answerId,
  bodyKind,
  discardBody,
  fetchWhileTurnOpen,
  followedRedirect,
  isRecord,
  isRequest,
  observeBody,
  parseRpcBody,
  readBodyBytes,
  TurnClosedError,
  type RpcBody,
  type RpcId,
  type RpcMessage,
  type RpcRequest,
} from "./forwarding-wire.js";
import {
  hashPayload,
  webClientToolCallLedger,
  type DurableToolCallLedger,
  type LedgerState,
  type ToolCallLedger,
} from "./tool-call-ledger.js";
import {
  webClientTurnWindows,
  type TurnWindow,
  type TurnWindowStore,
} from "./turn-windows.js";

export type WebConnectorEndpointDeps = {
  resolver: WebConnectorResolver;
  turns?: TurnWindowStore;
  ledger?: ToolCallLedger;
  /**
   * The backend's ledger. When set, a call goes upstream only after it is
   * recorded there, and is settled there too.
   */
  durableLedger?: DurableToolCallLedger;
  /**
   * The MCPJam user an OAuth bearer names, when it was issued for one of
   * `audiences`: the connector's URL, or the `/mcp` family the root metadata
   * names. Defaults to AuthKit.
   */
  verifyBearer?: (
    token: string,
    context: { audiences: string[] },
  ) => Promise<{ userId: string } | undefined>;
  authorizationServers?: () => Promise<string[]> | string[];
  /** Defaults to `web-clients-enabled` for the token's user. */
  isEnabled?: (
    connector: WebConnector,
    context: { userId?: string },
  ) => Promise<boolean>;
  /** Used when the upstream target brings no fetch of its own. */
  fetchUpstream?: typeof fetch;
  recorder?: WebClientRecorder;
};

/** Implementation-defined JSON-RPC server error; the vendor shows its message on the failed call. */
const REFUSED = -32000;
const SOURCE = "web-clients.forwarding";

const COPY = {
  noTurn:
    "No MCPJam run is using this connector, so the tool call was not sent. Start a run in MCPJam, then send the prompt again.",
  denied:
    "MCPJam's tool approval did not allow this call, so it was not sent. Change the approval in MCPJam, then send the prompt again.",
  approvalFailed:
    "MCPJam could not check this tool call, so it was not sent. Send the prompt again.",
  notRecorded:
    "MCPJam could not record this tool call, so it was not sent. Send the prompt again.",
  unknownOutcome:
    "MCPJam could not tell whether this project's MCP server ran this tool call. Check what the tool did before you send the prompt again.",
  roundedNumber:
    "This tool call has a number MCPJam can't check exactly, so it was not sent. Send the number as a string instead.",
  noToolName:
    "This tool call names no tool, so it was not sent. Send it again with a tool name.",
  batchHeld:
    "This request was not sent because a tool call in the same batch was refused. Send it again on its own.",
  invalid:
    "MCPJam could not read this MCP request, so it was not sent. Send one valid JSON-RPC message.",
  headerMismatch:
    "The Mcp-Method or Mcp-Name header does not match the request body, so the request was not sent. Send it again with matching headers.",
  tooLarge:
    "This MCP request is larger than MCPJam forwards, so it was not sent. Send a smaller request.",
  unreachable:
    "MCPJam could not reach this project's MCP server. Check that the server is running, then send the prompt again.",
  noUpstream:
    "MCPJam could not connect to this project's MCP server. Reconnect the server in MCPJam, then send the prompt again.",
  upstreamRefused:
    "This project's MCP server refused MCPJam's saved credential. Reconnect the server in MCPJam, then send the prompt again.",
  unavailable: "MCPJam could not check this connector. Try again in a moment.",
  signIn: "Sign in to MCPJam to use this connector.",
  forbidden:
    "Your MCPJam account can't use this connector's project. Ask a project admin to add you, then connect again.",
  notFound:
    "No MCPJam connector has this URL. Copy the connector URL from MCPJam again.",
  origin:
    "This connector does not accept requests from this web page. Connect to it from Claude or ChatGPT instead.",
  method: "This endpoint answers GET, POST and DELETE.",
} as const;

type Frame = (direction: "send" | "receive", message: unknown) => void;

/** Recording is observation only: the forwarded request never fails on it. */
function observe(action: () => void): void {
  try {
    action();
  } catch (error) {
    logger.warn("[web-clients] a frame could not be recorded", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Connector URLs' origin as configured, never the Host header: the caller picks that. */
function publicOrigin(): string | undefined {
  const configured = configuredInspectorPublicUrl();
  if (!configured || !URL.canParse(configured)) return undefined;
  const url = new URL(configured);
  return /^https?:$/.test(url.protocol) ? url.origin : undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
}

function isToolCall(message: RpcMessage): message is RpcRequest {
  return isRequest(message) && message.method === "tools/call";
}

function paramsOf(message: RpcMessage): Record<string, unknown> {
  return isRecord(message.params) ? message.params : {};
}

/** claude.ai's id for the model's tool use, on every call it makes. */
function toolUseIdOf(params: Record<string, unknown>): string | undefined {
  const value = isRecord(params._meta)
    ? params._meta["claudecode/toolUseId"]
    : undefined;
  return typeof value === "string" && value ? value : undefined;
}

const META = "io.modelcontextprotocol/";

/** Who the client says it is: `initialize`, or each request's `_meta` from 2026-07-28 on. */
function recordClient(
  recorder: WebClientRecorder,
  connectorId: string,
  scopeId: string,
  request: Request,
  messages: RpcMessage[],
): void {
  const userAgent = request.headers.get("user-agent") ?? undefined;
  const base = { connectorId, scopeId, ...(userAgent ? { userAgent } : {}) };
  for (const message of messages.filter(isRequest)) {
    const params = paramsOf(message);
    const meta = isRecord(params._meta) ? params._meta : {};
    if (message.method === "initialize") {
      recorder.client({
        ...base,
        source: "initialize",
        protocolVersion: params.protocolVersion,
        clientInfo: params.clientInfo,
        clientCapabilities: params.capabilities,
      });
    } else if (`${META}protocolVersion` in meta || `${META}clientInfo` in meta) {
      recorder.client({
        ...base,
        source: "request_meta",
        protocolVersion: meta[`${META}protocolVersion`],
        clientInfo: meta[`${META}clientInfo`],
        clientCapabilities: meta[`${META}clientCapabilities`],
      });
    }
  }
}

/** One JSON-RPC error per request in the body, in its shape (single or batch). */
function answerAll(
  body: RpcBody,
  message: (id: RpcId) => string,
  code: number,
  status: number,
  frame: Frame,
): Response {
  const answers = body.messages.filter(isRequest).map((request) => ({
    jsonrpc: "2.0" as const,
    id: request.id,
    error: { code, message: message(request.id) },
  }));
  for (const answer of answers) frame("receive", answer);
  const payload = body.batch
    ? answers
    : (answers[0] ?? {
        jsonrpc: "2.0",
        id: null,
        error: { code, message: message("") },
      });
  return Response.json(payload, { status });
}

function refuseUnread(error: NativeWireError): Response {
  const [status, code, message] =
    error.code === "request_too_large"
      ? [413, -32600, COPY.tooLarge]
      : error.code === "header_mismatch"
        ? [400, -32020, COPY.headerMismatch]
        : error.code === "rounded_number"
          ? [400, -32602, COPY.roundedNumber]
          : error.code === "invalid_json"
            ? [400, -32700, COPY.invalid]
            : [400, -32600, COPY.invalid];
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status },
  );
}

const ENDPOINT_PATHS = new RegExp(
  `^(?:${WEB_CONNECTOR_PATH_PREFIX}/[^/]+|/\\.well-known/oauth-protected-resource(?:${WEB_CONNECTOR_PATH_PREFIX}/[^/]+)?)$`,
);

/**
 * Registers the endpoint on `app` ahead of everything registered after it,
 * the global security, CORS and logging middleware included, so its answers
 * carry only the upstream server's MCP headers. Call it first.
 */
export function mountWebConnectorEndpoint(app: Hono, endpoint: Hono): void {
  app.use("*", async (c, next) => {
    if (!ENDPOINT_PATHS.test(c.req.path)) return next();
    return endpoint.fetch(c.req.raw);
  });
}

export function createWebConnectorEndpoint(deps: WebConnectorEndpointDeps): Hono {
  const turns = deps.turns ?? webClientTurnWindows;
  const ledger = deps.ledger ?? webClientToolCallLedger;
  const recorder = deps.recorder ?? webClientRecorder;
  const verifyBearer = deps.verifyBearer ?? verifyAuthKitBearer;
  const authorizationServers =
    deps.authorizationServers ?? authkitAuthorizationServers;
  const isEnabled =
    deps.isEnabled ??
    ((_connector: WebConnector, context: { userId?: string }) =>
      webClientsEnabledFor(context.userId));
  const app = new Hono();
  const notFound = (c: Context) => c.json({ error: COPY.notFound }, 404);

  /** RFC 9728 protected-resource metadata, with MCPJam's AuthKit as the authorization server. */
  const metadata = async (c: Context, path: string) => {
    const origin = publicOrigin();
    const servers = await authorizationServers();
    if (!origin || servers.length === 0) return notFound(c);
    return c.json({
      resource: `${origin}${path}`,
      authorization_servers: servers,
      bearer_methods_supported: ["header"],
    });
  };

  /** Who is calling and whether they may: a connector, its user, or the refusal to send. */
  const admit = async (
    c: Context,
    connectorId: string,
  ): Promise<Response | { connector: WebConnector; userId?: string }> => {
    const connector = await deps.resolver.resolve(connectorId);
    if (!connector) return notFound(c);
    if (connector.auth !== "oauth")
      return (await isEnabled(connector, {})) ? { connector } : notFound(c);
    const origin = publicOrigin();
    // No token's audience can be checked without it, so no OAuth connector is served.
    if (!origin) return notFound(c);
    const token = bearerToken(c.req.header("authorization"));
    const resource = `${origin}${webConnectorPath(connectorId)}`;
    const verified = token
      ? await verifyBearer(token, {
          audiences: [resource, `${origin}${WEB_CONNECTOR_PATH_PREFIX}`],
        })
      : undefined;
    if (!verified) {
      // A bare 401 with this header is what starts the vendor's OAuth discovery.
      const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${webConnectorPath(connectorId)}"${token ? ', error="invalid_token"' : ""}`;
      return c.json({ error: COPY.signIn }, 401, {
        "www-authenticate": challenge,
      });
    }
    if (!(await isEnabled(connector, { userId: verified.userId })))
      return notFound(c);
    if (!(await deps.resolver.mayUse?.(connector, verified.userId)))
      return c.json({ error: COPY.forbidden }, 403);
    return { connector, userId: verified.userId };
  };

  /** Undefined when the call may go; otherwise the reason it may not. */
  const decide = async (
    connectorId: string,
    window: TurnWindow | undefined,
    call: RpcRequest,
    userId: string | undefined,
  ): Promise<string | undefined> => {
    if (!window) return COPY.noTurn;
    const params = paramsOf(call);
    if (typeof params.name !== "string" || !params.name) return COPY.noToolName;
    const toolUseId = toolUseIdOf(params);
    let decision;
    try {
      decision = await window.approve({
        connectorId,
        turnId: window.turnId,
        jsonrpcId: call.id,
        toolName: params.name,
        arguments: params.arguments,
        ...(toolUseId ? { toolUseId } : {}),
        ...(userId ? { userId } : {}),
      });
    } catch (error) {
      reportRouteFailure("Web connector tool approval failed", error, {
        source: SOURCE,
        hop: "mcpjam_internal",
      });
      return COPY.approvalFailed;
    }
    if (!decision.allow) return decision.reason.trim() || COPY.denied;
    // The turn may have ended while the approval was pending.
    return turns.active(connectorId)?.turnId === window.turnId
      ? undefined
      : COPY.noTurn;
  };

  /** `turnOpen` is set when the request carries tool calls, which go only under their turn. */
  const send = async (
    target: UpstreamTarget,
    request: Request,
    bytes: Uint8Array<ArrayBuffer> | undefined,
    turnOpen: (() => boolean) | undefined,
  ): Promise<Response> => {
    const fetchUpstream = target.fetch ?? deps.fetchUpstream ?? fetch;
    // The vendor's `authorization` is never among the headers passed on.
    const headers = nativeRequestHeaders(request.headers, target.headers);
    const init: RequestInit = {
      method: request.method,
      headers,
      body: bytes,
      signal: request.signal,
    };
    // Redirects are followed hop by hop: a tool call goes on only while its
    // turn is open, and the server's own headers stay with its origin.
    const own = Object.keys(target.headers);
    const sendOnce = () =>
      fetchWhileTurnOpen(fetchUpstream, target.url, init, turnOpen, own);
    const response = await sendOnce();
    // Only a 401 to the request itself says it never ran. Behind a redirect
    // the server took it first, so sending it again could run a tool twice.
    if (
      response.status !== 401 ||
      !target.onUnauthorized ||
      followedRedirect(response, target.url)
    )
      return response;
    await discardBody(response);
    // A failed refresh leaves the call unsent, as a missing token does.
    const token = await target.onUnauthorized().catch((error: unknown) => {
      reportRouteFailure("Web connector token refresh failed", error, {
        source: SOURCE,
        hop: "mcpjam_internal",
      });
      return undefined;
    });
    if (!token) return new Response(null, { status: 401 });
    // The refresh can outlast the turn that approved the call.
    if (turnOpen && !turnOpen()) throw new TurnClosedError(401, false);
    headers.set("authorization", `Bearer ${token}`);
    return sendOnce();
  };

  const forward = async (args: {
    request: Request;
    connector: WebConnector;
    userId?: string;
    body: RpcBody;
    bytes?: Uint8Array<ArrayBuffer>;
  }): Promise<Response> => {
    const { request, connector, body } = args;
    const connectorId = connector.connectorId;
    const window = turns.active(connectorId);
    const requestScope = webClientScope(connectorId, window?.turnId);
    // A GET stream or a 2026-07-28 subscription outlives the turn it opened
    // in, so each of its frames goes under the turn running when it arrives.
    const longLived =
      request.method === "GET" ||
      body.messages.some((message) => message.method === "subscriptions/listen");
    const frame: Frame = (direction, message) =>
      observe(() =>
        recorder.frame({
          connector,
          scopeId: longLived
            ? webClientScope(connectorId, turns.active(connectorId)?.turnId)
            : requestScope,
          direction,
          message,
        }),
      );
    observe(() =>
      recordClient(recorder, connectorId, requestScope, request, body.messages),
    );
    for (const message of body.messages) frame("send", message);

    const refusals = new Map<RpcId, string>();
    for (const call of body.messages.filter(isToolCall)) {
      const reason = await decide(connectorId, window, call, args.userId);
      if (reason) refusals.set(call.id, reason);
    }
    if (refusals.size > 0)
      return answerAll(
        body,
        (id) => refusals.get(id) ?? COPY.batchHeld,
        REFUSED,
        200,
        frame,
      );

    let target: UpstreamTarget;
    try {
      target = await deps.resolver.upstream(connector, { userId: args.userId });
    } catch (error) {
      reportRouteFailure("Web connector upstream could not be resolved", error, {
        source: SOURCE,
        hop: "mcpjam_internal",
      });
      return answerAll(body, () => COPY.noUpstream, REFUSED, 502, frame);
    }

    type Outcome = Parameters<ToolCallLedger["settle"]>[1];
    const outcomeOf = (
      state: Exclude<LedgerState, "forwarded">,
      upstreamStatus?: number,
      resultHash?: string,
    ): Outcome => ({
      state,
      ...(upstreamStatus ? { upstreamStatus } : {}),
      ...(resultHash ? { resultHash } : {}),
    });
    /** A call sent on and not settled yet, with the answer seen for it if the ledger refused that. */
    type Pending = { entryId: string; durableId?: string; seen?: Outcome };
    const warn = (what: string, error: unknown) =>
      logger.warn(`[web-clients] ${what}`, {
        connector: connectorTag(connectorId),
        message: error instanceof Error ? error.message : String(error),
      });
    const release = () =>
      target
        .release?.()
        .catch((error: unknown) =>
          warn("the upstream connection was not released", error),
        );
    const settleDurable = (durableId: string | undefined, outcome: Outcome) => {
      // An unsettled record reads as ambiguous: the safe direction for recovery.
      if (durableId)
        deps.durableLedger
          ?.settle(durableId, outcome)
          .catch((error: unknown) => warn("a call was not settled durably", error));
    };
    const pending = new Map<RpcId, Pending>();
    /** Whether the ledger here took the outcome. */
    const settle = (call: Pending, outcome: Outcome): boolean => {
      let recorded = true;
      try {
        ledger.settle(call.entryId, outcome);
      } catch (error) {
        recorded = false;
        warn("a forwarded call could not be settled", error);
      }
      // The durable copy keeps its first outcome, so it is sent only that one.
      settleDurable(call.durableId, outcome);
      call.durableId = undefined;
      return recorded;
    };
    let finished = false;
    const finish = (state: "lost" | "error", upstreamStatus?: number) => {
      if (finished) return;
      finished = true;
      // An answer the ledger refused earlier is offered again before "lost".
      for (const call of pending.values())
        settle(call, call.seen ?? outcomeOf(state, upstreamStatus));
      pending.clear();
      void release();
    };

    // Recorded before anything is sent, so a call lost mid-flight stays on
    // record as uncertain, and recovery after a restart reads the durable copy.
    const calls = body.messages.filter(isToolCall).map((call) => {
      const params = paramsOf(call);
      const toolUseId = toolUseIdOf(params);
      return {
        connectorId,
        turnId: window?.turnId,
        runId: window?.runId,
        jsonrpcId: call.id,
        toolName: String(params.name),
        ...(toolUseId ? { toolUseId } : {}),
        ...(args.userId ? { userId: args.userId } : {}),
        argsHash: hashPayload(params.arguments ?? {}),
      };
    });
    const callIds = new Set(calls.map((call) => call.jsonrpcId));
    const durableIds: Array<string | undefined> = [];
    // Recorded but never sent: each record gets the error the vendor gets.
    const refuseCalls = (reason: string) => {
      const settling = new Set(
        Array.from(pending.values(), (call) => call.durableId),
      );
      finish("error");
      for (const durableId of durableIds)
        if (!settling.has(durableId))
          settleDurable(durableId, { state: "error" });
      return answerAll(
        body,
        (id) => (callIds.has(id) ? reason : COPY.batchHeld),
        REFUSED,
        200,
        frame,
      );
    };
    try {
      for (const call of calls)
        durableIds.push(await deps.durableLedger?.record(call));
    } catch (error) {
      reportRouteFailure("Web connector call could not be recorded", error, {
        source: SOURCE,
        hop: "mcpjam_internal",
      });
      return refuseCalls(COPY.notRecorded);
    }
    // A call goes only under the turn that approved it, which can end while
    // the server is resolved, the calls are recorded or a credential is
    // refreshed. A recovery that read the ledger after the close may not
    // have seen these calls and may send its own, so these are not sent.
    const approvedTurnOpen = () =>
      calls.length === 0 ||
      turns.active(connectorId)?.turnId === window?.turnId;
    if (!approvedTurnOpen()) return refuseCalls(COPY.noTurn);
    try {
      calls.forEach((call, index) => {
        const durableId = durableIds[index];
        const entry = ledger.forwarded({
          ...call,
          ...(durableId ? { durableId } : {}),
        });
        pending.set(call.jsonrpcId, { entryId: entry.id, durableId });
      });
    } catch (error) {
      reportRouteFailure("Web connector call could not be recorded", error, {
        source: SOURCE,
        hop: "mcpjam_internal",
      });
      return refuseCalls(COPY.notRecorded);
    }

    let response: Response;
    try {
      response = await send(
        target,
        request,
        args.bytes,
        calls.length > 0 ? approvedTurnOpen : undefined,
      );
    } catch (error) {
      if (error instanceof TurnClosedError) {
        // Behind a redirect the server took the call first, so it may have run.
        const unsure = error.afterRedirect;
        finish(unsure ? "lost" : "error", error.upstreamStatus);
        return answerAll(
          body,
          (id) =>
            !callIds.has(id)
              ? COPY.batchHeld
              : unsure
                ? COPY.unknownOutcome
                : COPY.noTurn,
          REFUSED,
          200,
          frame,
        );
      }
      finish("lost");
      reportRouteFailure("Web connector upstream did not answer", error, {
        source: SOURCE,
        hop: "user_server_hop",
      });
      return answerAll(
        body,
        (id) => (callIds.has(id) ? COPY.unknownOutcome : COPY.unreachable),
        REFUSED,
        502,
        frame,
      );
    }
    if (response.status === 401) {
      // The vendor holds MCPJam's credential, not the server's, so a
      // challenge from the server is not one it could answer; passing it on
      // would send the vendor to re-authorize somewhere else. Behind a
      // redirect the server took the request first, so a call may have run.
      const unsure = followedRedirect(response, target.url);
      await discardBody(response);
      finish(unsure ? "lost" : "error", 401);
      return answerAll(
        body,
        (id) =>
          unsure && callIds.has(id)
            ? COPY.unknownOutcome
            : COPY.upstreamRefused,
        REFUSED,
        502,
        frame,
      );
    }
    const status = response.status;
    const headers = nativeResponseHeaders(response.headers);
    if (!response.body) {
      finish("lost", status);
      return new Response(null, { status, headers });
    }
    const stream = observeBody({
      body: response.body,
      kind: bodyKind(response.headers.get("content-type")),
      onMessage: (message) => {
        frame("receive", message);
        const id = answerId(message);
        const call = id === undefined ? undefined : pending.get(id);
        if (id === undefined || call === undefined || !isRecord(message))
          return;
        const failed = "error" in message;
        call.seen ??= outcomeOf(
          failed ? "error" : "result",
          status,
          hashPayload(failed ? message.error : message.result),
        );
        // Only once the ledger took it: the exchange's end offers it again.
        if (settle(call, call.seen)) pending.delete(id);
      },
      onEnd: () => finish("lost", status),
    });
    return new Response(stream, { status, headers });
  };

  app.onError((error, c) => {
    reportRouteFailure("Web connector request failed", error, {
      source: SOURCE,
      hop: "mcpjam_internal",
    });
    return c.json({ error: COPY.unavailable }, 503);
  });

  app.get(
    `/.well-known/oauth-protected-resource${WEB_CONNECTOR_PATH_PREFIX}/:connectorId`,
    async (c) => {
      const connectorId = c.req.param("connectorId");
      const connector = await deps.resolver.resolve(connectorId);
      if (connector?.auth !== "oauth") return notFound(c);
      return metadata(c, webConnectorPath(connectorId));
    },
  );
  // A client that misses the document above falls back to this one, which
  // can't name one connector: it names the `/mcp` family, and `admit`
  // accepts a token for the family on every connector its user may use.
  app.get("/.well-known/oauth-protected-resource", (c) =>
    metadata(c, WEB_CONNECTOR_PATH_PREFIX),
  );

  app.all(`${WEB_CONNECTOR_PATH_PREFIX}/:connectorId`, async (c) => {
    // The global origin check never sees these requests.
    if (!connectorOriginAllowed(c.req.header("origin")))
      return c.json({ error: COPY.origin }, 403);
    const admitted = await admit(c, c.req.param("connectorId"));
    if (admitted instanceof Response) return admitted;
    const request = c.req.raw;
    if (!["GET", "POST", "DELETE"].includes(request.method))
      return c.json({ error: COPY.method }, 405, {
        allow: "GET, POST, DELETE",
      });
    let body: RpcBody = { batch: false, messages: [] };
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    if (request.method === "POST") {
      try {
        bytes = await readBodyBytes(request);
        body = parseRpcBody(bytes, request.headers);
      } catch (error) {
        if (error instanceof NativeWireError) return refuseUnread(error);
        throw error;
      }
    }
    return forward({ ...admitted, request, body, bytes });
  });

  return app;
}
