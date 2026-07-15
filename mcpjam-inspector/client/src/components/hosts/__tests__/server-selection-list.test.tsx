import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import {
  ServerSelectionList,
  type ServerOption,
} from "@/components/hosts/server-selection-list";

const baseServers: ServerOption[] = [
  { id: "s_a", name: "Alpha", meta: "https://alpha.example.com" },
  { id: "s_b", name: "Bravo" },
  { id: "s_c", name: "Charlie", meta: "https://charlie.example.com" },
];

describe("ServerSelectionList", () => {
  it("renders one row per server, with meta when provided", () => {
    render(
      <ServerSelectionList
        servers={baseServers}
        selectedIds={new Set()}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(screen.getByText("Charlie")).toBeInTheDocument();
    expect(
      screen.getByText("https://alpha.example.com"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("https://charlie.example.com"),
    ).toBeInTheDocument();
    // Bravo has no meta, so no second text node under it.
    expect(
      screen.queryByText("https://bravo.example.com"),
    ).not.toBeInTheDocument();
  });

  it("renders selected rows with checked checkboxes", () => {
    render(
      <ServerSelectionList
        servers={baseServers}
        selectedIds={new Set(["s_a", "s_c"])}
        onToggle={vi.fn()}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]).toBeChecked(); // Alpha
    expect(checkboxes[1]).not.toBeChecked(); // Bravo
    expect(checkboxes[2]).toBeChecked(); // Charlie
  });

  it("calls onToggle with (id, true) when an unselected checkbox is clicked", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ServerSelectionList
        servers={baseServers}
        selectedIds={new Set()}
        onToggle={onToggle}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Bravo" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("s_b", true);
  });

  it("calls onToggle with (id, false) when a selected checkbox is clicked", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ServerSelectionList
        servers={baseServers}
        selectedIds={new Set(["s_a"])}
        onToggle={onToggle}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Alpha" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("s_a", false);
  });

  it("respects disabled — clicking does not fire onToggle", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ServerSelectionList
        servers={baseServers}
        selectedIds={new Set()}
        onToggle={onToggle}
        disabled
      />,
    );
    const alpha = screen.getByRole("checkbox", { name: "Alpha" });
    expect(alpha).toBeDisabled();
    await user.click(alpha);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("renders the default empty-state when servers is empty and no override is given", () => {
    render(
      <ServerSelectionList
        servers={[]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("No servers available.")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("renders a caller-provided emptyState when servers is empty", () => {
    render(
      <ServerSelectionList
        servers={[]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        emptyState={
          <p data-testid="custom-empty">Attach a client to see servers.</p>
        }
      />,
    );
    expect(screen.getByTestId("custom-empty")).toBeInTheDocument();
    expect(
      screen.queryByText("No servers available."),
    ).not.toBeInTheDocument();
  });

  it("uses the ariaLabel prop for the surrounding group", () => {
    render(
      <ServerSelectionList
        servers={baseServers}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        ariaLabel="Suite servers"
      />,
    );
    expect(
      screen.getByRole("group", { name: "Suite servers" }),
    ).toBeInTheDocument();
  });
});
