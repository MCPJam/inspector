import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apis/web/base";
import { readScoreRunResume, writeScoreRunResume } from "../score-run-resume";

const {
  mockCreateServerIfMissing,
  mockUpdateServer,
  mockValidateHostedServer,
  mockAuthorizeServer,
  mockRunAll,
  mockSubmitScoreRun,
  mockScoreState,
} = vi.hoisted(() => ({
  mockCreateServerIfMissing: vi.fn(),
  mockUpdateServer: vi.fn(),
  mockValidateHostedServer: vi.fn(),
  mockAuthorizeServer: vi.fn(),
  mockRunAll: vi.fn(),
  mockSubmitScoreRun: vi.fn(),
  mockScoreState: {
    pooledScore: undefined as unknown,
    protocolScore: undefined as unknown,
    protocolResult: undefined as unknown,
  },
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
    pooledScore: mockScoreState.pooledScore,
    protocolScore: mockScoreState.protocolScore,
    appsScore: undefined,
    tasksScore: undefined,
    oauthScore: undefined,
    oauthNotScored: true,
    protocol: { status: "idle", result: mockScoreState.protocolResult },
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

const SERVER_URL = "https://mcp.acme.com/mcp";
const DELIVERY_EMAIL = "dev@acme.com";

async function submitServerUrl(user: UserEvent, url = SERVER_URL) {
  await user.type(screen.getByLabelText("MCP server URL"), url);
  await user.click(screen.getByRole("button", { name: "Score this server" }));
}

async function submitDeliveryEmail(user: UserEvent, email = DELIVERY_EMAIL) {
  await user.type(screen.getByLabelText("Scorecard email"), email);
  await user.click(screen.getByRole("button", { name: "Email the scorecard" }));
}

beforeEach(() => {
  mockCreateServerIfMissing.mockReset().mockResolvedValue(undefined);
  mockUpdateServer.mockReset().mockResolvedValue(undefined);
  mockValidateHostedServer.mockReset().mockResolvedValue({});
  mockAuthorizeServer.mockReset();
  mockRunAll.mockReset().mockResolvedValue(undefined);
  mockSubmitScoreRun.mockReset();
  mockScoreState.pooledScore = undefined;
  mockScoreState.protocolScore = undefined;
  mockScoreState.protocolResult = undefined;
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

  it("walks the local design path when no project is ready", async () => {
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId={null} />);
    await submitServerUrl(user, "https://mcp.excalidraw.com/mcp");
    await submitDeliveryEmail(user);

    expect(
      await screen.findByRole(
        "heading",
        { name: "Your scorecard is on its way." },
        { timeout: 2000 },
      ),
    ).toBeInTheDocument();
    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();
    expect(mockValidateHostedServer).not.toHaveBeenCalled();
    expect(mockRunAll).not.toHaveBeenCalled();
  });

  it("handshakes before running suites", async () => {
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId="proj_1" />);
    await submitServerUrl(user);

    expect(
      screen.getByRole("heading", {
        name: "Where should we send the scorecard?",
      }),
    ).toBeInTheDocument();
    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();

    await submitDeliveryEmail(user);

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

  it("rejects an invalid email without starting a handshake", async () => {
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId="proj_1" />);
    await submitServerUrl(user);
    await submitDeliveryEmail(user, "not-an-email");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a valid email address.",
    );
    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();
    expect(mockValidateHostedServer).not.toHaveBeenCalled();
  });

  it("allows a valid email retry and starts exactly one handshake", async () => {
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId="proj_1" />);
    await submitServerUrl(user);
    await submitDeliveryEmail(user, "not-an-email");

    await user.clear(screen.getByLabelText("Scorecard email"));
    await submitDeliveryEmail(user);

    await waitFor(() =>
      expect(mockValidateHostedServer).toHaveBeenCalledOnce(),
    );
    expect(mockCreateServerIfMissing).toHaveBeenCalledOnce();
  });

  it("normalizes the URL and email before starting an OAuth-gated run", async () => {
    mockValidateHostedServer.mockRejectedValue(
      new WebApiError(
        401,
        "unauthorized",
        "Authorization required",
        undefined,
        { oauthRequired: true },
      ),
    );
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId="proj_1" />);

    await submitServerUrl(user, `  ${SERVER_URL}  `);
    await submitDeliveryEmail(user, `  ${DELIVERY_EMAIL}  `);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Authorize and continue" }),
      ).toBeInTheDocument();
    });
    expect(mockCreateServerIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({ url: SERVER_URL }),
    );
    expect(readScoreRunResume()).toMatchObject({
      serverUrl: SERVER_URL,
      deliveryEmail: DELIVERY_EMAIL,
    });
  });

  it("returns to the URL form with context when the handshake fails", async () => {
    mockValidateHostedServer.mockRejectedValue(new Error("Handshake failed"));
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId="proj_1" />);

    await submitServerUrl(user);
    await submitDeliveryEmail(user);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Handshake failed");
    });
    expect(screen.getByLabelText("MCP server URL")).toHaveValue(SERVER_URL);
    expect(screen.queryByLabelText("Scorecard email")).not.toBeInTheDocument();
    expect(mockRunAll).not.toHaveBeenCalled();
  });

  it("persists a completed score exactly once and exposes its private link", async () => {
    const score = {
      score: 84,
      outcome: "passed",
      applicable: 10,
      passed: 8,
      failed: 1,
      couldNotRun: 1,
      notApplicable: 0,
      advisories: [],
    };
    mockScoreState.pooledScore = score;
    mockScoreState.protocolScore = score;
    mockScoreState.protocolResult = { profile: { pendingCheckIds: [] } };
    mockSubmitScoreRun.mockResolvedValue({ token: "tok_1" });
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId="proj_1" />);

    await submitServerUrl(user);
    await submitDeliveryEmail(user);

    expect(
      await screen.findByRole("heading", { name: "Your scorecard is on its way." }),
    ).toBeInTheDocument();
    expect(mockSubmitScoreRun).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "View in browser" })).toHaveAttribute(
      "href",
      `${window.location.origin}/results/tok_1`,
    );
  });

  it("reports a save failure without retrying indefinitely", async () => {
    mockScoreState.pooledScore = {
      score: 0,
      outcome: "failed",
      applicable: 1,
      passed: 0,
      failed: 1,
      couldNotRun: 0,
      notApplicable: 0,
      advisories: [],
    };
    mockSubmitScoreRun.mockRejectedValue(new Error("Storage unavailable"));
    const user = userEvent.setup();
    render(<ScoreRunnerPage convexProjectId="proj_1" />);

    await submitServerUrl(user);
    await submitDeliveryEmail(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Scan finished, but the shareable link could not be saved: Storage unavailable",
    );
    await waitFor(() => expect(mockSubmitScoreRun).toHaveBeenCalledOnce());
  });

  it("resumes an OAuth run with its saved email and clears the record", async () => {
    writeScoreRunResume({
      serverUrl: SERVER_URL,
      serverName: "score-acme",
      deliveryEmail: DELIVERY_EMAIL,
    });

    render(<ScoreRunnerPage convexProjectId="proj_1" />);

    await waitFor(() =>
      expect(mockValidateHostedServer).toHaveBeenCalledOnce(),
    );
    expect(mockCreateServerIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({ url: SERVER_URL }),
    );
    expect(readScoreRunResume()).toBeNull();
  });

  it("asks for an email when resuming a legacy record without one", async () => {
    const user = userEvent.setup();
    writeScoreRunResume({
      serverUrl: SERVER_URL,
      serverName: "score-acme",
    });

    render(<ScoreRunnerPage convexProjectId="proj_1" />);

    expect(
      await screen.findByRole("heading", {
        name: "Where should we send the scorecard?",
      }),
    ).toBeInTheDocument();
    expect(mockCreateServerIfMissing).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Scorecard email")).toHaveValue("");

    await submitDeliveryEmail(user);

    await waitFor(() =>
      expect(mockValidateHostedServer).toHaveBeenCalledOnce(),
    );
    expect(mockCreateServerIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({ url: SERVER_URL }),
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
    await submitServerUrl(user);
    await submitDeliveryEmail(user);

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
