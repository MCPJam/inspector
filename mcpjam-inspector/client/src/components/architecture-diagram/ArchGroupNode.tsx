import { memo } from "react";
import { type Node, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { ArchGroupNodeData } from "./types";

const statusStyles: Record<string, string> = {
  current: "opacity-100",
  complete: "opacity-100",
  pending: "opacity-40",
  neutral: "opacity-100",
};

export const ArchGroupNode = memo(
  (props: NodeProps<Node<ArchGroupNodeData>>) => {
    const { data } = props;

    const borderColor =
      data.status === "pending"
        ? "#d1d5db"
        : data.status === "neutral"
          ? "#94a3b8"
          : data.color;

    return (
      <div
        className={cn(
          "rounded-xl border-2 border-dashed transition-all duration-300",
          statusStyles[data.status],
        )}
        style={{
          width: data.width,
          height: data.height,
          borderColor,
          backgroundColor: `${borderColor}08`,
        }}
      >
        <div
          className="absolute top-3 left-4 text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: borderColor }}
        >
          {data.label}
        </div>
        {data.subtitle && (
          <div className="absolute top-7 left-4 text-[10px] text-muted-foreground">
            {data.subtitle}
          </div>
        )}
      </div>
    );
  },
);

ArchGroupNode.displayName = "ArchGroupNode";
