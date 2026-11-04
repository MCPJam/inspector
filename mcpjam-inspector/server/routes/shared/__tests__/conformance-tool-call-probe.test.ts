import { describe, expect, it, vi } from "vitest";

const { configs } = vi.hoisted(() => ({ configs: [] as unknown[] }));

vi.mock("@mcpjam/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/sdk")>()),
  MCPConformanceTest: class {
    constructor(config: unknown) {
      configs.push(config);
    }
    run() {
      return Promise.resolve({ passed: true, checks: [] });
    }
  },
}));

import { runProtocolConformance } from "../conformance.js";

const BASE = {
  serverUrl: "https://example.test/mcp",
  protocolVersion: "2026-07-28",
} as Parameters<typeof runProtocolConformance>[0];

describe("runProtocolConformance tool-call probe", () => {
  it("sends the named tool to the SDK as its one tools/call fixture", async () => {
    configs.length = 0;
    await runProtocolConformance({
      ...BASE,
      toolCallProbe: { toolName: "weather", arguments: { city: "Lima" } },
    });
    expect(configs[0]).toMatchObject({
      fixtures: {
        toolCalls: [{ toolName: "weather", arguments: { city: "Lima" } }],
      },
    });
  });

  it("sends no fixtures when no tool is named", async () => {
    configs.length = 0;
    await runProtocolConformance(BASE);
    expect(configs[0]).not.toHaveProperty("fixtures");
  });
});
