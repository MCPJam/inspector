import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GoalFindingsModel } from "../findings-derivation";
import { FindingsGoalInspect } from "../findings-goal-inspect";
import type { JourneyStageId } from "../journey-stages";

function goal(): GoalFindingsModel {
  const empty = { state: "none" as const, evidence: [] };
  return {
    journeyRefId: "journey-1",
    runId: "run-1",
    title: "Export the board",
    sessions: 3,
    sentiment: { label: "Stalled", tone: "fail" },
    stages: {
      connection: { state: "warn", evidence: [] },
      discovery: { state: "ok", evidence: [] },
      selection: { state: "warn", evidence: [] },
      call: empty,
      response: empty,
      value: { state: "fail", evidence: [] },
    },
    diagnosisStage: "value",
    diagnosis: { title: "User value", detail: "The task did not complete." },
    defaultStage: "value",
  };
}

function renderInspect(selectedStage: JourneyStageId) {
  const onSelectStage = vi.fn();
  const view = render(
    <FindingsGoalInspect
      goal={goal()}
      selectedStage={selectedStage}
      onSelectStage={onSelectStage}
    />
  );
  return { ...view, onSelectStage };
}

describe("FindingsGoalInspect stage selection", () => {
  it("keeps fail, warn, and none fills when selected — selection is a ring, not a recast", () => {
    const { rerender, onSelectStage } = renderInspect("value");

    const fail = screen.getByTestId("findings-stage-value");
    expect(fail).toHaveAttribute("aria-selected", "true");
    expect(fail.className).toMatch(/bg-red-500\/20/);
    expect(fail.className).not.toMatch(/bg-orange-300/);
    expect(fail.className).toMatch(/ring-white/);

    fireEvent.click(screen.getByTestId("findings-stage-selection"));
    expect(onSelectStage).toHaveBeenCalledWith("selection");
    rerender(
      <FindingsGoalInspect
        goal={goal()}
        selectedStage="selection"
        onSelectStage={onSelectStage}
      />
    );
    const warn = screen.getByTestId("findings-stage-selection");
    expect(warn).toHaveAttribute("aria-selected", "true");
    expect(warn.className).toMatch(/bg-amber-400\/15/);
    expect(warn.className).not.toMatch(/bg-orange-300/);
    expect(warn.className).toMatch(/ring-white/);

    fireEvent.click(screen.getByTestId("findings-stage-call"));
    expect(onSelectStage).toHaveBeenCalledWith("call");
    rerender(
      <FindingsGoalInspect
        goal={goal()}
        selectedStage="call"
        onSelectStage={onSelectStage}
      />
    );
    const none = screen.getByTestId("findings-stage-call");
    expect(none).toHaveAttribute("aria-selected", "true");
    expect(none.className).toMatch(/bg-white\/\[0\.045\]/);
    expect(none.className).not.toMatch(/bg-orange-300/);
    expect(none.className).toMatch(/ring-white/);
  });
});

describe("FindingsGoalInspect swimlane", () => {
  it("puts call and response on the server lane, everything else on the client", () => {
    renderInspect("value");

    const lanes = Object.fromEntries(
      (["connection", "discovery", "selection", "call", "response", "value"] as const).map(
        (id) => [id, screen.getByTestId(`findings-stage-${id}`).dataset.lane]
      )
    );
    expect(lanes).toEqual({
      connection: "client",
      discovery: "client",
      selection: "client",
      call: "server",
      response: "server",
      // The last stage comes back to the client — a server column that ran
      // clean must be able to sit above a failing user value.
      value: "client",
    });
  });

  it("renders chain numbers at body-readable size, not caption opacity", () => {
    renderInspect("value");

    const first = screen.getByTestId("findings-stage-connection");
    const number = first.querySelector("span");
    expect(number).toHaveTextContent("01");
    expect(number?.className).toMatch(/text-\[11px\]/);
    expect(number?.className).toMatch(/font-semibold/);
    expect(number?.className).not.toMatch(/opacity-60/);
    expect(
      within(screen.getByTestId("findings-stage-swimlane"))
        .getAllByRole("tab")
        .map((tab) => tab.querySelector("span")?.textContent)
    ).toEqual(["01", "02", "03", "04", "05", "06"]);
  });

  it("keeps DOM order in chain order so time reads top to bottom", () => {
    renderInspect("value");

    const swimlane = screen.getByTestId("findings-stage-swimlane");
    expect(
      within(swimlane)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("data-testid"))
    ).toEqual([
      "findings-stage-connection",
      "findings-stage-discovery",
      "findings-stage-selection",
      "findings-stage-call",
      "findings-stage-response",
      "findings-stage-value",
    ]);
  });

  it("marks a hand-off only where the chain crosses the wire", () => {
    renderInspect("value");

    // 03 Tool Selection → 04 Tool Call, and 05 Tool Response → 06 User Value.
    expect(
      screen
        .getAllByTestId("findings-lane-crossing")
        .map((crossing) => crossing.dataset.to)
    ).toEqual(["server", "client"]);
  });

  it("draws the system boundary between the lanes", () => {
    renderInspect("value");

    expect(screen.getByTestId("findings-lane-boundary")).toBeInTheDocument();
  });

  it("labels both lanes", () => {
    renderInspect("value");

    const swimlane = screen.getByTestId("findings-stage-swimlane");
    expect(
      within(swimlane).getAllByText("Client / agent").length
    ).toBeGreaterThan(0);
    expect(within(swimlane).getAllByText("Server").length).toBeGreaterThan(0);
  });
});
