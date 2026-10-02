/**
 * Smoke tests for the lazy-authentication fixture (`lazy-auth-server.ts`).
 *
 * Real sockets and the global `fetch` throughout: these pin the exact bytes
 * each mode answers with, so suites built on the fixture can rely on them.
 */

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import {
  AUTH_REQUIRED_RPC_ERROR_CODE,
  LAZY_AUTH_MODES,
  META_WWW_AUTHENTICATE_KEY,
  PRM_POINTER_PATH,
  PROTECTED_PROMPT_NAME,
  PROTECTED_RESOURCE_URI,
  PUBLIC_RESOURCE_URI,
  hashToken,
  startLazyAuthServer,
  type LazyAuthMode,
  type LazyAuthServer,
  type LazyAuthServerOptions,
} from "./lazy-auth-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const started: LazyAuthServer[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => {});
  }
  await Promise.all(started.splice(0).map((server) => server.close()));
});

async function start(options: LazyAuthServerOptions): Promise<LazyAuthServer> {
  const server = await startLazyAuthServer(options);
  started.push(server);
  return server;
}

interface RpcReply {
  status: number;
  wwwAuthenticate: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

let nextId = 1;

/** One JSON-RPC POST, 2025-era style (no `_meta` envelope). */
async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  token?: string
): Promise<RpcReply> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await response.text();
  return {
    status: response.status,
    wwwAuthenticate: response.headers.get("www-authenticate"),
    body: text ? JSON.parse(text) : undefined,
  };
}

const callTool = (
  server: LazyAuthServer,
  name: string,
  args: Record<string, unknown> = {},
  token?: string
) => rpc(server.url, "tools/call", { name, arguments: args }, token);

const prmUrl = (origin: string) =>
  `${origin}/.well-known/oauth-protected-resource/mcp`;

/** The 401 `WWW-Authenticate` of a tokenless `get_my_orders`, per HTTP mode. */
const HTTP_CHALLENGES: Array<
  [LazyAuthMode, (origin: string) => string | null]
> = [
  [
    "http401",
    (o) =>
      `Bearer error="invalid_token", error_description="Sign in to see your orders", resource_metadata="${prmUrl(o)}", scope="orders:read"`,
  ],
  ["http401-bare", () => "Bearer"],
  ["http401-noheader", () => null],
  ["http401-no-rm", () => `Bearer scope="orders:read"`],
  [
    "prm-pointer-only",
    (o) => `Bearer resource_metadata="${o}${PRM_POINTER_PATH}"`,
  ],
  [
    "http403-noscope",
    (o) =>
      `Bearer error="invalid_token", error_description="Sign in to see your orders", resource_metadata="${prmUrl(o)}", scope="orders:read"`,
  ],
];

const fullMetaChallenge = (o: string) =>
  `Bearer resource_metadata="${prmUrl(o)}", error="insufficient_scope", error_description="You need to login to continue"`;

/** The `_meta["mcp/www_authenticate"]` of a tokenless `get_my_orders`, per meta mode. */
const META_CHALLENGES: Array<[LazyAuthMode, (origin: string) => unknown]> = [
  ["meta", (o) => [fullMetaChallenge(o)]],
  ["meta-string", (o) => fullMetaChallenge(o)],
  ["meta-inherited-default", (o) => [fullMetaChallenge(o)]],
  ["meta-no-default", (o) => [fullMetaChallenge(o)]],
  [
    "meta-no-error-description",
    (o) => [
      `Bearer resource_metadata="${prmUrl(o)}", error="insufficient_scope"`,
    ],
  ],
];

