import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoundsRail } from "../rounds-rail";
import { makeClimb, makeRound } from "./fixtures";

function rail(rounds = [makeRound()], changes: React.ComponentProps<typeof RoundsRail>["changes"] = {}) {
  render(
    <RoundsRail
      climb={makeClimb({ state: "running", rounds })}
      selection={1}
      onSelect={vi.fn()}
      changes={changes}
    />,
  );
}

describe("RoundsRail", () => {
  it("marks a round a person overruled and says who and why on hover", () => {
    rail([makeRound({ verdict: "reverted", standing: "kept", overruled: { to: "kept", by: "Casey", reason: "It reads better.", at: 1 } })]);
    const row = screen.getByRole("button", { name: /Kept \(overruled\)/ });
    expect(row).toHaveAttribute("title", "Overruled by Casey: It reads better.");
  });

  it("shows one line for a code round where a mock round lists its change", () => {
    rail([makeRound({ serverId: "srv_branch" })], { 1: { code: { serverId: "srv_branch", serverName: "Echo (fast branch)" } } });
    expect(screen.getByText("Ran Echo (fast branch): your own code")).toBeInTheDocument();
  });

  it("leaves a round the rule decided unmarked", () => {
    rail();
    expect(screen.getByRole("button", { name: /Kept/ })).not.toHaveAttribute("title");
    expect(screen.queryByText(/overruled/)).not.toBeInTheDocument();
  });
});
