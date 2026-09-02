import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The session viewer's judge section. Auto-runs when no verdict exists;
 * completed → shared verdict card + Re-judge; failed → "Judge unavailable" +
 * Retry; running/pending → judging placeholder. Invokes
 * `swarmJudge:requestSwarmSessionJudge` with ONLY the session id.
 */
const { requestJudgeMock, toastMock } = vi.hoisted(() => ({
  requestJudgeMock: vi.fn().mockResolvedValue(null),
  toastMock: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useAction: () => requestJudgeMock,
  useQuery: () => undefined,
}));
vi.mock("sonner", () => ({ toast: toastMock }));

// Heavy transitive deps of ShareUsageThreadDetail — stubbed; only
// SwarmJudgeSection renders in these tests.
vi.mock("@mcpjam/chat-ui", () => ({ ReadOnlyTranscript: () => null }));
vi.mock("@/components/evals/trace-viewer-adapter", () => ({
  adaptTraceToUiMessages: () => [],
  snapshotsToTraceWidgetSnapshots: () => [],
}));
vi.mock("@/components/evals/trace-viewer", () => ({ TraceViewer: () => null }));
vi.mock("@/components/evals/browser-artifacts-view", () => ({
  BrowserArtifactsView: () => null,
}));
vi.mock("@/components/evals/trace-view-mode-tabs", () => ({
  ChatTraceViewModeHeaderBar: () => null,
}));
vi.mock("@/hooks/useSharedChatThreads", () => ({
  useSharedChatThread: () => ({ thread: null }),
  useSharedChatWidgetSnapshots: () => ({ snapshots: [] }),
  useSharedChatTurnTraces: () => ({ traces: [] }),
  useSessionBrowserArtifacts: () => ({ artifacts: [] }),
}));
vi.mock("@/components/scenarios/session-readiness", () => ({
  SessionInsightBar: () => null,
}));

import {
  isNotGradeableSwarmSessionError,
  SwarmJudgeSection,
} from "../ShareUsageThreadDetail";

describe("SwarmJudgeSection", () => {
  afterEach(() => {
    requestJudgeMock.mockClear();
    requestJudgeMock.mockResolvedValue(null);
    toastMock.error.mockClear();
  });

  it("absent → auto-invokes the judge action on mount", async () => {
    let resolveJudge: ((value: unknown) => void) | undefined;
    requestJudgeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveJudge = resolve;
        })
    );
    render(<SwarmJudgeSection threadId="session-1" />);

    await waitFor(() => {
      expect(requestJudgeMock).toHaveBeenCalledWith({ sessionId: "session-1" });
    });
    expect(
      screen.getByText(/Judging against the journey goal/)
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /run judge/i })).not.toBeInTheDocument();
    resolveJudge?.(null);
  });

  it("a null skip is not a failure — quiet copy, no toast, no stuck spinner", async () => {
    requestJudgeMock.mockResolvedValueOnce(null);
    render(<SwarmJudgeSection threadId="session-1" />);

    await waitFor(() => {
      expect(
        screen.getByText(/Not ready to judge/)
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/Judging against the journey goal/)
    ).not.toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("the legacy ConvexError skip is quiet too", async () => {
    requestJudgeMock.mockRejectedValueOnce(
      new Error("This session is not a gradeable swarm session")
    );
    render(<SwarmJudgeSection threadId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Not ready to judge/)).toBeInTheDocument();
    });
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("an unexpected auto-run error stays off the toast (silent) but is retryable", async () => {
    requestJudgeMock.mockRejectedValueOnce(new Error("OPENROUTER_API_KEY"));
    render(<SwarmJudgeSection threadId="session-1" />);

    await waitFor(() => {
      expect(screen.getByText("Judge unavailable")).toBeInTheDocument();
    });
    expect(screen.getByText("OPENROUTER_API_KEY")).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("completed → verdict card with score/reason + a Re-judge affordance", async () => {
    const user = userEvent.setup();
    render(
      <SwarmJudgeSection
        threadId="session-1"
        goalScore={{
          status: "completed",
          score: 0.82,
          passed: true,
          reason: "accomplished the goal",
        }}
      />
    );
    expect(screen.getByText("82%")).toBeInTheDocument();
    expect(screen.getByText(/meets goal/)).toBeInTheDocument();
    expect(screen.getByText(/accomplished the goal/)).toBeInTheDocument();

    await user.click(screen.getByTitle("Re-run the judge on this session"));
    expect(requestJudgeMock).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("failed → 'Judge unavailable' + error + Retry invoking the action", async () => {
    const user = userEvent.setup();
    render(
      <SwarmJudgeSection
        threadId="session-1"
        goalScore={{ status: "failed", error: "spend_cap_exceeded" }}
      />
    );
    expect(screen.getByText("Judge unavailable")).toBeInTheDocument();
    expect(screen.getByText("spend_cap_exceeded")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(requestJudgeMock).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("a completed record with malformed passed renders nothing (never a bogus verdict)", () => {
    const { container } = render(
      <SwarmJudgeSection
        threadId="session-1"
        goalScore={{
          status: "completed",
          score: 0.9,
          passed: "yes" as unknown as boolean,
        }}
      />
    );
    expect(container.textContent).not.toMatch(/below threshold|meets goal/);
  });

  it("running → judging placeholder, no controls", () => {
    render(
      <SwarmJudgeSection
        threadId="session-1"
        goalScore={{ status: "running" }}
      />
    );
    expect(
      screen.getByText(/Judging against the journey goal/)
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("ignores a judge request that resolves after the reader switched sessions", async () => {
    let rejectFirst: ((reason: unknown) => void) | undefined;
    requestJudgeMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        })
    );
    const { rerender } = render(<SwarmJudgeSection threadId="session-1" />);
    await waitFor(() => {
      expect(requestJudgeMock).toHaveBeenCalledWith({ sessionId: "session-1" });
    });

    // Move to another session, then let the FIRST request fail.
    requestJudgeMock.mockResolvedValueOnce(null);
    rerender(<SwarmJudgeSection threadId="session-2" />);
    await waitFor(() => {
      expect(requestJudgeMock).toHaveBeenCalledWith({ sessionId: "session-2" });
    });
    rejectFirst?.(new Error("stale judge failure"));

    // The new session's state stands — no error banner from the old request.
    await waitFor(() => {
      expect(
        screen.queryByText(/stale judge failure/)
      ).not.toBeInTheDocument();
    });
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("isNotGradeableSwarmSessionError matches the Convex payload and the message", () => {
    expect(
      isNotGradeableSwarmSessionError(
        new Error("This session is not a gradeable swarm session")
      )
    ).toBe(true);
    expect(
      isNotGradeableSwarmSessionError({
        data: "This session is not a gradeable swarm session",
      })
    ).toBe(true);
    expect(isNotGradeableSwarmSessionError(new Error("OPENROUTER"))).toBe(
      false
    );
  });

  it("a rerun failure surfaces a toast instead of throwing", async () => {
    requestJudgeMock.mockRejectedValueOnce(new Error("nope"));
    const user = userEvent.setup();
    render(
      <SwarmJudgeSection
        threadId="session-1"
        goalScore={{ status: "failed", error: "x" }}
      />
    );
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalled();
    });
  });
});
