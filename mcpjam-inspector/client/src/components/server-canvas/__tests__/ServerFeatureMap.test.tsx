import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { ServerFeatureMap } from "../ServerFeatureMap";
import { buildFeatureCards } from "../feature-tree";
import { SERVER_FEATURE_CATALOG, evaluate, storedEvidence } from "./fixtures";

const cards = buildFeatureCards(SERVER_FEATURE_CATALOG, evaluate(storedEvidence()));
const root = {
  name: "atlas-workspace",
  version: "1.8.0",
  protocolVersion: "2025-11-25",
  featureCount: 257,
};

function Harness({
  initialSelected = null,
  onSelect,
}: {
  initialSelected?: string | null;
  onSelect?: (id: string | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(initialSelected);
  return (
    <div style={{ width: 900, height: 700 }}>
      <ServerFeatureMap
        root={root}
        cards={cards}
        selectedId={selected}
        onSelect={(id) => {
          setSelected(id);
          onSelect?.(id);
        }}
      />
    </div>
  );
}

function showList() {
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  return screen.getByTestId("server-feature-list");
}

describe("ServerFeatureMap", () => {
  it("opens on the canvas with every card and the read-only note", () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll("[data-card]")).toHaveLength(8);
    expect(
      screen.getByText(
        "Opening this view does not run checks or start server actions.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the same rows as a keyboard-browsable list", () => {
    render(<Harness />);
    const list = showList();
    expect(
      screen.getByRole("button", { name: "List view", pressed: true }),
    ).toBeInTheDocument();
    expect(within(list).getAllByRole("heading", { level: 3 })).toHaveLength(8);
    const first = within(list).getByRole("button", {
      name: /^Server information/,
    });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toHaveTextContent("Lifecycle and Discovery");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });

  it("expands a family and selects it when its row is clicked", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const list = showList();
    const tools = within(list).getByRole("button", { name: /^Tools/ });
    fireEvent.click(tools);
    expect(tools).toHaveAttribute("aria-expanded", "true");
    expect(onSelect).toHaveBeenCalledWith("tools-discovery");
    fireEvent.click(within(list).getByRole("button", { name: /^tools\/list,/ }));
    expect(onSelect).toHaveBeenLastCalledWith("tools.list");
  });

  it("opens the family of a selected feature", () => {
    render(<Harness initialSelected="prompts.capability" />);
    const list = showList();
    expect(
      within(list).getByRole("button", { name: /^Prompts/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(list).getByRole("button", { name: /^prompts capability,/ }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("searches names and ids and opens the matching families", () => {
    render(<Harness />);
    const list = showList();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search features, ids or methods" }),
      { target: { value: "tools/list" } },
    );
    expect(screen.getByRole("status")).toHaveTextContent(/features? match/);
    expect(
      within(list).getByRole("button", { name: /^tools\/list,/ }),
    ).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /^Prompts/ })).toBeNull();
  });

  it("filters by state through the state picker", async () => {
    render(<Harness />);
    const list = showList();
    const trigger = screen.getByRole("combobox", { name: "Show features" });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: "Could add" }));
    });
    const rows = list.querySelectorAll("li[data-state]");
    expect(rows.length).toBeGreaterThan(0);
    const states = new Set(
      Array.from(rows).map((row) => row.getAttribute("data-state")),
    );
    expect(states.has("could-add")).toBe(true);
    expect(states.has("not-checked")).toBe(false);
  });

  it("says when nothing matches and offers to show everything", () => {
    render(<Harness />);
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search features, ids or methods" }),
      { target: { value: "zzz-no-match" } },
    );
    expect(
      screen.getByText(
        "No features match. Clear the search or choose another filter.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all features" }));
    expect(
      screen.getByRole("searchbox", { name: "Search features, ids or methods" }),
    ).toHaveValue("");
  });
});
