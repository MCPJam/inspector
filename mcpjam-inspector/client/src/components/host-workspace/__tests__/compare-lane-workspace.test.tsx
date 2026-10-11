import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompareLaneWorkspace } from "../CompareLaneWorkspace";

vi.mock("@/components/elicitation/OwnedPluginFormHost", () => ({
  OwnedPluginFormHost: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="lane-forms">{workspaceId}</div>
  ),
}));

const apps = {
  scope: {
    projectId: "project",
    hostId: "client",
    threadId: "lane-chat",
    pluginWorkspace: { version: 1 as const, workspaceId: "compare:lane" },
  },
  fileActions: null,
  panel: <input aria-label="Lane App" />,
  open: true,
} as never;

describe("compare lane workspace", () => {
  it("renders the lane exactly as before without an owner", () => {
    const { rerender } = render(
      <CompareLaneWorkspace
        apps={null}
        showDiagnostics={false}
        diagnostics={<p>Trace</p>}
      >
        <p>Chat</p>
      </CompareLaneWorkspace>,
    );
    expect(screen.getByText("Chat")).toBeInTheDocument();
    rerender(
      <CompareLaneWorkspace apps={null} showDiagnostics diagnostics={<p>Trace</p>}>
        <p>Chat</p>
      </CompareLaneWorkspace>,
    );
    expect(screen.queryByText("Chat")).toBeNull();
    expect(screen.getByText("Trace")).toBeInTheDocument();
  });

  it("keeps the lane's Apps mounted while its Trace view is shown", () => {
    const view = (showDiagnostics: boolean) => (
      <CompareLaneWorkspace
        apps={apps}
        showDiagnostics={showDiagnostics}
        diagnostics={<p>Trace</p>}
      >
        <p>Chat</p>
      </CompareLaneWorkspace>
    );
    const { rerender } = render(view(false));
    const app = screen.getByLabelText("Lane App");
    fireEvent.change(app, { target: { value: "state" } });
    expect(screen.getByTestId("lane-forms")).toHaveTextContent("compare:lane");
    rerender(view(true));
    expect(screen.getByText("Trace")).toBeInTheDocument();
    expect(app).not.toBeVisible();
    rerender(view(false));
    expect(screen.getByLabelText("Lane App")).toBe(app);
    expect(app).toHaveValue("state");
  });
});
