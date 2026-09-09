import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentSidePanelTrigger } from "../AgentSidePanelTrigger";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { openEvalChat } from "@/lib/mcpjam-agent/eval-scope";

const state = vi.hoisted(() => ({
  activeTab: "servers",
  context: undefined as any,
}));
vi.mock("@/lib/app-navigation", () => ({
  useActiveTab: () => state.activeTab,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/mcpjam-agent/eval-workspace", () => ({
  currentEvalPageScope: () => state.context,
}));
vi.mock("@mcpjam/design-system/tooltip", () => ({
  Tooltip: ({ children }: any) => children,
  TooltipTrigger: ({ children }: any) => children,
  TooltipContent: () => null,
}));
beforeEach(() => {
  state.context = undefined;
  useAgentPanelStore.getState().setOpen(false);
  useAgentPanelStore.getState().setActiveSession(null, null);
});
it.each(["home", "servers", "settings", "evaluate"])(
  "keeps the button usable on %s",
  (tab) => {
    state.activeTab = tab;
    render(<AgentSidePanelTrigger />);
    fireEvent.click(screen.getByRole("button", { name: "Ask MCPJam" }));
    expect(useAgentPanelStore.getState().isOpen).toBe(true);
  },
);
it("opens the scoped chat when a suite is active", () => {
  state.activeTab = "evaluate";
  state.context = {
    projectId: "project",
    suiteId: "suite",
    suiteName: "Suite",
  };
  render(<AgentSidePanelTrigger />);
  fireEvent.click(screen.getByRole("button", { name: "Ask MCPJam" }));
  expect(useAgentPanelStore.getState().activeSessionId).toMatch(/^eval-/);
});
it("does not reuse a scoped conversation outside Evaluate", () => {
  state.activeTab = "servers";
  openEvalChat({ projectId: "project", suiteId: "suite", suiteName: "Suite" });
  useAgentPanelStore.getState().setOpen(false);
  render(<AgentSidePanelTrigger />);
  fireEvent.click(screen.getByRole("button", { name: "Ask MCPJam" }));
  expect(useAgentPanelStore.getState().activeSessionId).toBeNull();
  expect(useAgentPanelStore.getState().isOpen).toBe(true);
});
