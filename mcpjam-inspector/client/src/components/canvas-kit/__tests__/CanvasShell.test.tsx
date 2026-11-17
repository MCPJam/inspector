import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider, type Node } from "@xyflow/react";
import { CanvasShell } from "../CanvasShell";

const NODES: Node[] = [
  { id: "root", position: { x: 0, y: 0 }, data: { label: "Root" } },
];

function renderShell(props: {
  edgeRevealDelayMs?: number;
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
});
