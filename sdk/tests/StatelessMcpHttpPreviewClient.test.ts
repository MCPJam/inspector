/**
 * Integration tests for `StatelessMcpHttpPreviewClient` against an
 * in-process HTTP server that enforces the DRAFT-2026-v1 wire contract:
 *   - body `_meta.io.modelcontextprotocol/protocolVersion === "DRAFT-2026-v1"`
 *   - `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers match
 *     body case-insensitively (RFC 9110)
 *   - `Mcp-Param-<Name>` mirrors `params.arguments.<param>` per SEP-2243
 *
 * These tests cover the gap the reviewer called out — the SDK suite has
 * no other coverage of the new stateless path.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import {
  StatelessMcpHttpPreviewClient,
  STATELESS_DRAFT_2026_V1,
  NotYetSupportedInStateless,
  type DiscoverResult,
} from "../src/mcp-client-manager/stateless-mcp-http-preview-client.js";

interface CapturedRequest {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FixtureOptions {
  emitSessionId?: boolean;
  ttlMs?: number;
  /**
   * Reject `server/discover` requests with -32004 (data.supported lists
   * 2025-11-25). Lets the connect-on-discover negative-path test simulate
   * a 2025-only server.
   */
  discoverThrowsUnsupportedVersion?: boolean;
}

