/**
 * A 2026-07-28 server that does not say who it is.
 *
 * "Servers SHOULD include the following `io.modelcontextprotocol/*` field in
 * every result's `_meta`, unless specifically configured not to do so"
 * (2026-07-28 basic/index.mdx:397-403), and the table under it marks
 * `io.modelcontextprotocol/serverInfo` as not required. Modern Client
 * Handshake failed such a server with "server identity (name) is missing".
 *
 * These pin the three readings of one `server/discover` result (identity
 * there, absent, malformed), the advice that reports the absent one, and that
 * the advice never asks on a 2025 revision.
 */

import { describe, expect, it, vi } from "vitest";
import {
  READINESS_CATALOG,
  PROTOCOL_CHECK_CATALOG,
} from "../../src/conformance-catalog.js";
import {
  collectRawAdvice,
  serverIdentityOutcome,
} from "../../src/mcp-conformance/readiness.js";
import {
  SERVER_INFO_META_KEY,
  isWellFormedIdentity,
  readServerIdentity,
} from "../../src/mcp-conformance/server-identity.js";
import {
  MCP_READINESS_IDS,
  READINESS_ERAS,
  type RawHttpCheckContext,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

const ADVICE = "readiness-server-identity";
const SERVER_URL = "http://127.0.0.1:9/mcp";
const IDENTITY = { name: "Hello MCP", version: "0.2.0" };

const stamped = (identity: unknown) => ({
  supportedVersions: ["2026-07-28"],
  capabilities: {},
  _meta: { [SERVER_INFO_META_KEY]: identity },
});

describe("readServerIdentity", () => {
  it("reads the identity from _meta, where 2026-07-28 puts it", () => {
    expect(readServerIdentity(stamped(IDENTITY))).toEqual(IDENTITY);
  });

  it("accepts a top-level serverInfo when _meta has none", () => {
    expect(readServerIdentity({ serverInfo: IDENTITY })).toEqual(IDENTITY);
  });

  it("prefers _meta when both are there", () => {
    expect(
      readServerIdentity({
        ...stamped(IDENTITY),
        serverInfo: { name: "other", version: "9" },
      }),
    ).toEqual(IDENTITY);
  });

  it.each([
    ["no _meta at all", { capabilities: {} }],
    ["a _meta without the key", { _meta: {} }],
  ])("finds none in %s", (_label, payload) => {
    expect(readServerIdentity(payload as Record<string, unknown>)).toBeUndefined();
  });

  it.each([null, "Hello MCP"])(
    "keeps a malformed _meta value %j ahead of the fallback",
    (identity) => {
      expect(
        readServerIdentity({ ...stamped(identity), serverInfo: IDENTITY }),
      ).toBe(identity);
    },
  );
});

describe("isWellFormedIdentity", () => {
  it("wants a string name and a string version", () => {
    expect(isWellFormedIdentity(IDENTITY)).toBe(true);
  });

  it.each([
    ["a number for a name", { name: 5, version: "1" }],
    ["no version", { name: "Hello MCP" }],
    ["no name", { version: "1" }],
    ["nothing", {}],
  ])("refuses %s", (_label, identity) => {
    expect(isWellFormedIdentity(identity)).toBe(false);
  });
});

describe("the Server Identity advice", () => {
  it("is 2026-07-28 advice, with a title", () => {
    expect(MCP_READINESS_IDS).toContain(ADVICE);
    expect(READINESS_ERAS[ADVICE]).toEqual(["modern"]);
    expect(READINESS_CATALOG[ADVICE].title).toBe("Server Identity");
  });

  it.each([
    ["no identity", { capabilities: {} }],
    ["a top-level identity only", { serverInfo: IDENTITY }],
  ] as const)("warns at SHOULD strength for %s", (_label, payload) => {
    const outcome = serverIdentityOutcome(payload);

    expect(outcome).toMatchObject({
      id: ADVICE,
      title: "Server Identity",
      severity: "warning",
      specStrength: "SHOULD",
      details: { metaKey: SERVER_INFO_META_KEY },
    });
    expect((outcome as { message: string }).message).toContain(
      `has no ${SERVER_INFO_META_KEY} in _meta`,
    );
    // A missed SHOULD, not behaviour the spec merely illustrates.
    expect(outcome).not.toHaveProperty("informational");
  });

  it("is met when the result names the server", () => {
    expect(serverIdentityOutcome(stamped(IDENTITY))).toEqual({
      id: ADVICE,
      title: "Server Identity",
      specStrength: "SHOULD",
    });
  });

  it("says nothing about a malformed identity: Server Discover fails that", () => {
    expect(serverIdentityOutcome(stamped({ name: 5 }))).toBeUndefined();
  });
});

describe("when the advice asks the server", () => {
  /** A server that answers every request with `result`, and counts them. */
  function serverAnswering(result: Record<string, unknown> | undefined) {
    const asked: string[] = [];
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id?: unknown;
        method?: string;
      };
      asked.push(body.method ?? String(init?.method));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? null,
          ...(result
            ? { result }
            : { error: { code: -32603, message: "down" } }),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    return { fetchFn, asked };
  }

  function context(
    fetchFn: typeof fetch,
    protocolVersion: "2025-11-25" | "2026-07-28",
    extra: Partial<RawHttpCheckContext> = {},
  ): RawHttpCheckContext {
    const config = normalizeMCPConformanceConfig({
      serverUrl: SERVER_URL,
      fetchFn,
      protocolVersion,
      checkTimeout: 500,
      readinessIds: [ADVICE],
    });
    return { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn, ...extra };
  }

  it("sends one server/discover on 2026-07-28 and reports what it found", async () => {
    const server = serverAnswering({ capabilities: {} });
    const outcomes = await collectRawAdvice(
      context(server.fetchFn, "2026-07-28"),
    );

    expect(server.asked).toEqual(["server/discover"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ id: ADVICE, severity: "warning" });
  });

  it("uses the server/discover answer the run already has", async () => {
    const server = serverAnswering(undefined);
    const fetchSpy = vi.fn(server.fetchFn);
    const outcomes = await collectRawAdvice(
      context(fetchSpy as unknown as typeof fetch, "2026-07-28", {
        discover: {
          status: 200,
          headers: {},
          json: { jsonrpc: "2.0", id: 1, result: stamped(IDENTITY) },
        } as never,
      }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      { id: ADVICE, title: "Server Identity", specStrength: "SHOULD" },
    ]);
  });

  it("asks nothing and says nothing on a 2025 revision", async () => {
    // There the name is `InitializeResult.serverInfo`, a required member.
    const server = serverAnswering({ capabilities: {} });
    const outcomes = await collectRawAdvice(
      context(server.fetchFn, "2025-11-25"),
    );

    expect(server.asked).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it("says nothing when server/discover gives no result to read", async () => {
    const server = serverAnswering(undefined);

    expect(
      await collectRawAdvice(context(server.fetchFn, "2026-07-28")),
    ).toEqual([]);
  });
});

describe("Modern Client Handshake's description", () => {
  it("no longer promises a server identity", () => {
    expect(PROTOCOL_CHECK_CATALOG["modern-client-handshake"].description).toBe(
      "The official client negotiates the modern revision and receives the server's capabilities.",
    );
  });
});
