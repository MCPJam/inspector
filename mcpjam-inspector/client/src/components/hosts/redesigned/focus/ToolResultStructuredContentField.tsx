import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import type {
  ModelVisibleMcpToolResults,
  ModelVisibleStructuredContent,
} from "@mcpjam/sdk/host-config";
import {
  getModelVisibleStructuredContent,
  parseModelVisibleStructuredContent,
  setModelVisibleStructuredContent,
} from "@/lib/model-visible-structured-content";
import { TRI_SELECTOR_ACTIVE_CLASSES } from "./primitives";

// Radix needs a non-empty value for every item, so the unset rule gets a
// sentinel that never reaches the draft.
const DEFAULT_OPTION = "default";

const LABEL = "Tool results sent to the model";

// Worded in the spec's terms for the three parts of a tool result: the text
// (`content`), `structuredContent` and `_meta`.
const OPTIONS: ReadonlyArray<{
  value: ModelVisibleStructuredContent | typeof DEFAULT_OPTION;
  label: string;
  ariaLabel: string;
  description: string;
}> = [
  {
    value: DEFAULT_OPTION,
    label: "All three",
    ariaLabel: "All three (default)",
    description:
      "The model gets the text, structuredContent and _meta as one escaped JSON string.",
  },
  {
    value: "fallback",
    label: "Text",
    ariaLabel: "Text",
    description:
      "The model gets the text, or structuredContent when content is empty.",
  },
  {
    value: "preferred",
    label: "structuredContent",
    ariaLabel: "structuredContent",
    description:
      "The model gets structuredContent, or the text when there is none.",
  },
  {
    value: "both",
    label: "Both",
    ariaLabel: "Text and structuredContent",
    description:
      "The model gets the text and structuredContent, without _meta.",
  },
];

/**
 * Which parts of a tool result the model sees
 * (`modelVisibleMcpToolResults.structuredContent`). The default writes
 * absence, so a client that never touches this keeps hashing as before.
 */
export function ToolResultStructuredContentField({
  policy,
  disabled,
  onChange,
}: {
  policy: ModelVisibleMcpToolResults | undefined;
  disabled: boolean;
  onChange: (next: ModelVisibleMcpToolResults | undefined) => void;
}) {
  const selected = getModelVisibleStructuredContent(policy) ?? DEFAULT_OPTION;
  const description = OPTIONS.find(
    (option) => option.value === selected,
  )?.description;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-border/60 pt-2.5">
      <div className="min-w-0">
        <span className="text-[12px] font-medium">{LABEL}</span>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {description}
        </p>
      </div>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        className="shrink-0"
        value={selected}
        onValueChange={(next) => {
          // Re-clicking the selected item emits "", which would leave nothing
          // selected.
          if (!next) return;
          onChange(
            setModelVisibleStructuredContent(
              policy,
              parseModelVisibleStructuredContent(next),
            ),
          );
        }}
        disabled={disabled}
        aria-label={LABEL}
      >
        {OPTIONS.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.ariaLabel}
            // flex-none: the labels differ in length, so each item takes its
            // label's width instead of an equal share.
            className={`h-7 flex-none px-2.5 text-xs ${TRI_SELECTOR_ACTIVE_CLASSES}`}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
