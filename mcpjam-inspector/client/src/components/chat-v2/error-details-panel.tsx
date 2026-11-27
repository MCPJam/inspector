import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { JsonEditor } from "@/components/ui/json-editor";
import { cn } from "@/lib/utils";

const TONE_CLASSES = {
  warning: {
    trigger: "text-warning hover:text-warning/80",
    border: "border-warning/30",
    pre: "text-warning-foreground",
  },
  destructive: {
    trigger: "text-destructive hover:text-destructive/80",
    border: "border-destructive/30",
    pre: "text-destructive",
  },
} as const;

/**
 * An error banner's collapsible "More details": the raw payload, in the JSON
 * viewer when it parsed (`detailsJson`), otherwise as bounded text.
 */
export function ErrorDetailsPanel({
  details,
  detailsJson,
  tone,
}: {
  details: string;
  detailsJson: unknown;
  tone: keyof typeof TONE_CLASSES;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const classes = TONE_CLASSES[tone];
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-1.5 text-xs transition-colors",
          classes.trigger,
        )}
      >
        <span>More details</span>
        {isOpen ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <div
          className={cn("rounded border bg-background/50 p-2", classes.border)}
        >
          {detailsJson ? (
            <JsonEditor
              height="100%"
              value={detailsJson}
              readOnly
              showToolbar={false}
            />
          ) : (
            <pre
              className={cn(
                // Bounded: `details` carries raw upstream payloads (a
                // gateway's HTML error page, for one), and an unbounded
                // `<pre>` grows the card until it owns the viewport.
                "text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto",
                classes.pre,
              )}
            >
              {details}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
