import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { TestRunView, type TestRunViewProps } from "../test-run-view";
import { CASE_ID, FINDINGS, MATRIX, SCORECARD } from "./test-run-fixtures";

function view(overrides: Partial<TestRunViewProps> = {}) {
  const props: TestRunViewProps = {
    runNumber: 4,
    title: "Sketch a two-node flow",
    verdict: "failed",
    passed: 5,
    total: 8,
    findings: FINDINGS,
    scorecard: SCORECARD,
    targets: MATRIX.targets,
    caseKey: CASE_ID,
    selectedTarget: MATRIX.targets[0],
    onSelectTarget: vi.fn(),
    truncated: false,
    preview: null,
    previewToggle: { open: false, onToggle: vi.fn() },
    onOpenIteration: vi.fn(),
    onCopyFixPrompt: vi.fn(),
    onEditTestCase: vi.fn(),
    ...overrides,
  };
  render(<TestRunView {...props} />);
  return props;
}

describe("TestRunView", () => {
  it("renders the sample test run's strings", () => {
    view();
    expect(screen.getByText("Test run · Run #4")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Sketch a two-node flow" }),
    ).toBeInTheDocument();
    const verdictLine = screen.getByText(/5\/8 iterations passed/);
    expect(within(verdictLine).getByText("Failed")).toHaveClass(
      "text-destructive",
    );
    expect(
      screen.getByRole("button", { name: "Edit Test Case" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Execution preview" }),
    ).toBeInTheDocument();

    const findings = screen.getByRole("region", { name: "Findings" });
    expect(within(findings).getByText("1")).toBeInTheDocument();
    expect(
      within(findings).getByText(
        "3 of 8 iterations broke at Selection: an expected tool call was never made.",
      ),
    ).toBeInTheDocument();
    expect(within(findings).getByText("How to fix:")).toBeInTheDocument();
    expect(
      within(findings).getByRole("button", { name: "About Findings" }),
    ).toBeInTheDocument();

    const scorecards = screen.getByRole("region", { name: "Scorecards" });
    expect(
      within(scorecards).getByText("every assertion, across 8 iterations"),
    ).toBeInTheDocument();
    expect(
      within(scorecards).getByText(
        "· 1 timed out, so its assertions weren't measured",
      ),
    ).toBeInTheDocument();
    expect(within(scorecards).getAllByText("Built-in")).toHaveLength(4);
    expect(within(scorecards).getAllByText("Advisory")).toHaveLength(2);
    expect(within(scorecards).getByText("5/8 passed")).toHaveClass(
      "text-destructive",
    );
    expect(
      within(scorecards).getAllByRole("button", {
        name: "Open failing iteration",
      }),
    ).toHaveLength(1);

    const iterations = screen.getByTestId("nav-test-run-iterations");
    expect(
      within(iterations).getByRole("button", { name: /gpt-5-mini/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(iterations).getByRole("button", { name: /gpt-5-mini/ }),
    ).toHaveTextContent("gpt-5-mini1/4");
    expect(
      within(iterations).getAllByRole("button", {
        name: /Open iteration \d details/,
      }),
    ).toHaveLength(4);
  });

  it.each([
    ["passed", "Passed", "text-success"],
    ["flaky", "Flaky · passed, but not every time", "text-warning"],
    ["pending", "Running", "text-pending"],
    ["empty", "No results", "text-muted-foreground"],
  ] as const)("paints %s", (verdict, word, tone) => {
    view({ verdict });
    expect(
      within(screen.getByText(/iterations passed/)).getByText(word),
    ).toHaveClass(tone);
  });

  it("paints no word when nothing decided the case", () => {
    view({ verdict: "undecided" });
    expect(screen.getByText(/iterations passed/).textContent).toBe(
      "5/8 iterations passed",
    );
  });

  it("switches model through the setter, and shows the picked target", () => {
    const props = view({ selectedTarget: MATRIX.targets[1] });
    const iterations = screen.getByTestId("nav-test-run-iterations");
    expect(
      within(iterations).getByRole("button", { name: /claude-haiku-4.5/ }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      within(iterations).getByRole("button", { name: /gpt-5-mini/ }),
    );
    expect(props.onSelectTarget).toHaveBeenCalledWith(
      MATRIX.targets[0].targetKey,
    );
  });

  it("names the one target instead of a switch", () => {
    view({ targets: [MATRIX.targets[0]] });
    const iterations = screen.getByTestId("nav-test-run-iterations");
    expect(
      within(iterations).getByText(`${MATRIX.targets[0].client} · gpt-5-mini`),
    ).toBeInTheDocument();
  });

  it("says when nothing was found, and when the list was cut", () => {
    view({ findings: [], truncated: true });
    expect(
      screen.getByText("No issue found in the recorded assertions."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Showing the first 200 iterations of this test run."),
    ).toBeInTheDocument();
  });

  it("opens iterations from a finding, a scorecard row and an iteration row", () => {
    const props = view();
    fireEvent.click(screen.getByRole("button", { name: /^Open iteration$/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open failing iteration" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open iteration 1 details" }),
    );
    expect(props.onOpenIteration).toHaveBeenNthCalledWith(1, "a1");
    expect(props.onOpenIteration).toHaveBeenNthCalledWith(2, "a1");
    expect(props.onOpenIteration).toHaveBeenNthCalledWith(3, "a1");
  });

  it("hides the toggle when the case could not be read, and keeps Edit", () => {
    const props = view({ previewToggle: null });
    expect(
      screen.queryByRole("button", { name: "Execution preview" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Test Case" }));
    expect(props.onEditTestCase).toHaveBeenCalled();
  });

  it("copies a finding's fix prompt", () => {
    const props = view();
    fireEvent.click(screen.getByRole("button", { name: "Copy fix prompt" }));
    expect(props.onCopyFixPrompt).toHaveBeenCalledWith(FINDINGS[0]);
  });
});
