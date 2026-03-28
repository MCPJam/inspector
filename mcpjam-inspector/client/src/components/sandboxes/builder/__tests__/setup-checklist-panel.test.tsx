import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ServerSelectionEditor,
  SetupChecklistPanel,
} from "../setup-checklist-panel";
import { SANDBOX_STARTERS } from "../drafts";
import type { RemoteServer } from "@/hooks/useWorkspaces";

const baseDraft = SANDBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
  "openai/gpt-5-mini",
);

describe("SetupChecklistPanel", () => {
  it("does not render the Setup header row on desktop (no onCloseMobile)", () => {
    render(
      <SetupChecklistPanel
        sandboxDraft={baseDraft}
        savedSandbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
      />,
    );

    expect(
      screen.queryByRole("heading", { name: "Setup" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Basics/i })).toBeInTheDocument();
  });

  it("renders mobile Done header when onCloseMobile is provided", () => {
    render(
      <SetupChecklistPanel
        sandboxDraft={baseDraft}
        savedSandbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
        onCloseMobile={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Setup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("uses a compact description field (2 rows)", () => {
    render(
      <SetupChecklistPanel
        sandboxDraft={baseDraft}
        savedSandbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Basics/i }));
    const description = screen.getByLabelText(/Description/i);
    expect(description).toHaveAttribute("rows", "2");
  });
});

describe("ServerSelectionEditor", () => {
  const httpServer: RemoteServer = {
    _id: "srv-1",
    workspaceId: "ws-1",
    name: "Linear MCP",
    enabled: true,
    transportType: "http",
    url: "https://mcp.linear.app/mcp",
    useOAuth: true,
  };

  const httpServerB: RemoteServer = {
    _id: "srv-2",
    workspaceId: "ws-1",
    name: "Other MCP",
    enabled: true,
    transportType: "http",
    url: "https://example.com/mcp",
    useOAuth: false,
  };

  it("uses a Required / Optional toggle for when the sandbox opens", () => {
    const onOptionalChange = vi.fn();
    render(
      <ServerSelectionEditor
        workspaceServers={[httpServer, httpServerB]}
        selectedServerIds={[httpServer._id, httpServerB._id]}
        optionalServerIds={[]}
        onToggleSelection={() => {}}
        onOptionalChange={onOptionalChange}
        onOpenAdd={() => {}}
      />,
    );

    expect(screen.getAllByText("When sandbox opens")).toHaveLength(2);
    const requiredButtons = screen.getAllByRole("radio", {
      name: /Required: connect when sandbox opens/i,
    });
    expect(requiredButtons[0]).toHaveAttribute("data-state", "on");
    fireEvent.click(
      screen.getAllByRole("radio", {
        name: /Optional: off until tester adds from chat/i,
      })[0]!,
    );
    expect(onOptionalChange).toHaveBeenCalledWith(httpServer._id, true);
  });
});
