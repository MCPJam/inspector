import { useDescribeSurface } from "@/lib/mcpjam-agent/describe-surface";
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
  useAgentPanelStore.getState().setOpen(false);
  useDescribeSurface.setState({
    scope: {
      kind: "evals",
      version: 1,
      id: "surface",
      projectId: "resolved-project",
      suiteId: "suite",
      suiteName: "Suite",
      caseId: "draft:describe",
    },
  });
});
it("renders inside the dashboard under its header and preserves its resolved project session", async () => {
  const sessionId = openEvalChat({
    projectId: "resolved-project",
    suiteId: "suite",
    suiteName: "Suite",
    caseId: "draft:describe",
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

it.each(["home", "servers", "chat", "settings", "tools", "evaluate"])(
  "cannot open chat on %s without a mounted Describe editor",
  (activeTab) => {
    useDescribeSurface.setState({ scope: null });
    render(
      <AgentSidePanelMount
        projectId="project"
        organizationId={null}
        activeTab={activeTab}
      />,
    );
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(useAgentPanelStore.getState().isOpen).toBe(false);
    expect(
      screen.queryByRole("complementary", { name: "Ask MCPJam" }),
    ).toBeNull();
    expect(screen.queryByText("General chat")).toBeNull();
  },
);
it("hides a retained session when Describe unmounts", () => {
  openEvalChat({
    projectId: "resolved-project",
    suiteId: "suite",
    suiteName: "Suite",
    caseId: "draft:describe",
  });
  render(
    <>
      <EvalAgentWorkspace projectId="resolved-project" organizationId={null}>
        <p>Editor</p>
      </EvalAgentWorkspace>
      <AgentSidePanelMount
        projectId="resolved-project"
        organizationId={null}
        activeTab="evaluate"
      />
    </>,
  );
  expect(screen.getByLabelText("Composer for resolved-project")).toBeVisible();
  act(() => useDescribeSurface.setState({ scope: null }));
  expect(
    screen.queryByRole("complementary", { name: "Ask MCPJam" }),
  ).toBeNull();
});
