import { cn } from "@/lib/utils";
import type { McpToolResultImagePreview } from "./mcp-tool-result-image-preview";

export function McpToolResultImagePreviewGrid({
  previews,
  className,
  tileClassName,
  imageClassName,
}: {
  previews: McpToolResultImagePreview[];
  className?: string;
  tileClassName?: string;
  imageClassName?: string;
}) {
  return (
    <div className={cn("grid gap-3", className)}>
      {previews.map((preview, index) => (
        <div
          key={`${preview.mediaType}-${index}`}
          className={cn(
            "min-h-[180px] min-w-0 rounded border border-border bg-background p-2 flex items-center justify-center",
            tileClassName
          )}
        >
          <img
            src={preview.src}
            alt={preview.alt}
            className={cn(
              "max-h-[520px] max-w-full object-contain",
              imageClassName
            )}
          />
        </div>
      ))}
    </div>
  );
}
