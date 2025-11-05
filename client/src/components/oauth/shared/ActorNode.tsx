import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { ActorNodeData } from "./types";

// Actor Node - Segmented vertical swimlane
export const ActorNode = memo((props: NodeProps<Node<ActorNodeData>>) => {
  const { data } = props;
  let currentY = 50;

  return (
    <div className="flex flex-col items-center relative" style={{ width: 140 }}>
      {/* Actor label at top - fixed height for consistent alignment */}
      <div
        className={cn(
          "px-4 py-2 rounded-md font-semibold text-xs border-2 bg-card shadow-sm z-10 mb-2 flex items-center justify-center text-center",
        )}
        style={{
          borderColor: data.color,
          height: "52px",
          minHeight: "52px",
          width: "130px",
        }}
      >
        {data.label}
      </div>

      {/* Segmented vertical line */}
      <div className="relative" style={{ width: 2, height: data.totalHeight }}>
        {data.segments.map((segment) => {
          const segmentY = currentY;
          currentY += segment.height;

          if (segment.type === "box") {
            return (
              <div
                key={segment.id}
                className="absolute left-1/2 -translate-x-1/2"
                style={{
                  top: segmentY,
                  width: 24,
                  height: segment.height,
                  backgroundColor: data.color,
                  opacity: 0.6,
                  borderRadius: 2,
                }}
              >
                {segment.handleId && (
                  <>
                    {/* Right side handles - both source and target for bidirectional flow */}
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={`${segment.handleId}-right-source`}
                      style={{
                        right: -4,
                        top: "50%",
                        background: data.color,
                        width: 8,
                        height: 8,
                        border: "2px solid white",
                      }}
                    />
                    <Handle
                      type="target"
                      position={Position.Right}
                      id={`${segment.handleId}-right-target`}
                      style={{
                        right: -4,
                        top: "50%",
                        background: data.color,
                        width: 8,
                        height: 8,
                        border: "2px solid white",
                      }}
                    />
                    {/* Left side handles - both source and target for bidirectional flow */}
                    <Handle
                      type="source"
                      position={Position.Left}
                      id={`${segment.handleId}-left-source`}
                      style={{
                        left: -4,
                        top: "50%",
                        background: data.color,
                        width: 8,
                        height: 8,
                        border: "2px solid white",
                      }}
                    />
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={`${segment.handleId}-left-target`}
                      style={{
                        left: -4,
                        top: "50%",
                        background: data.color,
                        width: 8,
                        height: 8,
                        border: "2px solid white",
                      }}
                    />
                  </>
                )}
              </div>
            );
          } else {
            return (
              <div
                key={segment.id}
                className="absolute left-1/2 -translate-x-1/2"
                style={{
                  top: segmentY,
                  width: 2,
                  height: segment.height,
                  backgroundColor: data.color,
                  opacity: 0.2,
                }}
              />
            );
          }
        })}
      </div>

      {/* Actor label at bottom - fixed height for consistent alignment */}
      <div
        className={cn(
          "px-4 py-2 rounded-md font-semibold text-xs border-2 bg-card shadow-sm z-10 mt-2 flex items-center justify-center text-center",
        )}
        style={{
          borderColor: data.color,
          height: "52px",
          minHeight: "52px",
          width: "130px",
        }}
      >
        {data.label}
      </div>
    </div>
  );
});

ActorNode.displayName = "ActorNode";
