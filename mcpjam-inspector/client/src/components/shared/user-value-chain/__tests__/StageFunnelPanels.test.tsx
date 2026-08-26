/**
 * The funnel panels' self-protection.
 *
 * These ship AHEAD of the backend query that answers them, so `useQuery`
 * throwing is the expected state during the dark window — and in any tree
 * without a `ConvexProvider`, which is every test that renders a host panel.
 *
 * The invariant is that the panel absorbs that itself rather than relying on
 * its caller: an `ErrorBoundary` only catches what its DESCENDANTS throw, so
 * a boundary placed inside the component that calls the hook would sit below
 * the throw and catch nothing. These tests render the panels with NO provider
 * and no boundary of their own — if the split ever regresses, they throw.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ScenarioStageFunnelPanel,
  SwarmRunStageFunnelPanels,
} from "../StageFunnelPanels";

describe("ScenarioStageFunnelPanel", () => {
  it("renders nothing instead of throwing when the query is unreachable", () => {
    const { container } = render(
      <ScenarioStageFunnelPanel scenarioId="scenario-1" />
    );
    expect(container.textContent).toBe("");
  });

  it("does not take its host down with it", () => {
    // The shape that matters: a sibling rendered beside the panel must still
    // be there. This is the User Testing sessions surface in miniature.
    const { getByTestId } = render(
      <div>
        <span data-testid="sibling">the rest of the page</span>
        <ScenarioStageFunnelPanel scenarioId="scenario-1" />
      </div>
    );
    expect(getByTestId("sibling").textContent).toBe("the rest of the page");
  });

  it("skips the query entirely with no scenario", () => {
    const { container } = render(
      <ScenarioStageFunnelPanel scenarioId={undefined} />
    );
    expect(container.textContent).toBe("");
  });
});

describe("SwarmRunStageFunnelPanels", () => {
  it("renders nothing instead of throwing when the query is unreachable", () => {
    const { container } = render(
      <SwarmRunStageFunnelPanels journeyRunIds={["run-1", "run-2"]} />
    );
    expect(container.textContent).toBe("");
  });

  it("does not take its host down with it", () => {
    const { getByTestId } = render(
      <div>
        <span data-testid="sibling">the rest of the page</span>
        <SwarmRunStageFunnelPanels journeyRunIds={["run-1"]} />
      </div>
    );
    expect(getByTestId("sibling").textContent).toBe("the rest of the page");
  });

  it("renders nothing at all for an empty run list — not even its spacing", () => {
    // The caller passes a possibly-empty set and cannot easily guard on it (an
    // empty Set is truthy), so the spacing rides on this component rather than
    // on a wrapper at the mount site. A wrapper would reserve padding for a
    // funnel that never appears, leaving a blank band above the session list.
    const { container } = render(
      <SwarmRunStageFunnelPanels
        journeyRunIds={[]}
        className="shrink-0 space-y-2 px-4 pt-3"
      />
    );
    expect(container.innerHTML).toBe("");
  });
});
