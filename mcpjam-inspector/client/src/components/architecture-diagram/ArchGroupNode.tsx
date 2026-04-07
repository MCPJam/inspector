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
        <div className="absolute top-3 left-4 flex items-center gap-2">
          {data.logos && data.logos.length > 0 && (
            <div className="flex items-center gap-1.5">
              {data.logos.map((logo, i) => (
                <img
                  key={i}
                  src={logo.src}
                  alt={logo.alt}
                  className="h-5 w-5 object-contain"
                  loading="lazy"
                />
              ))}
            </div>
          )}
          <span
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: borderColor }}
          >
            {data.label}
          </span>
        </div>
        {data.subtitle && (
          <div
            className="absolute text-[10px] text-muted-foreground"
            style={{ top: data.logos?.length ? 28 : 28, left: 16 }}
          >
            {data.subtitle}
          </div>
        )}
      </div>
    );
  },
);

ArchGroupNode.displayName = "ArchGroupNode";
