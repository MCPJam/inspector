import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { ArchBlockNodeData } from "./types";
import { ARCH_BLOCK_WIDTH, ARCH_BLOCK_HEIGHT } from "./constants";

const statusStyles: Record<string, string> = {
  current:
    "border-2 opacity-100 shadow-lg ring-2 ring-offset-1 ring-offset-background animate-pulse",
  complete: "border-2 opacity-100 shadow-sm",
  pending: "border opacity-40",
  neutral: "border opacity-100",
};

export const ArchBlockNode = memo(
  (props: NodeProps<Node<ArchBlockNodeData>>) => {
    const { data } = props;

    const borderColor =
      data.status === "pending"
        ? "#d1d5db"
        : data.status === "neutral"
          ? "#94a3b8"
          : data.color;

    const ringColor =
      data.status === "current" ? `${data.color}33` : "transparent";

    return (
      <div
        className={cn(
          "rounded-lg bg-card flex flex-col items-center justify-center text-center px-3 py-2 transition-all duration-300",
          statusStyles[data.status],
        )}
        style={{
          width: ARCH_BLOCK_WIDTH,
          height: ARCH_BLOCK_HEIGHT,
          borderColor,
          boxShadow:
            data.status === "current"
              ? `0 0 16px ${ringColor}`
              : undefined,
        }}
      >
        {data.icon && (
          <span className="text-base leading-none mb-1">{data.icon}</span>
        )}
        <div className="font-semibold text-xs leading-tight">{data.label}</div>
        {data.subtitle && (
          <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
            {data.subtitle}
          </div>
        )}

        <Handle
          type="target"
          position={Position.Left}
          style={{
            background: borderColor,
            width: 6,
            height: 6,
            border: "1.5px solid white",
          }}
        />
        <Handle
          type="source"
          position={Position.Right}
          style={{
            background: borderColor,
            width: 6,
            height: 6,
            border: "1.5px solid white",
          }}
        />
      </div>
    );
  },
);

ArchBlockNode.displayName = "ArchBlockNode";
