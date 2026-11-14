import type { ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramLayout } from "../DiagramLayout";
const viewport = vi.hoisted(() => ({
  width: 0,
  height: 0,
  notify: () => {},
  setCenter: vi.fn(),
}));
vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({ setCenter: viewport.setCenter }),
  ReactFlow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Background: () => null,
  Controls: () => null,
}));
vi.mock("../ActorNode", () => ({ ActorNode: () => null }));
vi.mock("../CustomActionEdge", () => ({ CustomActionEdge: () => null }));
const nodes = [
  { id: "client", position: { x: 0, y: 0 }, data: {} },
  { id: "server", position: { x: 400, y: 0 }, data: {} },
];
const edges = [
  {
    id: "request",
    source: "client",
    target: "server",
    data: { status: "current" },
  },
];
describe("diagram visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          viewport.notify = callback;
        }
        observe() {
          viewport.notify();
        }
        disconnect() {}
      },
    );
    viewport.width = 0;
    viewport.height = 0;
    viewport.setCenter.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("waits for dimensions before centering the initial hidden diagram", () => {
    const { rerender, container } = render(
      <DiagramLayout nodes={nodes} edges={edges} currentStep="idle" />,
    );
    act(() => vi.advanceTimersByTime(200));
    expect(viewport.setCenter).not.toHaveBeenCalled();
    Object.defineProperty(container.firstElementChild, "clientWidth", {
      value: 375,
    });
    Object.defineProperty(container.firstElementChild, "clientHeight", {
      value: 600,
    });
    act(() => viewport.notify());
    rerender(<DiagramLayout nodes={nodes} edges={edges} currentStep="idle" />);
    act(() => vi.advanceTimersByTime(200));
    expect(viewport.setCenter).toHaveBeenCalledOnce();
    expect(
      viewport.setCenter.mock.calls[0].slice(0, 2).every(Number.isFinite),
    ).toBe(true);
  });
  it("centers the current step after a hidden advance is revealed", () => {
    const { rerender, container } = render(
      <DiagramLayout nodes={nodes} edges={edges} currentStep="idle" />,
    );
    rerender(
      <DiagramLayout nodes={nodes} edges={edges} currentStep="request" />,
    );
    act(() => vi.advanceTimersByTime(200));
    expect(viewport.setCenter).not.toHaveBeenCalled();
    Object.defineProperty(container.firstElementChild, "clientWidth", {
      value: 375,
    });
    Object.defineProperty(container.firstElementChild, "clientHeight", {
      value: 600,
    });
    act(() => viewport.notify());
    rerender(
      <DiagramLayout nodes={nodes} edges={edges} currentStep="request" />,
    );
    act(() => vi.advanceTimersByTime(200));
    expect(viewport.setCenter).toHaveBeenCalledOnce();
    expect(
      viewport.setCenter.mock.calls[0].slice(0, 2).every(Number.isFinite),
    ).toBe(true);
  });
  it("preserves the viewport on reveal unless a step changed while hidden", () => {
    const { container, rerender } = render(
      <DiagramLayout nodes={nodes} edges={edges} currentStep="idle" />,
    );
    const pane = container.firstElementChild!;
    Object.defineProperty(pane, "clientWidth", {
      value: 375,
      configurable: true,
    });
    Object.defineProperty(pane, "clientHeight", { value: 600 });
    act(() => viewport.notify());
    act(() => vi.advanceTimersByTime(200));
    expect(viewport.setCenter).toHaveBeenCalledOnce();
    const width = (value: number) => {
      Object.defineProperty(pane, "clientWidth", { value, configurable: true });
      act(() => viewport.notify());
    };
    width(0);
    width(375);
    act(() => vi.advanceTimersByTime(200));
    expect(viewport.setCenter).toHaveBeenCalledOnce();
    width(0);
    rerender(
      <DiagramLayout nodes={nodes} edges={edges} currentStep="request" />,
    );
    act(() => vi.advanceTimersByTime(200));
    expect(viewport.setCenter).toHaveBeenCalledOnce();
    width(375);
    act(() => vi.advanceTimersByTime(200));
    expect(viewport.setCenter).toHaveBeenCalledTimes(2);
  });

  it("rechecks the DOM when a pane hides before the centering timer runs", () => {
    const { container } = render(
      <DiagramLayout nodes={nodes} edges={edges} currentStep="idle" />,
    );
    Object.defineProperty(container.firstElementChild, "clientWidth", {
      value: 375,
      configurable: true,
    });
    Object.defineProperty(container.firstElementChild, "clientHeight", {
      value: 600,
      configurable: true,
    });
    act(() => viewport.notify());
    Object.defineProperty(container.firstElementChild, "clientWidth", {
      value: 0,
    });
    act(() => vi.advanceTimersByTime(200));
    expect(viewport.setCenter).not.toHaveBeenCalled();
  });
});
