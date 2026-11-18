import http from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createElicitInput } from "@openai/mcp-extensions/server";
const f = vi.hoisted(() => ({
  verify: undefined as
    | undefined
    | ((token: string) => Promise<{ sub: string; sid: string; orgId: string }>),
  answer: vi.fn(),
}));
vi.mock("../../authkit-jwt.js", () => ({
  verifyAuthKitToken: (token: string) => f.verify!(token),
}));
vi.mock("../../../routes/web/hosted-elicitation.js", () => ({
  HostedElicitationBridge: class {
    async callback() {
      return f.answer();
    }
    attachStreamWriter() {}
    dispose() {}
  },
}));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: (token: string) => ({
    query: async () => {
      const actor = await f.verify!(token);
      if (actor.sub !== "actor") throw new Error("Foreign actor");
      return { actorId: "actor", projectId: "project" };
    },
  }),
}));
import {
  preparePluginOperation,
  bindPluginOperation,
  receiptOnlyPorts,
} from "../operation-authorization";
import { turnAuthorizations } from "../../turn-authorization";
import {
  turnAuthorizationPart,
  turnAuthorizationIdentity,
} from "../../../../shared/turn-authorization";
import {
  RevokedSessionCache,
  setRevokedSessionCacheForTests,
} from "../../revoked-session-cache";
import { admitPluginWorkspace } from "../admission";
import { getConvexBearerForRequest } from "../../../utils/v1-convex-token";
import {
  createOwnedPluginLegacyForms,
  ownedLegacyFormCapabilities,
} from "../owned-legacy";
import { RequestOwnedToolInvoker } from "../request-invoker";
import type { PluginFormOwner } from "../instances";

const instance: PluginFormOwner = {
  owner: {
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 1,
    serverId: "server",
    bindingId: "binding",
    placement: "interactive",
  },
  subject: "subject",
  hostId: "host",
  hostRevision: "revision",
  serverIdentity: { kind: "standalone", serverId: "server" },
};
const op = {
  invocationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  origin: "app" as const,
  params: { name: "review", arguments: {} },
};
const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let live = new AbortController();
let clock = Date.now();
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let manager: MCPClientManager | undefined;
let closeServer: (() => Promise<void>) | undefined;
let cache: RevokedSessionCache;
let dispatches = 0,
  consumed = 0,
  initializes = 0;
let metadata: ReturnType<typeof turnAuthorizationPart.parse> | undefined;
const mint = (sub = "actor", sid = "session", org = "org") =>
  new SignJWT({ sid, org_id: org })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(sub)
    .setIssuedAt(Math.floor(clock / 1000))
    .setExpirationTime(Math.floor(clock / 1000) + 300)
    .sign(keys.privateKey);
