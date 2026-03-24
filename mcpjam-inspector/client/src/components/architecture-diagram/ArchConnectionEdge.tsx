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
  complete:
    "border-green-500/50 bg-green-50 dark:bg-green-950/20 text-foreground/80",
  current:
    "border-blue-500 bg-blue-100 dark:bg-blue-950/30 text-foreground shadow-md shadow-blue-500/10",
  pending: "border-border bg-muted/30 text-muted-foreground/50",
  neutral:
    "border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/30 text-foreground/70",
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
                pointerEvents: "all",
              }}
            >
              <div
                className={cn(
                  "px-2 py-1 rounded border text-[10px] font-medium whitespace-nowrap",
                  "cursor-pointer transition-all duration-200 hover:shadow-md hover:scale-[1.02]",
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
