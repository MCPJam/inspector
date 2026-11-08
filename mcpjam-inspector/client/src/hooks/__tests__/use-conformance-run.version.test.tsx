import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectedServer,
  createHttpServerConfig,
} from "@/test/factories";
import type { ConformanceConnectionResult } from "@/shared/conformance-connection";
import { useConformanceRun } from "../use-conformance-run";

const { check, protocol, apps, tasks, oauth } = vi.hoisted(() => ({
  check: vi.fn(),
  protocol: vi.fn(),
  apps: vi.fn(),
  tasks: vi.fn(),
  oauth: vi.fn(),
}));
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

describe("conformance run version snapshot", () => {
  it("resolves Auto once for all four suites and resolves again on rerun", async () => {
    const { result } = renderHook(() =>
      useConformanceRun({ server, deferOAuthAuthorization: true }),
    );
    await act(async () => result.current.runAll());
    expect(result.current.versionPin).toBe("auto");
    expect(result.current.resolvedProtocolVersion).toBe("2025-06-18");
    for (const suite of [protocol, apps, tasks])
      expect(suite).toHaveBeenLastCalledWith(
        "target",
        expect.objectContaining({ protocolVersion: "2025-06-18" }),
      );
    expect(oauth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        oauthProfile: expect.objectContaining({
          protocolVersion: "2025-06-18",
        }),
      }),
    );
    check.mockResolvedValueOnce({
      status: "ready",
      protocolVersion: "2026-07-28",
    });
    await act(async () => result.current.runAll());
    expect(check).toHaveBeenCalledTimes(2);
    expect(result.current.resolvedProtocolVersion).toBe("2026-07-28");
    expect(apps).toHaveBeenLastCalledWith(
      "target",
      expect.objectContaining({ protocolVersion: "2026-07-28" }),
    );
  });

  it("consumes setup's resolved version only for its first run", async () => {
    const { result } = renderHook(() =>
      useConformanceRun({
        server,
        initialResolvedProtocolVersion: "2026-07-28",
        deferOAuthAuthorization: true,
      }),
    );
    await act(async () => result.current.runAll());
    expect(check).not.toHaveBeenCalled();
    expect(tasks).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({ protocolVersion: "2026-07-28" }),
    );
    await act(async () => result.current.runAll());
    expect(check).toHaveBeenCalledTimes(1);
    expect(result.current.resolvedProtocolVersion).toBe("2025-06-18");
  });

  it.each([{ supportedVersions: [] }, { supportedVersions: ["2025-06-18"] }])(
    "only lists supported versions when provided: %j",
    async ({ supportedVersions }) => {
      check.mockResolvedValueOnce({
        status: "unsupported",
        protocolVersion: "2026-07-28",
        supportedVersions,
      });
      const { result } = renderHook(() =>
        useConformanceRun({ server, initialVersionPin: "2026-07-28" }),
      );
      await act(async () => result.current.runAll());
      expect(result.current.apps.error).toBe(
        `The server doesn't support MCP protocol version 2026-07-28.${supportedVersions.length ? " Supported versions: 2025-06-18." : ""} Choose a supported version and try again.`,
      );
      for (const suite of [protocol, apps, tasks, oauth])
        expect(suite).not.toHaveBeenCalled();
    },
  );

  it("starts no suite when Auto resolution fails", async () => {
    check.mockResolvedValueOnce({
      status: "failed",
      message: "Cannot resolve version",
    });
    const { result } = renderHook(() => useConformanceRun({ server }));
    await act(async () => result.current.runAll());
    for (const suite of [protocol, apps, tasks, oauth])
      expect(suite).not.toHaveBeenCalled();
    expect(result.current.apps).toMatchObject({
      status: "error",
      error: "Cannot resolve version",
    });
    expect(result.current.resolvedProtocolVersion).toBeUndefined();
    expect(result.current.isRunning).toBe(false);
  });

  it("still runs the suites when the server asks for a login", async () => {
    check.mockResolvedValueOnce({
      status: "auth-required",
      message: "The server requires authorization (HTTP 401).",
    });
    const { result } = renderHook(() => useConformanceRun({ server }));
    await act(async () => result.current.runAll());
    // Each suite reaches the 401 itself and reports its checks as "Not run"
    // with the sign-in prompt, instead of every suite failing outright.
    for (const suite of [protocol, apps, tasks])
      expect(suite).toHaveBeenCalled();
    expect(oauth).not.toHaveBeenCalled();
    expect(result.current.oauth).toMatchObject({
      status: "error",
      error: "The server requires authorization (HTTP 401).",
    });
    expect(result.current.resolvedProtocolVersion).toBeUndefined();
  });

  it("ignores an Auto reply after the target changes", async () => {
    let resolve: (result: ConformanceConnectionResult) => void = () => {
      throw new Error("Not initialized");
    };
    check.mockReturnValueOnce(
      new Promise<ConformanceConnectionResult>((done) => {
        resolve = done;
      }),
    );
    const { result, rerender } = renderHook(
      ({ target }) => useConformanceRun({ server: target }),
      { initialProps: { target: server } },
    );
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.runAll();
    });
    rerender({
      target: {
        ...server,
        config: createHttpServerConfig("https://other.test/mcp"),
      },
    });
    await act(async () => {
      resolve({ status: "ready", protocolVersion: "2025-06-18" });
      await pending;
    });
    expect(protocol).not.toHaveBeenCalled();
    expect(result.current.resolvedProtocolVersion).toBeUndefined();
  });
});