const AUTH_MODES = LAZY_AUTH_MODES.filter((mode) => mode !== "none");

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function postForm(
  url: string,
  form: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const REDIRECT_URI = "http://127.0.0.1:65530/oauth/callback";

/** Discover → register (DCR) → authorize URL, as a client would build it. */
async function prepareAuthorization(
  server: LazyAuthServer,
  extra: Record<string, string | undefined> = {}
) {
  const prm = await (await fetch(server.resourceMetadataUrl)).json();
  const asMetadata = await (
    await fetch(
      `${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`
    )
  ).json();
  const registration = await fetch(asMetadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Smoke Test Client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registration.status).toBe(201);
  const { client_id: clientId } = (await registration.json()) as {
    client_id: string;
  };

  const pkce = pkcePair();
  const authorizeUrl = new URL(asMetadata.authorization_endpoint);
  const params: Record<string, string | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource: prm.resource,
    scope: "orders:read offline_access",
    ...extra,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) authorizeUrl.searchParams.set(key, value);
  }
  return {
    prm,
    asMetadata,
    clientId,
    pkce,
    authorizeUrl: authorizeUrl.toString(),
  };
}

/** A minimal legacy HTTP+SSE client: opens the stream, reads events. */
async function openSse(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queued: Array<{ event: string; data: string }> = [];

  async function nextEvent(): Promise<{ event: string; data: string }> {
    for (;;) {
      const shifted = queued.shift();
      if (shifted) return shifted;
      const boundary = buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        return { event, data: data.join("\n") };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed");
      buffer += decoder.decode(value, { stream: true });
    }
  }

  const endpoint = await nextEvent();
  expect(endpoint.event).toBe("endpoint");
  cleanups.push(async () => controller.abort());
  return {
    messagesUrl: new URL(endpoint.data, url).toString(),
    async nextMessage() {
      const event = await nextEvent();
      expect(event.event).toBe("message");
      return JSON.parse(event.data);
    },
  };
}

// ---------------------------------------------------------------------------
// Tokenless behavior, per mode
// ---------------------------------------------------------------------------

