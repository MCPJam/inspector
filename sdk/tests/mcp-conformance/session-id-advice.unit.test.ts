/**
 * A 2026-07-28 server that sends an `Mcp-Session-Id` header.
 *
 * 2026-07-28 removed protocol-level sessions. For a server that still sends
 * the header it says "An `Mcp-Session-Id` header on a request: ignore it, and
 * do not mint or echo session IDs" (streamable-http.mdx:686-692): a SHOULD.
 * Check 35 (`modern-no-session-id`) failed such a server.
 *
 * These pin the check's verdicts, the No Session Id advice that now reports
 * the header, and that a pass of the check no longer marks the server
 * sessionless on the server-features page.
 */

import { describe, expect, it } from "vitest";
import {
  PROTOCOL_CHECK_CATALOG,
  READINESS_CATALOG,
} from "../../src/conformance-catalog.js";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import { collectRawAdvice } from "../../src/mcp-conformance/readiness.js";
import { noSessionIdOutcome } from "../../src/mcp-conformance/session-id-advice.js";
import {
  MCP_READINESS_IDS,
  READINESS_ERAS,
  type MCPCheckId,
  type RawHttpCheckContext,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import { featuresForCheck } from "../../src/server-features/index.js";

const CHECK: MCPCheckId = "modern-no-session-id";
const ADVICE = "readiness-no-session-id";
const SERVER_URL = "http://127.0.0.1:9/mcp";

const DISCOVER_RESULT = {
  resultType: "complete",
  supportedVersions: ["2026-07-28"],
  capabilities: {},
};

/** A captured exchange, as the raw track records it. */
function exchange(
  status: number,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
) {
  return {
    status,
    headers,
    json: { jsonrpc: "2.0", id: 1, ...payload },
  } as never;
}

/** A 2026-07-28 server that answers everything with `server/discover`'s result. */
function server(options: {
  sessionId?: string;
  status?: number;
  /** Answer with a JSON-RPC error instead of a result. */
  error?: boolean;
}) {
  const asked: Array<{ method: string; sentSessionId: string | null }> = [];
  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: unknown;
      method?: string;
    };
    asked.push({
      method: body.method ?? "?",
      sentSessionId: new Headers(init?.headers as HeadersInit).get(
        "mcp-session-id",
      ),
    });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id ?? null,
        ...(options.error
          ? { error: { code: -32603, message: "down" } }
          : { result: DISCOVER_RESULT }),
      }),
      {
        status: options.status ?? 200,
        headers: {
          "content-type": "application/json",
          ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
        },
      },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}

function context(
  fetchFn: typeof fetch,
  protocolVersion: "2025-11-25" | "2026-07-28" = "2026-07-28",
): RawHttpCheckContext {
  const config = normalizeMCPConformanceConfig({
    serverUrl: SERVER_URL,
    fetchFn,
    protocolVersion,
    checkTimeout: 500,
    readinessIds: [ADVICE],
  });
  return { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn };
}

async function grade(fetchFn: typeof fetch) {
  const results = await runModernChecks(context(fetchFn), new Set([CHECK]));
  expect(results).toHaveLength(1);
  return results[0]!;
}

