import { describe, it, expect, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";

import {
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { SidebarAutoCollapse } from "@/components/sidebar/sidebar-auto-collapse";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";

function OpenProbe() {
  const { open } = useSidebar();
  return <span data-testid="open">{open ? "open" : "closed"}</span>;
}

function renderAt(activeTab: string | undefined) {
  const view = render(
    <SidebarProvider defaultOpen={true}>
      <SidebarAutoCollapse activeTab={activeTab} />
      <OpenProbe />
      <SidebarTrigger />
    </SidebarProvider>,
  );

  return {
    ...view,
    navigate(next: string | undefined) {
      view.rerender(
        <SidebarProvider defaultOpen={true}>
          <SidebarAutoCollapse activeTab={next} />
          <OpenProbe />
          <SidebarTrigger />
        </SidebarProvider>,
      );
    },
  };
}

const state = () => screen.getByTestId("open").textContent;

function setAgentPanelOpen(next: boolean) {
  act(() => {
    useAgentPanelStore.setState({ isOpen: next });
  });
}

describe("SidebarAutoCollapse", () => {
  beforeEach(() => {
    useAgentPanelStore.setState({ isOpen: false });
  });

  it.each([
    "playground",
    "evals",
    "evaluate",
    "oauth-flow",
    "xaa-flow",
    "swarms",
  ])("collapses the sidebar when navigating to %s", (tab) => {
    const { navigate } = renderAt("home");
    expect(state()).toBe("open");

    navigate(tab);

    expect(state()).toBe("closed");
  });

  it("collapses on a wide surface the app deep-links straight into", () => {
    renderAt("playground");

    expect(state()).toBe("closed");
  });

  it("expands again when navigating back to a normal tab", () => {
    const { navigate } = renderAt("playground");
    expect(state()).toBe("closed");

    navigate("tools");

    expect(state()).toBe("open");
  });

  it("keeps a manual expand while moving between wide surfaces", () => {
    const { navigate } = renderAt("playground");
    expect(state()).toBe("closed");

    fireEvent.click(screen.getByRole("button", { name: /toggle sidebar/i }));
    expect(state()).toBe("open");

    navigate("evals");

    expect(state()).toBe("open");
  });

  it("keeps a manual collapse while moving between normal tabs", () => {
    const { navigate } = renderAt("home");

    fireEvent.click(screen.getByRole("button", { name: /toggle sidebar/i }));
    expect(state()).toBe("closed");

    navigate("tools");

    expect(state()).toBe("closed");
  });

  it("collapses the sidebar when Ask MCPJam opens on a normal tab", () => {
    renderAt("home");
    expect(state()).toBe("open");

    setAgentPanelOpen(true);

    expect(state()).toBe("closed");
  });

  it("expands again when Ask MCPJam closes on a normal tab", () => {
    renderAt("home");
    setAgentPanelOpen(true);
    expect(state()).toBe("closed");

    setAgentPanelOpen(false);

    expect(state()).toBe("open");
  });

  it("collapses even if the user had expanded the rail on a wide tab", () => {
    renderAt("playground");
    expect(state()).toBe("closed");

    fireEvent.click(screen.getByRole("button", { name: /toggle sidebar/i }));
    expect(state()).toBe("open");

    setAgentPanelOpen(true);

    expect(state()).toBe("closed");
  });

  it("stays collapsed after Ask MCPJam closes on a wide tab", () => {
    renderAt("playground");
    setAgentPanelOpen(true);
    expect(state()).toBe("closed");

    setAgentPanelOpen(false);

    expect(state()).toBe("closed");
  });

  it("does not re-expand a sidebar the user had already collapsed", () => {
    renderAt("home");
    fireEvent.click(screen.getByRole("button", { name: /toggle sidebar/i }));
    expect(state()).toBe("closed");

    setAgentPanelOpen(true);
    setAgentPanelOpen(false);

    expect(state()).toBe("closed");
  });

  it("collapses when the app loads with Ask MCPJam already open", () => {
    useAgentPanelStore.setState({ isOpen: true });

    renderAt("home");

    expect(state()).toBe("closed");
  });
});
