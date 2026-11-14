import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSidePanelMount } from "../AgentSidePanelMount";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";

vi.mock("../AgentSidePanel", () => ({
  AgentSidePanel: () => <aside>Agent panel</aside>,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

function pressShortcut() {
  act(() => {
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
  });
}

beforeEach(() => {
  useAgentPanelStore.setState({
    isOpen: false,
    activeSessionId: null,
    activeSessionProjectId: null,
  });
});

afterEach(() => {
  delete window.__MCP_RUNTIME_CONFIG__;
});

describe("AgentSidePanelMount", () => {
  it("mounts the panel and answers the shortcut while the agent is on", () => {
    render(
      <AgentSidePanelMount projectId="p" organizationId="org" activeTab="home" />,
    );
    expect(screen.getByText("Agent panel")).toBeInTheDocument();
    pressShortcut();
    expect(useAgentPanelStore.getState().isOpen).toBe(true);
  });

  it("mounts nothing and ignores the shortcut when the server turns the agent off", () => {
    window.__MCP_RUNTIME_CONFIG__ = { platformAgentDisabled: true };
    const { container } = render(
      <AgentSidePanelMount projectId="p" organizationId="org" activeTab="home" />,
    );
    expect(container).toBeEmptyDOMElement();
    pressShortcut();
    expect(useAgentPanelStore.getState().isOpen).toBe(false);
  });
});
