import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type EdgeTypes,
  type FitViewOptions,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

/** Class for node handles that exist only to anchor edges. */
export const DECORATIVE_HANDLE_CLASS = "!opacity-0 !w-2 !h-2";

const FIT_VIEW_PADDING = 0.18;
/** Space above the content when the first view is aligned to the top. */
const TOP_ALIGN_INSET = 24;
/** Reveal a top-aligned canvas even if its first fit never settles. */
const TOP_ALIGN_REVEAL_FALLBACK_MS = 400;

export interface CanvasShellProps<N extends Node, E extends Edge> {
  nodes: N[];
  edges: E[];
  nodeTypes: NodeTypes;
  edgeTypes: EdgeTypes;
  /** Id of the dot-grid pattern; unique per canvas on a page. */
  backgroundId: string;
  style?: CSSProperties;
  /** False renders a static summary whose nodes cannot be selected. */
  elementsSelectable?: boolean;
  /**
   * How long the edges stay hidden after mount, so cards that morph into
   * place land before the lines that join them appear.
   */
  edgeRevealDelayMs?: number;
  /**
   * Narrows the first fit, e.g. to the top of a tall tree at a readable
   * zoom. By default every node is fitted.
   */
  fitViewOptions?: Pick<FitViewOptions<N>, "nodes" | "minZoom" | "maxZoom">;
  /**
   * Keep the first fit's zoom and horizontal position but put the content
   * at the top of the frame, so a tall tree opens on its root.
   */
  alignTopAfterFit?: boolean;
  onNodeClick: (node: N) => void;
  onPaneClick: () => void;
}

/**
 * The pan-and-zoom frame every tree canvas shares: a rounded, bordered
 * surface on a dot grid, zoom controls, and no dragging or connecting.
 *
 * Two gates keep the first frames clean. ReactFlow paints nodes at their raw
 * coordinates before `fitView` applies, so the viewport stays transparent
 * until the fit has settled. The edges stay hidden for `edgeRevealDelayMs`.
 * The `host-redesign-canvas` class and the `data-*-ready` attributes drive
 * the CSS side of both gates in `index.css`.
 */
export function CanvasShell<N extends Node, E extends Edge>({
  nodes,
  edges,
  nodeTypes,
  edgeTypes,
  backgroundId,
  style,
  elementsSelectable = true,
  edgeRevealDelayMs = 0,
  fitViewOptions,
  alignTopAfterFit = false,
  onNodeClick,
  onPaneClick,
}: CanvasShellProps<N, E>) {
  const [edgesReady, setEdgesReady] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setEdgesReady(true), edgeRevealDelayMs);
    return () => window.clearTimeout(t);
  }, [edgeRevealDelayMs]);

  const [viewportReady, setViewportReady] = useState(false);
  // The canvas can unmount before its reveal runs (a route change, a test
  // ending), so the pending reveal is cancelled on unmount.
  const revealTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(revealTimer.current);
    };
  }, []);

  return (
    <div
      className="host-redesign-canvas relative h-full w-full overflow-hidden rounded-[28px] border border-border/70 bg-background"
      style={style}
      data-edges-ready={edgesReady ? "true" : "false"}
      data-viewport-ready={viewportReady ? "true" : "false"}
    >
      {/* Inline opacity gate: inline style always wins over the cascade,
          unlike the `data-viewport-ready` attribute selector, which xyflow's
          own stylesheet shadows in some load orders. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: viewportReady ? 1 : 0,
          transition: viewportReady
            ? "opacity 220ms cubic-bezier(0.22, 1, 0.36, 1)"
            : "none",
        }}
      >
        <ReactFlow<N, E>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.55}
          maxZoom={1.35}
          proOptions={{ hideAttribution: true }}
          panOnDrag
          panOnScroll
          zoomOnScroll
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={elementsSelectable}
          fitView
          fitViewOptions={{
            ...fitViewOptions,
            padding: FIT_VIEW_PADDING,
            duration: 0,
          }}
          onInit={(instance) => {
            // React Flow can deliver its queued onInit after unmount.
            if (!mounted.current) return;
            // Fit again and flip visibility a few frames later: a single
            // requestAnimationFrame fires before ReactFlow's first
            // measurement pass.
            const fitted = instance.fitView({
              ...fitViewOptions,
              padding: FIT_VIEW_PADDING,
              duration: 0,
            });
            revealTimer.current = window.setTimeout(
              () => setViewportReady(true),
              alignTopAfterFit ? TOP_ALIGN_REVEAL_FALLBACK_MS : 60,
            );
            if (!alignTopAfterFit) return;
            void fitted.then(() => {
              if (!mounted.current) return;
              const { x, zoom } = instance.getViewport();
              void instance.setViewport({ x, y: TOP_ALIGN_INSET, zoom });
              window.clearTimeout(revealTimer.current);
              setViewportReady(true);
            });
          }}
          onNodeClick={(_, node) => onNodeClick(node)}
          onPaneClick={onPaneClick}
        >
          <Background
            id={backgroundId}
            variant={BackgroundVariant.Dots}
            gap={16}
            size={0.9}
            color="oklch(0.55 0.02 250 / 0.22)"
            patternClassName="opacity-[0.45]"
          />
          <Controls
            showInteractive={false}
            className="!rounded-xl !border !border-border/70 !bg-card/95"
          />
        </ReactFlow>
      </div>
    </div>
  );
}
