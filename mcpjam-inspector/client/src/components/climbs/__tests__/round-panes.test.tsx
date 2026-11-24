import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const useRoundPanes = vi.fn();
vi.mock("../use-round-panes", () => ({ useRoundPanes: (...args: unknown[]) => useRoundPanes(...args) }));
vi.mock("../pane-card", () => ({
  PaneCard: ({ pane }: { pane: { title: string; sub: string } }) => (
    <div data-testid="pane">{pane.title} · {pane.sub}</div>
  ),
}));

import { RoundPanes } from "../round-panes";
import { makeClimb } from "./fixtures";

const climb = makeClimb({
  groups: {
    steering: 2,
    validation: 1,
    confirmation: 0,
    steeringCases: [
      { key: "case_1", tool: "list_projects" },
      { key: "case_2", tool: "show_servers" },
    ],
    steeringToolsWithoutValidation: [],
  },
});

describe("RoundPanes", () => {
  it("opens on a steering case the round failed and shows the three versions", () => {
    useRoundPanes.mockReturnValue({
      panes: [
        { letter: "A", title: "Baseline", sub: "env" },
        { letter: "B", title: "Best so far", sub: "Baseline + round 1" },
        { letter: "C", title: "This change", sub: "env" },
      ],
      caseTitles: { case_1: "Counts projects", case_2: "Lists servers" },
      loading: false,
    });
    render(<RoundPanes climb={climb} roundNumber={2} failedCaseKeys={["case_2"]} labels={{}} bestSub="Baseline + round 1" />);
    expect(screen.getAllByTestId("pane")).toHaveLength(3);
    expect(useRoundPanes.mock.calls.at(-1)?.[0]).toMatchObject({ caseKey: "case_2", mode: "version", roundNumber: 2 });
    expect(screen.getByRole("combobox", { name: "Case" })).toHaveTextContent("Lists servers");
  });

  it("switches to this change in each environment", async () => {
    useRoundPanes.mockReturnValue({ panes: [], caseTitles: {}, loading: false });
    render(<RoundPanes climb={climb} roundNumber={1} failedCaseKeys={[]} labels={{}} bestSub="Baseline" />);
    await userEvent.click(screen.getByRole("radio", { name: "By environment" }));
    expect(useRoundPanes.mock.calls.at(-1)?.[0]).toMatchObject({ mode: "environment", caseKey: "case_1" });
  });

  it("offers nothing when no steering case exists", () => {
    useRoundPanes.mockReturnValue({ panes: [], caseTitles: {}, loading: false });
    const { container } = render(
      <RoundPanes climb={makeClimb()} roundNumber={1} failedCaseKeys={[]} labels={{}} bestSub="Baseline" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
