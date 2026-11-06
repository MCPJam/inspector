import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { PreviewItem } from "../../case-steps/case-steps-model";
import {
  EXECUTION_PREVIEW_OPEN_KEY,
  ExecutionPreviewPanel,
  ExecutionPreviewToggle,
  useExecutionPreviewOpen,
} from "../../case-steps/execution-preview-panel";

const ITEMS: PreviewItem[] = [
  {
    key: "action:p0",
    marker: "agent",
    title: "Step 1 · User prompt",
    badge: "agent runs",
    detail: "“Sketch”",
  },
  {
    key: "check:a1",
    marker: "check",
    title: "Tool was called with read_me",
    detail: "Blocking",
  },
  {
    key: "outcome",
    marker: "outcome",
    title: "Expected outcome",
    detail: "“Two boxes”",
  },
  {
    key: "after-run",
    marker: "agent",
    title: "End-of-run evaluation",
    lines: [{ suite: true, text: "3 suite evaluators" }],
  },
];

function setReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("reduce"),
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  setReducedMotion(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ExecutionPreviewToggle", () => {
  it.each([
    [false, "Show execution preview"],
    [true, "Hide execution preview"],
  ])("open=%s is pressed and titled", (open, title) => {
    render(<ExecutionPreviewToggle open={open} onToggle={() => undefined} />);
    const button = screen.getByRole("button", { name: "Execution preview" });
    expect(button).toHaveAttribute("aria-pressed", String(open));
    expect(button).toHaveAttribute("title", title);
  });
});

describe("useExecutionPreviewOpen", () => {
  it("starts closed and remembers the choice", () => {
    const first = renderHook(() => useExecutionPreviewOpen());
    expect(first.result.current[0]).toBe(false);
    act(() => first.result.current[1](true));
    expect(window.localStorage.getItem(EXECUTION_PREVIEW_OPEN_KEY)).toBe("1");
    expect(renderHook(() => useExecutionPreviewOpen()).result.current[0]).toBe(
      true,
    );
  });

  it("starts closed and keeps working when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useExecutionPreviewOpen());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});

describe("ExecutionPreviewPanel", () => {
  it("lists numbered items folded, with the test run key and info line", () => {
    render(
      <ExecutionPreviewPanel
        items={ITEMS}
        variant="test_run"
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("complementary", { name: "Execution preview" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "How this case runs, in order. Click a step to open it in the test case.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/^[1-4]$/).map((n) => n.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(screen.queryByText("“Sketch”")).toBeNull();
    const key = screen.getByLabelText("Key");
    for (const word of [
      "Agent runs",
      "No model",
      "Assertion",
      "Suite default",
      "This case only",
    ]) {
      expect(key).toHaveTextContent(word);
    }
    expect(
      screen.getByText(
        "Suite settings configure grading; they are not a step in the run.",
      ),
    ).toBeInTheDocument();
  });

  it("folds and unfolds one row at a time", () => {
    render(
      <ExecutionPreviewPanel
        items={ITEMS}
        variant="test_run"
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const chevron = screen.getByRole("button", {
      name: "Show description: Step 1 · User prompt",
    });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chevron);
    expect(screen.getByText("“Sketch”")).toBeInTheDocument();
    expect(screen.queryByText("Blocking")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide description: Step 1 · User prompt",
      }),
    );
    expect(screen.queryByText("“Sketch”")).toBeNull();
  });

  it("says where a click goes, holds every row, then jumps after 500 ms", () => {
    vi.useFakeTimers();
    const onJump = vi.fn();
    render(
      <ExecutionPreviewPanel
        items={ITEMS}
        variant="test_run"
        onJump={onJump}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Tool was called with read_me"));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Opening in test case",
    );
    expect(
      screen.getByText("Expected outcome").closest("button"),
    ).toBeDisabled();
    act(() => vi.advanceTimersByTime(499));
    expect(onJump).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onJump).toHaveBeenCalledWith("check:a1");
  });

  it("jumps at once under reduced motion", () => {
    setReducedMotion(true);
    const onJump = vi.fn();
    render(
      <ExecutionPreviewPanel
        items={ITEMS}
        variant="test_run"
        onJump={onJump}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Expected outcome"));
    expect(onJump).toHaveBeenCalledWith("outcome");
  });

  it("closes from its ×", () => {
    const onClose = vi.fn();
    render(
      <ExecutionPreviewPanel
        items={ITEMS}
        variant="test_run"
        onJump={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close execution preview" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("editor variant: its own key, and a click jumps at once", () => {
    const onJump = vi.fn();
    render(
      <ExecutionPreviewPanel
        items={ITEMS}
        variant="editor"
        onJump={onJump}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "How this case will run, in order. Click a step to edit it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("An assertion is graded")).toBeInTheDocument();
    fireEvent.click(screen.getByText("End-of-run evaluation"));
    expect(onJump).toHaveBeenCalledWith("after-run");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
