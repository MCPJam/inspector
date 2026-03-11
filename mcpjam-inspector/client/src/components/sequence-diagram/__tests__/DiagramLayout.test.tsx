import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { DiagramLayout } from "../DiagramLayout";
import type { DiagramZoomConfig } from "../types";
import type { Node, Edge } from "@xyflow/react";

// Mock useReactFlow to capture setCenter calls
const mockSetCenter = vi.fn();
vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      setCenter: mockSetCenter,
      getNodes: () => [],
      getEdges: () => [],
      fitView: vi.fn(),
      setViewport: vi.fn(),
    }),
  };
});

// Minimal test fixtures
const nodes: Node[] = [
  {
    id: "actor-client",
    type: "actor",
    position: { x: 100, y: 0 },
    data: {
      label: "Client",
      color: "#10b981",
      totalHeight: 460,
      segments: [
        { id: "client-box-step1", type: "box", height: 80, handleId: "step1" },
      ],
    },
  },
  {
    id: "actor-server",
    type: "actor",
    position: { x: 350, y: 0 },
    data: {
      label: "Server",
      color: "#f59e0b",
      totalHeight: 460,
      segments: [
        { id: "server-box-step1", type: "box", height: 80, handleId: "step1" },
      ],
    },
  },
];

const edges: Edge[] = [
  {
    id: "edge-step1",
    source: "actor-client",
    target: "actor-server",
    type: "actionEdge",
    data: { stepId: "step1", label: "Request", description: "A request", status: "current" },
  },
];

function renderWithProvider(props: React.ComponentProps<typeof DiagramLayout>) {
  return render(
    <ReactFlowProvider>
      <DiagramLayout {...props} />
    </ReactFlowProvider>,
  );
}

describe("DiagramLayout", () => {
  beforeEach(() => {
    mockSetCenter.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("no auto-zoom when currentStep is undefined", () => {
    it("does not call setCenter at all", () => {
      renderWithProvider({ nodes, edges });

      // Advance all timers
      vi.advanceTimersByTime(500);
      expect(mockSetCenter).not.toHaveBeenCalled();
    });
  });

  describe("zoomConfig parameterization", () => {
    it("zooms to top when currentStep matches idleStepId", () => {
      const zoomConfig: DiagramZoomConfig = {
        idleStepId: "idle",
        completeStepId: "complete",
      };

      renderWithProvider({
        nodes,
        edges,
        currentStep: "idle",
        zoomConfig,
      });

      vi.advanceTimersByTime(200);

      // Should zoom to center of actor nodes
      expect(mockSetCenter).toHaveBeenCalledTimes(1);
      const [x, y, options] = mockSetCenter.mock.calls[0];
      // Center of actors at x=100 and x=350 → (100+350)/2 + 70 = 295
      expect(x).toBe(295);
      expect(y).toBe(200);
      expect(options.zoom).toBe(0.8);
    });

    it("does NOT auto-zoom when currentStep matches completeStepId", () => {
      const zoomConfig: DiagramZoomConfig = {
        idleStepId: "idle",
        completeStepId: "complete",
      };

      renderWithProvider({
        nodes,
        edges,
        currentStep: "complete",
        zoomConfig,
      });

      vi.advanceTimersByTime(200);
      expect(mockSetCenter).not.toHaveBeenCalled();
    });

    it("zooms to current edge when currentStep is an active step", () => {
      const zoomConfig: DiagramZoomConfig = {
        idleStepId: "idle",
        completeStepId: "done",
      };

      renderWithProvider({
        nodes,
        edges,
        currentStep: "step1",
        zoomConfig,
      });

      vi.advanceTimersByTime(200);
      expect(mockSetCenter).toHaveBeenCalledTimes(1);
      const [, , options] = mockSetCenter.mock.calls[0];
      expect(options.zoom).toBe(1.2); // zoomed in to current step
    });
  });

  describe("focusedStep override", () => {
    it("zooms to focused step instead of current step when provided", () => {
      const edgesWithFocus: Edge[] = [
        ...edges,
        {
          id: "edge-step2",
          source: "actor-server",
          target: "actor-client",
          type: "actionEdge",
          data: {
            stepId: "step2",
            label: "Response",
            description: "A response",
            status: "pending",
          },
        },
      ];

      renderWithProvider({
        nodes,
        edges: edgesWithFocus,
        currentStep: "step1",
        focusedStep: "step2",
      });

      vi.advanceTimersByTime(200);
      expect(mockSetCenter).toHaveBeenCalledTimes(1);
    });
  });
});
