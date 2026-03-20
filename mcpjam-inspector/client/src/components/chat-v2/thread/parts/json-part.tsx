import { useMemo } from "react";
import { JsonEditor } from "@/components/ui/json-editor";
import { buildLineLayouts } from "@/components/ui/json-editor/json-editor-edit";

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
    Math.max(MIN_JSON_PART_HEIGHT, contentHeight),
  );
}

export function JsonPart({ label, value }: { label: string; value: unknown }) {
  const height = useMemo(() => getJsonPartHeight(value), [value]);

  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">{label}</div>
      <JsonEditor
        height={height}
        maxHeight={MAX_JSON_PART_HEIGHT}
        value={value}
        viewOnly
      />
    </div>
  );
}
