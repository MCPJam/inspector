/**
 * The judge's criteria, and the three refusals that keep them meaningful.
 *
 * Ids are LOAD-BEARING: the judge cites them in its reasons and `rubricHits`
 * correlates by them, so two criteria sharing one id collapse into an
 * arbitrary winner. And the whole rubric is hashed into every verdict, which
 * is why an id that followed its label would quietly retire a suite's
 * calibration every time somebody fixed a typo.
 *
 * The save is ONE batched mutation, so a rubric the backend would refuse takes
 * the settings beside it down with it. Refusing here is what keeps a bad
 * criterion from costing somebody their unrelated threshold change.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  criterionError,
  isRubricValid,
  JudgeRubricEditor,
  MAX_JUDGE_RUBRIC_CRITERIA,
  slugifyCriterionId,
} from "../judge-rubric-editor";
import type { EvalJudgeRubric } from "../types";

function renderEditor(value: EvalJudgeRubric | undefined) {
  const onChange = vi.fn();
  const result = render(
    <JudgeRubricEditor value={value} onChange={onChange} />,
  );
  return { ...result, onChange };
}

describe("JudgeRubricEditor", () => {
  it("refuses a duplicate id inline, naming why it matters", () => {
    const { container } = renderEditor({
      criteria: [
        { id: "cites", label: "Cites a source" },
        { id: "cites", label: "Cites a second source" },
      ],
    });
    const error = container.querySelector("[data-criterion-error]");
    expect(error?.textContent).toContain("unique");
    expect(error?.textContent).toContain("cites them in its reasons");
  });

  it("refuses an id the backend's pattern would reject", () => {
    const { container } = renderEditor({
      criteria: [{ id: "not valid!", label: "Something" }],
    });
    expect(
      container.querySelector("[data-criterion-error]")?.textContent,
    ).toContain("letters, digits, hyphen or underscore");
  });

  it("refuses a blank label", () => {
    const { container } = renderEditor({
      criteria: [{ id: "ok", label: "   " }],
    });
    expect(
      container.querySelector("[data-criterion-error]")?.textContent,
    ).toContain("needs a label");
  });

  it("stops at the criteria cap", () => {
    renderEditor({
      criteria: Array.from(
        { length: MAX_JUDGE_RUBRIC_CRITERIA },
        (_, index) => ({ id: `c${index}`, label: `Criterion ${index}` }),
      ),
    });
    expect(
      screen.getByRole("button", { name: "Add criterion" }),
    ).toBeDisabled();
    expect(screen.getByText(/25 of 25 — at the limit/)).toBeTruthy();
  });

  it("drafts undefined when the last criterion is removed", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      criteria: [{ id: "cites", label: "Cites a source" }],
    });
    await user.click(
      screen.getByRole("button", { name: /Remove criterion 1/ }),
    );
    // `undefined`, not `{criteria: []}` — the backend refuses an empty list
    // because a rubric that asks nothing still changes what the judge is
    // asked, and `null` is how you clear one. `toUpdateArgs` makes that null.
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("mints the id from the first label, then leaves it alone", async () => {
    const user = userEvent.setup();
    const { onChange, rerender } = renderEditor({
      criteria: [{ id: "criterion", label: "" }],
    });
    const label = screen.getByLabelText("Criterion 1 label");
    await user.type(label, "C");
    expect(onChange).toHaveBeenLastCalledWith({
      criteria: [{ id: "c", label: "C" }],
    });

    // With a label already present, further typing must NOT move the id: the
    // rubric hash is what the agreement rate is measured against, so an id
    // that tracked its label would retire the calibration on every typo fix.
    onChange.mockClear();
    rerender(
      <JudgeRubricEditor
        value={{ criteria: [{ id: "cites", label: "Cites" }] }}
        onChange={onChange}
      />,
    );
    await user.type(screen.getByLabelText("Criterion 1 label"), "!");
    expect(onChange).toHaveBeenLastCalledWith({
      criteria: [{ id: "cites", label: "Cites!" }],
    });
  });
});

describe("rubric validation helpers", () => {
  it("treats no rubric as valid — it is how you clear one", () => {
    expect(isRubricValid(undefined)).toBe(true);
    expect(isRubricValid({ criteria: [] })).toBe(true);
  });

  it("rejects a rubric with any bad criterion", () => {
    expect(
      isRubricValid({
        criteria: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
        ],
      }),
    ).toBe(false);
    expect(
      isRubricValid({
        criteria: Array.from({ length: 26 }, (_, i) => ({
          id: `c${i}`,
          label: "x",
        })),
      }),
    ).toBe(false);
  });

  it("accepts a criterion at every boundary the backend accepts", () => {
    const criteria = [
      {
        id: "a".repeat(64),
        label: "x".repeat(200),
        description: "y".repeat(1000),
      },
    ];
    expect(criterionError(criteria[0], 0, criteria)).toBeUndefined();
  });

  it("slugifies a label into an id somebody would have written", () => {
    expect(slugifyCriterionId("Cites a source!")).toBe("cites-a-source");
    expect(slugifyCriterionId("   ")).toBe("criterion");
    expect(slugifyCriterionId("!!!")).toBe("criterion");
  });
});
