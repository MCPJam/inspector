/**
 * The rubric editor's job is the id layer: `ChecksSection` is id-blind and
 * hands back a bare `Predicate[]` on every edit, so this component is the only
 * thing standing between "the author nudged a threshold" and "a brand-new
 * criterion appeared, and the old one's results are orphaned".
 *
 * `ChecksSection` is stubbed to a pair of buttons — its own behavior has its
 * own tests, and driving a Radix select in jsdom would test the select rather
 * than the mapping.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { JourneyRubricEditor } from "../journey-rubric-editor";
import type { JourneyCriterion } from "@/shared/journey-rubric";
import type { Predicate } from "@/shared/eval-matching";

const ADDED: Predicate = { type: "toolCalledAtLeastOnce", toolName: "search" };
const EDITED: Predicate = { type: "turnCountUnder", turns: 5 };

vi.mock("@/components/evals/checks-section", () => ({
  ChecksSection: ({
    value,
    onChange,
  }: {
    value: Predicate[];
    onChange: (next: Predicate[]) => void;
  }) => (
    <div>
      <span data-testid="predicate-count">{value.length}</span>
      <button type="button" onClick={() => onChange([...value, ADDED])}>
        add check
      </button>
      <button
        type="button"
        onClick={() => onChange(value.map((p, i) => (i === 0 ? EDITED : p)))}
      >
        edit first
      </button>
      <button type="button" onClick={() => onChange(value.slice(1))}>
        remove first
      </button>
    </div>
  ),
}));

function Harness({ initial = [] }: { initial?: JourneyCriterion[] }) {
  const [rubric, setRubric] = useState<JourneyCriterion[]>(initial);
  return (
    <>
      <JourneyRubricEditor value={rubric} onChange={setRubric} />
      <span data-testid="ids">{rubric.map((e) => e.id).join(",")}</span>
      <span data-testid="labels">
        {rubric.map((e) => e.label ?? "-").join(",")}
      </span>
    </>
  );
}

const ids = () => screen.getByTestId("ids").textContent ?? "";

describe("JourneyRubricEditor", () => {
  it("mints an id when a check is added", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(ids()).toBe("");

    await user.click(screen.getByRole("button", { name: "add check" }));

    expect(ids().length).toBeGreaterThan(0);
    expect(screen.getByTestId("predicate-count")).toHaveTextContent("1");
  });

  it("PRESERVES the id when a check is edited", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ id: "keep-me", predicate: { type: "turnCountUnder", turns: 3 } }]} />);

    await user.click(screen.getByRole("button", { name: "edit first" }));

    expect(ids()).toBe("keep-me");
  });

  it("keeps survivors' ids when a check is removed", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[
          { id: "a", predicate: { type: "noToolErrors" } },
          { id: "b", predicate: { type: "turnCountUnder", turns: 3 } },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "remove first" }));

    expect(ids()).toBe("b");
  });

  it("keeps ids stable across add-then-edit", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "add check" }));
    const minted = ids();

    await user.click(screen.getByRole("button", { name: "edit first" }));

    expect(ids()).toBe(minted);
  });

  it("edits a per-row label without disturbing the id", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[{ id: "a", predicate: { type: "turnCountUnder", turns: 3 } }]}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: /name for criterion 1/i }),
      "Quick",
    );

    expect(screen.getByTestId("labels")).toHaveTextContent("Quick");
    expect(ids()).toBe("a");
  });

  it("uses the formatted predicate as the label PLACEHOLDER, not a prefilled value", () => {
    render(
      <Harness
        initial={[{ id: "a", predicate: { type: "turnCountUnder", turns: 3 } }]}
      />,
    );
    const input = screen.getByRole("textbox", { name: /name for criterion 1/i });
    // A derived label stored as a value would stop tracking the predicate the
    // moment the author changed the threshold.
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Fewer than 3 user turns");
  });

  it("renders no name inputs for an empty rubric", () => {
    render(<Harness />);
    expect(screen.queryByText("Names (optional)")).not.toBeInTheDocument();
  });
});