describe("tokenless requests", () => {
  it.each(LAZY_AUTH_MODES)(
    "%s: initialize, listing and the public tool need no token",
    async (mode) => {
      const server = await start({ mode });

      const init = await rpc(server.url, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1.0.0" },
      });
      expect(init.status).toBe(200);
      expect(init.body.result.protocolVersion).toBe("2025-11-25");

      const tools = await rpc(server.url, "tools/list");
      expect(tools.status).toBe(200);
      expect(
        tools.body.result.tools.map((t: { name: string }) => t.name)
      ).toEqual(["list_products", "get_my_orders", "cancel_order"]);

      for (const method of ["resources/list", "prompts/list"]) {
        expect((await rpc(server.url, method)).status).toBe(200);
      }

      const products = await callTool(server, "list_products");
      expect(products.status).toBe(200);
      expect(products.body.result.isError).toBeUndefined();
      expect(products.body.result.structuredContent.products).toHaveLength(3);

      const publicRead = await rpc(server.url, "resources/read", {
        uri: PUBLIC_RESOURCE_URI,
      });
      expect(publicRead.status).toBe(200);
      expect(publicRead.body.result.contents[0].uri).toBe(PUBLIC_RESOURCE_URI);
    }
  );

  it.each(HTTP_CHALLENGES)(
    "%s: a tokenless get_my_orders is refused at the HTTP layer",
    async (mode, expectedChallenge) => {
      const server = await start({ mode });
      const reply = await callTool(server, "get_my_orders");
      expect(reply.status).toBe(401);
      expect(reply.wwwAuthenticate).toBe(expectedChallenge(server.origin));
      // The refusal precedes JSON-RPC: the body is an OAuth error, not a response.
      expect(reply.body.jsonrpc).toBeUndefined();
    }
  );

  it.each(META_CHALLENGES)(
    "%s: a tokenless get_my_orders is a 200 isError result with the _meta challenge",
    async (mode, expectedChallenge) => {
      const server = await start({ mode });
      const reply = await callTool(server, "get_my_orders");
      expect(reply.status).toBe(200);
      expect(reply.wwwAuthenticate).toBeNull();
      expect(reply.body.result).toEqual({
        content: [{ type: "text", text: "Sign in to see your orders." }],
        isError: true,
        _meta: {
          [META_WWW_AUTHENTICATE_KEY]: expectedChallenge(server.origin),
        },
      });
    }
  );

  it("none: everything succeeds tokenless and there is no PRM", async () => {
    const server = await start({ mode: "none" });
    const orders = await callTool(server, "get_my_orders");
    expect(orders.status).toBe(200);
    expect(orders.body.result.structuredContent.orders).toHaveLength(2);
    const cancel = await callTool(server, "cancel_order", {
      order_id: "ord_1001",
    });
    expect(cancel.body.result.content[0].text).toBe("Order ord_1001 cancelled");
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect((await fetch(`${server.origin}${path}`)).status).toBe(404);
    }
  });

  it("meta modes: securitySchemes on tools and the inherited server default", async () => {
    const declared = await start({ mode: "meta" });
    const declaredTools = (await rpc(declared.url, "tools/list")).body.result
      .tools;
    const byName = (tools: Array<Record<string, unknown>>, name: string) =>
      tools.find((tool) => tool.name === name) ?? {};
    expect(byName(declaredTools, "list_products").securitySchemes).toEqual([
      { type: "noauth" },
    ]);
    expect(byName(declaredTools, "list_products").annotations).toEqual({
      readOnlyHint: true,
    });
    expect(byName(declaredTools, "get_my_orders").securitySchemes).toEqual([
      { type: "oauth2", scopes: ["orders:read"] },
    ]);
    expect(byName(declaredTools, "get_my_orders")._meta).toEqual({
      securitySchemes: [{ type: "oauth2", scopes: ["orders:read"] }],
    });
    expect(byName(declaredTools, "cancel_order").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });

    for (const mode of ["meta-inherited-default", "meta-no-default"] as const) {
      const server = await start({ mode });
      const orders = byName(
        (await rpc(server.url, "tools/list")).body.result.tools,
        "get_my_orders"
      );
      expect(orders).not.toHaveProperty("securitySchemes");
      expect(orders).not.toHaveProperty("_meta");
      const init = await rpc(server.url, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1.0.0" },
      });
      expect(init.body.result.protocolVersion).toBe("2025-06-18");
      expect(init.body.result._meta?.securitySchemes).toEqual(
        mode === "meta-inherited-default"
          ? [{ type: "oauth2", scopes: ["orders:read", "orders:write"] }]
          : undefined
      );
    }
  });

  it("http401: protected resources and prompts are refused like tools", async () => {
    const server = await start({ mode: "http401" });
    const read = await rpc(server.url, "resources/read", {
      uri: PROTECTED_RESOURCE_URI,
    });
    expect(read.status).toBe(401);
    expect(read.wwwAuthenticate).toContain('scope="orders:read"');
    const prompt = await rpc(server.url, "prompts/get", {
      name: PROTECTED_PROMPT_NAME,
    });
    expect(prompt.status).toBe(401);

    const token = server.mintAccessToken(["orders:read"]);
    const readOk = await rpc(
      server.url,
      "resources/read",
      { uri: PROTECTED_RESOURCE_URI },
      token
    );
    expect(readOk.status).toBe(200);
    expect(JSON.parse(readOk.body.result.contents[0].text)).toHaveLength(2);
    const promptOk = await rpc(
      server.url,
      "prompts/get",
      { name: PROTECTED_PROMPT_NAME },
      token
    );
    expect(promptOk.body.result.messages).toHaveLength(1);
  });

  it("meta: protected resources and prompts get a JSON-RPC error (no _meta channel)", async () => {
    const server = await start({ mode: "meta" });
    const read = await rpc(server.url, "resources/read", {
      uri: PROTECTED_RESOURCE_URI,
    });
    expect(read.status).toBe(200);
    expect(read.body.error.code).toBe(AUTH_REQUIRED_RPC_ERROR_CODE);
    const prompt = await rpc(server.url, "prompts/get", {
      name: PROTECTED_PROMPT_NAME,
    });
    expect(prompt.body.error.code).toBe(AUTH_REQUIRED_RPC_ERROR_CODE);
  });
});

