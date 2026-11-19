import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  RevisionDiffView,
  type RevisionSide,
  type SnapshotDiff,
} from "../ServerHistoryDiff";

function changedTool(name: string, before: string, after: string) {
  return {
    name,
    changedFields: ["description"],
    before: { name, description: before },
    after: { name, description: after },
  };
}

function diffWith(
  changed: SnapshotDiff["tools"]["changed"],
  discovery?: SnapshotDiff["discovery"],
): SnapshotDiff {
  return { discovery, tools: { added: [], removed: [], changed } };
}

const from: RevisionSide = {
  revisionNumber: 5,
  discovery: {
    serverInfo: { name: "Markets MCP Server", version: "4.1.2" },
    instructions: "Call list_markets first.",
  },
};
const to: RevisionSide = {
  revisionNumber: 6,
  discovery: {
    serverInfo: { name: "Markets MCP Server", version: "1.7.0" },
    instructions: "Call list_markets before placing an order.",
  },
};

function toolButton(name: string) {
  return screen.getByRole("button", { name: new RegExp(name) });
}

describe("RevisionDiffView", () => {
  it("shows the old and new text of a changed description", () => {
    render(
      <RevisionDiffView
        diff={diffWith([
          changedTool(
            "list_assets",
            "List assets on the exchange.",
            "List assets on the exchange, with custody status.",
          ),
        ])}
        from={from}
        to={to}
      />,
    );

    expect(toolButton("list_assets")).toHaveAttribute("aria-expanded", "true");
    const removed = screen.getByText("Removed:").parentElement;
    const added = screen.getByText("Added:").parentElement;
    expect(removed).toHaveTextContent("List assets on the exchange.");
    expect(added).toHaveTextContent(
      "List assets on the exchange, with custody status.",
    );
  });

  it("starts closed past five changed tools and opens on click", () => {
    const changed = Array.from({ length: 6 }, (_, index) =>
      changedTool(`tool_${index}`, `Old ${index}.`, `New ${index}.`),
    );
    render(<RevisionDiffView diff={diffWith(changed)} from={from} to={to} />);

    expect(screen.queryByText("Removed:")).not.toBeInTheDocument();
    fireEvent.click(toolButton("tool_2"));
    expect(toolButton("tool_2")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Removed:").parentElement).toHaveTextContent(
      "Old 2.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getAllByText("Removed:")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByText("Removed:")).not.toBeInTheDocument();
  });

  it("shows server info values, with short ones as old and new", () => {
    render(
      <RevisionDiffView
        diff={diffWith([], {
          changed: true,
          changedFields: ["serverInfo.version", "instructions"],
        })}
        from={from}
        to={to}
      />,
    );

    const version = screen.getByText("version").parentElement!;
    expect(within(version).getByText("4.1.2")).toBeInTheDocument();
    expect(within(version).getByText("1.7.0")).toBeInTheDocument();
    expect(screen.getByText("Added:").parentElement).toHaveTextContent(
      "Call list_markets before placing an order.",
    );
  });

  it("says when storage dropped a side instead of showing a deletion", () => {
    render(
      <RevisionDiffView
        diff={diffWith([], { changed: true, changedFields: ["instructions"] })}
        from={from}
        to={{ ...to, droppedFields: ["discovery.instructions"] }}
      />,
    );

    expect(
      screen.getByText(/Revision 6 was too large to store in full/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Removed:")).not.toBeInTheDocument();
  });

  it("waits for the revisions before drawing server info", () => {
    render(
      <RevisionDiffView
        diff={diffWith([], { changed: true, changedFields: ["instructions"] })}
        from={undefined}
        to={to}
      />,
    );

    expect(screen.getByText("instructions")).toBeInTheDocument();
    expect(screen.queryByText("Removed:")).not.toBeInTheDocument();
  });

  it("says so when a revision is missing", () => {
    render(
      <RevisionDiffView
        diff={diffWith([], { changed: true, changedFields: ["instructions"] })}
        from={null}
        to={to}
      />,
    );

    expect(
      screen.getByText("Revision not found, so these values can't be shown."),
    ).toBeInTheDocument();
  });
});
