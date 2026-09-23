import { useState } from "react";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CaseChecksPage } from "../../evaluate/case-workspace/case-checks-page";
import {
  STANDARD_ASSERTION_CHECKS,
  type StandardCheckDraft,
} from "../standard-checks-model";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
afterEach(cleanup);
const check = STANDARD_ASSERTION_CHECKS.find(
  (c) => c.id === "response.performance",
)!;
const capabilities = {
  scorers: {
    predicateKinds: STANDARD_ASSERTION_CHECKS.map((c) => c.preset.type),
    suppressedSuiteStandardCheckIds: true,
  },
} as SuiteCapabilities;
it("saves a family override, reloads it off, and restores the customized inherited rule", () => {
  const save = vi.fn();
  let stored: StandardCheckDraft = {};
  function Editor() {
    const [draft, setDraft] = useState(stored);
    return (
      <CaseChecksPage
        title="Catalog"
        suitePredicates={[
          { type: "toolLatencyUnder", ms: 1234, role: "advisory" },
        ]}
        {...draft}
        capabilities={capabilities}
        onChecksChange={(next) => {
          setDraft(next);
          stored = next;
          save(next);
        }}
        judgeSkipped={false}
        onJudgeSkippedChange={() => {}}
      />
    );
  }
  const first = render(<Editor />);
  expect(screen.getByRole("checkbox", { name: check.name })).toHaveAttribute(
    "data-state",
    "checked",
  );
  expect(screen.getByText(check.label)).toBeTruthy();
  expect(screen.getByText("From suite")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: check.name }));
  expect(save).toHaveBeenCalledWith({
    predicates: undefined,
    suppressedSuiteStandardCheckIds: [check.id],
  });
  first.unmount();
  render(<Editor />);
  expect(screen.getByRole("checkbox", { name: check.name })).toHaveAttribute(
    "data-state",
    "unchecked",
  );
  expect(screen.getByText("From suite · off for this case")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: check.name }));
  expect(stored).toEqual({
    predicates: undefined,
    suppressedSuiteStandardCheckIds: [],
  });
  expect(screen.getByText(check.label)).toBeTruthy();
});
it("keeps inherited toggles disabled until suppression is supported", () => {
  render(
    <CaseChecksPage
      title="Catalog"
      suitePredicates={[check.preset]}
      onChecksChange={() => {}}
      capabilities={
        {
          scorers: { predicateKinds: [check.preset.type] },
        } as SuiteCapabilities
      }
      judgeSkipped={false}
      onJudgeSkippedChange={() => {}}
    />,
  );
  expect(screen.getByRole("checkbox", { name: check.name })).toBeDisabled();
});
