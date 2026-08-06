/**
 * HP-44 — a real HTTP MCP resource server + authorization server that records
 * every request it receives as a HAR.
 *
 * This is the harness's capture instrument and its HP-39 bolt-on, in one piece.
 * Two things it gives us that the in-process `fetch` stub cannot:
 *
 *  1. **It captures a REAL host.** Any client that can be pointed at a URL —
 *     Claude Code, the Inspector app in a browser, VS Code, `codex`, `goose` —
 *     does its genuine handshake against this server, and the server records it.
 *     The task calls for "a proxy (HAR or equivalent)"; being the endpoint IS the
 *     equivalent, and it is strictly more faithful than a proxy: there is no TLS
 *     interception, no client trust-store change, and nothing that could alter
 *     the client's behavior in the act of observing it.
 *
 *  2. **It exercises the real network path.** Real header casing, real
 *     `Content-Length`, real form encoding, a real 302 on `/authorize`, real
 *     connection headers. A `fetch` stub silently normalizes all of that, and
 *     several bugs only appear once it does not — the origin-vs-port ordering bug
 *     in `abstractUrl` was found exactly here.
 *
 * The `/authorize` leg auto-approves and 302s straight back to the client's
 * redirect URI. That is deliberate: consent is a human decision that tells us
 * nothing about the client's wire behavior, and requiring a click would make the
 * capture un-runnable in CI. Unlike the emulator path, the `/authorize` request
 * IS intercepted here, so its headers are genuinely observed rather than
 * reconstructed.
 *
 * Nothing here is a credential: the tokens are fixed literals, and the trace
 * pipeline redacts them anyway.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import type { TraceScenario } from "../../src/oauth-golden-trace/index.js";

/** Fixed, obviously-fake credentials. Redacted by the pipeline regardless. */
const ACCESS_TOKEN = "hp44-capture-access-token-not-a-real-credential";
const REFRESH_TOKEN = "hp44-capture-refresh-token-not-a-real-credential";
const AUTHORIZATION_CODE = "hp44-capture-authorization-code-not-a-real-credential";

export type HarNameValue = { name: string; value: string };

export type HarEntry = {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarNameValue[];
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarNameValue[];
    content: { size: number; mimeType: string; text: string };
  };
};

export type CaptureServerOptions = {
  /** Publish an RFC 9728 PRM document. Default true. */
  publishesPrm?: boolean;
  /** Advertise a `registration_endpoint`. Default true. */
  supportsDcr?: boolean;
  /** Advertise `client_id_metadata_document_supported`. Default false. */
  supportsCimd?: boolean;
  /** Protocol version returned from `initialize`. Default `2025-11-25`. */
  serverProtocolVersion?: string;
  /** Fixed port. Default 0 (ephemeral) — pass one for a stable external URL. */
  port?: number;
  /**
   * Interface to bind. Default `127.0.0.1`. Pass `0.0.0.0` to accept connections
   * from outside the machine, which a tunnel needs.
   */
  host?: string;
  /**
   * The base URL this server is reachable at FROM THE CLIENT, when that differs
   * from where it binds — e.g. `https://abc123.ngrok.app` in front of
   * `127.0.0.1:3999`.
   *
   * This is what makes HOSTED clients capturable at all, and it is not a
   * convenience. A local client (Claude Code, VS Code, Codex, Goose, Cline) runs
   * OAuth on the user's machine and can reach `127.0.0.1`. A hosted client
   * (Slack, ChatGPT, Claude.ai web, Mistral, Notion, Perplexity, M365 Copilot)
   * performs the handshake from ITS OWN infrastructure, so `127.0.0.1` resolves to
   * that vendor's server, not ours — the capture would never arrive.
   *
   * Every URL the server ADVERTISES must therefore be the public one: the PRM
   * `resource` and `authorization_servers`, the AS metadata endpoints, and the
   * `resource_metadata` pointer in the 401 challenge. Several clients hard-fail
   * when the PRM `resource` does not equal the URL they were configured with
   * (RFC 9728), so advertising the bind origin would break the flow rather than
   * merely mislabel it.
   */
  publicOrigin?: string;
};

/**
 * Render a bind host as a URL authority component.
 *
 * A wildcard bind address is not a reachable destination, so it is rewritten to
 * the corresponding loopback. An IPv6 literal has to be bracketed: `new URL()`
 * cannot parse `http://::1:3999` at all, and this origin is fed straight back
 * into `new URL(request.url, bindOrigin)` on every inbound request, so an
 * unbracketed value fails the whole capture on the first hit rather than
 * degrading.
 */
