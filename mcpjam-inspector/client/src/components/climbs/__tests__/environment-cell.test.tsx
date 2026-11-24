import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EnvironmentCell } from "../environment-cell";
import { makeRoundDetail } from "./fixtures";

describe("EnvironmentCell", () => {
  it("shows pass rate and validation as the best so far, then this change", () => {
    const [env] = makeRoundDetail().environments;
    render(<EnvironmentCell name="MCPJam · Sonnet" env={env} measure="pass_rate" />);
    expect(screen.getByText("Better")).toBeInTheDocument();
    expect(screen.getByText("78% → 94%")).toBeInTheDocument();
    expect(screen.getByText("83% → 83%")).toBeInTheDocument();
    expect(screen.queryByText("Tokens")).not.toBeInTheDocument();
  });
  it("leads with the measure on a climb for tokens", () => {
    const env = {
      ...makeRoundDetail().environments[0],
      steering: { passRate: { bestBps: 10000, candidateBps: 10000, deltaBps: 0, noiseBps: 0, move: "none" as const }, measure: { ratioBps: 6900, noiseBps: 200, comparedCases: 6, move: "better" as const } },
    };
    render(<EnvironmentCell name="Claude Code" env={env} measure="tokens" />);
    expect(screen.getByText("Tokens")).toBeInTheDocument();
    expect(screen.getByText("31% lower")).toBeInTheDocument();
  });
  it("says Worse, and how many iterations the model provider lost", () => {
    const base = makeRoundDetail().environments[1];
    const env = { ...base, steering: { passRate: { bestBps: 9000, candidateBps: 7000, deltaBps: -2000, noiseBps: 560, move: "worse" as const } } };
    render(<EnvironmentCell name="Claude Code" env={env} measure="pass_rate" />);
    expect(screen.getByText("Worse")).toBeInTheDocument();
    expect(screen.getByText(/2 iterations lost to the model provider/)).toBeInTheDocument();
  });
  it("says there is nothing to compare when the environment has no numbers", () => {
    render(<EnvironmentCell name="Haiku" env={undefined} measure="pass_rate" />);
    expect(screen.getByText("Not compared")).toBeInTheDocument();
    expect(screen.getByText("No numbers to compare")).toBeInTheDocument();
  });
});
