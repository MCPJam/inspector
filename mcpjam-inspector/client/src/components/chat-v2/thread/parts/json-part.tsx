import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { JsonEditor } from "@/components/ui/json-editor";
import { buildLineLayouts } from "@/components/ui/json-editor/json-editor-edit";
import { useMcpToolResultImagePreviews } from "@/components/chat-v2/shared/mcp-tool-result-image-preview";
import { McpToolResultImagePreviewGrid } from "@/components/chat-v2/shared/mcp-tool-result-image-preview-grid";

const MIN_JSON_PART_HEIGHT = 80;
const MAX_JSON_PART_HEIGHT = 480;
const JSON_PART_VERTICAL_PADDING = 24;
const DEFAULT_CHARS_PER_VISUAL_LINE = 80;

function getJsonPartHeight(value: unknown): number {
  let content = "null";

  try {
    content = JSON.stringify(value, null, 2) ?? "null";
  } catch {
    content = String(value);
  }

  const lines = content.split("\n");
  const layouts = buildLineLayouts(lines, true, DEFAULT_CHARS_PER_VISUAL_LINE);
  const lastLayout = layouts.at(-1);
  const contentHeight = lastLayout
    ? lastLayout.top + lastLayout.height + JSON_PART_VERTICAL_PADDING
    : MIN_JSON_PART_HEIGHT;

  return Math.min(
    MAX_JSON_PART_HEIGHT,
    Math.max(MIN_JSON_PART_HEIGHT, contentHeight)
  );
}

export function JsonPart({
  label,
  value,
  autoHeight = false,
  serverId,
  mcpToolResultImageRendering = "inline",
}: {
  label: string;
  value: unknown;
  autoHeight?: boolean;
  serverId?: string;
  mcpToolResultImageRendering?: "none" | "panel" | "inline";
}) {
  const [imageMode, setImageMode] = useState<"images" | "raw">("images");
  const height = useMemo(() => getJsonPartHeight(value), [value]);
  const canRenderImages = mcpToolResultImageRendering !== "none";
  const imageState = useMcpToolResultImagePreviews(
    canRenderImages ? value : undefined,
    { serverId }
  );

  useEffect(() => {
    setImageMode("images");
  }, [value]);

  return (
    <div className="space-y-1 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">{label}</div>
        {imageState.status === "ready" && imageState.previews.length > 0 && (
          <ToggleGroup
            type="single"
            value={imageMode}
            onValueChange={(next) => {
              if (next) setImageMode(next as "images" | "raw");
            }}
            className="gap-0.5"
          >
            <ToggleGroupItem
              value="images"
              aria-label="Images"
              className="h-6 px-2 text-[10px]"
            >
              Images
            </ToggleGroupItem>
            <ToggleGroupItem
              value="raw"
              aria-label="Raw"
              className="h-6 px-2 text-[10px]"
            >
              Raw
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      {imageState.hasCandidate &&
      (imageState.status === "idle" || imageState.status === "loading") ? (
        <div className="min-h-[120px] rounded-md border border-border/30 bg-muted/20 flex items-center justify-center">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Resolving images...
          </div>
        </div>
      ) : imageState.status === "ready" &&
        imageState.previews.length > 0 &&
        imageMode === "images" ? (
        <div className="max-h-[480px] overflow-auto rounded-md border border-border/30 bg-muted/20 p-2">
          <McpToolResultImagePreviewGrid
            previews={imageState.previews}
            className="grid-cols-1"
            tileClassName="min-h-[160px]"
            imageClassName="max-h-[440px]"
          />
        </div>
      ) : (
        <JsonEditor
          height={autoHeight ? "auto" : height}
          maxHeight={autoHeight ? undefined : MAX_JSON_PART_HEIGHT}
          value={value}
          viewOnly
        />
      )}
    </div>
  );
}