async function server() {
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();
  const node = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : undefined;
    if (body?.method === "server/discover") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
      return;
    }
    let transport = transports.get(String(req.headers["mcp-session-id"]));
    if (body?.method === "initialize") {
      initializes++;
      const mcp = new McpServer(
        { name: "owned-app", version: "1" },
        { capabilities: { tools: {} } },
      );
      mcp.registerTool("review", {}, async (ctx) => {
        dispatches++;
        const result = await createElicitInput(mcp)(ctx, {
          mode: "form",
          message: "Review",
          requestedSchema: {
            type: "object",
            properties: {
              agree: { type: "boolean" },
              count: { type: "integer" },
            },
            required: ["agree", "count"],
          },
        });
        consumed++;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      });
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, transport!); },
      });
      await mcp.connect(transport);
    }
    if (!transport) {
      res.writeHead(400).end();
      return;
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => node.listen(0, "127.0.0.1", resolve));
  closeServer = async () => {
    await Promise.allSettled([...transports.values()].map((t) => t.close()));
    node.closeAllConnections();
    await new Promise<void>((r) => node.close(() => r()));
  };
  return `http://127.0.0.1:${(node.address() as AddressInfo).port}/mcp`;
}
beforeEach(async () => {
  live = new AbortController();
  clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  keys = await generateKeyPair("RS256");
  dispatches = consumed = initializes = 0;
  f.verify = async (token) => {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      currentDate: new Date(clock),
    });
    return {
      sub: payload.sub!,
      sid: String(payload.sid),
      orgId: String(payload.org_id),
    };
  };
  cache = new RevokedSessionCache({
    fetchPage: async () => ({
      sessions: [],
      cursor: null,
      isDone: true,
      watermark: Date.now(),
    }),
  });
  await cache.scan();
  setRevokedSessionCacheForTests(cache);
});
afterEach(async () => {
  if (metadata) {
    try {
      turnAuthorizations.cancelOperation(
        turnAuthorizationIdentity.parse(
          (({ expiresAt, tokenExpiresAt, ...rest }) => rest)(metadata.data),
        ),
        { subject: "actor", sessionId: "session", organizationId: "org" },
      );
    } catch {
      /* A refused/finished claim is already absent. */
    }
  }
  metadata = undefined;
  await manager?.disconnectAllServers();
  manager = undefined;
  await closeServer?.();
  closeServer = undefined;
  setRevokedSessionCacheForTests(null);
  vi.restoreAllMocks();
});
function app(url: string) {
  const invoker = new RequestOwnedToolInvoker(instance.owner, () => {});
  return new Hono()
    .use("*", async (c, next) => {
      const token = c.req.header("authorization")!.replace(/^Bearer /, "");
      const actor = await f.verify!(token);
      c.set("authMethod", "authkit_jwt");
      c.set("workosUserId", actor.sub);
      await next();
    })
    .post("/renew", async (c) =>
      c.json(
        await preparePluginOperation(c, instance, op, requestId, live.signal),
      ),
    )
    .post("/call", async (c) => {
      const body = await c.req.json();
      const scoped = turnAuthorizationIdentity.parse(body.authorization);
      const bound = await bindPluginOperation(
        c,
        instance,
        op,
        scoped,
        c.req.raw.signal,
      );
      try {
        const admission = await admitPluginWorkspace({
          projectId: "project",
          descriptor: { version: 1, workspaceId: "workspace" },
          bearer: await getConvexBearerForRequest(c),
          getAuthorization: () => getConvexBearerForRequest(c),
        });
        const forms = createOwnedPluginLegacyForms({
          bearer: await getConvexBearerForRequest(c),
          getAuthorization: admission.getAuthorization,
          projectId: "project",
          workspaceId: "workspace",
          hostId: "host",
          hostRevision: "revision",
          serverId: "server",
          signal: c.req.raw.signal,
          manager: () => manager,
          assertCurrent: () => admission.revalidate(),
          profile: { origin: "mcp-app", fileResources: false, userResources: false, previews: false },
        });
        manager ??= new MCPClientManager(
          {},
          {
            lazyConnect: true,
            extensionRequestHandlers: { server: [forms.binding] },
          },
        );
        if (!manager.getServerConfig("server"))
          await manager.connectToServer("server", {
            url,
            clientCapabilities: ownedLegacyFormCapabilities(
              {},
              { binding: forms.binding },
            ),
          });
        const result = await invoker.invoke(
          receiptOnlyPorts(
            {
              authorize: async () => {
                await admission.revalidate();
                return {
                  owner: instance.owner,
                  revision: "revision",
                  enabled: true,
                  tool: { name: "review" },
                  allowedOrigins: ["app"],
                  requiresApproval: false,
                };
              },
              admit: () => admission.revalidate(),
              approve: async () => false,
              execute: (auth, _params, signal) =>
                forms.run(auth, op.invocationId, signal, () =>
                  manager!.executeTool("server", "review", {}),
                ),
              classifyFailure: () => "unknown",
            },
            bound.receiptOnly,
          ),
          "app",
          op.invocationId,
          op.params,
          c.req.raw.signal,
        );
        return c.json({ result });
      } finally {
        bound.dispose();
      }
    });
}
it("keeps one actual legacy App call alive after signed JWT expiry and recovers its receipt without dispatch", async () => {
  const target = app(await server());
  const original = await mint();
  const prepared = await target.request("/renew", {
    method: "POST",
    headers: { authorization: `Bearer ${original}` },
  });
  metadata = turnAuthorizationPart.parse(await prepared.json());
  expect(initializes).toBe(0);
  const identity = turnAuthorizationIdentity.parse(
    (({ expiresAt, tokenExpiresAt, ...rest }) => rest)(metadata.data),
  );
  let fresh = "";
  f.answer.mockImplementationOnce(async () => {
    clock += 360_000;
    await cache.scan();
    await expect(f.verify!(original)).rejects.toThrow();
    fresh = await mint();
    await turnAuthorizations.renew(
      identity,
      { subject: "actor", sessionId: "session", organizationId: "org" },
      fresh,
    );
    return { action: "accept", content: { agree: false, count: 0 } };
  });
  const first = await target.request("/call", {
    method: "POST",
    headers: { authorization: `Bearer ${original}` },
    body: JSON.stringify({ authorization: identity }),
  });
  expect(first.status).toBe(200);
  expect(JSON.parse((await first.json()).result.content[0].text)).toEqual({ action: "accept", content: { agree: false, count: 0 } });
  expect(dispatches).toBe(1);
  expect(consumed).toBe(1);
  const replay = await target.request("/call", {
    method: "POST",
    headers: { authorization: `Bearer ${fresh}` },
    body: JSON.stringify({ authorization: identity }),
  });
  expect(replay.status).toBe(200);
  expect(dispatches).toBe(1);
  expect(consumed).toBe(1);
});
it.each(["foreign", "revoked"])(
  "keeps %s renewal from changing the original App authority",
  async (kind) => {
    const target = app(await server());
    const original = await mint();
    metadata = turnAuthorizationPart.parse(
      await (
        await target.request("/renew", {
          method: "POST",
          headers: { authorization: `Bearer ${original}` },
        })
      ).json(),
    );
    const identity = turnAuthorizationIdentity.parse(
      (({ expiresAt, tokenExpiresAt, ...rest }) => rest)(metadata.data),
    );
    f.answer.mockImplementationOnce(async () => {
      clock += 240_000;
      await cache.scan();
      if (kind === "revoked") cache.markRevokedLocally("session");
      const fresh = await mint(kind === "foreign" ? "other" : "actor");
      await expect(
        turnAuthorizations.renew(
          identity,
          {
            subject: kind === "foreign" ? "other" : "actor",
            sessionId: "session",
            organizationId: "org",
          },
          fresh,
        ),
      ).rejects.toThrow();
      return { action: "accept", content: { agree: false, count: 0 } };
    });
    const result = await target.request("/call", {
      method: "POST",
      headers: { authorization: `Bearer ${original}` },
      body: JSON.stringify({ authorization: identity }),
    });
    expect(result.status).toBe(kind === "foreign" ? 200 : 500);
    expect(dispatches).toBe(1);
    expect(consumed).toBe(kind === "foreign" ? 1 : 0);
  },
);