async function startFixture(opts: FixtureOptions = {}): Promise<{
  url: URL;
  close: () => Promise<void>;
  captured: CapturedRequest[];
}> {
  const captured: CapturedRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf-8");
    const body = JSON.parse(text);
    captured.push({
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(",") : (v ?? ""),
        ]),
      ),
      body,
    });

    const protoVersion =
      body?.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
    if (protoVersion !== STATELESS_DRAFT_2026_V1) {
      return respond(res, opts, {
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: {
          code: -32004,
          message: "Unsupported protocol version",
          data: { supported: [STATELESS_DRAFT_2026_V1] },
        },
      });
    }
    const headerProto = pick(req, "mcp-protocol-version");
    if (headerProto !== STATELESS_DRAFT_2026_V1) {
      return respond(res, opts, {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32001,
          message: "HeaderMismatch",
          data: { field: "MCP-Protocol-Version", expected: STATELESS_DRAFT_2026_V1 },
        },
      });
    }
    const headerMethod = pick(req, "mcp-method");
    if (headerMethod !== body.method) {
      return respond(res, opts, {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32001,
          message: "HeaderMismatch",
          data: { field: "Mcp-Method" },
        },
      });
    }

    if (opts.discoverThrowsUnsupportedVersion && body.method === "server/discover") {
      return respond(res, opts, {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32004,
          message: "Unsupported protocol version",
          data: {
            supported: ["2025-11-25"],
            requested: STATELESS_DRAFT_2026_V1,
          },
        },
      });
    }

    switch (body.method) {
      case "server/discover":
        return respond(res, opts, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: STATELESS_DRAFT_2026_V1,
            serverInfo: { name: "fixture-server", version: "0.1.0" },
            serverCapabilities: {
              tools: {},
              resources: {},
              prompts: {},
            },
            supportedVersions: [STATELESS_DRAFT_2026_V1],
          } satisfies DiscoverResult,
        });
      case "tools/list":
        return respond(res, opts, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "echo",
                inputSchema: { type: "object", properties: { value: { type: "string" } } },
              },
              {
                name: "regional-echo",
                inputSchema: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    region: { type: "string", "x-mcp-header": "Region" },
                  },
                },
              },
            ],
            ttlMs: opts.ttlMs ?? 60_000,
          },
        });
      case "tools/call": {
        if (body.params?.name === "regional-echo") {
          // Mirror contract: body and header must carry the same region
          // value. Reject otherwise.
          const headerRegion = pick(req, "mcp-param-region");
          const bodyRegion = body.params.arguments?.region;
          if (
            (headerRegion !== undefined || bodyRegion !== undefined) &&
            headerRegion !== bodyRegion
          ) {
            return respond(res, opts, {
              jsonrpc: "2.0",
              id: body.id,
              error: {
                code: -32001,
                message: "HeaderMismatch",
                data: {
                  field: "Mcp-Param-Region",
                  bodyRegion,
                  headerRegion,
                },
              },
            });
          }
          return respond(res, opts, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [
                { type: "text", text: JSON.stringify({ region: headerRegion ?? null }) },
              ],
            },
          });
        }
        return respond(res, opts, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              {
                type: "text",
                text: String(body.params?.arguments?.value ?? ""),
              },
            ],
          },
        });
      }
      case "ping":
        return respond(res, opts, { jsonrpc: "2.0", id: body.id, result: {} });
      default:
        return respond(res, opts, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: new URL(`http://127.0.0.1:${port}/`),
    captured,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function pick(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

function respond(
  res: ServerResponse,
  opts: FixtureOptions,
  payload: unknown,
): void {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.emitSessionId) headers["Mcp-Session-Id"] = "fixture-session";
  res.writeHead(200, headers);
  res.end(JSON.stringify(payload));
}

describe("StatelessMcpHttpPreviewClient", () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let client: StatelessMcpHttpPreviewClient;

  beforeEach(async () => {
    fixture = await startFixture();
    client = new StatelessMcpHttpPreviewClient({
      url: fixture.url,
      clientInfo: { name: "test-client", version: "0.0.1" },
      serverId: "fixture",
      // The default-on `server/discover` probe pollutes the
      // `captured` indices the existing tests assert on (they expect
      // captured[0] to be their first triggered RPC). Disable for the
      // generic suite; dedicated discover tests opt in explicitly.
      discoverOnConnect: false,
    });
    await client.connect(undefined as never);
  });

  afterEach(async () => {
    await client.close();
    await fixture.close();
  });

  test("listTools sends DRAFT-2026-v1 _meta and required headers, returns tools", async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    const sent = fixture.captured[0];
    expect(sent.body.method).toBe("tools/list");
    expect(
      (sent.body as { params?: { _meta?: Record<string, unknown> } }).params
        ?._meta?.["io.modelcontextprotocol/protocolVersion"],
    ).toBe(STATELESS_DRAFT_2026_V1);
    expect(
      (sent.body as { params?: { _meta?: Record<string, unknown> } }).params
        ?._meta?.["io.modelcontextprotocol/clientInfo"],
    ).toEqual({ name: "test-client", version: "0.0.1" });
    expect(sent.headers["mcp-protocol-version"]).toBe(STATELESS_DRAFT_2026_V1);
    expect(sent.headers["mcp-method"]).toBe("tools/list");
  });

  test("callTool on annotated tool mirrors body and header per SEP-2243", async () => {
    // Lazy-fill: callTool with no prior listTools triggers auto-discovery
    // and then emits Mcp-Param-Region. The mirror contract requires that
    // params.arguments.region also stays present in the body.
    const result = await client.callTool({
      name: "regional-echo",
      arguments: { value: "hi", region: "us-west1" },
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ region: "us-west1" }) },
    ]);

    // Two requests captured: tools/list (lazy discovery) + tools/call.
    expect(fixture.captured).toHaveLength(2);
    const callRequest = fixture.captured[1];
    expect(callRequest.body.method).toBe("tools/call");
    // Mirror: body keeps the annotated arg AND header carries it.
    expect(
      (callRequest.body as {
        params: { arguments: Record<string, unknown> };
      }).params.arguments,
    ).toEqual({ value: "hi", region: "us-west1" });
    expect(callRequest.headers["mcp-param-region"]).toBe("us-west1");
    expect(callRequest.headers["mcp-name"]).toBe("regional-echo");
  });

  test("callTool with body/header mismatch is rejected by server (-32001)", async () => {
    // Direct send bypassing deriveHeaders to assert the fixture catches
    // a mismatch — protects against the preview accidentally regressing
    // to a "lift" implementation.
    const result = await fetch(fixture.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": STATELESS_DRAFT_2026_V1,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "regional-echo",
        "Mcp-Param-Region": "us-west1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "regional-echo",
          // Body region disagrees with header — strict mirror servers
          // must reject.
          arguments: { value: "hi", region: "eu-central1" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": STATELESS_DRAFT_2026_V1,
            "io.modelcontextprotocol/clientInfo": { name: "raw", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const payload = (await result.json()) as {
      error?: { code: number; message: string };
    };
    expect(payload.error?.code).toBe(-32001);
  });

  test("preserves caller _meta.progressToken and _meta.traceparent on merge", async () => {
    await client.ping({
      // RequestOptions onprogress isn't required; pass _meta via request()
      // directly so we can pin the merge behavior.
    });
    // Use the generic request() path which forwards caller params verbatim
    // through to send(), so we can assert merge from a known seed.
    await client.request(
      {
        method: "ping",
        params: {
          _meta: {
            progressToken: "tok-1",
            traceparent: "00-aaa-bbb-01",
            tracestate: "vendor=foo",
            baggage: "userId=42",
          },
        },
      } as never,
    );
    const lastBody = fixture.captured[fixture.captured.length - 1].body as {
      params: { _meta: Record<string, unknown> };
    };
    expect(lastBody.params._meta.progressToken).toBe("tok-1");
    expect(lastBody.params._meta.traceparent).toBe("00-aaa-bbb-01");
    expect(lastBody.params._meta.tracestate).toBe("vendor=foo");
    expect(lastBody.params._meta.baggage).toBe("userId=42");
    // Our locked keys still present.
    expect(
      lastBody.params._meta["io.modelcontextprotocol/protocolVersion"],
    ).toBe(STATELESS_DRAFT_2026_V1);
  });

  test("never sends Mcp-Session-Id header outbound", async () => {
    await client.listTools();
    await client.ping();
    for (const captured of fixture.captured) {
      expect(captured.headers["mcp-session-id"]).toBeUndefined();
    }
  });

  test("warns and marks non-conforming when server returns mcp-session-id (never echoed)", async () => {
    await fixture.close();
    fixture = await startFixture({ emitSessionId: true });
    client = new StatelessMcpHttpPreviewClient({
      url: fixture.url,
      clientInfo: { name: "test-client", version: "0.0.1" },
      serverId: "fixture-with-session",
    });
    await client.connect(undefined as never);
    await client.listTools();
    expect(client.hasSeenNonConformingSessionId()).toBe(true);
    // Subsequent request still does not echo the session id back.
    await client.ping();
    for (const captured of fixture.captured) {
      expect(captured.headers["mcp-session-id"]).toBeUndefined();
    }
  });

  test("subscribeResource throws NotYetSupportedInStateless", async () => {
    await expect(client.subscribeResource({ uri: "x://" })).rejects.toThrow(
      NotYetSupportedInStateless,
    );
    await expect(client.unsubscribeResource({ uri: "x://" })).rejects.toThrow(
      NotYetSupportedInStateless,
    );
  });

  test("setLoggingLevel is no-op (no network call)", async () => {
    const before = fixture.captured.length;
    await client.setLoggingLevel("debug");
    expect(fixture.captured.length).toBe(before);
  });

  test("listTools excludes tools with invalid x-mcp-header annotations", async () => {
    await fixture.close();
    // Boot a fixture that returns an invalid annotation (non-ASCII).
    const bad = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      respond(res, {}, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            { name: "ok", inputSchema: { type: "object", properties: {} } },
            {
              name: "bad",
              inputSchema: {
                type: "object",
                properties: {
                  region: { type: "string", "x-mcp-header": "Bad Token" },
                },
              },
            },
          ],
          ttlMs: 60_000,
        },
      });
    });
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", () => r()));
    const port = (bad.address() as AddressInfo).port;
    const badClient = new StatelessMcpHttpPreviewClient({
      url: new URL(`http://127.0.0.1:${port}/`),
      clientInfo: { name: "test", version: "0" },
      serverId: "bad",
      // Bad fixture only serves tools/list; auto-discover would 404.
      discoverOnConnect: false,
    });
    await badClient.connect(undefined as never);
    const result = await badClient.listTools();
    expect((result.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["ok"]);
    await badClient.close();
    await new Promise<void>((r) => bad.close(() => r()));
  });

  // ---- server/discover (SEP-2575) ----
  // Default-on discover probe runs from `connect()`. These three tests
  // use their own fixture+client because the suite-wide beforeEach
  // disables discover so other tests' captured indices stay clean.

  test("connect() fires server/discover and populates serverCapabilities", async () => {
    // Standalone client (no shared beforeEach) so we can leave
    // discoverOnConnect at its default `true`.
    const localFixture = await startFixture();
    const localClient = new StatelessMcpHttpPreviewClient({
      url: localFixture.url,
      clientInfo: { name: "test-client", version: "0.0.1" },
      serverId: "discover-fixture",
    });
    try {
      await localClient.connect(undefined as never);

      // Exactly one outbound request — the discover probe.
      expect(localFixture.captured).toHaveLength(1);
      const sent = localFixture.captured[0];
      expect(sent.body.method).toBe("server/discover");
      expect(sent.headers["mcp-method"]).toBe("server/discover");
      expect(sent.headers["mcp-protocol-version"]).toBe(STATELESS_DRAFT_2026_V1);

      // Capability getters now return the discover-populated values
      // instead of the permissive synthetic / undefined defaults.
      expect(localClient.getServerVersion()).toEqual({
        name: "fixture-server",
        version: "0.1.0",
      });
      expect(localClient.getServerCapabilities()).toEqual({
        tools: {},
        resources: {},
        prompts: {},
      });
    } finally {
      await localClient.close();
      await localFixture.close();
    }
  });

  test("connect() throws and surfaces -32004 when server rejects version", async () => {
    const rejectFixture = await startFixture({
      discoverThrowsUnsupportedVersion: true,
    });
    const rejectClient = new StatelessMcpHttpPreviewClient({
      url: rejectFixture.url,
      clientInfo: { name: "test-client", version: "0.0.1" },
      serverId: "reject-fixture",
    });
    try {
      // Connect must reject with a labeled error carrying the JSON-RPC
      // code + message; the wire log captures the full envelope via the
      // receive logger (fix from the prior commit).
      await expect(
        rejectClient.connect(undefined as never),
      ).rejects.toMatchObject({
        code: -32004,
        message: expect.stringContaining("Unsupported protocol version"),
      });

      // Capability getters return undefined when discover failed —
      // distinguishes "no info" from a fake synthetic.
      expect(rejectClient.getServerCapabilities()).toBeUndefined();
      expect(rejectClient.getServerVersion()).toBeUndefined();
    } finally {
      await rejectClient.close();
      await rejectFixture.close();
    }
  });

  test("discoverOnConnect: false skips the probe entirely", async () => {
    const silentFixture = await startFixture();
    const silentClient = new StatelessMcpHttpPreviewClient({
      url: silentFixture.url,
      clientInfo: { name: "test-client", version: "0.0.1" },
      serverId: "silent-fixture",
      discoverOnConnect: false,
    });
    try {
      await silentClient.connect(undefined as never);

      // Zero outbound requests — the opt-out is real.
      expect(silentFixture.captured).toHaveLength(0);

      // Capability getters return undefined (no discover ran). Manager
      // callers handle undefined the same way they handle the legacy
      // pre-connect state.
      expect(silentClient.getServerCapabilities()).toBeUndefined();
      expect(silentClient.getServerVersion()).toBeUndefined();
    } finally {
      await silentClient.close();
      await silentFixture.close();
    }
  });
});
