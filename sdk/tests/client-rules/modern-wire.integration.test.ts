/**
 * Client rules for the 2026-07-28 (modern) wire, proven on what MCPJam sends.
 *
 * Every modern-era conformance check runs once, pinned to 2026-07-28, against
 * in-process `createMcpHandler` fixtures. Each request is recorded at the fetch
 * seam, tagged with the check that sent it. The modern era has no `node:http`
 * probe, so the fetch seam sees both stacks: the official client the
 * client-backed checks connect with, and the raw modern probes.
 *
 * Extra runs cover what the plain fixture cannot reach: names that must be
 * Base64-encoded into `Mcp-Name`, a server that logs on request, a narrow set
 * of subscribable capabilities, and one full run with every modern check at
 * once (the way the product runs them) for request-id reuse.
 *
 * A few probes break one header ON PURPOSE (that is what their check tests).
 * `DELIBERATE_HEADERS` names each by request id and header; only that header
 * on that request is excused, and everything else is judged as usual.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CHECK_ERAS,
  MCP_CHECK_IDS,
  MCP_LOG_LEVELS,
  MCPConformanceTest,
  type MCPCheckId,
} from "../../src/mcp-conformance/index.js";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import { createFixtureHandler } from "../support/dual-era-fixture.js";
import {
  createLoggingFixtureHandler,
  EMIT_LOG_TOOL_NAME,
} from "../support/logging-fixture.js";
import { createSubscriptionFixtureHandler } from "../support/subscription-fixture.js";
import { mcpNameProblem } from "../support/mcp-name-validation.js";
import {
  buildFetchCorpus,
  exercised,
  expectKnownViolations,
  isRpcRequest,
  mayRule,
  overlaps,
  recordingFetch,
  rpcMethodOf,
  rpcOf,
  ruleTest,
  runOneCheck,
  violationsByCheck,
  type FetchCorpus,
  type WireRequest,
} from "./harness.js";

const MODERN_CHECKS: string[] = MCP_CHECK_IDS.filter((id) =>
  CHECK_ERAS[id].includes("modern"),
);

/**
 * Probes that break one header on purpose, by check: the probe's request id
 * (see checks/modern.ts) and the header it breaks.
 */
const DELIBERATE_HEADERS: Record<string, { id: number; header: string }> = {
  "modern-missing-method-header-rejected": { id: 7250, header: "mcp-method" },
  "modern-protocol-version-header-mismatch": { id: 7200, header: "mcp-protocol-version" },
  "modern-unsupported-version-error": { id: 7500, header: "mcp-protocol-version" },
  "modern-name-header-mismatch": { id: 7400, header: "mcp-name" },
};

/** Methods 2026-07-28 removed, which this check sends on purpose to see -32601. */
const REMOVED_METHODS_CHECK = "modern-removed-methods-not-found";

function brokenOnPurpose(request: WireRequest, header: string): boolean {
  const probe = DELIBERATE_HEADERS[request.check];
  return probe !== undefined && probe.header === header && rpcOf(request)?.id === probe.id;
}

const NAMED_METHODS = new Set(["tools/call", "prompts/get", "resources/read"]);

/** Checks known to break a rule, by rule id. Absent means none does. */
const KNOWN: Record<string, string[]> = {};

const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const LOG_LEVEL_KEY = "io.modelcontextprotocol/logLevel";

// Names a raw copy into a header would get wrong: non-ASCII, and a plain-ASCII
// name that looks like the Base64 sentinel. The resource stays ASCII: the
// server SDK percent-encodes a non-ASCII URI when it registers it, so it could
// not serve one back by its listed name.
const NAMED_TOOL = "hello-ñandú";
const NAMED_PROMPT = "=?base64?aGVsbG8=?=";
const NAMED_RESOURCE = "test://named-resource";

function buildNamedServer(): McpServer {
  const server = new McpServer(
    { name: "client-rules-named-fixture", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );
  server.registerTool(
    NAMED_TOOL,
    {
      description: "A tool whose name needs Base64 in Mcp-Name.",
      inputSchema: {},
      outputSchema: { greeting: z.string() },
    },
    async () => ({
      content: [{ type: "text" as const, text: "hola" }],
      structuredContent: { greeting: "hola" },
    }),
  );
  server.registerPrompt(
    NAMED_PROMPT,
    { description: "A prompt whose name looks like the Base64 sentinel." },
    async () => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: "hello" } },
      ],
    }),
  );
  server.registerResource(
    "named",
    NAMED_RESOURCE,
    { description: "A plain resource, so resources/read is in the mix.", mimeType: "text/plain" },
    async () => ({
      contents: [{ uri: NAMED_RESOURCE, mimeType: "text/plain", text: "sol" }],
    }),
  );
  return server;
}

