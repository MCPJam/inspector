import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { TraceTimeline } from "../trace-timeline";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    direction,
  }: {
    children: ReactNode;
    direction: string;
  }) => (
    <div data-testid="resizable-panel-group" data-direction={direction}>
      {children}
    </div>
  ),
  ResizablePanel: ({
    children,
    defaultSize,
    minSize,
  }: {
    children: ReactNode;
    defaultSize?: number;
    minSize?: number;
  }) => (
    <div
      data-testid="resizable-panel"
      data-default-size={defaultSize}
      data-min-size={minSize}
    >
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

const spans: EvalTraceSpan[] = [
  {
    id: "step-0",
    name: "Step 1",
    category: "step",
    startMs: 0,
    endMs: 1000,
    stepIndex: 0,
  },
];

let width = 0;
let observers: (() => void)[] = [];
const OriginalResizeObserver = global.ResizeObserver;

beforeEach(() => {
  width = 0;
  observers = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width }) as DOMRect,
  );
  global.ResizeObserver = class {
    constructor(callback: () => void) {
      observers.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.restoreAllMocks();
  global.ResizeObserver = OriginalResizeObserver;
});

function direction() {
  return screen
    .getByTestId("resizable-panel-group")
    .getAttribute("data-direction");
}

function panelSizes() {
  return screen
    .getAllByTestId("resizable-panel")
    .map((panel) => panel.getAttribute("data-default-size"));
}

describe("TraceTimeline detail placement", () => {
  it("stacks the detail below by default, however wide", () => {
    width = 1600;
    render(<TraceTimeline recordedSpans={spans} transcriptMessages={[]} />);
    expect(direction()).toBe("vertical");
    expect(panelSizes()).toEqual(["65", "35"]);
  });

  it("puts the detail beside the waterfall at 1024px and up with auto", () => {
    width = 1280;
    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={[]}
        detailPlacement="auto"
      />,
    );
    expect(direction()).toBe("horizontal");
    expect(panelSizes()).toEqual(["62", "38"]);
  });

  it("stacks again when an auto timeline narrows below 1024px", () => {
    width = 1280;
    render(
      <TraceTimeline
        recordedSpans={spans}
        transcriptMessages={[]}
        detailPlacement="auto"
      />,
    );
    width = 900;
    act(() => observers.forEach((notify) => notify()));
    expect(direction()).toBe("vertical");
    expect(panelSizes()).toEqual(["65", "35"]);
  });
});
