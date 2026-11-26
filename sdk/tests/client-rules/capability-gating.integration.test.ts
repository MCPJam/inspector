/**
 * Client rules about capability negotiation: the client only uses what the
 * server declared.
 *
 * The server here declares tools and nothing else: no prompts, resources,
 * logging or completions. Every conformance check runs once against it in
 * each era, and the test asserts that nothing on the wire asks for an
 * undeclared capability. The localhost security checks are left out: they
 * dial `node:http` straight at the URL, and this fixture has no socket.
 *
 * One check sends methods 2026-07-28 removed ON PURPOSE, to see the server
 * answer -32601; only those methods are excused (see `DELIBERATE`), and the
 * rest of that check's traffic is judged like any other.
 */

import { beforeAll, describe, expect } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CHECK_ERAS, MCP_CHECK_IDS } from "../../src/mcp-conformance/index.js";
import {
  buildFetchCorpus,
  exercised,
  expectKnownViolations,
  rpcMethodOf,
  ruleTest,
  violationsByCheck,
  type FetchCorpus,
  type WireRequest,
} from "./harness.js";

function buildToolsOnlyServer(): McpServer {
  const server = new McpServer(
    { name: "client-rules-tools-only", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "echo",
    { description: "Echoes the message.", inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: "text" as const, text: message }] }),
  );
  return server;
}

const LEGACY_CHECKS = MCP_CHECK_IDS.filter(
  (id) => CHECK_ERAS[id].includes("legacy") && !id.startsWith("localhost-host-"),
);
const MODERN_CHECKS = MCP_CHECK_IDS.filter((id) => CHECK_ERAS[id].includes("modern"));

/**
 * Methods a check sends on purpose, by check. These are removed from
 * 2026-07-28, so sending them is a probe for -32601, not use of a capability.
 */
const DELIBERATE: Record<string, readonly string[]> = {
  "modern-removed-methods-not-found": [
    "logging/setLevel",
    "resources/subscribe",
    "resources/unsubscribe",
  ],
};

/** Checks known to break a rule, by rule id. Absent means none does. */
const KNOWN: Record<string, string[]> = {};

function undeclaredUse(
  request: WireRequest,
  prefixes: readonly string[],
): string | undefined {
  const method = rpcMethodOf(request);
  if (!method) return undefined;
  if (DELIBERATE[request.check]?.includes(method)) return undefined;
  return prefixes.some((prefix) => method === prefix || method.startsWith(`${prefix}/`))
    ? `sent ${method}`
    : undefined;
}

let legacy: FetchCorpus;
let modern: FetchCorpus;

beforeAll(async () => {
  const handler = createMcpHandler(() => buildToolsOnlyServer());
  legacy = await buildFetchCorpus(LEGACY_CHECKS, handler, { protocolVersion: "2025-11-25" });
  modern = await buildFetchCorpus(MODERN_CHECKS, handler, { protocolVersion: "2026-07-28" });
}, 180_000);

describe("a server that declares tools only", () => {
  ruleTest(
    "C008",
    "no check uses logging, completions, prompts or resources (2025-11-25)",
    (context) => {
      exercised(
        context,
        legacy.requests.some((request) => rpcMethodOf(request) === "tools/list"),
        "the checks never reached the server",
      );
      expectKnownViolations(
        violationsByCheck(legacy.requests, (request) =>
          undeclaredUse(request, ["logging", "completion", "prompts", "resources"]),
        ),
        KNOWN.C008,
      );
    },
  );

  ruleTest(
    "C008",
    "no check uses logging, completions, prompts or resources (2026-07-28)",
    (context) => {
      exercised(
        context,
        modern.requests.some((request) => rpcMethodOf(request) === "tools/list"),
        "the checks never reached the server",
      );
      expectKnownViolations(
        violationsByCheck(modern.requests, (request) =>
          undeclaredUse(request, ["logging", "completion", "prompts", "resources"]),
        ),
        KNOWN.C008_MODERN,
      );
    },
  );

  ruleTest("C020", "no check sends prompts/* when prompts were not declared", () => {
    expectKnownViolations(
      violationsByCheck([...legacy.requests, ...modern.requests], (request) =>
        undeclaredUse(request, ["prompts"]),
      ),
      KNOWN.C020,
    );
  });
});