function metaOf(request: WireRequest): Record<string, unknown> | undefined {
  const meta = rpcOf(request)?.params?._meta;
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : undefined;
}

/** The name a named request targets: `params.name`, or `params.uri` for resources/read. */
function targetOf(request: WireRequest): string {
  const params = rpcOf(request)!.params ?? {};
  return String(params.name ?? params.uri);
}

let main: FetchCorpus;
let named: FetchCorpus;

beforeAll(async () => {
  main = await buildFetchCorpus(
    MODERN_CHECKS,
    createFixtureHandler({ logging: true, apps: true }),
    { protocolVersion: "2026-07-28" },
  );
  named = await buildFetchCorpus(
    MODERN_CHECKS,
    createMcpHandler(() => buildNamedServer()),
    {
      protocolVersion: "2026-07-28",
      fixtures: {
        toolCalls: [{ toolName: NAMED_TOOL }],
        promptGets: [{ promptName: NAMED_PROMPT }],
      },
    },
  );
}, 180_000);

describe("modern wire corpus (2026-07-28, in-process fixtures)", () => {
  it("(control) every modern check sent traffic, and the Mcp-Name judge can fail", () => {
    for (const check of MODERN_CHECKS) {
      expect(main.requests.some((request) => request.check === check), check).toBe(true);
    }
    expect(mcpNameProblem(NAMED_TOOL, NAMED_TOOL)).toBe(
      "Mcp-Name has characters that are not visible ASCII",
    );
    expect(mcpNameProblem(NAMED_PROMPT, NAMED_PROMPT)).toBe(
      "Mcp-Name header does not match",
    );
  });

  mayRule(
    "C011",
    "MCPJam does call server/discover first on a 2026-07-28 run",
  );

  ruleTest("C022", "every modern request id is a string or an integer", () => {
    expectKnownViolations(
      violationsByCheck([...main.requests, ...named.requests].filter(isRpcRequest), (request) => {
        const id = rpcOf(request)!.id;
        return typeof id === "string" || Number.isInteger(id)
          ? undefined
          : `${rpcMethodOf(request)} had id ${JSON.stringify(id)}`;
      }),
      KNOWN.C022,
    );
  });

  ruleTest("C064", "no modern request id is null", () => {
    expectKnownViolations(
      violationsByCheck(
        [...main.requests, ...named.requests].filter(
          (request) => rpcMethodOf(request) !== undefined,
        ),
        (request) => {
          const rpc = rpcOf(request)!;
          return rpc.hasId && rpc.id === null ? `${rpc.method} had id null` : undefined;
        },
      ),
      KNOWN.C064,
    );
  });

  ruleTest("C029", "on 2026-07-28 too, every POST carries one JSON-RPC message", () => {
    expectKnownViolations(
      violationsByCheck(
        [...main.requests, ...named.requests].filter((request) => request.httpMethod === "POST"),
        (request) => (Array.isArray(request.body) ? "sent a JSON array (batch)" : undefined),
      ),
      KNOWN.C029,
    );
  });

  ruleTest(
    "C033",
    "every modern POST request carries MCP-Protocol-Version and Mcp-Method, plus Mcp-Name when it names a target",
    () => {
      // The required standard headers must be present. That their values match
      // the body is a separate rule (C217 and friends), not this one.
      expectKnownViolations(
        violationsByCheck(
          [...main.requests, ...named.requests].filter(
            (request) => request.httpMethod === "POST" && isRpcRequest(request),
          ),
          (request) => {
            const method = rpcMethodOf(request)!;
            const required = ["mcp-protocol-version", "mcp-method"];
            if (NAMED_METHODS.has(method)) required.push("mcp-name");
            const missing = required.filter(
              (header) => !request.headers[header] && !brokenOnPurpose(request, header),
            );
            return missing.length > 0 ? `${method} had no ${missing.join(", ")}` : undefined;
          },
        ),
        KNOWN.C033,
      );
    },
  );

  ruleTest(
    "C034",
    "after server/discover, every request uses one of the versions it listed",
    () => {
      const problems = new Map<string, string>();
      for (const check of MODERN_CHECKS) {
        const requests = main.requests.filter((request) => request.check === check);
        const discover = requests.find(
          (request) =>
            rpcMethodOf(request) === "server/discover" && request.responseJson !== undefined,
        );
        const supported = (discover?.responseJson as { result?: { supportedVersions?: unknown } })
          ?.result?.supportedVersions;
        if (!discover || !Array.isArray(supported)) continue;
        for (const request of requests.slice(requests.indexOf(discover) + 1)) {
          if (brokenOnPurpose(request, "mcp-protocol-version")) continue;
          const version = request.headers["mcp-protocol-version"];
          if (!supported.includes(version)) {
            problems.set(check, `${rpcMethodOf(request)} used ${version}, server listed ${JSON.stringify(supported)}`);
            break;
          }
        }
      }
      expectKnownViolations(problems, KNOWN.C034);
    },
  );

  ruleTest(
    "C054",
    "subscriptions go through subscriptions/listen, never resources/subscribe",
    (context) => {
      exercised(
        context,
        main.requests.some((request) => rpcMethodOf(request) === "subscriptions/listen"),
        "no check subscribed",
      );
      expectKnownViolations(
        violationsByCheck(
          main.requests.filter((request) => request.check !== REMOVED_METHODS_CHECK),
          (request) =>
            ["resources/subscribe", "resources/unsubscribe"].includes(rpcMethodOf(request) ?? "")
              ? `sent ${rpcMethodOf(request)}`
              : undefined,
        ),
        KNOWN.C054,
      );
    },
  );

  ruleTest(
    "C066",
    "no modern request declares the deprecated roots capability",
    (context) => {
      const declaring = [...main.requests, ...named.requests].filter(
        (request) => metaOf(request)?.[CLIENT_CAPABILITIES_KEY] !== undefined,
      );
      exercised(context, declaring.length > 0, "no request declared client capabilities");
      expectKnownViolations(
        violationsByCheck(declaring, (request) =>
          "roots" in (metaOf(request)![CLIENT_CAPABILITIES_KEY] as object)
            ? `${rpcMethodOf(request)} declared roots`
            : undefined,
        ),
        KNOWN.C066,
      );
    },
  );

  ruleTest(
    "C067",
    "no modern request declares the deprecated sampling capability",
    (context) => {
      const declaring = [...main.requests, ...named.requests].filter(
        (request) => metaOf(request)?.[CLIENT_CAPABILITIES_KEY] !== undefined,
      );
      exercised(context, declaring.length > 0, "no request declared client capabilities");
      expectKnownViolations(
        violationsByCheck(declaring, (request) =>
          "sampling" in (metaOf(request)![CLIENT_CAPABILITIES_KEY] as object)
            ? `${rpcMethodOf(request)} declared sampling`
            : undefined,
        ),
        KNOWN.C067,
      );
    },
  );
});