describe("check 35 on a server that sends a session id", () => {
  it("passes, and lists the session id it saw", async () => {
    // The case in the card: this used to fail.
    const result = await grade(server({ sessionId: "abc-123" }).fetchFn);

    expect(result.status).toBe("passed");
    expect(result.details).toEqual({
      inspectedResponses: 1,
      succeededResponses: 1,
      sessionIds: [{ status: 200, sessionId: "abc-123" }],
    });
  });

  it("passes a server that sends none, with no sessionIds in the details", async () => {
    const result = await grade(server({}).fetchFn);

    expect(result.status).toBe("passed");
    expect(result.details).toEqual({
      inspectedResponses: 1,
      succeededResponses: 1,
    });
  });

  it("still could not run when no exchange succeeded, session id or not", async () => {
    // A 401 that carries a session id used to fail the check. No exchange
    // completed, so there is nothing to grade either way.
    const result = await grade(
      server({ sessionId: "on-a-401", status: 401, error: true }).fetchFn,
    );

    expect([result.status, result.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(result.details).toMatchObject({
      succeededResponses: 0,
      httpStatus: 401,
      sessionIds: [{ status: 401, sessionId: "on-a-401" }],
    });
  });

  it("has a title and description that hold for a server that sends one", () => {
    expect(PROTOCOL_CHECK_CATALOG[CHECK]).toEqual({
      title: "Sessionless Exchange",
      description:
        "A modern request is served without a session. A session id the server sends anyway is reported as advice.",
    });
  });
});

describe("noSessionIdOutcome", () => {
  it("warns, at SHOULD strength, when the answer carries a session id", () => {
    const outcome = noSessionIdOutcome(
      exchange(200, { "mcp-session-id": "abc-123" }, { result: DISCOVER_RESULT }),
    );

    expect(outcome).toMatchObject({
      id: ADVICE,
      title: "No Session Id",
      severity: "warning",
      specStrength: "SHOULD",
      details: { sessionId: "abc-123" },
    });
    expect((outcome as { message: string }).message).toContain(
      'Mcp-Session-Id header ("abc-123")',
    );
    expect(outcome).not.toHaveProperty("informational");
  });

  it("is met when the answer carries none", () => {
    expect(
      noSessionIdOutcome(exchange(200, {}, { result: DISCOVER_RESULT })),
    ).toEqual({ id: ADVICE, title: "No Session Id", specStrength: "SHOULD" });
  });

  it.each([
    ["a JSON-RPC error", exchange(400, { "mcp-session-id": "x" }, { error: { code: -32022, message: "no" } })],
    ["a 401 with no body", { status: 401, headers: { "mcp-session-id": "x" } } as never],
  ])("says nothing about %s: no exchange was served", (_label, result) => {
    expect(noSessionIdOutcome(result)).toBeUndefined();
  });
});

describe("the No Session Id advice", () => {
  it("is 2026-07-28 advice, with a title", () => {
    expect(MCP_READINESS_IDS).toContain(ADVICE);
    expect(READINESS_ERAS[ADVICE]).toEqual(["modern"]);
    expect(READINESS_CATALOG[ADVICE].title).toBe("No Session Id");
  });

  it("sends one server/discover, without a session id, and reports the header", async () => {
    const { fetchFn, asked } = server({ sessionId: "minted" });
    const outcomes = await collectRawAdvice(context(fetchFn));

    expect(asked).toEqual([{ method: "server/discover", sentSessionId: null }]);
    expect(outcomes).toEqual([
      expect.objectContaining({ id: ADVICE, severity: "warning" }),
    ]);
  });

  it("uses the server/discover answer the run already has", async () => {
    const { fetchFn, asked } = server({});
    const outcomes = await collectRawAdvice({
      ...context(fetchFn),
      discover: exchange(200, { "mcp-session-id": "from-the-gate" }, { result: DISCOVER_RESULT }),
    });

    expect(asked).toEqual([]);
    expect(outcomes).toEqual([
      expect.objectContaining({ id: ADVICE, details: { sessionId: "from-the-gate" } }),
    ]);
  });

  it("asks nothing and says nothing on a 2025 revision, which has sessions", async () => {
    const { fetchFn, asked } = server({ sessionId: "legacy-session" });

    expect(await collectRawAdvice(context(fetchFn, "2025-11-25"))).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe("the server-features page", () => {
  it("no longer takes a pass of check 35 as proof the server is sessionless", () => {
    // It passes whether or not a session id was sent, so it cannot show the
    // "No sessions" row. That row keeps its own probe of the header.
    expect(featuresForCheck(`protocol:${CHECK}` as never)).toEqual([]);
  });
});
