import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider, type Node } from "@xyflow/react";
import { CanvasShell } from "../CanvasShell";

const NODES: Node[] = [
  { id: "root", position: { x: 0, y: 0 }, data: { label: "Root" } },
];

function renderShell(props: {
  edgeRevealDelayMs?: number;
  alignTopAfterFit?: boolean;
  onNodeClick?: (node: Node) => void;
  onPaneClick?: () => void;
}) {
  return render(
    <ReactFlowProvider>
      <div style={{ width: 600, height: 400 }}>
        <CanvasShell
          nodes={NODES}
          edges={[]}
          nodeTypes={{}}
          edgeTypes={{}}
          backgroundId="test-dots"
          edgeRevealDelayMs={props.edgeRevealDelayMs}
          alignTopAfterFit={props.alignTopAfterFit}
          onNodeClick={props.onNodeClick ?? (() => {})}
          onPaneClick={props.onPaneClick ?? (() => {})}
        />
      </div>
    </ReactFlowProvider>,
  );
}

describe("CanvasShell", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the edges back for the reveal delay", () => {
    vi.useFakeTimers();
    const { container } = renderShell({ edgeRevealDelayMs: 1000 });
    const shell = container.querySelector(".host-redesign-canvas");
    expect(shell).toHaveAttribute("data-edges-ready", "false");

    act(() => vi.advanceTimersByTime(999));
    expect(shell).toHaveAttribute("data-edges-ready", "false");

    act(() => vi.advanceTimersByTime(1));
    expect(shell).toHaveAttribute("data-edges-ready", "true");
  });

  it("hands the clicked node to onNodeClick", () => {
    const onNodeClick = vi.fn();
    const { container } = renderShell({ onNodeClick });
    const node = container.querySelector('.react-flow__node[data-id="root"]');
    expect(node).not.toBeNull();
    fireEvent.click(node as Element);
    expect(onNodeClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "root" }),
    );
  });

  // jsdom never measures nodes, so the first fit never settles here: this
  // covers the fallback. The top alignment itself was checked in a browser.
  it("reveals a top-aligned canvas even if its first fit never settles", async () => {
    vi.useFakeTimers();
    const { container } = renderShell({ alignTopAfterFit: true });
    const shell = container.querySelector(".host-redesign-canvas");
    expect(shell).toHaveAttribute("data-viewport-ready", "false");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(shell).toHaveAttribute("data-viewport-ready", "true");
  });

  it("does not schedule a reveal when React Flow initializes after unmount", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const { unmount } = renderShell({});
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    const scheduledReveal = setTimeoutSpy.mock.calls.some(([, ms]) => ms === 60);
    setTimeoutSpy.mockRestore();
    expect(scheduledReveal).toBe(false);
  });

  // A reveal left pending after unmount fired once the test environment was
  // gone and failed CI with "window is not defined".
  it.each([
    { alignTopAfterFit: false, delay: 60 },
    { alignTopAfterFit: true, delay: 400 },
  ])(
    "cancels the pending reveal when it unmounts first (alignTopAfterFit: $alignTopAfterFit)",
    async ({ alignTopAfterFit, delay }) => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
      const { unmount } = renderShell({ alignTopAfterFit });
      // ReactFlow calls onInit a frame after mount; stop well before the
      // reveal itself is due.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });

      const revealCall = setTimeoutSpy.mock.calls.findIndex(
        ([, ms]) => ms === delay,
      );
      expect(revealCall).toBeGreaterThanOrEqual(0);
      const revealId = setTimeoutSpy.mock.results[revealCall].value;

      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(revealId);
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    },
  );
});
