import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PassCriteriaBadge } from "../pass-criteria-badge";
import type { EvalSuiteRun } from "../types";

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
    },
    status: "completed",
    result: "passed",
    createdAt: 1_000,
    completedAt: 2_000,
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    ...overrides,
  } as EvalSuiteRun;
}

describe("PassCriteriaBadge", () => {
  it("labels cancelled runs as cancelled, not failed", () => {
    render(
      <PassCriteriaBadge
        run={makeRun({ status: "cancelled", result: "cancelled" })}
      />,
    );

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("labels timed out runs as timed out, not failed", () => {
    render(
      <PassCriteriaBadge
        run={makeRun({ status: "timed_out", result: "timed_out" })}
      />,
    );

    expect(screen.getByText("Timed out")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });
});

describe("PassCriteriaBadge — a run held for its judge", () => {
  // `grading` is past execution and before the verdict. Its `result` is the
  // truthy "pending", which used to fall through `passed === false` into a
  // red "Suite Failed" for a run the judge may pass minutes later.
  it.each(["compact", "detailed"] as const)(
    "renders Grading, never Failed, in the %s variant",
    (variant) => {
      render(
        <PassCriteriaBadge
          run={makeRun({
            status: "grading",
            result: "pending",
            summary: { total: 4, passed: 2, failed: 2, passRate: 0.5 },
          })}
          variant={variant}
        />,
      );
      expect(screen.getByLabelText("Suite is being graded")).toHaveTextContent(
        "Grading",
      );
      expect(screen.queryByText(/Failed/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Passed/)).not.toBeInTheDocument();
    },
  );
});

describe("PassCriteriaBadge — a run that could not be measured", () => {
  // Verdict policy 2 can conclude `inconclusive`: the run finished and there
  // was not enough valid signal to decide it either way. Folding that into
  // `failed` reports a defect nothing observed, so neither verdict word may
  // appear anywhere the user (or a screen reader) can reach it.
  //
  // Asserted as a NEGATIVE on the two verdict words rather than a positive on
  // "Inconclusive": the bug was a fall-through, and only a negative catches the
  // next branch that falls through the same way.
  it.each(["compact", "detailed"] as const)(
    "says neither Passed nor Failed in the %s variant",
    (variant) => {
      const { container } = render(
        <PassCriteriaBadge
          run={makeRun({
            status: "completed",
            result: "inconclusive",
            verdictPolicyVersion: 2,
            passCriteria: { minimumPassRate: 80 },
            summary: { total: 4, passed: 1, failed: 3, passRate: 0.25 },
          })}
          variant={variant}
        />,
      );

      const ariaLabels = [...container.querySelectorAll("[aria-label]")].map(
        (el) => el.getAttribute("aria-label") ?? "",
      );
      const reachableText = [container.textContent ?? "", ...ariaLabels].join(
        " ",
      );

      expect(reachableText).not.toMatch(/passed/i);
      expect(reachableText).not.toMatch(/failed/i);
      expect(reachableText).toMatch(/Inconclusive/);
    },
  );

  // The threshold lives in the compact badge's aria-label, so this has to read
  // the same reachable surface the assertions above do — `textContent` alone
  // passes trivially and guards nothing.
  it("does not quote a pass-criteria threshold it never applied", () => {
    const { container } = render(
      <PassCriteriaBadge
        run={makeRun({
          status: "completed",
          result: "inconclusive",
          passCriteria: { minimumPassRate: 80 },
          summary: { total: 4, passed: 1, failed: 3, passRate: 0.25 },
        })}
        variant="compact"
      />,
    );

    const ariaLabels = [...container.querySelectorAll("[aria-label]")].map(
      (el) => el.getAttribute("aria-label") ?? "",
    );
    const reachableText = [container.textContent ?? "", ...ariaLabels].join(
      " ",
    );

    expect(reachableText).not.toContain("80%");
  });
});
