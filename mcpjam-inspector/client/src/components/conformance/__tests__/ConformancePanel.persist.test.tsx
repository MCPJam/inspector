import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerWithName } from "@/hooks/use-app-state";

const mockRunProtocol = vi.fn();
const mockRunApps = vi.fn();
const mockRunTasks = vi.fn();
const mockStartOAuth = vi.fn();

const { startRun } = vi.hoisted(() => ({
  startRun: vi.fn().mockResolvedValue({ runId: "run_1" }),
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

vi.mock("convex/react", () => ({
  useMutation: (name: string) => {
    if (name === "conformanceRuns:startRun") return startRun;
    return vi.fn().mockResolvedValue(undefined);
  },
  useAction: () => vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/conformance/directory-readiness/DirectoryReadinessSection", () => ({
  DirectoryReadinessSection: () => null,
}));

import { ConformanceTab } from "../ConformancePanel";

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

describe("ConformanceTab persist", () => {
  beforeEach(() => {
    startRun.mockClear();
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
      expect(screen.getByRole("button", { name: /run available checks/i })).toBeInTheDocument(),
    );
    expect(startRun).not.toHaveBeenCalled();

    unmount();
    render(<ConformanceTab server={createHttpServer()} persist={persist} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run available checks/i })).toBeInTheDocument(),
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

    await user.click(
      screen.getByRole("button", { name: /run available checks/i }),
    );

    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
  });
});