describe("Mcp-Name encoding (names that cannot go into a header as they are)", () => {
  ruleTest(
    "C048",
    "the raw probes put a decodable, visible-ASCII Mcp-Name on every named request",
    (context) => {
      const requests = named.requests.filter(
        (request) =>
          NAMED_METHODS.has(rpcMethodOf(request) ?? "") && !brokenOnPurpose(request, "mcp-name"),
      );
      const targets = new Set(requests.map(targetOf));
      exercised(
        context,
        targets.has(NAMED_TOOL) && targets.has(NAMED_PROMPT),
        "the probes never named the tool or prompt that need Base64",
      );
      expectKnownViolations(
        violationsByCheck(requests, (request) => {
          const problem = mcpNameProblem(request.headers["mcp-name"], targetOf(request));
          return problem ? `${rpcMethodOf(request)} ${targetOf(request)}: ${problem}` : undefined;
        }),
        KNOWN.C048,
      );
    },
  );

  ruleTest(
    "C048",
    "the official client puts a decodable, visible-ASCII Mcp-Name on every named request",
    async () => {
      const handler = createMcpHandler(() => buildNamedServer());
      const sent: WireRequest[] = [];
      const manager = new MCPClientManager();
      try {
        await manager.connectToServer("named", {
          url: "http://localhost/mcp",
          mcpProtocolVersion: "2026-07-28",
          baseFetch: recordingFetch((request) => handler.fetch(request), sent, () => "client"),
          timeout: 10_000,
        });
        await manager.executeTool("named", NAMED_TOOL, {});
        await manager.getPrompt("named", { name: NAMED_PROMPT });
        await manager.readResource("named", { uri: NAMED_RESOURCE });
      } finally {
        await manager.disconnectAllServers().catch(() => {});
      }
      const requests = sent.filter((request) => NAMED_METHODS.has(rpcMethodOf(request) ?? ""));
      expect(new Set(requests.map(targetOf))).toEqual(
        new Set([NAMED_TOOL, NAMED_PROMPT, NAMED_RESOURCE]),
      );
      for (const request of requests) {
        expect(
          mcpNameProblem(request.headers["mcp-name"], targetOf(request)),
          `${rpcMethodOf(request)} ${targetOf(request)}`,
        ).toBeUndefined();
      }
    },
  );
});