// ---------------------------------------------------------------------------
// Tokens and scopes
// ---------------------------------------------------------------------------

describe("tokens and step-up", () => {
  it.each(AUTH_MODES)(
    "%s: orders:read unlocks get_my_orders; cancel_order needs a step-up",
    async (mode) => {
      const server = await start({ mode });
      const token = server.mintAccessToken(["orders:read"]);

      const orders = await callTool(server, "get_my_orders", {}, token);
      expect(orders.status).toBe(200);
      expect(orders.body.result.isError).toBeUndefined();
      expect(
        orders.body.result.structuredContent.orders.map(
          (o: { id: string }) => o.id
        )
      ).toEqual(["ord_1001", "ord_1002"]);

      const cancel = await callTool(
        server,
        "cancel_order",
        { order_id: "ord_1001" },
        token
      );
      expect(cancel.status).toBe(403);
      expect(cancel.wwwAuthenticate).toBe(
        mode === "http403-noscope"
          ? `Bearer error="insufficient_scope"`
          : `Bearer error="insufficient_scope", scope="orders:write", resource_metadata="${server.resourceMetadataUrl}"`
      );

      const writer = server.mintAccessToken(["orders:read", "orders:write"]);
      const cancelled = await callTool(
        server,
        "cancel_order",
        { order_id: "ord_1001" },
        writer
      );
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.result.content[0].text).toBe(
        "Order ord_1001 cancelled"
      );
    }
  );

  it("treats unknown and expired tokens as missing", async () => {
    const server = await start({ mode: "http401" });
    const unknown = await callTool(
      server,
      "get_my_orders",
      {},
      "not-a-real-token"
    );
    expect(unknown.status).toBe(401);
    const expired = server.mintAccessToken(["orders:read"], {
      expiresInSeconds: 0,
    });
    expect((await callTool(server, "get_my_orders", {}, expired)).status).toBe(
      401
    );
  });

  it("logs requests with token hashes only", async () => {
    const server = await start({ mode: "http401" });
    const token = server.mintAccessToken(["orders:read"]);
    await callTool(server, "list_products");
    await callTool(server, "get_my_orders");
    await callTool(server, "get_my_orders", {}, token);

    expect(server.requests).toEqual([
      {
        method: "POST",
        path: "/mcp",
        status: 200,
        rpcMethod: "tools/call",
        toolName: "list_products",
      },
      {
        method: "POST",
        path: "/mcp",
        status: 401,
        rpcMethod: "tools/call",
        toolName: "get_my_orders",
      },
      {
        method: "POST",
        path: "/mcp",
        status: 200,
        rpcMethod: "tools/call",
        toolName: "get_my_orders",
        tokenHash: hashToken(token),
      },
    ]);
    expect(JSON.stringify(server.requests)).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------
// Metadata and the OAuth flow
// ---------------------------------------------------------------------------

describe("authorization server", () => {
  it("serves PRM at both well-known paths and matching AS metadata", async () => {
    const server = await start({ mode: "http401" });
    const expectedPrm = {
      resource: `${server.origin}/mcp`,
      authorization_servers: [server.origin],
      scopes_supported: ["orders:read", "orders:write"],
      bearer_methods_supported: ["header"],
    };
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      expect(await (await fetch(`${server.origin}${path}`)).json()).toEqual(
        expectedPrm
      );
    }
    expect((await fetch(`${server.origin}${PRM_POINTER_PATH}`)).status).toBe(
      404
    );

    const oauth = await (
      await fetch(`${server.origin}/.well-known/oauth-authorization-server`)
    ).json();
    const oidc = await (
      await fetch(`${server.origin}/.well-known/openid-configuration`)
    ).json();
    expect(oidc).toEqual(oauth);
    expect(oauth).toMatchObject({
      issuer: server.origin,
      authorization_endpoint: `${server.origin}/authorize`,
      token_endpoint: `${server.origin}/token`,
      registration_endpoint: `${server.origin}/register`,
      scopes_supported: ["orders:read", "orders:write", "offline_access"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("prm-pointer-only: PRM only at the pointer path", async () => {
    const server = await start({ mode: "prm-pointer-only" });
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      expect((await fetch(`${server.origin}${path}`)).status).toBe(404);
    }
    const pointer = await fetch(`${server.origin}${PRM_POINTER_PATH}`);
    expect(pointer.status).toBe(200);
    expect((await pointer.json()).resource).toBe(`${server.origin}/mcp`);
  });

  it("runs DCR → PKCE authorize → token → call → refresh end to end", async () => {
    const server = await start({ mode: "http401" });

    // The challenge is where a client starts.
    const challenge = await callTool(server, "get_my_orders");
    expect(challenge.wwwAuthenticate).toContain(
      `resource_metadata="${server.resourceMetadataUrl}"`
    );

    const { clientId, pkce, authorizeUrl, prm } =
      await prepareAuthorization(server);
    expect(prm.resource).toBe(server.url);

    // The consent page is a real page with an Allow button.
    const consent = await fetch(authorizeUrl);
    expect(consent.headers.get("content-type")).toContain("text/html");
    expect(await consent.text()).toContain(">Allow</button>");

    const location = new URL(await server.approveAuthorization(authorizeUrl));
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("iss")).toBe(server.origin);
    const code = location.searchParams.get("code") ?? "";
    expect(code).toBeTruthy();

    const token = await postForm(`${server.origin}/token`, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: pkce.verifier,
      resource: server.url,
    });
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "orders:read offline_access",
    });
    const accessToken = token.body.access_token as string;
    const refreshToken = token.body.refresh_token as string;

    const orders = await callTool(server, "get_my_orders", {}, accessToken);
    expect(orders.status).toBe(200);
    expect(orders.body.result.structuredContent.orders).toHaveLength(2);

    // Codes are single use.
    const replay = await postForm(`${server.origin}/token`, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    expect(replay.body.error).toBe("invalid_grant");

    const refreshed = await postForm(`${server.origin}/token`, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(refreshToken);
    const again = await callTool(
      server,
      "get_my_orders",
      {},
      refreshed.body.access_token as string
    );
    expect(again.status).toBe(200);

    // Refresh tokens rotate: the spent one is rejected.
    const spent = await postForm(`${server.origin}/token`, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(spent.body.error).toBe("invalid_grant");

    // Wrong verifier fails PKCE.
    const second = await prepareAuthorization(server);
    const secondCode =
      new URL(
        await server.approveAuthorization(second.authorizeUrl)
      ).searchParams.get("code") ?? "";
    const badPkce = await postForm(`${server.origin}/token`, {
      grant_type: "authorization_code",
      code: secondCode,
      redirect_uri: REDIRECT_URI,
      client_id: second.clientId,
      code_verifier: pkcePair().verifier,
    });
    expect(badPkce.body.error).toBe("invalid_grant");
  });

  it("redirects authorize errors back to the client, with iss", async () => {
    const server = await start({ mode: "http401" });

    const noPkce = await prepareAuthorization(server, {
      code_challenge: undefined,
      code_challenge_method: undefined,
    });
    const noPkceLocation = new URL(
      await server.approveAuthorization(noPkce.authorizeUrl)
    );
    expect(noPkceLocation.searchParams.get("error")).toBe("invalid_request");
    expect(noPkceLocation.searchParams.get("iss")).toBe(server.origin);

    const wrongResource = await prepareAuthorization(server, {
      resource: "https://elsewhere.example/mcp",
    });
    expect(
      new URL(
        await server.approveAuthorization(wrongResource.authorizeUrl)
      ).searchParams.get("error")
    ).toBe("invalid_target");

    // An unregistered redirect URI is never redirected to.
    const badRedirect = await prepareAuthorization(server, {
      redirect_uri: "http://127.0.0.1:65530/elsewhere",
    });
    await expect(
      server.approveAuthorization(badRedirect.authorizeUrl)
    ).rejects.toThrow(/HTTP 400/);
  });

  it("accepts a Client ID Metadata Document client", async () => {
    const server = await start({ mode: "http401" });

    // Serve a CIMD on its own loopback origin.
    const cimdServer = http.createServer((req, res) => {
      const address = cimdServer.address() as AddressInfo;
      const clientId = `http://127.0.0.1:${address.port}/client.json`;
      if (req.url === "/client.json") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            client_id: clientId,
            client_name: "CIMD Client",
            redirect_uris: [REDIRECT_URI],
            token_endpoint_auth_method: "none",
          })
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      cimdServer.listen(0, "127.0.0.1", resolve)
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          cimdServer.closeAllConnections();
          cimdServer.close(() => resolve());
        })
    );
    const clientId = `http://127.0.0.1:${(cimdServer.address() as AddressInfo).port}/client.json`;

    const pkce = pkcePair();
    const authorizeUrl = new URL(`${server.origin}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: "cimd-state",
      resource: server.url,
    }).toString();

    const location = new URL(
      await server.approveAuthorization(authorizeUrl.toString())
    );
    const token = await postForm(`${server.origin}/token`, {
      grant_type: "authorization_code",
      code: location.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    expect(token.status).toBe(200);
    // No scope requested: everything the resource supports.
    expect(token.body.scope).toBe("orders:read orders:write");

    // A redirect URI the document does not list is refused.
    authorizeUrl.searchParams.set(
      "redirect_uri",
      "http://127.0.0.1:65530/other"
    );
    await expect(
      server.approveAuthorization(authorizeUrl.toString())
    ).rejects.toThrow(/HTTP 400/);
  });
});

// ---------------------------------------------------------------------------
// Legacy HTTP+SSE transport
// ---------------------------------------------------------------------------

describe("legacy HTTP+SSE transport", () => {
  it("http401: the gate answers on the POST; public calls arrive on the stream", async () => {
    const server = await start({ mode: "http401", transport: "sse" });
    expect(server.url).toBe(`${server.origin}/sse`);
    expect(server.resourceMetadataUrl).toBe(
      `${server.origin}/.well-known/oauth-protected-resource/sse`
    );
    const prm = await (await fetch(server.resourceMetadataUrl)).json();
    expect(prm.resource).toBe(server.url);

    const sse = await openSse(server.url);

    const refused = await callToolAt(sse.messagesUrl, "get_my_orders");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="Sign in to see your orders", resource_metadata="${server.resourceMetadataUrl}", scope="orders:read"`
    );

    const accepted = await callToolAt(sse.messagesUrl, "list_products");
    expect(accepted.status).toBe(202);
    const message = await sse.nextMessage();
    expect(message.result.structuredContent.products).toHaveLength(3);

    const token = server.mintAccessToken(["orders:read"]);
    expect(
      (await callToolAt(sse.messagesUrl, "get_my_orders", token)).status
    ).toBe(202);
    expect(
      (await sse.nextMessage()).result.structuredContent.orders
    ).toHaveLength(2);
  });

  it("meta: the challenge result arrives on the stream", async () => {
    const server = await start({ mode: "meta", transport: "sse" });
    const sse = await openSse(server.url);
    expect((await callToolAt(sse.messagesUrl, "get_my_orders")).status).toBe(
      202
    );
    const message = await sse.nextMessage();
    expect(message.result.isError).toBe(true);
    expect(message.result._meta[META_WWW_AUTHENTICATE_KEY]).toEqual([
      `Bearer resource_metadata="${server.resourceMetadataUrl}", error="insufficient_scope", error_description="You need to login to continue"`,
    ]);
  });
});

async function callToolAt(messagesUrl: string, name: string, token?: string) {
  return fetch(messagesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
}

// ---------------------------------------------------------------------------
// MCPClientManager
// ---------------------------------------------------------------------------

describe("MCPClientManager against the fixture", () => {
  async function connect(
    server: LazyAuthServer,
    config: Record<string, unknown> = {}
  ): Promise<MCPClientManager> {
    const manager = new MCPClientManager();
    cleanups.push(() => manager.disconnectAllServers());
    await manager.connectToServer("lazy", {
      url: server.url,
      timeout: 10_000,
      ...config,
    });
    return manager;
  }

  const toolNames = async (manager: MCPClientManager) =>
    (await manager.listTools("lazy")).tools.map((tool) => tool.name);

  /** The JSON-RPC methods the server saw, in order (to pin which handshake ran). */
  const rpcMethods = (server: LazyAuthServer) =>
    server.requests.flatMap((entry) =>
      entry.rpcMethod ? [entry.rpcMethod] : []
    );

  it("connects unpinned over Streamable HTTP (auto negotiation lands on 2026-07-28)", async () => {
    const server = await start({ mode: "http401" });
    const manager = await connect(server);
    expect(manager.getInitializationInfo("lazy")?.protocolVersion).toBe(
      "2026-07-28"
    );
    expect(rpcMethods(server)[0]).toBe("server/discover");
    expect(rpcMethods(server)).not.toContain("initialize");
    expect(await toolNames(manager)).toEqual([
      "list_products",
      "get_my_orders",
      "cancel_order",
    ]);
    const products = await manager.executeTool("lazy", "list_products", {});
    expect((products as { isError?: boolean }).isError).toBeFalsy();
  });

  it("connects pinned to 2026-07-28", async () => {
    const server = await start({ mode: "meta" });
    const manager = await connect(server, { mcpProtocolVersion: "2026-07-28" });
    expect(manager.getInitializationInfo("lazy")?.protocolVersion).toBe(
      "2026-07-28"
    );
    expect(await toolNames(manager)).toEqual([
      "list_products",
      "get_my_orders",
      "cancel_order",
    ]);
    // The _meta challenge survives the modern-era encoding.
    const orders = (await manager.executeTool("lazy", "get_my_orders", {})) as {
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    expect(orders.isError).toBe(true);
    expect(orders._meta?.[META_WWW_AUTHENTICATE_KEY]).toEqual([
      fullMetaChallenge(server.origin),
    ]);
  });

  it("connects pinned to 2025-11-25 (legacy initialize)", async () => {
    const server = await start({ mode: "http401" });
    const manager = await connect(server, { mcpProtocolVersion: "2025-11-25" });
    expect(manager.getInitializationInfo("lazy")?.protocolVersion).toBe(
      "2025-11-25"
    );
    expect(rpcMethods(server).slice(0, 2)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(await toolNames(manager)).toContain("get_my_orders");
  });

  it("connects over legacy HTTP+SSE", async () => {
    const server = await start({ mode: "http401", transport: "sse" });
    const manager = await connect(server);
    // Auto negotiation probes `server/discover`, gets -32601, and falls back.
    expect(rpcMethods(server)).toEqual(
      expect.arrayContaining(["server/discover", "initialize"])
    );
    expect(manager.getInitializationInfo("lazy")?.protocolVersion).toBe(
      "2025-11-25"
    );
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      path: "/sse",
      status: 200,
    });
    expect(await toolNames(manager)).toEqual([
      "list_products",
      "get_my_orders",
      "cancel_order",
    ]);
  });
});
