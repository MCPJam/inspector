/**
 * Capabilities Consistent (check 5) against a real 2025-11-25 server.
 *
 * "Servers that support tools MUST declare the tools capability" (2025-11-25
 * server/tools.mdx:38, and the same for prompts and resources). The official
 * client never lists what the server did not declare, so the check asks for
 * those listings itself: a server that answers one with items serves a
 * feature it did not declare (catalog 5.F1).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  MCPConformanceTest,
  type MCPCheckId,
} from "../../src/mcp-conformance/index.js";
import {
  serveCapabilityServer,
  type CapabilityServerOptions,
} from "../support/capability-server.js";

const ID: MCPCheckId = "capabilities-consistent";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function run(options: CapabilityServerOptions) {
  const served = await serveCapabilityServer(options);
  cleanups.push(served.close);
  const result = await new MCPConformanceTest({
    serverUrl: served.url,
    protocolVersion: "2025-11-25",
    checkTimeout: 5_000,
    checkIds: [ID],
    readinessIds: [],
  }).run();
  const check = result.checks.find((entry) => entry.id === ID);
  if (!check) throw new Error(`no result for ${ID}`);
  return {
    check,
    sent: (method: string) =>
      served.log.filter((line) => line === `POST ${method}`).length,
  };
}

describe("capabilities-consistent on 2025-11-25", () => {
  it("passes a server whose undeclared listings answer Method not found", async () => {
    const { check, sent } = await run({ capabilities: { tools: {} } });

    expect(check.status).toBe("passed");
    // The undeclared ones were asked, so the pass is evidence, not silence.
    expect(sent("prompts/list")).toBe(1);
    expect(sent("resources/list")).toBe(1);
    expect(sent("resources/templates/list")).toBe(1);
    expect(check.details).toMatchObject({
      undeclaredListings: {
        "prompts/list": { outcome: "refused", httpStatus: 404 },
        "resources/list": { outcome: "refused", httpStatus: 404 },
      },
    });
  });

  it("passes when Method not found comes on HTTP 200", async () => {
    const { check } = await run({
      capabilities: { tools: {} },
      undeclaredStatus: 200,
    });

    expect(check.status).toBe("passed");
    expect(check.details).toMatchObject({
      undeclaredListings: {
        "prompts/list": { outcome: "refused", code: -32601 },
      },
    });
  });

  it.each([
    ["tools/list", "tools", { prompts: {} }],
    ["prompts/list", "prompts", { tools: {} }],
    ["resources/list", "resources", { tools: {} }],
    ["resources/templates/list", "resources", { tools: {} }],
  ] as const)(
    "fails a server that serves %s without declaring %s (catalog 5.F1)",
    async (method, capability, capabilities) => {
      const { check } = await run({
        capabilities,
        serveUndeclared: [method],
      });

      expect(check.status).toBe("failed");
      expect(check.error?.message).toContain(
        `${method} returned 1 item(s) but the server does not advertise capabilities.${capability}`
      );
    }
  );

  it("does not fail a declared listing that errors: only 2026-07-28 requires the answer", async () => {
    const { check } = await run({
      capabilities: { tools: {} },
      listErrors: { "tools/list": -32603 },
    });

    expect(check.status).toBe("passed");
  });
});
