import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { ArchAssetNodeData } from "./types";
import {
  ARCH_ASSET_CODE_WIDTH,
  ARCH_ASSET_CODE_HEIGHT,
} from "./constants";

const statusStyles: Record<string, string> = {
  current:
    "border-2 opacity-100 shadow-lg ring-2 ring-offset-1 ring-offset-background animate-pulse",
  complete: "border-2 opacity-100 shadow-sm",
  pending: "border opacity-40",
  neutral: "border opacity-100",
};

const SIDES = [
  { side: "top", position: Position.Top },
  { side: "right", position: Position.Right },
  { side: "bottom", position: Position.Bottom },
  { side: "left", position: Position.Left },
] as const;

const hiddenHandleStyle = {
  width: 1,
  height: 1,
  opacity: 0,
  border: "none",
  background: "transparent",
};

export const ArchAssetNode = memo(
  (props: NodeProps<Node<ArchAssetNodeData>>) => {
    const { data } = props;

    const borderColor =
      data.status === "pending"
        ? "#d1d5db"
        : data.status === "neutral"
          ? "#94a3b8"
          : data.color;

    const ringColor =
      data.status === "current" ? `${data.color}33` : "transparent";

    const w = data.width ?? ARCH_ASSET_CODE_WIDTH;
    const h = data.height ?? ARCH_ASSET_CODE_HEIGHT;

    return (
      <div
        className={cn(
          "rounded-lg bg-card flex flex-col overflow-hidden transition-all duration-300",
          statusStyles[data.status],
        )}
        style={{
          width: w,
          height: h,
          borderColor,
          boxShadow:
            data.status === "current" ? `0 0 16px ${ringColor}` : undefined,
        }}
      >
        <div className="shrink-0 flex items-start gap-2 px-2.5 pt-2 pb-1.5 border-b border-border/40">
          {data.icon && (
            <data.icon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 text-left">
            <div className="text-[11px] font-semibold leading-tight">
              {data.label}
            </div>
            {data.subtitle && (
              <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                {data.subtitle}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          {data.assetType === "image" && data.imageSrc ? (
            <div className="flex-1 min-h-0 p-1.5 flex items-center justify-center bg-muted/30">
              <img
                src={data.imageSrc}
                alt={data.imageAlt ?? ""}
                className="max-w-full max-h-full object-contain rounded"
              />
            </div>
          ) : (
            <div className="flex-1 min-h-0 bg-muted/50 overflow-hidden rounded-b-md">
              <pre className="h-full overflow-hidden p-2 m-0">
                <code
                  className={cn(
                    "text-[10px] font-mono leading-snug block whitespace-pre-wrap break-all text-foreground/90",
                  )}
                >
                  {data.code ?? ""}
                </code>
              </pre>
            </div>
          )}
        </div>

        {SIDES.map(({ side, position }) => (
          <Handle
            key={`${side}-source`}
            id={`${side}-source`}
            type="source"
            position={position}
            style={hiddenHandleStyle}
          />
        ))}
        {SIDES.map(({ side, position }) => (
          <Handle
            key={`${side}-target`}
            id={`${side}-target`}
            type="target"
            position={position}
            style={hiddenHandleStyle}
          />
        ))}
      </div>
    );
  },
);

ArchAssetNode.displayName = "ArchAssetNode";
