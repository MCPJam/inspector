import {
  useAgentPanelStore,
  AGENT_PANEL_STORAGE_KEY,
} from "@/stores/agent-panel/agent-panel-store";
import { act, fireEvent } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import {
  useEvalGeneration,
  evalSuiteKey,
} from "@/lib/mcpjam-agent/eval-workspace";
import { useEvalPromptQueue } from "@/lib/mcpjam-agent/eval-scope";
import { EvalGenerationWorkspace } from "../eval-generation-workspace";

const chat = vi.hoisted(() => ({
  status: "ready",
  error: undefined,
  messages: [] as any[],
}));
vi.mock("@ai-sdk/react", () => ({ useChat: () => chat }));
vi.mock("@/lib/mcpjam-agent/agent-chat-instances", () => ({
  getOrCreateAgentChat: () => ({ chat: {} }),
  stopAgentChat: vi.fn(),
}));
const target = {
  projectId: "p",
  suiteId: "s",
  suiteName: "Suite",
  sessionId: "eval-test",
  onBack: vi.fn(),
};
const key = evalSuiteKey(target);
function seed(status: "ready" | "running") {
  useEvalGeneration.setState({
    suites: {
      [key]: {
        status,
        drafts: [
          {
            id: "draft",
            revision: "r1",
            input: { suiteId: "s", title: "Existing case", steps: [] } as any,
          },
        ],
      },
    },
  });
}
beforeEach(() => {
  chat.status = "ready";
  chat.messages = [];
  useEvalGeneration.setState({ suites: {} });
  useEvalPromptQueue.setState({ pending: {} });
});
it.each(["ready", "submitted", "streaming"])(
  "keeps existing drafts visible without generation scaffolding during %s chat",
  (status) => {
    seed("ready");
    chat.status = status;
    renderWithProviders(<EvalGenerationWorkspace {...target} />);
    expect(screen.getByText("Existing case")).toBeVisible();
    expect(screen.queryByTestId("generating-case-skeleton")).toBeNull();
    expect(
      screen.queryByText("Discovering your servers and drafting cases…"),
    ).toBeNull();
  },
);
it("shows skeletons during the initial Generate handoff", () => {
  chat.status = "submitted";
  renderWithProviders(<EvalGenerationWorkspace {...target} />);
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(3);
});
it("shows additional-generation progress only for an actual new job", () => {
  seed("running");
  renderWithProviders(<EvalGenerationWorkspace {...target} />);
  expect(screen.getByText("Existing case")).toBeVisible();
  expect(screen.getByText("Generating additional cases…")).toBeVisible();
  expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(3);
});
it.each(["ui_eval_run_suite", "ui_eval_generate_cases"])(
  "only generation approval shows case placeholders (%s)",
  (toolName) => {
    seed("ready");
    chat.messages = [
      { parts: [{ type: `tool-${toolName}`, state: "approval-requested" }] },
    ];
    renderWithProviders(<EvalGenerationWorkspace {...target} />);
    expect(screen.queryAllByTestId("generating-case-skeleton")).toHaveLength(
      toolName === "ui_eval_generate_cases" ? 3 : 0,
    );
  },
);

it("opens chat on entry and ignores another tab closing an eval panel", () => {
  useAgentPanelStore.setState({
    isOpen: false,
    activeSessionId: null,
    activeSessionProjectId: null,
  });
  renderWithProviders(<EvalGenerationWorkspace {...target} />);
  expect(useAgentPanelStore.getState().isOpen).toBe(true);
  expect(useAgentPanelStore.getState().activeSessionId).toBe(target.sessionId);
  act(() => {
    localStorage.setItem(
      AGENT_PANEL_STORAGE_KEY,
      JSON.stringify({
        isOpen: false,
        width: 420,
        activeSessionId: "eval-other",
        activeSessionProjectId: "other",
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: AGENT_PANEL_STORAGE_KEY }),
    );
  });
  expect(useAgentPanelStore.getState().isOpen).toBe(true);
  expect(useAgentPanelStore.getState().activeSessionId).toBe(target.sessionId);
  act(() => useAgentPanelStore.getState().setOpen(false));
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect(useAgentPanelStore.getState().isOpen).toBe(true);
});
