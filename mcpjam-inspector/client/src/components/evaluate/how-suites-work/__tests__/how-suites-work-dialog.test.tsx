import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, userEvent } from "@/test";
import { track } from "@/lib/analytics";
import { HowSuitesWorkDialog } from "../how-suites-work-dialog";
import type { HowSuitesWorkTrigger } from "../use-how-suites-work";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const trackMock = vi.mocked(track);

function renderDialog(trigger: HowSuitesWorkTrigger = "menu") {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <HowSuitesWorkDialog open onOpenChange={onOpenChange} trigger={trigger} />,
  );
  const rerenderOpen = (open: boolean) =>
    view.rerender(
      <HowSuitesWorkDialog
        open={open}
        onOpenChange={onOpenChange}
        trigger={trigger}
      />,
    );
  return { onOpenChange, rerenderOpen };
}

// The dialog's hidden title is also an h2, so read the visible step title.
const heading = () =>
  screen
    .getAllByRole("heading", { level: 2 })
    .map((node) => node.textContent)
    .find((text) => text !== "How suites work");
const eventsNamed = (name: string) =>
  trackMock.mock.calls.filter(([event]) => event === name);

beforeEach(() => {
  localStorage.clear();
  trackMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HowSuitesWorkDialog content", () => {
  it("opens on step 1 with its strings and buttons", () => {
    renderDialog();
    expect(
      screen.getByRole("dialog", { name: "How suites work" }),
    ).toBeInTheDocument();
    expect(heading()).toBe("The whole flow");
    expect(
      screen.getByText("Evals nest four layers deep. Here they are."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Walk me through it" }),
    ).toHaveFocus();
    expect(screen.queryByLabelText("Where you'll see it")).toBeNull();
  });

  it.each([
    [
      2,
      "Suite",
      "Your test cases, and where they run.",
      "Suite page",
      "Evaluate/Excalidraw quickstart",
    ],
    [
      3,
      "Suite run",
      "Press Run. Each press makes a new run.",
      "Suite Run page",
      "Excalidraw quickstart/Run #6",
    ],
    [
      4,
      "Test run",
      "One test case inside a run. It passes, fails, or is flaky.",
      "Test run page",
      "Run #6/Draw a rectangle",
    ],
    [
      5,
      "Iteration",
      "One try of a test run. Each try has its own chat and scorecard.",
      "Iteration page",
      "Draw a rectangle/Iteration #2",
    ],
  ])(
    "shows step %i after the primary button",
    async (n, title, say, page, trail) => {
      const user = userEvent.setup();
      renderDialog();
      for (let i = 1; i < n; i++) {
        await user.click(
          screen.getByRole("button", {
            name: i === 1 ? "Walk me through it" : "Next",
          }),
        );
      }
      expect(heading()).toBe(title);
      expect(screen.getByText(say)).toBeInTheDocument();
      expect(screen.getByText(page)).toBeInTheDocument();
      expect(screen.getByLabelText("Where you'll see it").textContent).toBe(
        trail,
      );
      for (const name of ["Skip", "Back", "Next"]) {
        expect(screen.getByRole("button", { name })).toBeInTheDocument();
      }
    },
  );

  it("shows step 6 with Back and Got it only", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Step 6: You're set" }));
    expect(heading()).toBe("You're set");
    expect(
      screen.getByText("Build a test case, then press Run."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Got it" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Where you'll see it")).toBeNull();
  });
});

describe("HowSuitesWorkDialog navigation", () => {
  it("goes back one step", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Step 3: Suite run" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(heading()).toBe("Suite");
  });

  it("jumps from the spine and marks the chip current", async () => {
    const user = userEvent.setup();
    renderDialog();
    const flow = screen.getByRole("list", { name: "The flow" });
    expect(flow.tagName).toBe("OL");
    await user.click(screen.getByRole("button", { name: "Test run" }));
    expect(heading()).toBe("Test run");
    expect(screen.getByRole("button", { name: "Test run" })).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(
      screen.getByRole("button", { name: "Step 4: Test run" }),
    ).toHaveAttribute("aria-current", "step");
  });

  it("moves with the arrow keys and stops at both ends", () => {
    renderDialog();
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(heading()).toBe("The whole flow");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(heading()).toBe("Suite");
    fireEvent.click(screen.getByRole("button", { name: "Step 6: You're set" }));
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(heading()).toBe("You're set");
  });

  it("starts on step 1 again after reopening and stops listening when closed", () => {
    const removeListener = vi.spyOn(document, "removeEventListener");
    const { rerenderOpen } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Step 4: Test run" }));
    rerenderOpen(false);
    expect(removeListener.mock.calls.some(([type]) => type === "keydown")).toBe(
      true,
    );
    rerenderOpen(true);
    expect(heading()).toBe("The whole flow");
  });
});

describe("HowSuitesWorkDialog closing and analytics", () => {
  it("sends shown once on open", () => {
    renderDialog("first_visit");
    expect(eventsNamed("eval_tutorial_shown")).toEqual([
      [
        "eval_tutorial_shown",
        { location: "evaluate_tutorial", trigger: "first_visit", step: 1 },
      ],
    ]);
  });

  it("closes from Skip and reports the step on dismiss", async () => {
    const user = userEvent.setup();
    const { onOpenChange, rerenderOpen } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Step 3: Suite run" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerenderOpen(false);
    expect(eventsNamed("eval_tutorial_dismissed")).toEqual([
      [
        "eval_tutorial_dismissed",
        { location: "evaluate_tutorial", trigger: "menu", step: 3 },
      ],
    ]);
  });

  it("closes from the X button", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Escape from step 6 and reports a dismiss on step 6", async () => {
    const user = userEvent.setup();
    const { onOpenChange, rerenderOpen } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Step 6: You're set" }));
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerenderOpen(false);
    expect(eventsNamed("eval_tutorial_dismissed")).toEqual([
      [
        "eval_tutorial_dismissed",
        { location: "evaluate_tutorial", trigger: "menu", step: 6 },
      ],
    ]);
    expect(eventsNamed("eval_tutorial_completed")).toEqual([]);
  });

  it("finishes from Got it with one completed event and no dismiss", async () => {
    const user = userEvent.setup();
    const { onOpenChange, rerenderOpen } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Step 6: You're set" }));
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerenderOpen(false);
    expect(eventsNamed("eval_tutorial_completed")).toEqual([
      [
        "eval_tutorial_completed",
        { location: "evaluate_tutorial", trigger: "menu", step: 6 },
      ],
    ]);
    expect(eventsNamed("eval_tutorial_dismissed")).toEqual([]);
  });

  it("sends one end event per open when the parent closes it", () => {
    const { rerenderOpen } = renderDialog();
    rerenderOpen(false);
    rerenderOpen(false);
    rerenderOpen(true);
    rerenderOpen(false);
    expect(eventsNamed("eval_tutorial_shown")).toHaveLength(2);
    expect(eventsNamed("eval_tutorial_dismissed")).toHaveLength(2);
  });
});

describe("HowSuitesWorkDialog reduced motion", () => {
  it("drops transitions when the user prefers reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string): MediaQueryList => ({
        matches: query.includes("reduce"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    );
    renderDialog();
    expect(
      screen.getByTestId("how-suites-work-run-card").style.transition,
    ).toBe("none");
  });
});
