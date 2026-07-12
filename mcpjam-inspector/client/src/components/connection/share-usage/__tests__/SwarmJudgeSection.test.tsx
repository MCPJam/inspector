import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The session viewer's judge section (TL must-have: on-demand UX). States:
 * completed → shared verdict card + Re-judge; failed → "Judge unavailable" +
 * Retry (failed judgments are recoverable, never hidden); running → judging
 * placeholder. Retry/Re-judge invoke `swarmJudge:requestSwarmSessionJudge`
 * with ONLY the session id.
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
vi.mock("@/components/chatboxes/session-readiness", () => ({
  SessionInsightBar: () => null,
}));

import { SwarmJudgeSection } from "../ShareUsageThreadDetail";

describe("SwarmJudgeSection", () => {
  afterEach(() => {
    requestJudgeMock.mockClear();
    requestJudgeMock.mockResolvedValue(null);
    toastMock.error.mockClear();
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
      />,
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
      />,
    );
    expect(screen.getByText("Judge unavailable")).toBeInTheDocument();
    expect(screen.getByText("spend_cap_exceeded")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(requestJudgeMock).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("running → judging placeholder, no controls", () => {
    render(
      <SwarmJudgeSection threadId="session-1" goalScore={{ status: "running" }} />,
    );
    expect(
      screen.getByText(/Judging against the journey goal/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("a rerun failure surfaces a toast instead of throwing", async () => {
    requestJudgeMock.mockRejectedValueOnce(new Error("nope"));
    const user = userEvent.setup();
    render(
      <SwarmJudgeSection
        threadId="session-1"
        goalScore={{ status: "failed", error: "x" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalled();
    });
  });
});
