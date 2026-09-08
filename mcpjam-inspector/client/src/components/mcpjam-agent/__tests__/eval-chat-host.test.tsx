import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentSidePanelMount } from "../AgentSidePanelMount";
import { EvalAgentWorkspace } from "@/components/evaluate/eval-agent-workspace";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { openEvalChat } from "@/lib/mcpjam-agent/eval-scope";
vi.mock("@/hooks/use-app-ready", () => ({
  useAppReady: () => ({ status: "ready" }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../McpjamAgentThread", () => ({
  McpjamAgentThread: ({ projectId }: any) => (
    <textarea aria-label={`Composer for ${projectId}`} />
  ),
}));
vi.mock("../McpjamAgentHero", () => ({
  McpjamAgentHero: () => <div>General chat</div>,
}));
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  useAgentPanelStore.getState().setActiveSession(null, null);
});
it("renders inside the dashboard under its header and preserves its resolved project session", async () => {
  const sessionId = openEvalChat({
    projectId: "resolved-project",
    suiteId: "suite",
    suiteName: "Suite",
  });
  render(
    <>
      <header>Evaluate header</header>
      <EvalAgentWorkspace projectId="resolved-project" organizationId={null}>
        <button>Edit steps</button>
      </EvalAgentWorkspace>
      <AgentSidePanelMount
        projectId="bootstrap-project"
        organizationId={null}
        activeTab="evaluate"
      />
    </>,
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("Composer for resolved-project"),
    ).toBeVisible(),
  );
  expect(useAgentPanelStore.getState().activeSessionId).toBe(sessionId);
  const workspace = screen.getByTestId("eval-agent-workspace");
  expect(workspace).toContainElement(
    screen.getByRole("complementary", { name: "Ask MCPJam" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Edit steps" })).toBeEnabled();
  act(() => useAgentPanelStore.getState().setOpen(false));
  act(() => useAgentPanelStore.getState().setOpen(true));
  expect(screen.getByLabelText("Composer for resolved-project")).toBeVisible();
  expect(
    screen.getAllByRole("complementary", { name: "Ask MCPJam" }),
  ).toHaveLength(1);
});

it.each(["home", "servers", "chat", "settings", "tools"])(
  "opens general chat on %s without carrying over the eval conversation",
  (activeTab) => {
    openEvalChat({
      projectId: "project",
      suiteId: "suite",
      suiteName: "Suite",
    });
    render(
      <AgentSidePanelMount
        projectId="project"
        organizationId={null}
        activeTab={activeTab}
      />,
    );
    expect(
      screen.queryByRole("complementary", { name: "Ask MCPJam" }),
    ).toBeNull();
    expect(useAgentPanelStore.getState().isOpen).toBe(false);
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(useAgentPanelStore.getState().isOpen).toBe(true);
    expect(useAgentPanelStore.getState().activeSessionId).toBeNull();
    expect(screen.getByText("General chat")).toBeVisible();
  },
);

it("opens general chat on the Evaluate landing page without a suite context", () => {
  useAgentPanelStore.getState().setOpen(false);
  render(
    <AgentSidePanelMount
      projectId="project"
      organizationId={null}
      activeTab="evaluate"
    />,
  );
  fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
  expect(screen.getByText("General chat")).toBeVisible();
});

it("closes on leaving Evaluate and requires an explicit request when returning", () => {
  const scope = { projectId: "project", suiteId: "suite", suiteName: "Suite" };
  const sessionId = openEvalChat(scope);
  const view = (activeTab: string) => (
    <>
      <EvalAgentWorkspace projectId="project" organizationId={null}>
        <button>Edit steps</button>
      </EvalAgentWorkspace>
      <AgentSidePanelMount
        projectId="project"
        organizationId={null}
        activeTab={activeTab}
      />
    </>
  );
  const { rerender } = render(view("evaluate"));
  expect(screen.getByLabelText("Composer for project")).toBeVisible();
  rerender(view("servers"));
  expect(
    screen.queryByRole("complementary", { name: "Ask MCPJam" }),
  ).toBeNull();
  rerender(view("evaluate"));
  expect(
    screen.queryByRole("complementary", { name: "Ask MCPJam" }),
  ).toBeNull();
  act(() => {
    expect(openEvalChat(scope)).toBe(sessionId);
  });
  expect(screen.getByLabelText("Composer for project")).toBeVisible();
});
