import type { ReactNode } from "react";
import { JsonEditor } from "@/components/ui/json-editor";
import type { EventTurnParts } from "@/shared/event-turn-parts";

/**
 * An expanded event card: the instructions as prose and the event in the JSON
 * viewer the thread uses for a tool call's input. The data stays untrusted,
 * so it renders only as JSON values. The Raw tab keeps the exact text.
 */
export function EventContextBody({ parts }: { parts: EventTurnParts }) {
  return (
    <div className="space-y-3 border-t border-border px-2 py-2">
      {parts.server ? (
        <Section label="Server">
          <p className="text-foreground">{parts.server}</p>
        </Section>
      ) : null}
      <Section label="Instructions">
        <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
          {parts.instructions}
        </p>
      </Section>
      <Section label="Event data">
        <div className="max-h-[300px] overflow-auto rounded-md border border-border/30 bg-muted/20">
          <JsonEditor
            height="100%"
            viewOnly
            value={parts.data}
            className="p-2 text-[11px]"
            collapsible
            defaultExpandDepth={2}
          />
        </div>
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