function hostForUrl(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "::0") return "[::1]";
  // Already bracketed, or a hostname/IPv4 — neither needs help. Only a bare IPv6
  // literal contains a colon.
  if (host.startsWith("[") || !host.includes(":")) return host;
  return `[${host}]`;
}

export type CaptureServer = {
  /** Base origin, e.g. `http://127.0.0.1:3999`. */
  origin: string;
  /** The MCP endpoint clients should be pointed at. */
  mcpUrl: string;
  /** Scenario block describing exactly what this instance implements. */
  scenario: TraceScenario;
  /** HAR log of everything received so far. */
  har: () => { log: { version: string; creator: { name: string; version: string }; entries: HarEntry[] } };
  /** Number of requests recorded. */
  requestCount: () => number;
  /**
   * Requests served but NOT recorded because the entry cap was reached. Non-zero
   * means the HAR is an incomplete view of what happened and any trace built from
   * it is truncated — the caller must not read it as a complete capture.
   */
  droppedCount: () => number;
  /** Discard recorded traffic without restarting (e.g. between phases). */
  reset: () => void;
  close: () => Promise<void>;
  raw: Server;
};

function headerList(headers: NodeJS.Dict<string | string[]>): HarNameValue[] {
  const out: HarNameValue[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) out.push({ name, value: entry });
    } else {
      out.push({ name, value });
    }
  }
  return out;
}

/**
 * Ceiling on a single recorded request body.
 *
 * Generous next to any real OAuth or MCP payload — a DCR registration is a few
 * hundred bytes — and small enough that a flood cannot exhaust the heap. This is
 * a test instrument, but `--public-origin` puts it behind a tunnel on the open
 * internet, where "test instrument" stops being a containment argument.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Ceiling on recorded HAR entries. A capture is a handful of legs; anything past
 * this is a flood, and dropping the overflow keeps the artifact (and the process)
 * intact. `har()` reports the drop rather than silently returning a short log.
 */
const MAX_HAR_ENTRIES = 2000;

/**
 * Read a request body, truncating past {@link MAX_BODY_BYTES}.
 *
 * Truncation is marked in the returned string so a downstream parse failure is
 * attributable to the cap rather than looking like a malformed client.
 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (size + buffer.length > MAX_BODY_BYTES) {
      chunks.push(buffer.subarray(0, Math.max(0, MAX_BODY_BYTES - size)));
      size = MAX_BODY_BYTES;
      truncated = true;
      break;
    }
    chunks.push(buffer);
    size += buffer.length;
  }
  if (truncated) {
    // Drain the rest so the socket closes cleanly instead of the peer seeing a
    // reset mid-upload, which would look like a server bug in the capture.
    request.resume();
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return truncated ? `${body}\n<<truncated at ${MAX_BODY_BYTES} bytes>>` : body;
}

/**
 * Start the server.
 *
 * Resolves once it is listening, so a caller can hand `mcpUrl` to a real client
 * immediately.
 */
