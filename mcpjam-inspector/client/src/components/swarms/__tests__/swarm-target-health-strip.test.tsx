import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SwarmWaveTargetHealth } from "@/lib/swarm-api";
import { SwarmTargetHealthStrip } from "../swarm-target-health-strip";

/**
 * Launch outcomes are REPORTED, never mined.
 *
 * A target that never reached a session used to become a `target_failures`
 * finding: a confident "your MCP server is broken" row with no session to
 * open behind it. The miner now emits those outcomes as `targetHealth` and
 * this strip is where they land — beside the findings, never among them.
 */

function health(
  overrides: Partial<SwarmWaveTargetHealth> = {}
): SwarmWaveTargetHealth {
  return {
    subjectKind: "environment",
    subjectId: "env-1",
    subjectLabel: "Prod stack",
    attempted: 4,
    succeeded: 1,
    failed: 2,
    rateLimited: 1,
    ...overrides,
  };
}

describe("SwarmTargetHealthStrip", () => {
  it("keeps rate limited apart from failed", () => {
    // Summing them made every throttled wave read as an outage.
    render(<SwarmTargetHealthStrip targetHealth={[health()]} terminal />);
    expect(screen.getByTestId("swarm-target-health-failed")).toHaveTextContent(
      "2 failed"
    );
    expect(
      screen.getByTestId("swarm-target-health-rate-limited")
    ).toHaveTextContent("1 rate limited");
  });

  it("says these are launch outcomes, not a finding about the server", () => {
    render(<SwarmTargetHealthStrip targetHealth={[health()]} terminal />);
    expect(screen.getByTestId("swarm-target-health")).toHaveTextContent(
      /not a finding about the server/i
    );
  });

  it("stays silent while the wave is still running", () => {
    // Mid-run counts move: an attempt about to be retried reads as a failure
    // until it isn't, and an outage banner over a healthy run is worse than
    // no banner.
    const { container } = render(
      <SwarmTargetHealthStrip targetHealth={[health()]} terminal={false} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("stays silent when every launch succeeded", () => {
    const { container } = render(
      <SwarmTargetHealthStrip
        targetHealth={[
          health({ attempted: 3, succeeded: 3, failed: 0, rateLimited: 0 }),
        ]}
        terminal
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("tolerates a server deployed before the field existed", () => {
    const { container } = render(
      <SwarmTargetHealthStrip targetHealth={undefined} terminal />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("stays silent when target health is present but empty", () => {
    const { container } = render(
      <SwarmTargetHealthStrip targetHealth={[]} terminal />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists one row per troubled target, hiding the healthy ones", () => {
    render(
      <SwarmTargetHealthStrip
        targetHealth={[
          health(),
          health({
            subjectKind: "host",
            subjectId: "h-2",
            subjectLabel: "Cursor",
            attempted: 2,
            succeeded: 2,
            failed: 0,
            rateLimited: 0,
          }),
        ]}
        terminal
      />
    );
    const rows = screen.getAllByTestId("swarm-target-health-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-subject-id", "env-1");
  });
});
