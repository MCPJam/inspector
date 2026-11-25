import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type {
  ModelVisibleMcpToolResults,
  ModelVisibleStructuredContent,
} from "@mcpjam/sdk/host-config";
import {
  getModelVisibleStructuredContent,
  MODEL_VISIBLE_STRUCTURED_CONTENT_RULES,
  parseModelVisibleStructuredContent,
  setModelVisibleStructuredContent,
} from "@/lib/model-visible-structured-content";

// Radix Select needs a non-empty value for every item, so the unset rule
// gets a sentinel that never reaches the draft.
const DEFAULT_OPTION = "default";

const LABEL = "Tool results sent to the model";

const OPTION_LABELS: Record<ModelVisibleStructuredContent, string> = {
  fallback: "Prefer text",
  preferred: "Prefer structured content",
  both: "Text and structured content",
};

const DEFAULT_LABEL = "Combined JSON (default)";

const DEFAULT_DESCRIPTION =
  "Sends text, structured content and _meta together as one JSON string.";

const DESCRIPTIONS: Record<ModelVisibleStructuredContent, string> = {
  fallback:
    "Sends the text. Sends structured content only when there is no text, like Claude Desktop.",
  preferred:
    "Sends structured content. Sends the text only when there is no structured content, like Claude Code and Codex CLI.",
  both: "Sends the text and the structured content, once each.",
};

/**
 * Which half of a tool result the model sees
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
      <div className="min-w-0">
        <span className="text-[12px] font-medium">{LABEL}</span>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {rule ? DESCRIPTIONS[rule] : DEFAULT_DESCRIPTION}
        </p>
      </div>
      <Select
        value={rule ?? DEFAULT_OPTION}
        onValueChange={(next) =>
          onChange(
            setModelVisibleStructuredContent(
              policy,
              parseModelVisibleStructuredContent(next),
            ),
          )
        }
        disabled={disabled}
      >
        <SelectTrigger
          aria-label={LABEL}
          className="h-9 w-[220px] flex-shrink-0 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_OPTION}>{DEFAULT_LABEL}</SelectItem>
          {MODEL_VISIBLE_STRUCTURED_CONTENT_RULES.map((option) => (
            <SelectItem key={option} value={option}>
              {OPTION_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
