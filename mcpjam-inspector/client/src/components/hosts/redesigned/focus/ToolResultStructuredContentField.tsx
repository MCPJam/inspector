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
  ruleForToolResultParts,
  setModelVisibleStructuredContent,
  TOOL_RESULT_PARTS,
  toolResultPartsForRule,
} from "@/lib/model-visible-structured-content";
import { TRI_SELECTOR_ACTIVE_CLASSES } from "./primitives";

const LABEL = "Tool results sent to the model";

// Worded in the spec's terms: a tool result's three parts are `content`,
// `structuredContent` and `_meta`.
const DESCRIPTIONS: Record<ModelVisibleStructuredContent | "default", string> =
  {
    default:
      "The model gets content, structuredContent and _meta as one escaped JSON string.",
    fallback:
      "The model gets content, or structuredContent when content is empty.",
    preferred:
      "The model gets structuredContent, or content when there is none.",
    both: "The model gets content and structuredContent, each once.",
  };

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
  const rule = getModelVisibleStructuredContent(policy);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2.5">
      <div className="min-w-0 flex-1">
        <span className="text-[12px] font-medium">{LABEL}</span>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {DESCRIPTIONS[rule ?? "default"]}
        </p>
      </div>
      <ToggleGroup
        type="multiple"
        size="sm"
        variant="outline"
        className="shrink-0"
        value={toolResultPartsForRule(rule)}
        onValueChange={(selected) => {
          const next = ruleForToolResultParts(rule, selected);
          if (next) {
            onChange(setModelVisibleStructuredContent(policy, next.rule));
          }
        }}
        disabled={disabled}
        aria-label={LABEL}
      >
        {TOOL_RESULT_PARTS.map((part) => (
          <ToggleGroupItem
            key={part}
            value={part}
            aria-label={part}
            // flex-none: the labels differ in length, so each item takes its
            // label's width instead of an equal share.
            className={`h-7 flex-none px-2.5 text-xs ${TRI_SELECTOR_ACTIVE_CLASSES}`}
          >
            {part}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
