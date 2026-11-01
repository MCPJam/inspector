import { cn } from "@/lib/utils";
import type { McpToolResultImagePreview } from "./mcp-tool-result-image-preview";

export function McpToolResultImagePreviewGrid({
  previews,
  omittedImageCount = 0,
  className,
  tileClassName,
  imageClassName,
}: {
  previews: McpToolResultImagePreview[];
  omittedImageCount?: number;
  className?: string;
  tileClassName?: string;
  imageClassName?: string;
}) {
  return (
    <div className={cn("grid gap-3", className)}>
      {omittedImageCount > 0 && (
        <p
          role="alert"
          className="col-span-full rounded border border-warning bg-warning/10 p-2 text-foreground"
        >
          {omittedImageCount}{" "}
          {omittedImageCount === 1 ? "image was" : "images were"} omitted
          because image size or count limits were exceeded.
        </p>
      )}
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
