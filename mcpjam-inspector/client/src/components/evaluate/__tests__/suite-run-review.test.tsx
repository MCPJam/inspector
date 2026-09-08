import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuiteRunReview, selectReviewTargets } from "../suite-run-review";
import type { EvalSuite, EvalCase } from "../../evals/types";
const suite = {
  _id: "suite",
  name: "Checkout",
  environment: { servers: [] },
  environmentIds: ["env-sonnet", "env-opus"],
  minIterations: 5,
  verdictPolicyVersion: 2,
  verdictPolicyDefaults: { repetitions: 5, passThreshold: 0.8 },
} as EvalSuite;
const cases = [
  { _id: "one", runs: 1, models: [] },
  { _id: "two", runs: 1, models: [] },
] as unknown as EvalCase[];
const environments = [
  { environmentId: "env-sonnet", hostId: "claude", modelId: "sonnet" },
  { environmentId: "env-opus", hostId: "claude", modelId: "opus" },
];
const names = new Map([["claude", "Claude"]]);

describe("suite run review", () => {
  it("requires a target and never mutates suite defaults", () => {
    expect(() => selectReviewTargets(suite, [])).toThrow("Select at least one");
    expect(() => selectReviewTargets(suite, ["stale"])).toThrow(
      "no longer attached",
    );
    expect(selectReviewTargets(suite, ["env-opus"]).environmentIds).toEqual([
      "env-opus",
    ]);
    expect(suite.environmentIds).toEqual(["env-sonnet", "env-opus"]);
  });
  it("launches selected targets with a validated one-off iteration count", async () => {
    const user = userEvent.setup();
    const start = vi.fn();
    const close = vi.fn();
    render(
      <SuiteRunReview
        suite={suite}
        cases={cases}
        environments={environments}
        hostNamesById={names}
        onStart={start}
        onClose={close}
      />,
    );
    expect(screen.getByRole("spinbutton")).toHaveValue(3);
    expect(screen.getByText("80%")).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "Claude · sonnet" }));
    await user.clear(screen.getByRole("spinbutton"));
    await user.type(screen.getByRole("spinbutton"), "11");
    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
    await user.clear(screen.getByRole("spinbutton"));
    await user.type(screen.getByRole("spinbutton"), "4");
    await user.click(screen.getByRole("button", { name: "Start run" }));
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ environmentIds: ["env-opus"] }),
      { iterationOverride: 4 },
    );
    expect(close).toHaveBeenCalledOnce();
  });
  it("does not show its own in-progress launch as a blocker", async () => {
    let finish!: () => void;
    const onStart = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    const props = { suite, cases, environments, hostNamesById: names, onStart, onClose };
    const { rerender } = render(<SuiteRunReview {...props} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Start run" }));
    rerender(<SuiteRunReview {...props} disabledReason="A suite or replay is already in progress." />);
    expect(screen.queryByText("A suite or replay is already in progress.")).toBeNull();
    expect(screen.getByRole("button", { name: "Starting run…" })).toBeDisabled();
    await act(async () => finish());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("holds launch while pending and preserves selections after failure", async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const start = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const close = vi.fn();
    render(
      <SuiteRunReview
        suite={suite}
        cases={cases}
        environments={environments}
        hostNamesById={names}
        onStart={start}
        onClose={close}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start run" }));
    expect(
      screen.getByRole("button", { name: "Starting run…" }),
    ).toBeDisabled();
    reject(new Error("Connection unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection unavailable",
    );
    expect(close).not.toHaveBeenCalled();
    expect(
      screen.getByRole("checkbox", { name: "Claude · opus" }),
    ).toBeChecked();
  });
});
