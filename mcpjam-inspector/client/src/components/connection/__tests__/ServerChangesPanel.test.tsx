import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ServerChangesPanel } from "../ServerChangesPanel";
import type { ServerInspectionDiff } from "@/lib/inspection/types";

// Mock ScrollableJsonView to avoid json-editor complexity in tests
vi.mock("@/components/ui/json-editor", () => ({
  ScrollableJsonView: ({ value }: { value: unknown }) => (
    <pre data-testid="json-view">{JSON.stringify(value)}</pre>
  ),
}));

function makeDiff(
  overrides: Partial<ServerInspectionDiff> = {},
): ServerInspectionDiff {
  return {
    initChanges: [],
    toolChanges: [],
    computedAt: Date.now(),
    ...overrides,
  };
}

describe("ServerChangesPanel", () => {
  it("renders nothing when diff is null", () => {
    const { container } = render(<ServerChangesPanel diff={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when diff is undefined", () => {
    const { container } = render(<ServerChangesPanel diff={undefined} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when diff has no changes", () => {
    const { container } = render(<ServerChangesPanel diff={makeDiff()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders summary badges for added tools", () => {
    render(
      <ServerChangesPanel
        diff={makeDiff({
          toolChanges: [
            { type: "added", name: "tool_a" },
            { type: "added", name: "tool_b" },
          ],
        })}
      />,
    );
    const badge = screen.getByTestId("badge-added");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain("2 added");
  });

  it("renders summary badges for removed tools", () => {
    render(
      <ServerChangesPanel
        diff={makeDiff({
          toolChanges: [{ type: "removed", name: "old_tool" }],
        })}
      />,
    );
    const badge = screen.getByTestId("badge-removed");
    expect(badge.textContent).toContain("1 removed");
  });

  it("renders summary badges for changed tools", () => {
    render(
      <ServerChangesPanel
        diff={makeDiff({
          toolChanges: [
            {
              type: "changed",
              name: "t",
              changedFields: ["description"],
            },
          ],
        })}
      />,
    );
    const badge = screen.getByTestId("badge-changed");
    expect(badge.textContent).toContain("1 changed");
  });

  it("renders init changed badge", () => {
    render(
      <ServerChangesPanel
        diff={makeDiff({
          initChanges: [{ field: "protocolVersion", before: "1", after: "2" }],
        })}
      />,
    );
    const badge = screen.getByTestId("badge-init");
    expect(badge.textContent).toContain("Init changed");
  });

  it("renders added tool group", () => {
    render(
      <ServerChangesPanel
        diff={makeDiff({
          toolChanges: [
            {
              type: "added",
              name: "new_tool",
              after: { name: "new_tool", description: "Does stuff" },
            },
          ],
        })}
      />,
    );
    const group = screen.getByTestId("tool-group-added");
    expect(group).toBeInTheDocument();
    expect(screen.getByText("new_tool")).toBeInTheDocument();
  });

  it("renders removed tool group with strikethrough", () => {
    render(
      <ServerChangesPanel
        diff={makeDiff({
          toolChanges: [{ type: "removed", name: "old_tool" }],
        })}
      />,
    );
    const group = screen.getByTestId("tool-group-removed");
    expect(group).toBeInTheDocument();
    const toolName = screen.getByText("old_tool");
    expect(toolName.className).toContain("line-through");
  });

  it("renders changed tool group with field badges", () => {
    render(
      <ServerChangesPanel
        diff={makeDiff({
          toolChanges: [
            {
              type: "changed",
              name: "my_tool",
              changedFields: ["description", "inputSchema"],
              before: { name: "my_tool", description: "old" },
              after: { name: "my_tool", description: "new" },
            },
          ],
        })}
      />,
    );
    const group = screen.getByTestId("tool-group-changed");
    expect(group).toBeInTheDocument();
    expect(screen.getByText("description")).toBeInTheDocument();
    expect(screen.getByText("inputSchema")).toBeInTheDocument();
  });

  it("renders init change for string fields with before/after", () => {
    render(
      <ServerChangesPanel
        diff={makeDiff({
          initChanges: [
            {
              field: "protocolVersion",
              before: "2024-11-05",
              after: "2025-03-26",
            },
          ],
        })}
      />,
    );
    const changeEl = screen.getByTestId("init-change-protocolVersion");
    expect(changeEl).toBeInTheDocument();
    expect(screen.getByText("2024-11-05")).toBeInTheDocument();
    expect(screen.getByText("2025-03-26")).toBeInTheDocument();
  });

  it("renders init change for object fields with JSON views", () => {
    render(
      <ServerChangesPanel
        diff={makeDiff({
          initChanges: [
            {
              field: "serverCapabilities",
              before: { tools: {} },
              after: { tools: {}, prompts: {} },
            },
          ],
        })}
      />,
    );
    const jsonViews = screen.getAllByTestId("json-view");
    expect(jsonViews.length).toBeGreaterThanOrEqual(2);
  });
});
