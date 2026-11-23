/**
 * What the raw 2025-era probes do when `initialize` is answered with a protocol
 * version MCPJam does not support.
 *
 * "If the client does not support the version in the server's response, it
 * SHOULD disconnect." The raw probes build their own session by hand, so they
 * have to make that decision themselves: after such an answer they send no
 * more requests on the session, and the checks that needed those requests
 * report that they could not run.
 *
 * Driven with a scripted `fetch`, so every request the probes send is counted.
 */

import { describe, expect, it } from "vitest";
import { runProtocolChecks } from "../../src/mcp-conformance/checks/protocol.js";
import { runTransportChecks } from "../../src/mcp-conformance/checks/transport.js";
import { legacyInitialize } from "../../src/mcp-conformance/raw-http.js";
import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

type LegacyVersion = "2025-11-25" | "2025-06-18" | "2025-03-26";
const LEGACY_VERSIONS: LegacyVersion[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];
const UNSUPPORTED = "2099-01-01";

/** One line per request the probes sent, e.g. `POST initialize`, `GET`. */
type Sent = string[];

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/**
 * A correct 2025 server, except for what `initialize` answers. `answer` is the
 * whole `initialize` response when given; otherwise it is a normal result
 * carrying `answeredVersion`.
 */
function scriptedServer(options: {
  sent: Sent;
  answeredVersion?: string;
  initializeAnswer?: () => Response;
}): typeof fetch {
  return async (_input, init) => {
    const httpMethod = init?.method ?? "GET";
    if (httpMethod !== "POST") {
      options.sent.push(httpMethod);
      return new Response(null, { status: 405 });
    }
    const body = JSON.parse(String(init?.body));
    options.sent.push(`POST ${body.method}`);

    switch (body.method) {
      case "initialize":
        return (
          options.initializeAnswer?.() ??
          json(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                ...(options.answeredVersion === undefined
                  ? {}
                  : { protocolVersion: options.answeredVersion }),
                capabilities: { tools: {} },
                serverInfo: { name: "scripted", version: "1" },
              },
            },
            { headers: { "mcp-session-id": "session-1" } }
          )
        );
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
      default:
        return json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  };
}

function context(
  fetchFn: typeof fetch,
  protocolVersion: LegacyVersion = "2025-11-25"
): RawHttpCheckContext {
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://legacy.example.test/mcp",
    protocolVersion,
    checkTimeout: 500,
    fetchFn,
  });
  return { config, serverUrl: config.serverUrl, fetchFn: config.fetchFn };
}

function byId(results: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = results.find((result) => result.id === id);
  if (!found) throw new Error(`check ${id} not in results`);
  return found;
}

const STOP_MESSAGE = `The server answered initialize with protocol version "${UNSUPPORTED}", which MCPJam does not support. A client should disconnect in that case, so this check sent nothing more and could not run.`;

/** The checks that need more requests on the session after `initialize`. */
const NEEDS_SESSION: MCPCheckId[] = [
  "server-accepts-multiple-post-streams",
  "server-sse-streams-functional",
  "notification-post-accepted",
  "get-stream-or-405",
];
/** The checks that only read the `initialize` answer. */
const READS_INITIALIZE: MCPCheckId[] = [
  "server-sse-polling-session",
  "session-id-visible-ascii",
  "post-response-content-type",
];

describe("legacyInitialize reports a version MCPJam does not support", () => {
  it("names the answered version when it is not a known one", async () => {
    const sent: Sent = [];
    const result = await legacyInitialize(
      context(scriptedServer({ sent, answeredVersion: UNSUPPORTED }))
    );
    expect(result.unsupportedVersion).toBe(UNSUPPORTED);
    expect(result.sessionId).toBe("session-1");
  });

  it.each([
    ["the version that was asked for", "2025-11-25"],
    ["an older version MCPJam also supports", "2025-06-18"],
    ["no version at all", undefined],
  ])("reports nothing when the server answers %s", async (_label, answered) => {
    const result = await legacyInitialize(
      context(scriptedServer({ sent: [], answeredVersion: answered }))
    );
    expect(result.unsupportedVersion).toBeUndefined();
  });

  it("reports nothing when initialize is refused", async () => {
    const result = await legacyInitialize(
      context(
        scriptedServer({
          sent: [],
          initializeAnswer: () =>
            json(
              {
                jsonrpc: "2.0",
                id: 1,
                error: {
                  code: -32602,
                  message: "Unsupported protocol version",
                },
              },
              { status: 400 }
            ),
        })
      )
    );
    expect(result.unsupportedVersion).toBeUndefined();
  });
});

describe.each(LEGACY_VERSIONS)(
  "an unsupported version on a %s run",
  (version) => {
    it("Invalid Method Error sends only initialize and could not run", async () => {
      const sent: Sent = [];
      const results = await runProtocolChecks(
        context(
          scriptedServer({ sent, answeredVersion: UNSUPPORTED }),
          version
        ),
        new Set<MCPCheckId>(["protocol-invalid-method-error"])
      );

      expect(sent).toEqual(["POST initialize"]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        status: "skipped",
        skipReason: "could-not-run",
        details: { negotiatedProtocolVersion: UNSUPPORTED },
      });
      expect(results[0].error?.message).toBe(STOP_MESSAGE);
    });

    it("the transport checks send nothing on the session but its DELETE", async () => {
      const sent: Sent = [];
      const results = await runTransportChecks(
        context(
          scriptedServer({ sent, answeredVersion: UNSUPPORTED }),
          version
        ),
        new Set<MCPCheckId>([...READS_INITIALIZE, ...NEEDS_SESSION])
      );

      // Ending the session is how a Streamable HTTP client disconnects.
      expect(sent).toEqual(["POST initialize", "DELETE"]);
      for (const id of NEEDS_SESSION) {
        expect(byId(results, id)).toMatchObject({
          status: "skipped",
          skipReason: "could-not-run",
          details: { negotiatedProtocolVersion: UNSUPPORTED },
        });
        expect(byId(results, id).error?.message).toBe(STOP_MESSAGE);
      }
      // These read the initialize answer and need nothing after it.
      for (const id of READS_INITIALIZE) {
        expect(byId(results, id).status).toBe("passed");
      }
    });
  }
);

describe("a supported version leaves the probes as they were", () => {
  it("Invalid Method Error sends its probe and passes", async () => {
    const sent: Sent = [];
    const results = await runProtocolChecks(
      context(scriptedServer({ sent, answeredVersion: "2025-11-25" })),
      new Set<MCPCheckId>(["protocol-invalid-method-error"])
    );

    expect(sent).toEqual([
      "POST initialize",
      "POST nonexistent/method_that_does_not_exist",
    ]);
    expect(results[0].status).toBe("passed");
  });

  it("the transport checks go on to use the session", async () => {
    const sent: Sent = [];
    const results = await runTransportChecks(
      context(scriptedServer({ sent, answeredVersion: "2025-06-18" })),
      new Set<MCPCheckId>(NEEDS_SESSION)
    );

    expect(sent.filter((line) => line === "POST tools/list")).toHaveLength(3);
    expect(sent).toContain("POST notifications/initialized");
    expect(sent).toContain("GET");
    for (const id of NEEDS_SESSION) {
      expect(byId(results, id).skipReason).not.toBe("could-not-run");
    }
  });
});
