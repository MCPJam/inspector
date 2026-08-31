import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apis/web/base";

const {
  mockCreateServerIfMissing,
  mockUpdateServer,
  mockValidateHostedServer,
  mockAuthorizeServer,
  mockRunAll,
  mockSubmitScoreRun,
} = vi.hoisted(() => ({
  mockCreateServerIfMissing: vi.fn(),
  mockUpdateServer: vi.fn(),
  mockValidateHostedServer: vi.fn(),
  mockAuthorizeServer: vi.fn(),
  mockRunAll: vi.fn(),
  mockSubmitScoreRun: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (ref: string) =>
    String(ref).includes("createServerIfMissing")
      ? mockCreateServerIfMissing
      : mockUpdateServer,
}));

vi.mock("@/hooks/use-app-ready", () => ({
  useAppReady: () => ({ status: "ready" }),
  useAppReadyMessage: () => null,
}));

vi.mock("@/hooks/use-conformance-run", () => ({
  useConformanceRun: () => ({
    runAll: mockRunAll,
    isRunning: false,
    pooledScore: undefined,
    protocolScore: undefined,
    appsScore: undefined,
    tasksScore: undefined,
    oauthScore: undefined,
    oauthNotScored: true,
    protocol: { status: "idle" },
    apps: { status: "idle" },
    tasks: { status: "idle" },
    oauth: { status: "idle" },
    authorizeOAuth: vi.fn(),
  }),
}));

vi.mock("@/hooks/hosted/use-hosted-oauth-gate", () => ({
  useHostedOAuthGate: () => ({
    authorizeServer: mockAuthorizeServer,
    hasBusyOAuth: false,
  }),
}));

vi.mock("@/lib/apis/web/context", () => ({
  tryResolveProjectServer: () => ({
    projectId: "proj_1",
    serverId: "srv_1",
  }),
}));

vi.mock("@/lib/apis/web/servers-api", () => ({
  validateHostedServer: (...args: unknown[]) =>
    mockValidateHostedServer(...args),
}));

vi.mock("@/lib/apis/score-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/apis/score-api")>();
  return {
    ...actual,
    submitScoreRun: (...args: unknown[]) => mockSubmitScoreRun(...args),
  };
});

vi.mock("../score-server-name", () => ({
  deriveScoreServerName: vi.fn(async () => "score-acme"),
}));

import { ScoreRunnerPage } from "../ScoreRunnerPage";

beforeEach(() => {
  mockCreateServerIfMissing.mockReset().mockResolvedValue(undefined);
  mockUpdateServer.mockReset().mockResolvedValue(undefined);
  mockValidateHostedServer.mockReset().mockResolvedValue({});
  mockAuthorizeServer.mockReset();
  mockRunAll.mockReset().mockResolvedValue(undefined);
  mockSubmitScoreRun.mockReset();
  sessionStorage.clear();
});

describe("ScoreRunnerPage", () => {
  it("rejects an invalid URL without starting a handshake", async () => {
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId="proj_1" />);
    await user.type(screen.getByLabelText("MCP server URL"), "not a url!!");
    await user.click(screen.getByRole("button", { name: "Score this server" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a valid http(s) MCP server URL.",
    );
    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();
    expect(mockValidateHostedServer).not.toHaveBeenCalled();
  });

  it("handshakes before running suites", async () => {
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId="proj_1" />);
    await user.type(
      screen.getByLabelText("MCP server URL"),
      "https://mcp.acme.com/mcp",
    );
    await user.click(screen.getByRole("button", { name: "Score this server" }));

    await waitFor(() => {
      expect(mockValidateHostedServer).toHaveBeenCalled();
    });
    expect(mockCreateServerIfMissing).toHaveBeenCalled();
    await waitFor(() => {
      expect(mockRunAll).toHaveBeenCalled();
    });
    expect(mockValidateHostedServer.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunAll.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("exposes authorize when the handshake requires OAuth", async () => {
    mockValidateHostedServer.mockRejectedValue(
      new WebApiError(
        401,
        "unauthorized",
        "Authorization required",
        undefined,
        {
          oauthRequired: true,
        },
      ),
    );
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId="proj_1" />);
    await user.type(
      screen.getByLabelText("MCP server URL"),
      "https://mcp.acme.com/mcp",
    );
    await user.click(screen.getByRole("button", { name: "Score this server" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Authorize and continue" }),
      ).toBeInTheDocument();
    });
    expect(mockRunAll).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Authorize and continue" }),
    );
    expect(mockAuthorizeServer).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "srv_1",
        useOAuth: true,
        clientId: null,
      }),
    );
  });
});