describe("per-request log level (2026-07-28 logging)", () => {
  ruleTest(
    "C058",
    "to get logs for a request, the client puts a log level in that request's _meta",
    async (context) => {
      const sent: WireRequest[] = [];
      const handler = createLoggingFixtureHandler({ mode: "conforming" });
      await runOneCheck("modern-logs-require-log-level", {
        serverUrl: "http://localhost/mcp",
        protocolVersion: "2026-07-28",
        logProbe: { toolName: EMIT_LOG_TOOL_NAME },
        fetchFn: recordingFetch((request) => handler.fetch(request), sent, () => "logs"),
      });
      // The check asks for logs once (and once deliberately without asking).
      const withLevel = sent.filter(
        (request) =>
          rpcMethodOf(request) === "tools/call" && metaOf(request)?.[LOG_LEVEL_KEY] !== undefined,
      );
      exercised(context, withLevel.length > 0, "the logging check never asked for logs");
      for (const request of withLevel) {
        expect(MCP_LOG_LEVELS).toContain(metaOf(request)![LOG_LEVEL_KEY]);
      }
    },
  );
});

describe("subscriptions/listen (2026-07-28 subscriptions)", () => {
  let listens: WireRequest[];

  beforeAll(async () => {
    const sent: WireRequest[] = [];
    // Advertise only two of the four subscribable things.
    const handler = createSubscriptionFixtureHandler({
      capabilities: { promptsListChanged: false, resourcesSubscribe: false },
    });
    for (const check of [
      "modern-subscription-filter-and-tagging",
      "modern-subscription-ack-precedes-notifications",
    ]) {
      await runOneCheck(check, {
        serverUrl: "http://localhost/mcp",
        protocolVersion: "2026-07-28",
        fetchFn: recordingFetch((request) => handler.fetch(request), sent, () => check),
      });
    }
    listens = sent.filter((request) => rpcMethodOf(request) === "subscriptions/listen");
  }, 60_000);

  ruleTest("C060", "every subscriptions/listen carries a notifications filter", (context) => {
    exercised(context, listens.length > 0, "no subscriptions/listen was sent");
    for (const listen of listens) {
      const filter = rpcOf(listen)!.params?.notifications;
      expect(filter && typeof filter === "object" && !Array.isArray(filter), listen.check).toBe(true);
    }
  });

  mayRule(
    "C061",
    "MCPJam does leave out the filter fields for things the server does not offer",
  );

  ruleTest(
    "C062",
    "over HTTP the client ends a subscription by closing its stream",
    (context) => {
      exercised(context, listens.length > 0, "no subscriptions/listen was sent");
      for (const listen of listens) {
        expect(listen.abortedAt, `${listen.check}: stream was never closed by the client`).toBeDefined();
      }
    },
  );

  mayRule(
    "C063",
    "MCPJam does: the subscription coordinator re-listens after a stream drops without its final result",
  );
});

describe("request ids in one full run (every modern check at once)", () => {
  ruleTest(
    "C065",
    "no request id is reused while a request with that id is still outstanding",
    async () => {
      const inner = createMcpHandler(() => buildNamedServer());
      const sent: WireRequest[] = [];
      // A small delay on every answer keeps requests from the families that
      // run at the same time outstanding together, so a clash would show.
      const slow = async (request: Request) => {
        await new Promise((wait) => setTimeout(wait, 15));
        return inner.fetch(request);
      };
      await new MCPConformanceTest({
        serverUrl: "http://localhost/mcp",
        protocolVersion: "2026-07-28",
        checkIds: MODERN_CHECKS as MCPCheckId[],
        readinessIds: [],
        checkTimeout: 5_000,
        __suppressTelemetry: true,
        fixtures: {
          toolCalls: [{ toolName: NAMED_TOOL }],
          promptGets: [{ promptName: NAMED_PROMPT }],
        },
        fetchFn: recordingFetch(slow, sent, () => "full-run"),
      }).run();
      const requests = sent.filter(isRpcRequest);
      const clashes: string[] = [];
      requests.forEach((a, index) => {
        for (const b of requests.slice(index + 1)) {
          if (JSON.stringify(rpcOf(a)!.id) === JSON.stringify(rpcOf(b)!.id) && overlaps(a, b)) {
            clashes.push(`id ${JSON.stringify(rpcOf(a)!.id)}: ${rpcMethodOf(a)} and ${rpcMethodOf(b)}`);
          }
        }
      });
      expect(clashes, clashes.join("\n")).toEqual(KNOWN.C065 ?? []);
    },
    60_000,
  );
});
