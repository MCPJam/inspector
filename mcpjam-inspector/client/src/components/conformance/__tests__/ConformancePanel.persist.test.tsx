import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerWithName } from "@/hooks/use-app-state";

const mockRunProtocol = vi.fn();
const mockRunApps = vi.fn();
const mockRunTasks = vi.fn();
const mockStartOAuth = vi.fn();

const { startRun, finalizeRun, cancelRun } = vi.hoisted(() => ({
  startRun: vi.fn().mockResolvedValue({ runId: "run_1" }),
  finalizeRun: vi.fn().mockResolvedValue({ runId: "run_1" }),
  cancelRun: vi.fn().mockResolvedValue({ cancelled: true }),
}));

vi.mock("@/lib/apis/mcp-conformance-api", () => ({
  runProtocolConformance: (...args: unknown[]) => mockRunProtocol(...args),
  runAppsConformance: (...args: unknown[]) => mockRunApps(...args),
  runTasksConformance: (...args: unknown[]) => mockRunTasks(...args),
  startOAuthConformance: (...args: unknown[]) => mockStartOAuth(...args),
  submitOAuthConformanceCode: vi.fn(),
  completeOAuthConformance: vi.fn(),
}));

vi.mock("@/components/oauth/utils", () => ({
  deriveOAuthProfileFromServer: () => ({
    serverUrl: "https://test.com",
    clientId: "",
    clientSecret: "",
    scopes: "",
    customHeaders: [],
    protocolVersion: "2025-11-25",
    registrationStrategy: "cimd",
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useMutation: (ref: unknown) => {
      // String names and typed references (makeFunctionReference) both arrive.
      const name =
        typeof ref === "string" ? ref : getFunctionName(ref as never);
      if (name === "conformanceRuns:startRun") return startRun;
      if (name === "conformanceRuns:finalizeRun") return finalizeRun;
      if (name === "conformanceRuns:cancelRun") return cancelRun;
      return vi.fn().mockResolvedValue(undefined);
    },
    useAction: () => vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock(
  "@/components/conformance/directory-readiness/DirectoryReadinessSection",
  () => ({
    DirectoryReadinessSection: () => null,
  }),
);

import { ConformanceTab } from "../ConformanceTab";
import { RUN_LABEL } from "../ConformancePageChrome";

function createHttpServer(): ServerWithName {
  return {
    name: "http-server",
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    enabled: true,
    retryCount: 0,
    config: {
      url: "https://example.com/mcp",
      timeout: 30000,
    },
  };
}

function hang() {
  return new Promise(() => {});
}

function mockPassingSuites() {
  const base = {
    passed: true,
    outcome: "passed",
    serverUrl: "https://example.com/mcp",
    target: "https://example.com/mcp",
    summary: "ok",
    durationMs: 1,
    checks: [],
    categorySummary: {},
  };
  mockRunProtocol.mockResolvedValue({ success: true, result: base });
  mockRunApps.mockResolvedValue({
    success: true,
    result: {
      ...base,
      discovery: {
        toolCount: 0,
        uiToolCount: 0,
        listedResourceCount: 0,
        listedUiResourceCount: 0,
        checkedUiResourceCount: 0,
      },
    },
  });
  mockRunTasks.mockResolvedValue({
    success: true,
    result: {
      ...base,
      discovery: {
        protocolVersion: "2025-11-25",
        wire: "legacy",
        toolCount: 0,
        taskCapableToolCount: 0,
      },
    },
  });
  mockStartOAuth.mockResolvedValue({
    phase: "complete",
    result: {
      passed: true,
      outcome: "passed",
      protocolVersion: "2025-11-25",
      registrationStrategy: "cimd",
      serverUrl: "https://example.com/mcp",
      summary: "ok",
      durationMs: 1,
      steps: [],
    },
  });
}

describe("ConformanceTab persist", () => {
  beforeEach(() => {
    startRun.mockClear();
    finalizeRun.mockClear();
    cancelRun.mockClear();
    mockRunProtocol.mockImplementation(hang);
    mockRunApps.mockImplementation(hang);
    mockRunTasks.mockImplementation(hang);
    mockStartOAuth.mockImplementation(hang);
  });

  it("does not create a Convex run on mount or remount", async () => {
    const persist = { projectId: "proj_1", serverId: "srv_1" };
    const { unmount } = render(
      <ConformanceTab server={createHttpServer()} persist={persist} />,
    );

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: RUN_LABEL })[0],
      ).toBeInTheDocument(),
    );
    expect(startRun).not.toHaveBeenCalled();

    unmount();
    render(<ConformanceTab server={createHttpServer()} persist={persist} />);

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: RUN_LABEL })[0],
      ).toBeInTheDocument(),
    );
    expect(startRun).not.toHaveBeenCalled();
  });

  it("creates one Convex run when the operator starts checks", async () => {
    const user = userEvent.setup();
    render(
      <ConformanceTab
        server={createHttpServer()}
        persist={{ projectId: "proj_1", serverId: "srv_1" }}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);

    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
  });

  it("cancels a run the page leaves before it finalizes", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <ConformanceTab
        server={createHttpServer()}
        persist={{ projectId: "proj_1", serverId: "srv_1" }}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));

    unmount();

    expect(cancelRun).toHaveBeenCalledWith({ runId: "run_1" });
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it("cancels a run whose id arrives after the page left", async () => {
    const user = userEvent.setup();
    let resolveStart: (value: { runId: string }) => void = () => {};
    startRun.mockImplementationOnce(
      () => new Promise((resolve) => (resolveStart = resolve)),
    );
    const { unmount } = render(
      <ConformanceTab
        server={createHttpServer()}
        persist={{ projectId: "proj_1", serverId: "srv_1" }}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));

    unmount();
    expect(cancelRun).not.toHaveBeenCalled();
    resolveStart({ runId: "run_2" });

    await waitFor(() =>
      expect(cancelRun).toHaveBeenCalledWith({ runId: "run_2" }),
    );
  });

  it("cancels a run whose finalize fails after the page left", async () => {
    const user = userEvent.setup();
    mockPassingSuites();
    let rejectFinalize: (error: Error) => void = () => {};
    finalizeRun.mockImplementationOnce(
      () => new Promise((_, reject) => (rejectFinalize = reject)),
    );
    const { unmount } = render(
      <ConformanceTab
        server={createHttpServer()}
        persist={{ projectId: "proj_1", serverId: "srv_1" }}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);
    await waitFor(() => expect(finalizeRun).toHaveBeenCalledTimes(1));

    unmount();
    expect(cancelRun).not.toHaveBeenCalled();
    rejectFinalize(new Error("finalize failed"));

    await waitFor(() =>
      expect(cancelRun).toHaveBeenCalledWith({ runId: "run_1" }),
    );
  });

  it("finalizes a finished run without a link to it, and does not cancel it on leave", async () => {
    const user = userEvent.setup();
    mockPassingSuites();
    const { unmount } = render(
      <ConformanceTab
        server={createHttpServer()}
        persist={{ projectId: "proj_1", serverId: "srv_1" }}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: RUN_LABEL })[0]);

    await waitFor(() =>
      expect(finalizeRun).toHaveBeenCalledWith({ runId: "run_1" }),
    );
    // The results are already on screen and the run is in History.
    expect(
      screen.queryByRole("button", { name: "View saved run" }),
    ).not.toBeInTheDocument();

    unmount();
    expect(cancelRun).not.toHaveBeenCalled();
  });
});
