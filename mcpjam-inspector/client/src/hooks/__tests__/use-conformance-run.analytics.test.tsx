import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectedServer,
  createHttpServerConfig,
} from "@/test/factories";
import { useConformanceRun } from "../use-conformance-run";

const { track, check, protocol, apps, tasks, oauth } = vi.hoisted(() => ({
  track: vi.fn(),
  check: vi.fn(),
  protocol: vi.fn(),
  apps: vi.fn(),
  tasks: vi.fn(),
  oauth: vi.fn(),
}));
vi.mock("@/lib/analytics", () => ({ track }));
vi.mock("@/lib/apis/conformance-connection-api", () => ({
  checkConformanceConnection: check,
}));
vi.mock("@/lib/apis/mcp-conformance-api", () => ({
  runProtocolConformance: protocol,
  runAppsConformance: apps,
  runTasksConformance: tasks,
  startOAuthConformance: oauth,
  completeOAuthConformance: vi.fn(),
  cancelOAuthConformance: vi.fn(async () => ({ success: true })),
  submitOAuthConformanceCode: vi.fn(),
}));
vi.mock("@/components/oauth/utils", () => ({
  deriveOAuthProfileFromServer: () => ({
    serverUrl: "https://fixture.test/mcp",
    registrationStrategy: "dcr",
    clientId: "",
    clientSecret: "",
    scopes: "",
    customHeaders: [],
  }),
}));

const server = createConnectedServer({
  name: "target",
  config: createHttpServerConfig("https://fixture.test/mcp"),
});

const conformanceEvents = () =>
  track.mock.calls.filter(([event]) => event === "conformance_run_triggered");

beforeEach(() => {
  vi.resetAllMocks();
  check.mockResolvedValue({ status: "ready", protocolVersion: "2025-06-18" });
  for (const suite of [protocol, apps, tasks])
    suite.mockRejectedValue(new Error("Stopped after capturing request"));
  oauth.mockResolvedValue({
    phase: "authorization_needed",
    sessionId: "session",
    authorizationUrl: "https://auth.test/authorize",
  });
});

describe("conformance_run_triggered from the app", () => {
  it("sends one event per run, however many suite requests it makes", async () => {
    const { result } = renderHook(() =>
      useConformanceRun({ server, deferOAuthAuthorization: true }),
    );
    expect(conformanceEvents()).toHaveLength(0);

    await act(async () => result.current.runAll());
    expect(protocol).toHaveBeenCalled();
    expect(apps).toHaveBeenCalled();
    expect(tasks).toHaveBeenCalled();
    expect(conformanceEvents()).toEqual([
      [
        "conformance_run_triggered",
        { location: "conformance_tab", run_source: "ui" },
      ],
    ]);

    await act(async () => result.current.runAll());
    expect(conformanceEvents()).toHaveLength(2);
  });

  it("labels the score runner's runs with its own location", async () => {
    const { result } = renderHook(() =>
      useConformanceRun({
        server,
        analyticsLocation: "score_runner",
        deferOAuthAuthorization: true,
      }),
    );
    await act(async () => result.current.runAll());
    expect(conformanceEvents()).toEqual([
      [
        "conformance_run_triggered",
        { location: "score_runner", run_source: "ui" },
      ],
    ]);
  });
});
