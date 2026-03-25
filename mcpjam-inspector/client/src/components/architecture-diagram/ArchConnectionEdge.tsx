import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  getBezierPath,
  getStraightPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { ArchEdgeData } from "./types";

const statusColor: Record<string, string> = {
  complete: "#10b981",
  current: "#3b82f6",
  pending: "#d1d5db",
  neutral: "#94a3b8",
};

const labelStyles: Record<string, string> = {
  complete: "bg-green-500/10 text-green-700 dark:text-green-400",
  current: "bg-blue-500/15 text-blue-700 dark:text-blue-400 shadow-sm",
  pending: "bg-muted/50 text-muted-foreground/40",
  neutral: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
};

const pathFunctions = {
  smoothstep: getSmoothStepPath,
  bezier: getBezierPath,
  straight: getStraightPath,
} as const;

export const ArchConnectionEdge = memo(
  (props: EdgeProps<Edge<ArchEdgeData>>) => {
    const {
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      data,
      markerEnd,
      markerStart,
    } = props;

    if (!data) return null;

    const stroke = statusColor[data.status] ?? statusColor.neutral;
    const pathType = data.pathType ?? "smoothstep";
    const labelInteractive = data.interactiveLabels !== false;
    const getPath = pathFunctions[pathType] ?? getSmoothStepPath;

    const pathParams = {
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      ...(pathType === "smoothstep" ? { borderRadius: 8 } : {}),
    };

    const [edgePath, labelX, labelY] = getPath(pathParams);

    return (
      <>
        <BaseEdge
          path={edgePath}
          markerEnd={markerEnd}
          markerStart={markerStart}
          style={{
            stroke,
            strokeWidth: data.status === "current" ? 2.5 : 1.5,
            strokeDasharray: data.status === "current" ? "6,4" : undefined,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            opacity: data.status === "pending" ? 0.4 : 1,
            transition: "all 0.3s ease",
          }}
        />
        {data.label && (
          <EdgeLabelRenderer>
            <div
              style={{
                position: "absolute",
                transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
                pointerEvents: labelInteractive ? "all" : "none",
                zIndex: 10,
              }}
            >
              <div
                className={cn(
                  "px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap",
                  "backdrop-blur-sm transition-all duration-200",
                  labelInteractive &&
                    "cursor-pointer hover:scale-[1.02]",
                  labelStyles[data.status],
                )}
              >
                {data.label}
              </div>
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  },
);

ArchConnectionEdge.displayName = "ArchConnectionEdge";
