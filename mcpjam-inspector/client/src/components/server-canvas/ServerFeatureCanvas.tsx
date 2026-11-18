import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Handle,
  Position,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  CanvasShell,
  DECORATIVE_HANDLE_CLASS,
} from "@/components/canvas-kit/CanvasShell";
import { useReportedHeight } from "@/components/canvas-kit/measured-shift";
import { TreeBranchEdge } from "@/components/canvas-kit/tree-edges";
import {
  ServerFeatureCard,
  ServerRootCard,
  type FeatureCardHandlers,
  type ServerRootSummary,
} from "./ServerCanvasCards";
import type { CardModel } from "./feature-tree";
import {
  CARD_WIDTH,
  ROOT_NODE_ID,
  estimateCardHeight,
  initialViewNodeIds,
  layoutServerCanvas,
} from "./server-canvas-layout";

type RootNode = Node<{ summary: ServerRootSummary }, "serverRoot">;
type CardNode = Node<
  { card: CardModel; side: "left" | "right" },
  "featureCard"
>;
type CanvasNode = RootNode | CardNode;

/** Stable for the canvas's lifetime, so observers are set up once per node. */
const ReportHeightContext = createContext<
  ((nodeId: string, height: number) => void) | null
>(null);
const HandlersContext = createContext<FeatureCardHandlers | null>(null);

function useNodeHeightReport(nodeId: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const report = useContext(ReportHeightContext);
  const reportHeight = useCallback(
    (height: number) => report?.(nodeId, height),
    [report, nodeId],
  );
  useReportedHeight(ref, reportHeight);
  return ref;
}

const RootRenderer = memo(({ id, data }: NodeProps<RootNode>) => {
  const ref = useNodeHeightReport(id);
  return (
    <div ref={ref} className="w-full">
      <ServerRootCard summary={data.summary} />
      <Handle
        type="source"
        position={Position.Bottom}
        className={DECORATIVE_HANDLE_CLASS}
      />
    </div>
  );
});
RootRenderer.displayName = "ServerCanvasRootRenderer";

const CardRenderer = memo(({ id, data }: NodeProps<CardNode>) => {
  const ref = useNodeHeightReport(id);
  const handlers = useContext(HandlersContext);
  if (!handlers) return null;
  return (
    <div ref={ref} className="w-full">
      <ServerFeatureCard card={data.card} handlers={handlers} />
      <Handle
        type="target"
        position={data.side === "left" ? Position.Right : Position.Left}
        className={DECORATIVE_HANDLE_CLASS}
      />
    </div>
  );
});
CardRenderer.displayName = "ServerCanvasCardRenderer";

const nodeTypes = { serverRoot: RootRenderer, featureCard: CardRenderer };
const edgeTypes = { stub: TreeBranchEdge };
/** The map panel already frames the canvas, so the shell drops its own. */
const SHELL_STYLE = { border: "none", borderRadius: 0 };
const EDGE_STYLE = {
  stroke: "color-mix(in oklch, var(--muted-foreground) 55%, transparent)",
  strokeWidth: 1.5,
};

/**
 * The section cards on a pan-and-zoom canvas. It opens at a readable zoom,
 * sized to the root and the top card of each column and aligned to the root
 * rather than fitting every card; scrolling pans down the trunk.
 */
export function ServerFeatureCanvas({
  root,
  cards,
  handlers,
  onPaneClick,
}: {
  root: ServerRootSummary;
  cards: readonly CardModel[];
  handlers: FeatureCardHandlers;
  onPaneClick: () => void;
}) {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const reportHeight = useCallback((nodeId: string, height: number) => {
    setHeights((prev) =>
      Math.abs((prev[nodeId] ?? 0) - height) < 0.5
        ? prev
        : { ...prev, [nodeId]: height },
    );
  }, []);

  const { nodes, edges } = useMemo(() => {
    const byId = new Map(cards.map((card) => [card.id, card]));
    const layout = layoutServerCanvas({
      cards: cards.map((card) => ({
        id: card.id,
        estimatedHeight: estimateCardHeight(card.families.length),
      })),
      heights,
    });
    const flowNodes: CanvasNode[] = layout.nodes.flatMap((node): CanvasNode[] => {
      const common = {
        id: node.id,
        position: { x: node.x, y: node.y },
        style: { width: CARD_WIDTH },
        draggable: false,
        selectable: false,
        focusable: false,
      };
      if (node.id === ROOT_NODE_ID)
        return [{ ...common, type: "serverRoot", data: { summary: root } }];
      const card = byId.get(node.id as CardModel["id"]);
      return card && node.side
        ? [{ ...common, type: "featureCard", data: { card, side: node.side } }]
        : [];
    });
    const flowEdges: Edge[] = layout.edges.map((edge) => ({
      ...edge,
      type: "stub",
      style: EDGE_STYLE,
      focusable: false,
    }));
    return { nodes: flowNodes, edges: flowEdges };
  }, [cards, heights, root]);

  // The first fit only: later card changes keep the reader's viewport.
  const [fitViewOptions] = useState(() => ({
    nodes: initialViewNodeIds(cards.map((card) => card.id)).map((id) => ({
      id,
    })),
    minZoom: 0.8,
    maxZoom: 1,
  }));

  return (
    <ReportHeightContext.Provider value={reportHeight}>
      <HandlersContext.Provider value={handlers}>
        <ReactFlowProvider>
          <CanvasShell<CanvasNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            backgroundId="server-canvas-dots"
            style={SHELL_STYLE}
            elementsSelectable={false}
            fitViewOptions={fitViewOptions}
            alignTopAfterFit
            onNodeClick={() => {}}
            onPaneClick={onPaneClick}
          />
        </ReactFlowProvider>
      </HandlersContext.Provider>
    </ReportHeightContext.Provider>
  );
}
