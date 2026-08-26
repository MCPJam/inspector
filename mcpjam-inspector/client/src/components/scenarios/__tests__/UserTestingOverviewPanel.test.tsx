/**
 * The scenario list is the landing screen for User Testing, so two things
 * matter more than layout: it must not claim numbers it doesn't have, and it
 * must not white-screen when the backend is older than the client.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioListItem } from "@/hooks/useScenarios";

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/lib/scenario-client-style", () => ({
  getScenarioHostLabel: (style: string) => {
    // A row can only blow up the render through one of these helpers now that
    // the field reads are guarded; this is the lever the failure test pulls.
    if (style === "explode") throw new TypeError("bad row");
    return `Label:${style}`;
  },
  getScenarioHostLogo: () => "logo.png",
}));

import { UserTestingOverviewPanel } from "../UserTestingOverviewPanel";

const row = (over: Partial<ScenarioListItem> = {}): ScenarioListItem => ({
  scenarioId: "cb1",
  projectId: "p1",
  name: "Payments beta",
  hostStyle: "cursor",
  mode: "anyone_with_link",
  allowGuestAccess: true,
  serverCount: 1,
  serverNames: ["acme-payments"],
  namedHostId: "host-1",
  namedHostName: "Cursor",
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

const defaults = {
  isLoading: false,
  onOpenScenario: vi.fn(),
  onCreateScenario: vi.fn(),
  createLabel: "New client",
};

describe("UserTestingOverviewPanel", () => {
  it("renders a scenario's client, server and tester count", () => {
    render(
      <UserTestingOverviewPanel
        {...defaults}
        scenarios={[row({ uniqueTesterCount: 24, lastSessionAt: Date.now() })]}
      />,
    );

    expect(screen.getByText("Payments beta")).toBeInTheDocument();
    expect(screen.getByText("Label:cursor")).toBeInTheDocument();
    expect(screen.getByText("acme-payments")).toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-overview-testers"),
    ).toHaveTextContent("24");
  });

  // A backend that predates the counters sends nothing. "0 testers" and "we
  // don't know yet" are different claims, and only one of them should send
  // someone looking for a bug.
  it("shows an em dash, not zero, when the counters are absent", () => {
    render(<UserTestingOverviewPanel {...defaults} scenarios={[row()]} />);

    expect(
      screen.getByTestId("user-testing-overview-testers"),
    ).toHaveTextContent("—");
  });

  it("counts a genuinely untested scenario as zero", () => {
    render(
      <UserTestingOverviewPanel
        {...defaults}
        scenarios={[row({ uniqueTesterCount: 0 })]}
      />,
    );

    expect(
      screen.getByTestId("user-testing-overview-testers"),
    ).toHaveTextContent("0");
  });

  it("opens a scenario by its SCENARIO id, not the host it displays", () => {
    const onOpenScenario = vi.fn();
    render(
      <UserTestingOverviewPanel
        {...defaults}
        onOpenScenario={onOpenScenario}
        scenarios={[row({ scenarioId: "cb-42", namedHostId: "host-42" })]}
      />,
    );

    fireEvent.click(screen.getByTestId("user-testing-overview-row"));

    // Several environment-backed scenarios can display the SAME host, so the
    // host id doesn't address a row.
    expect(onOpenScenario).toHaveBeenCalledWith("cb-42");
  });

  it("badges a row whose environment can't resolve, instead of hiding it", () => {
    render(
      <UserTestingOverviewPanel
        {...defaults}
        scenarios={[
          row({
            environmentId: "env-1",
            environmentError: {
              code: "ENV_ARCHIVED",
              message: "Environment “prod” is archived.",
            },
          }),
        ]}
      />,
    );

    // Its share link is still minted — the person who can retire it has to be
    // able to see it.
    expect(screen.getByTestId("user-testing-overview-row")).toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-overview-row-error"),
    ).toHaveAttribute("aria-label", "Environment “prod” is archived.");
  });

  it("shows no error badge on a healthy row", () => {
    render(<UserTestingOverviewPanel {...defaults} scenarios={[row()]} />);

    expect(
      screen.queryByTestId("user-testing-overview-row-error"),
    ).not.toBeInTheDocument();
  });

  it("renders the empty state, with the create action, when there are none", () => {
    const onCreateScenario = vi.fn();
    render(
      <UserTestingOverviewPanel
        {...defaults}
        onCreateScenario={onCreateScenario}
        scenarios={[]}
      />,
    );

    expect(
      screen.getByTestId("user-testing-overview-empty"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New client/i }));
    expect(onCreateScenario).toHaveBeenCalled();
  });

  // The empty state carries the only explanation of what a scenario IS, and it
  // read as a parenthetical buried inside a long clause. One dash can be
  // deliberate; two in one sentence means the sentence wanted to be two.
  it("explains a study in the frame's words, without a double-dash parenthetical", () => {
    render(<UserTestingOverviewPanel {...defaults} scenarios={[]} />);

    const empty = screen.getByTestId("user-testing-overview-empty");
    const copy = empty.textContent ?? "";

    expect(copy).toContain("Create your first study");
    expect(copy).toContain("A study starts with a link you send");
    expect(copy).toContain("their sessions are recorded here");
    // No table placeholders live in the empty state, so every dash here is prose.
    expect(copy.split("—").length - 1).toBeLessThan(2);
  });

  it("fills the panel so it can centre in it, like the Swarm empty state", () => {
    // jsdom has no layout, so the class is the only observable: without a
    // height of its own the box is content-tall and `justify-center` does
    // nothing, which left the notice pinned to the top of the panel.
    render(<UserTestingOverviewPanel {...defaults} scenarios={[]} />);

    const empty = screen.getByTestId("user-testing-overview-empty");
    expect(empty.className).toContain("min-h-full");
    expect(empty.className).toContain("justify-center");
  });

  it("leads with the study illustration, not a persona avatar", () => {
    // BB-125's own bitmap, now that the asset exists. A persona avatar reads as
    // "a user"; this page is about a study.
    render(<UserTestingOverviewPanel {...defaults} scenarios={[]} />);

    const art = screen.getByTestId("user-testing-empty-illustration");
    expect(art).toBeVisible();
    expect(art).toHaveAttribute("src", "/user-testing-empty.png");
    // Decorative: the heading and body below already say what this is, so a
    // screen reader announcing the art too would only repeat them.
    expect(art).toHaveAttribute("alt", "");
    expect(
      screen.queryByTestId("persona-pixel-avatar")
    ).not.toBeInTheDocument();
  });

  it("shows a skeleton while the list is loading, not an empty state", () => {
    render(
      <UserTestingOverviewPanel
        {...defaults}
        isLoading
        scenarios={undefined}
      />,
    );

    expect(
      screen.getByTestId("user-testing-overview-loading"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("user-testing-overview-empty"),
    ).not.toBeInTheDocument();
  });

  // A backend that stops sending a field must cost that CELL, not the row and
  // not the screen.
  it("still renders a row that is missing its server list", () => {
    const malformed = {
      ...row(),
      serverNames: undefined,
      serverCount: 2,
    } as unknown as ScenarioListItem;

    render(<UserTestingOverviewPanel {...defaults} scenarios={[malformed]} />);

    expect(screen.getByText("Payments beta")).toBeInTheDocument();
    expect(screen.getByText("2 servers")).toBeInTheDocument();
  });

  // When the list genuinely can't render, say so. Reusing the empty state here
  // would tell a user with scenarios that they have none — and send them off
  // to create a duplicate.
  it("shows a failure notice, not an empty state, when a row throws", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(
      <UserTestingOverviewPanel
        {...defaults}
        scenarios={[
          row({ hostStyle: "explode" as ScenarioListItem["hostStyle"] }),
        ]}
      />,
    );

    expect(
      screen.getByTestId("user-testing-overview-error"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("user-testing-overview-empty"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No scenarios yet/i)).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  // The list hook reports `isLoading: false` with no data when the query is
  // skipped (signed out, no project). Spinning on that forever is the failure
  // mode this guards.
  it("does not spin forever when the query was never issued", () => {
    render(
      <UserTestingOverviewPanel
        {...defaults}
        isLoading={false}
        scenarios={undefined}
      />,
    );

    expect(
      screen.queryByTestId("user-testing-overview-loading"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-overview-empty"),
    ).toBeInTheDocument();
  });
});
