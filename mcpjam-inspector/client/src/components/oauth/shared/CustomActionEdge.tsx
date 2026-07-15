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
    // Keep the label inside the edge so the arrow remains visible on both
    // sides. Long values (especially MCP URLs) should not cover the entire
    // request/response line.
    const labelMaxWidth = Math.max(
      160,
      Math.min(420, Math.abs(targetX - sourceX) * 0.8)
    );
    const details =
      data.stepId === "generate_pkce_parameters"
        ? data.details?.filter(
            (detail) =>
              !["code_challenge", "method", "resource"].includes(detail.label)
          )
        : data.details;

    return (
      <>
        {!data.isInternal && (
          <BaseEdge
            path={`M ${sourceX},${sourceY} L ${targetX},${targetY}`}
            style={style}
            markerEnd={markerEnd}
          />
        )}
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
              zIndex: 10,
            }}
          >
            <div
              className={cn(
                "w-fit max-w-full overflow-hidden rounded border px-2 py-1 text-[11px] leading-tight shadow-sm backdrop-blur-sm",
                statusColor
              )}
              style={{ maxWidth: labelMaxWidth }}
            >
              <div className="truncate font-medium" title={data.label}>
                {data.label}
              </div>
              {details && details.length > 0 && (
                <div className="mt-0.5 flex min-w-0 flex-col gap-0.5 text-[9px] leading-tight text-muted-foreground">
                  {details.map((d, i) => (
                    <div
                      key={i}
                      className="flex min-w-0 items-baseline gap-1 whitespace-nowrap"
                    >
                      <span className="shrink-0">{d.label}:</span>
                      <span
                        className="min-w-0 truncate"
                        title={
                          typeof d.value === "string" ? d.value : undefined
                        }
                      >
                        {d.value}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </EdgeLabelRenderer>
      </>
    );
  }
);

CustomActionEdge.displayName = "CustomActionEdge";
