import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { ActionEdgeData } from "./types";

// Custom Edge with Label
export const CustomActionEdge = memo(
  (props: EdgeProps<Edge<ActionEdgeData>>) => {
    const { sourceX, sourceY, targetX, targetY, data, style, markerEnd } =
      props;

    if (!data) return null;

    const statusColor = {
      complete: "border-green-500/50 bg-green-50 dark:bg-green-950/20",
      current:
        "border-blue-500 bg-blue-100 dark:bg-blue-950/30 shadow-lg shadow-blue-500/20 animate-pulse",
      pending: "border-border bg-muted/30",
    }[data.status];

    const labelX = (sourceX + targetX) / 2;
    const labelY = (sourceY + targetY) / 2;

    return (
      <>
        <BaseEdge
          path={`M ${sourceX},${sourceY} L ${targetX},${targetY}`}
          style={style}
          markerEnd={markerEnd}
        />
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
                "px-3 py-1.5 rounded border text-xs shadow-sm backdrop-blur-sm",
                statusColor,
              )}
            >
              <div className="font-medium">{data.label}</div>
              {data.details && data.details.length > 0 && (
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {data.details.map((d, i) => (
                    <div key={i}>
                      {d.label}: {d.value}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </EdgeLabelRenderer>
      </>
    );
  },
);

CustomActionEdge.displayName = "CustomActionEdge";