export async function startCaptureServer(
  options: CaptureServerOptions = {},
): Promise<CaptureServer> {
  const publishesPrm = options.publishesPrm ?? true;
  const supportsDcr = options.supportsDcr ?? true;
  const supportsCimd = options.supportsCimd ?? false;
  const serverProtocolVersion = options.serverProtocolVersion ?? "2025-11-25";

  let entries: HarEntry[] = [];
  /** Requests served but NOT recorded because {@link MAX_HAR_ENTRIES} was hit. */
  let dropped = 0;
  /** Where the server actually listens. Used only to parse inbound request URLs. */
  let bindOrigin = "";
  /** What the server ADVERTISES, and what the client sees. See `publicOrigin`. */
  let origin = "";

  const server = createServer((request, response) => {
    // A rejection here must fail ON THE WIRE, not in the process: discarding the
    // promise leaves the client hanging until its own timeout (which reads as a
    // host bug in the capture) and crashes Node under
    // `--unhandled-rejections=throw`. A 500 is recorded nowhere, so the loud log
    // is the only trace of it.
    handle(request, response).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
      }
      response.end(JSON.stringify({ error: "capture_server_error" }));
      console.error("[hp44] capture server handler failed", error);
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const startedAt = Date.now();
    const startedDateTime = new Date(startedAt).toISOString();
    const requestBody = await readBody(request);
    const requestHeaders = headerList(request.headers);
    const url = new URL(request.url ?? "/", bindOrigin || "http://127.0.0.1");
    const path = url.pathname;

    // Node lowercases every `IncomingMessage` header name, so this is the only
    // spelling that can ever be present.
    const authorization = request.headers.authorization;

    // `send` is the single exit point, so every response is recorded exactly
    // once and no branch can return without being captured.
    const send = (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ): void => {
      const resolved = {
        "Content-Type": "application/json",
        ...headers,
      };
      response.writeHead(status, resolved);
      response.end(body);

      // Keep serving after the cap — refusing traffic would change the behavior
      // being observed, which is the one thing this server must not do. Only the
      // recording stops.
      if (entries.length >= MAX_HAR_ENTRIES) {
        dropped += 1;
        return;
      }

      entries.push({
        startedDateTime,
        time: Date.now() - startedAt,
        request: {
          method: request.method ?? "GET",
          // Recorded as the CLIENT addressed it, so the trace and the scenario
          // agree on one origin and `{mcp_server}` substitutes cleanly.
          url: `${origin}${request.url ?? "/"}`,
          httpVersion: `HTTP/${request.httpVersion}`,
          headers: requestHeaders,
          ...(requestBody
            ? {
                postData: {
                  mimeType:
                    (request.headers["content-type"] as string | undefined) ??
                    "application/octet-stream",
                  text: requestBody,
                },
              }
            : {}),
        },
        response: {
          status,
          statusText: "",
          httpVersion: "HTTP/1.1",
          headers: headerList(resolved),
          content: {
            size: Buffer.byteLength(body),
            mimeType: resolved["Content-Type"] ?? "application/json",
            text: body,
          },
        },
      });
    };

    const json = (
      status: number,
      value: unknown,
      headers?: Record<string, string>,
    ): void => send(status, JSON.stringify(value), headers);

    // ── RFC 9728 protected resource metadata ──
    if (publishesPrm && path === "/.well-known/oauth-protected-resource/mcp") {
      json(200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["mcp:read", "mcp:write"],
        bearer_methods_supported: ["header"],
      });
      return;
    }
    // Clients differ on whether they try the path-aware form or the root form
    // first; serving both means the LADDER ORDER is what gets recorded rather
    // than the client being forced down one rung by a 404.
    if (publishesPrm && path === "/.well-known/oauth-protected-resource") {
      json(200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["mcp:read", "mcp:write"],
        bearer_methods_supported: ["header"],
      });
      return;
    }

    // ── RFC 8414 authorization server metadata ──
    if (
      path === "/.well-known/oauth-authorization-server" ||
      path === "/.well-known/oauth-authorization-server/mcp" ||
      path === "/.well-known/openid-configuration"
    ) {
      json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(supportsDcr ? { registration_endpoint: `${origin}/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp:read", "mcp:write"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        ...(supportsCimd ? { client_id_metadata_document_supported: true } : {}),
      });
      return;
    }

    // ── RFC 7591 dynamic client registration ──
    if (path === "/register" && request.method === "POST") {
      let registered: Record<string, unknown> = {};
      try {
        registered = JSON.parse(requestBody) as Record<string, unknown>;
      } catch {
        // Recorded verbatim regardless; a client that posts a non-JSON body is
        // itself the finding.
      }
      json(201, {
        client_id: "hp44-capture-issued-client-id",
        client_id_issued_at: Math.floor(startedAt / 1000),
        // Echo the client's own metadata back, which is what a real AS does and
        // what several clients then validate.
        ...registered,
      });
      return;
    }

    // ── /authorize — auto-approve, 302 back to the client's redirect URI ──
    if (path === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (!redirectUri) {
        json(400, { error: "invalid_request", error_description: "redirect_uri is required" });
        return;
      }
      // A host that sends a relative or otherwise unparseable `redirect_uri` is
      // itself the finding — answer it as an OAuth error so the capture records
      // the rejection, rather than throwing out of the handler.
      let location: URL;
      try {
        location = new URL(redirectUri);
      } catch {
        json(400, {
          error: "invalid_request",
          error_description: "redirect_uri is not an absolute URL",
        });
        return;
      }
      location.searchParams.set("code", AUTHORIZATION_CODE);
      if (state) location.searchParams.set("state", state);
      // RFC 9207: echo the issuer so a 2026-07-28-era client can validate it.
      location.searchParams.set("iss", origin);
      send(302, "", { Location: location.toString(), "Content-Type": "text/plain" });
      return;
    }

    // ── /token ──
    if (path === "/token" && request.method === "POST") {
      const form = new URLSearchParams(requestBody);
      json(200, {
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: REFRESH_TOKEN,
        scope: form.get("scope") ?? "mcp:read mcp:write",
      });
      return;
    }

    // ── MCP endpoint ──
    if (path === "/mcp") {
      if (!authorization) {
        send(401, JSON.stringify({ error: "unauthorized" }), {
          "WWW-Authenticate": publishesPrm
            ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
            : "Bearer",
        });
        return;
      }

      let rpc: { id?: unknown; method?: string } = {};
      try {
        rpc = JSON.parse(requestBody) as { id?: unknown; method?: string };
      } catch {
        // Fall through to a generic OK below.
      }

      if (rpc.method === "initialize") {
        json(
          200,
          {
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: {
              protocolVersion: serverProtocolVersion,
              serverInfo: { name: "hp44-capture-server", version: "1.0.0" },
              capabilities: { tools: {} },
            },
          },
          { "Mcp-Session-Id": "hp44-capture-session" },
        );
        return;
      }
      if (rpc.method === "tools/list") {
        json(200, {
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: { tools: [{ name: "hp44_noop", description: "No-op probe tool", inputSchema: { type: "object" } }] },
        });
        return;
      }
      if (rpc.method === "tools/call") {
        json(200, {
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: { content: [{ type: "text", text: "ok" }] },
        });
        return;
      }
      // Notifications carry no id and expect 202 with no body.
      if (typeof rpc.method === "string" && rpc.id == null) {
        send(202, "", { "Content-Type": "text/plain" });
        return;
      }

      json(200, { jsonrpc: "2.0", id: rpc.id ?? 1, result: {} });
      return;
    }

    json(404, { error: "not_found" });
  }

  // Validated here rather than only in the CLI wrapper, because a bad value does
  // not fail loudly — it silently becomes the origin of every URL this server
  // advertises, so the captured trace records a handshake against a host that
  // does not exist. Non-CLI callers deserve the same guarantee as the script.
  if (options.publicOrigin !== undefined) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(options.publicOrigin);
    } catch {
      parsed = undefined;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new Error(
        `startCaptureServer: publicOrigin must be an absolute http(s) URL, got \`${options.publicOrigin}\``,
      );
    }
  }

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    // `listen` reports a bind failure by EMITTING `error`, not by calling back, so
    // awaiting only the success callback leaves this promise pending forever on an
    // occupied port — the caller hangs instead of failing.
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  bindOrigin = `http://${hostForUrl(host)}:${address.port}`;
  // Advertise the public origin when one is supplied (a tunnel in front of us);
  // otherwise the bind origin IS the public origin.
  origin = (options.publicOrigin ?? bindOrigin).replace(/\/$/, "");

  const scenario: TraceScenario = {
    // The advertised protocol version is part of the scenario IDENTITY, not just
    // its capabilities: two captures that differ only in the version the server
    // announced are different experiments, and the pin-vs-negotiate projection
    // needs to tell them apart. With a shared id they compared as "the same
    // scenario" and the contrast arm rejected a valid experiment.
    scenarioId: `http-capture-dcr-authcode${publishesPrm ? "-prm" : "-noprm"}-mcp${serverProtocolVersion}`,
    description:
      "Real HTTP MCP resource server + authorization server, recording its own traffic as a HAR. 401 challenge → RFC 9728 PRM → RFC 8414 AS metadata → RFC 7591 DCR → authorization code + PKCE → token → MCP initialize.",
    mcpServerUrl: `${origin}/mcp`,
    authorizationServerUrl: origin,
    capabilities: {
      publishesPrm,
      ...(publishesPrm ? { prmResource: `${origin}/mcp` } : {}),
      supportsDcr,
      supportsCimd,
      codeChallengeMethods: ["S256"],
      serverProtocolVersion,
      asMetadataDocuments: ["/.well-known/oauth-authorization-server"],
      challengesUnauthenticated: true,
    },
  };

  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    scenario,
    har: () => ({
      log: {
        version: "1.2",
        creator: { name: "mcpjam-hp44-capture-server", version: "1" },
        entries: [...entries],
      },
    }),
    requestCount: () => entries.length,
    droppedCount: () => dropped,
    reset: () => {
      entries = [];
      dropped = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    raw: server,
  };
}
