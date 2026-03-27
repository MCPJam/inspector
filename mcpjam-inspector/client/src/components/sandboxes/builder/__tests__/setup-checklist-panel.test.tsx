import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SetupChecklistPanel } from "../setup-checklist-panel";
import { SANDBOX_STARTERS } from "../drafts";

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

    expect(screen.queryByRole("heading", { name: "Setup" })).not.toBeInTheDocument();
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
