import {
  beginDescribe,
  useDescribeFlow,
} from "@/lib/mcpjam-agent/describe-flow";
import { stopAgentChat } from "@/lib/mcpjam-agent/agent-chat-instances";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { useEvalAgentScopes } from "@/lib/mcpjam-agent/eval-scope";
import { useDescribeSurface } from "@/lib/mcpjam-agent/describe-surface";
import { AgentSidePanel } from "../AgentSidePanel";

const chatState = vi.hoisted(() => ({ status: "ready" }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/mcpjam-agent/agent-chat-instances", () => ({
  stopAgentChat: vi.fn(),
  getOrCreateAgentChat: () => ({
    chat: {
      get status() {
        return chatState.status;
      },
      stop: vi.fn(),
    },
  }),
}));
vi.mock("../McpjamAgentThread", () => ({
  McpjamAgentThread: ({ onNewChat }: { onNewChat: () => void }) => {
    const [text, setText] = useState("");
    return (
      <>
        <textarea
          aria-label="Agent composer"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="button" onClick={onNewChat}>
          Start new chat
        </button>
      </>
    );
  },
}));
vi.mock("../McpjamAgentHero", () => ({
  McpjamAgentHero: () => <div>General composer</div>,
}));
let resize: () => void;
let narrow = true;
beforeEach(() => {
  narrow = true;
  chatState.status = "ready";
  vi.clearAllMocks();
  useDescribeFlow.setState({ sessions: {} });
  useDescribeSurface.setState({ scope: null });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 609,
  });
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return narrow;
    },
    addEventListener: (_: string, callback: () => void) => {
      resize = callback;
    },
    removeEventListener: vi.fn(),
  }));
  useAgentPanelStore.setState({
    isOpen: true,
    width: 420,
    activeSessionId: "eval-panel",
    activeSessionProjectId: "p",
  });
  useEvalAgentScopes.setState({
    scopes: {
      "eval-panel": {
        kind: "evals",
        version: 1,
        id: "scope",
        projectId: "p",
        suiteId: "s",
        suiteName: "Support",
      },
    },
  });
});
describe("shared agent docking", () => {
  it("uses a responsive right drawer and preserves composer across close/reopen and breakpoint changes", () => {
    const { container } = render(
      <AgentSidePanel projectId="p" organizationId={null} activeTab="evals" />,
    );
    const panel = container.querySelector('[data-slot="agent-side-panel"]')!;
    expect(panel).toHaveAttribute("data-agent-dock", "side");
    expect(panel).toHaveClass("absolute", "right-0");
    expect(panel).toHaveStyle({ width: "420px" });
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-orientation",
      "vertical",
    );
    act(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 375,
      });
      resize();
    });
    expect(panel).toHaveStyle({ width: "351px" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Agent composer"), {
      target: { value: "Keep this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close MCPJam Agent" }));
    expect(panel).not.toBeVisible();
    act(() => useAgentPanelStore.getState().setOpen(true));
    expect(screen.getByLabelText("Agent composer")).toHaveValue(
      "Keep this draft",
    );
    act(() => {
      narrow = false;
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1440,
      });
      resize();
    });
    expect(panel).toHaveAttribute("data-agent-dock", "side");
    expect(screen.getByLabelText("Agent composer")).toHaveValue(
      "Keep this draft",
    );
  });
  it("keeps eval chat focused without general-chat or conversation navigation controls", () => {
    render(
      <AgentSidePanel
        projectId="p"
        organizationId={null}
        activeTab="evaluate"
      />,
    );
    for (const name of ["New chat", "General chat", "Back to compose"])
      expect(screen.queryByRole("button", { name, exact: true })).toBeNull();
    expect(screen.queryByText("Evals · Support")).toBeNull();
    expect(screen.getByText("Ask MCPJam")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close MCPJam Agent" }),
    ).toBeVisible();
  });
});

it("opens a general chat when an eval chat is away from its case editor", () => {
  render(
    <AgentSidePanel projectId="p" organizationId={null} activeTab="evaluate" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start new chat" }));
  expect(useAgentPanelStore.getState().activeSessionId).toBeNull();
  expect(screen.getByText("General composer")).toBeVisible();
});

it("opens a fresh eval chat when the eval chat is on its case editor", () => {
  useDescribeSurface.setState({
    scope: useEvalAgentScopes.getState().scopes["eval-panel"],
  });
  render(
    <AgentSidePanel projectId="p" organizationId={null} activeTab="evaluate" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start new chat" }));
  const sessionId = useAgentPanelStore.getState().activeSessionId;
  expect(sessionId).toMatch(/^eval-/);
  expect(sessionId).not.toBe("eval-panel");
  expect(screen.queryByText("General composer")).toBeNull();
});

it("pauses an active generation on close and does not resume automatically on reopen", () => {
  beginDescribe("eval-panel", "Fetch issues");
  chatState.status = "streaming";
  render(
    <AgentSidePanel projectId="p" organizationId={null} activeTab="evals" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close MCPJam Agent" }));
  expect(stopAgentChat).toHaveBeenCalledWith("eval-panel");
  expect(useDescribeFlow.getState().sessions["eval-panel"].needsResume).toBe(
    true,
  );
  act(() => useAgentPanelStore.getState().setOpen(true));
  expect(useDescribeFlow.getState().sessions["eval-panel"].needsResume).toBe(
    true,
  );
});
