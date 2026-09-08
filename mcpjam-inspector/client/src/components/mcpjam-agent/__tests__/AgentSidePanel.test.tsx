import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { useEvalAgentScopes } from "@/lib/mcpjam-agent/eval-scope";
import { AgentSidePanel } from "../AgentSidePanel";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/mcpjam-agent/agent-chat-instances", () => ({
  stopAgentChat: vi.fn(),
  getOrCreateAgentChat: () => ({ chat: { stop: vi.fn() } }),
}));
vi.mock("../McpjamAgentThread", () => ({
  McpjamAgentThread: () => {
    const [text, setText] = useState("");
    return (
      <textarea
        aria-label="Agent composer"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
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
  it("docks below without a dialog, preserves composer across close/reopen and breakpoint changes", () => {
    const { container } = render(
      <AgentSidePanel projectId="p" organizationId={null} activeTab="evals" />,
    );
    const panel = container.querySelector('[data-slot="agent-side-panel"]')!;
    expect(panel).toHaveAttribute("data-agent-dock", "bottom");
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
      resize();
    });
    expect(panel).toHaveAttribute("data-agent-dock", "side");
    expect(screen.getByLabelText("Agent composer")).toHaveValue(
      "Keep this draft",
    );
  });
  it("keeps eval chat focused without general-chat or conversation navigation controls", () => {
    render(<AgentSidePanel projectId="p" organizationId={null} activeTab="evaluate" />);
    for (const name of ["New chat", "General chat", "Back to compose"])
      expect(screen.queryByRole("button", { name, exact: true })).toBeNull();
    expect(screen.queryByText("Evals · Support")).toBeNull();
    expect(screen.getByText("Ask MCPJam")).toBeVisible();
    expect(screen.getByRole("button", { name: "Close MCPJam Agent" })).toBeVisible();
  });
});
