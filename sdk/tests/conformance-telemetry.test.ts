import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as telemetry from "../src/telemetry.js";
import { runConformance } from "../src/conformance-run.js";
import { MCPConformanceTest } from "../src/mcp-conformance/runner.js";
import { MCPConformanceSuite } from "../src/mcp-conformance/suite.js";
import { MCPAppsConformanceTest } from "../src/apps-conformance/runner.js";
import { MCPAppsConformanceSuite } from "../src/apps-conformance/suite.js";
import { normalizeMCPAppsConformanceConfig } from "../src/apps-conformance/validation.js";
import { MCPTasksConformanceTest } from "../src/tasks-conformance/runner.js";
import { normalizeMCPTasksConformanceConfig } from "../src/tasks-conformance/validation.js";
import { OAuthConformanceTest } from "../src/oauth-conformance/runner.js";
import { OAuthConformanceSuite } from "../src/oauth-conformance/suite.js";
import type { OAuthConformanceConfig } from "../src/oauth-conformance/types.js";

// Nothing listens here, so every run fails fast without leaving the machine.
const CLOSED = "http://127.0.0.1:65535/mcp";

/** OAuth never reaches the network: every request answers 404 at once. */
const notFound = (async () =>
  new Response(null, { status: 404 })) as unknown as typeof fetch;

const oauthFlow = {
  protocolVersion: "2025-06-18",
  registrationStrategy: "dcr",
  auth: { mode: "client_credentials", clientId: "id", clientSecret: "secret" },
} satisfies Partial<OAuthConformanceConfig>;

const spyOnCapture = () =>
  vi.spyOn(telemetry, "captureConformanceRun").mockResolvedValue();
let capture: ReturnType<typeof spyOnCapture>;

beforeEach(() => {
  capture = spyOnCapture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sources = () => capture.mock.calls.map(([source]) => source);
const settle = (run: Promise<unknown>) => run.catch(() => undefined);

describe("conformance_run_triggered: one event per top-level run", () => {
  it("each Test class sends one sdk event, and none when suppressed", async () => {
    await settle(
      new MCPConformanceTest({
        serverUrl: CLOSED,
        checkIds: ["server-initialize"],
        checkTimeout: 2_000,
      }).run(),
    );
    await settle(new MCPAppsConformanceTest({ url: CLOSED, timeout: 2_000 }).run());
    await settle(new MCPTasksConformanceTest({ url: CLOSED, timeout: 2_000 }).run());
    await settle(
      new OAuthConformanceTest({
        ...oauthFlow,
        serverUrl: CLOSED,
        fetchFn: notFound,
      }).run(),
    );
    expect(sources()).toEqual(["sdk", "sdk", "sdk", "sdk"]);

    capture.mockClear();
    await settle(
      new MCPConformanceTest({
        serverUrl: CLOSED,
        checkIds: ["server-initialize"],
        checkTimeout: 2_000,
        __suppressTelemetry: true,
      }).run(),
    );
    await settle(
      new MCPAppsConformanceTest({
        url: CLOSED,
        timeout: 2_000,
        __suppressTelemetry: true,
      }).run(),
    );
    await settle(
      new MCPTasksConformanceTest({
        url: CLOSED,
        timeout: 2_000,
        __suppressTelemetry: true,
      }).run(),
    );
    await settle(
      new OAuthConformanceTest({
        ...oauthFlow,
        serverUrl: CLOSED,
        fetchFn: notFound,
        __suppressTelemetry: true,
      }).run(),
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("a suite with two runs sends one event, not one per run", async () => {
    const protocolRuns = vi.spyOn(MCPConformanceTest.prototype, "run");
    await settle(
      new MCPConformanceSuite({
        serverUrl: CLOSED,
        runs: [
          { label: "a", checkIds: ["server-initialize"], checkTimeout: 2_000 },
          { label: "b", checkIds: ["server-initialize"], checkTimeout: 2_000 },
        ],
      }).run(),
    );
    expect(protocolRuns).toHaveBeenCalledTimes(2);
    expect(sources()).toEqual(["sdk"]);

    capture.mockClear();
    const appsRuns = vi.spyOn(MCPAppsConformanceTest.prototype, "run");
    await settle(
      new MCPAppsConformanceSuite({
        target: { url: CLOSED, timeout: 2_000 },
        runs: [{ label: "a" }, { label: "b" }],
      }).run(),
    );
    expect(appsRuns).toHaveBeenCalledTimes(2);
    expect(sources()).toEqual(["sdk"]);

    capture.mockClear();
    const oauthRuns = vi.spyOn(OAuthConformanceTest.prototype, "run");
    await settle(
      new OAuthConformanceSuite({
        serverUrl: CLOSED,
        defaults: { fetchFn: notFound },
        flows: [
          { ...oauthFlow, label: "a" },
          { ...oauthFlow, label: "b" },
        ],
      }).run(),
    );
    expect(oauthRuns).toHaveBeenCalledTimes(2);
    expect(sources()).toEqual(["sdk"]);
  });

  it("a suite told to stay quiet sends nothing", async () => {
    await settle(
      new MCPConformanceSuite({
        serverUrl: CLOSED,
        runs: [{ checkIds: ["server-initialize"], checkTimeout: 2_000 }],
        __suppressTelemetry: true,
      }).run(),
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("runConformance sends one event for all its suites, with a host's label", async () => {
    const protocolRuns = vi.spyOn(MCPConformanceTest.prototype, "run");
    const appsRuns = vi.spyOn(MCPAppsConformanceTest.prototype, "run");
    const config = {
      server: { url: CLOSED, timeout: 2_000 },
      suites: ["protocol", "apps"] as ("protocol" | "apps")[],
      // A pinned version runs the suites without a first connection.
      protocolVersion: "2025-06-18" as const,
      protocol: { checkIds: ["server-initialize" as const], checkTimeout: 2_000 },
    };
    await runConformance(config);
    expect(protocolRuns).toHaveBeenCalledTimes(1);
    expect(appsRuns).toHaveBeenCalledTimes(1);
    expect(sources()).toEqual(["sdk"]);

    capture.mockClear();
    await runConformance({ ...config, __telemetryRunSource: "api" });
    expect(sources()).toEqual(["api"]);

    capture.mockClear();
    await runConformance({
      ...config,
      __telemetryRunSource: "api",
      __suppressTelemetry: true,
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("keeps the flag out of the server config a connection is built from", () => {
    const apps = normalizeMCPAppsConformanceConfig({
      url: CLOSED,
      __suppressTelemetry: true,
    });
    expect(apps.serverConfig).not.toHaveProperty("__suppressTelemetry");
    const tasks = normalizeMCPTasksConformanceConfig({
      url: CLOSED,
      __suppressTelemetry: true,
    });
    expect(tasks.serverConfig).not.toHaveProperty("__suppressTelemetry");
  });
});
