import { afterEach, describe, expect, it, vi } from "vitest";

const { configs } = vi.hoisted(() => ({
  configs: [] as Array<{ suite: string; config: unknown }>,
}));

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  // Each stand-in records the config the route hands the SDK and finishes
  // at once, so no suite ever dials anything.
  const recording = (suite: string, result: unknown) =>
    class {
      constructor(config: unknown) {
        configs.push({ suite, config });
      }
      run() {
        return Promise.resolve(result);
      }
    };
  return {
    ...actual,
    MCPConformanceTest: recording("protocol", { passed: true, checks: [] }),
    MCPAppsConformanceTest: recording("apps", { passed: true, checks: [] }),
    MCPTasksConformanceTest: recording("tasks", { passed: true, checks: [] }),
    OAuthConformanceTest: recording("oauth", { passed: true, steps: [] }),
  };
});

import {
  runAppsConformance,
  runProtocolConformance,
  runTasksConformance,
  startOAuthConformance,
} from "../conformance.js";
import { clearAllSessions } from "../../../services/conformance-oauth-sessions.js";

const URL = "https://example.test/mcp";

afterEach(() => {
  configs.length = 0;
  clearAllSessions();
});

// The browser sends one `conformance_run_triggered` for the whole UI run.
// Each suite request here must not add one more from the SDK.
describe("UI suite requests tell the SDK not to count the run again", () => {
  it.each([
    [
      "protocol",
      () =>
        runProtocolConformance({
          serverUrl: URL,
          protocolVersion: "2026-07-28",
        } as Parameters<typeof runProtocolConformance>[0]),
    ],
    ["apps", () => runAppsConformance({ url: URL })],
    ["tasks", () => runTasksConformance({ url: URL })],
    [
      "oauth",
      () =>
        startOAuthConformance({
          defaultServerUrl: URL,
          redirectUrl: "https://inspector.example/oauth/callback/debug",
        }),
    ],
  ] as const)("%s", async (suite, run) => {
    await (run() as Promise<unknown>).catch(() => undefined);
    expect(configs).toContainEqual({
      suite,
      config: expect.objectContaining({ __suppressTelemetry: true }),
    });
  });
});
