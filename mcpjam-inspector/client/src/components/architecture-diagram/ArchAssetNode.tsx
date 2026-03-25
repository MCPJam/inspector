import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { ArchAssetNodeData } from "./types";
import { ARCH_ASSET_CODE_WIDTH, ARCH_ASSET_CODE_HEIGHT } from "./constants";

const statusStyles: Record<string, string> = {
  current: "opacity-100 shadow-lg ring-2 ring-offset-1 ring-offset-background",
  complete: "opacity-100 shadow-sm",
  pending: "opacity-40",
  neutral: "opacity-100",
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

    // 10% opacity hex suffix for the header background
    const headerBg = `${data.color}1a`;

    return (
      <div
        className={cn(
          "rounded-xl border-2 border-dashed bg-card flex flex-col overflow-hidden transition-all duration-300",
          statusStyles[data.status],
        )}
        style={{
          width: w,
          height: h,
          borderColor,
          boxShadow:
            data.status === "current" ? `0 0 20px ${ringColor}` : undefined,
        }}
      >
        {/* Colored header strip */}
        {!data.compact && (
          <div
            className="flex items-center gap-2 px-4 py-2.5 shrink-0"
            style={{ backgroundColor: headerBg }}
          >
            {data.icon && (
              <data.icon
                className="h-4 w-4 shrink-0"
                style={{ color: borderColor }}
              />
            )}
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-tight truncate">
                {data.label}
              </div>
              {data.subtitle && (
                <div className="text-[10px] text-muted-foreground leading-tight truncate">
                  {data.subtitle}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Content body */}
        {data.assetType === "code" && data.code && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <pre className="px-4 py-3 text-[11px] font-mono leading-relaxed text-foreground/70 whitespace-pre overflow-hidden h-full m-0">
              {data.code}
            </pre>
          </div>
        )}

        {data.assetType === "image" && data.imageSrc && (
          <div className="flex-1 min-h-0 overflow-hidden p-2">
            <img
              src={data.imageSrc}
              alt={data.imageAlt ?? data.label}
              className="w-full h-full object-contain rounded-lg"
              loading="lazy"
            />
          </div>
        )}

        {/* Hidden handles on all sides */}
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
