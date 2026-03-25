import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { ArchBlockNodeData } from "./types";
import {
  ARCH_BLOCK_WIDTH,
  ARCH_BLOCK_HEIGHT,
  ARCH_BLOCK_HERO_IMAGE_MIN_HEIGHT,
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

    const w = data.width ?? ARCH_BLOCK_WIDTH;
    const h = data.height ?? ARCH_BLOCK_HEIGHT;
    const isLarge = w > ARCH_BLOCK_WIDTH || h > ARCH_BLOCK_HEIGHT;

    // Hero strip needs enough vertical space; wide-but-short nodes use compact layout
    const hasLargeImage = Boolean(
      data.imageSrc &&
        isLarge &&
        h >= ARCH_BLOCK_HERO_IMAGE_MIN_HEIGHT,
    );

    return (
      <div
        className={cn(
          "rounded-lg bg-card flex flex-col overflow-hidden transition-all duration-300",
          !hasLargeImage && "items-center justify-center text-center px-3 py-2",
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
        {hasLargeImage ? (
          <>
            <div className="flex-1 min-h-0 overflow-hidden">
              <img
                src={data.imageSrc}
                alt={data.imageAlt ?? data.label}
                className="w-full h-full object-cover rounded-t-md"
                loading="lazy"
              />
            </div>
            <div className="px-2 py-1.5 text-center shrink-0">
              <div className="text-xs font-semibold leading-tight">
                {data.label}
              </div>
              {data.subtitle && (
                <div className="text-[10px] text-muted-foreground leading-tight">
                  {data.subtitle}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {data.logos && data.logos.length > 0 ? (
              <div className="mb-1 flex items-center justify-center gap-1.5">
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
            ) : data.imageSrc ? (
              <img
                src={data.imageSrc}
                alt={data.imageAlt ?? data.label}
                className="mb-1 h-5 w-5 object-contain"
                loading="lazy"
              />
            ) : data.icon ? (
              <data.icon
                className={cn(
                  "mb-1 text-muted-foreground",
                  isLarge ? "h-6 w-6" : "h-4 w-4",
                )}
              />
            ) : null}
            <div
              className={cn(
                "font-semibold leading-tight",
                isLarge ? "text-base" : "text-xs",
              )}
            >
              {data.label}
            </div>
            {data.subtitle && (
              <div
                className={cn(
                  "text-muted-foreground leading-tight mt-0.5",
                  isLarge ? "text-xs" : "text-[10px]",
                )}
              >
                {data.subtitle}
              </div>
            )}
          </>
        )}

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

ArchBlockNode.displayName = "ArchBlockNode";
