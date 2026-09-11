import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentSidePanelTrigger } from "../AgentSidePanelTrigger";
import { useDescribeSurface } from "@/lib/mcpjam-agent/describe-surface";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
const route = vi.hoisted(() => ({ tab: "home" }));
vi.mock("@/lib/app-navigation", () => ({ useActiveTab: () => route.tab }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
beforeEach(() => {
  useDescribeSurface.setState({ scope: null });
  useAgentPanelStore.setState({ isOpen: false, activeSessionId: null, activeSessionProjectId: null });
});
it.each(["home", "servers", "chat", "settings", "tools", "evals"])("offers Ask MCPJam on %s", (tab) => {
  route.tab = tab;
  render(<AgentSidePanelTrigger />);
  fireEvent.click(screen.getByRole("button", { name: "Ask MCPJam" }));
  expect(useAgentPanelStore.getState().isOpen).toBe(true);
});
it("hides Ask MCPJam in new Evaluate outside Describe", () => {
  route.tab = "evaluate";
  render(<AgentSidePanelTrigger />);
  expect(screen.queryByRole("button", { name: "Ask MCPJam" })).toBeNull();
});
it("opens scoped chat in Describe", () => {
  route.tab = "evaluate";
  useDescribeSurface.setState({ scope: { kind: "evals", version: 1, id: "scope", projectId: "p", suiteId: "s", suiteName: "Suite", caseId: "draft:describe" } });
  render(<AgentSidePanelTrigger />);
  fireEvent.click(screen.getByRole("button", { name: "Ask MCPJam" }));
  expect(useAgentPanelStore.getState().isOpen).toBe(true);
  expect(useAgentPanelStore.getState().activeSessionProjectId).toBe("p");
});
