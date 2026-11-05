/** The How suites work dialog: content per step, navigation and analytics. */

import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/analytics";
import { HowSuitesWorkDialog, type TutorialTrigger } from "../how-suites-work";
import { TUTORIAL_STEPS } from "../how-suites-work/how-suites-work-copy";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const trackMock = vi.mocked(track);

function Harness({
  trigger = "menu",
  onBuildCase,
}: {
  trigger?: TutorialTrigger;
  onBuildCase?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <HowSuitesWorkDialog
        open={open}
        onOpenChange={setOpen}
        trigger={trigger}
        onBuildCase={onBuildCase}
      />
    </>
  );
}

const dialog = () => screen.getByRole("dialog", { name: "How suites work" });
const spine = () => within(dialog()).getByRole("list", { name: "The flow" });
const dots = () => within(dialog()).getAllByRole("tab");
const goTo = (step: number) => fireEvent.click(dots()[step - 1]);
// The first h2 is the dialog's visually hidden name; the last is the step title.
const heading = () =>
  within(dialog()).getAllByRole("heading", { level: 2 }).at(-1);
const footerButtons = () =>
  within(dialog())
    .getAllByRole("button")
    .filter((b) => !b.getAttribute("role") && b.closest("ol") === null)
    .map((b) => b.textContent)
    .filter((label) => label !== "Close");

beforeEach(() => trackMock.mockClear());

const EXPECTED_BUTTONS = [
  ["Skip", "Walk me through it"],
  ["Skip", "Back", "Next"],
  ["Skip", "Back", "Next"],
  ["Skip", "Back", "Next"],
  ["Skip", "Back", "Next"],
  ["Back", "Build a test case", "Got it"],
];
const EXPECTED_CURRENT = [
  null,
  "Suite",
  "Suite run",
  "Test run",
  "Iteration",
  null,
];

describe("HowSuitesWorkDialog content", () => {
  it.each(TUTORIAL_STEPS.map((s, i) => [i + 1, s] as const))(
    "step %i shows its copy, spine, dot and buttons",
    (n, step) => {
      render(<Harness onBuildCase={() => {}} />);
      goTo(n);
      expect(heading()).toHaveTextContent(step.title);
      expect(within(dialog()).getByText(step.line)).toHaveAttribute(
        "aria-live",
        "polite",
      );
      const trail = within(dialog()).queryByLabelText("Where you'll see it");
      if (step.page) {
        expect(within(dialog()).getByText(step.page.label)).toBeInTheDocument();
        expect(trail).toHaveTextContent(step.page.trail.join("/"));
      } else {
        expect(trail).toBeNull();
      }
      const current = within(spine())
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-current") === "step")
        .map((b) => b.textContent);
      expect(current).toEqual(
        EXPECTED_CURRENT[n - 1] ? [EXPECTED_CURRENT[n - 1]] : [],
      );
      expect(dots()[n - 1]).toHaveAttribute("aria-selected", "true");
      expect(dots()[n - 1]).toHaveAccessibleName(`Step ${n}: ${step.title}`);
      expect(footerButtons()).toEqual(EXPECTED_BUTTONS[n - 1]);
    },
  );

  it("hides the diagram from assistive tech and names the possum", () => {
    render(<Harness />);
    expect(screen.getByTestId("tutorial-diagram")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      within(dialog()).getByRole("img", { name: "MCPJam possum" }),
    ).toBeInTheDocument();
  });
});

describe("HowSuitesWorkDialog navigation", () => {
  it("walks forward and back, and starts on step 1 each opening", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(
      screen.getByRole("button", { name: "Walk me through it" }),
    );
    expect(heading()).toHaveTextContent("Suite");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(heading()).toHaveTextContent("Suite run");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(heading()).toHaveTextContent("Suite");

    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(heading()).toHaveTextContent("The whole flow");
  });

  it("jumps from spine pills and clamps the arrow keys", () => {
    render(<Harness />);
    fireEvent.click(within(spine()).getByRole("button", { name: "Iteration" }));
    expect(heading()).toHaveTextContent("Iteration");

    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(heading()).toHaveTextContent("You're set");

    goTo(1);
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(heading()).toHaveTextContent("The whole flow");

    // The arrows only change step, never scroll the dialog sideways.
    expect(fireEvent.keyDown(document, { key: "ArrowRight" })).toBe(false);
    expect(fireEvent.keyDown(document, { key: "ArrowDown" })).toBe(true);
  });

  it("offers Build a test case only with a handler, and calls it after closing", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    goTo(6);
    expect(
      screen.queryByRole("button", { name: "Build a test case" }),
    ).toBeNull();
    unmount();

    const calls: string[] = [];
    const onBuildCase = vi.fn(() => calls.push("build"));
    render(
      <HowSuitesWorkDialog
        open
        onOpenChange={(open) => calls.push(`open:${open}`)}
        trigger="menu"
        onBuildCase={onBuildCase}
      />,
    );
    goTo(6);
    await user.click(screen.getByRole("button", { name: "Build a test case" }));
    expect(calls).toEqual(["open:false", "build"]);
    expect(onBuildCase).toHaveBeenCalledOnce();
  });
});

describe("HowSuitesWorkDialog analytics", () => {
  it("reports shown on open with the trigger", () => {
    render(<Harness trigger="first_visit" />);
    expect(trackMock.mock.calls).toEqual([
      ["eval_tutorial_shown", { trigger: "first_visit", step: 1 }],
    ]);
  });

  it("reports dismissed with the step when skipped early", async () => {
    const user = userEvent.setup();
    render(<Harness trigger="first_suite" />);
    goTo(3);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(trackMock.mock.calls.slice(1)).toEqual([
      ["eval_tutorial_dismissed", { trigger: "first_suite", step: 3 }],
    ]);
  });

  it("reports completed when Esc closes the last step", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    goTo(6);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trackMock.mock.calls.slice(1)).toEqual([
      ["eval_tutorial_completed", { trigger: "menu", step: 6 }],
    ]);
  });

  it("reports completed once for Got it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    goTo(6);
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(trackMock.mock.calls.map(([name]) => name)).toEqual([
      "eval_tutorial_shown",
      "eval_tutorial_completed",
    ]);
  });
});
