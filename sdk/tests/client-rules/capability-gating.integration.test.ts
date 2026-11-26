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
 * Two checks send undeclared methods ON PURPOSE (that is what they test), so
 * their traffic is excused; see `DELIBERATE`.
 */

import { beforeAll, describe, expect } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CHECK_ERAS, MCP_CHECK_IDS } from "../../src/mcp-conformance/index.js";
import {
  buildFetchCorpus,
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

/** Checks that send an undeclared or removed method on purpose, and why. */
const DELIBERATE: Record<string, string> = {
  "modern-removed-methods-not-found":
    "sends logging/setLevel and resources/subscribe to prove 2026-07-28 removed them",
  "protocol-invalid-method-error": "sends a method that does not exist",
};

/** Checks known to break a rule, by rule id. Absent means none does. */
const KNOWN: Record<string, string[]> = {};

function undeclaredUse(
  request: WireRequest,
  prefixes: readonly string[],
): string | undefined {
  if (request.check in DELIBERATE) return undefined;
  const method = rpcMethodOf(request);
  if (!method) return undefined;
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
    () => {
      expect(legacy.requests.some((request) => rpcMethodOf(request) === "tools/list")).toBe(true);
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
    () => {
      expect(modern.requests.some((request) => rpcMethodOf(request) === "tools/list")).toBe(true);
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
