import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { TraceViewer } from "../evals/trace-viewer";
import { usePersistedSessionTrace } from "../swarms/use-persisted-session-trace";
import { COPY } from "./climb-copy";

function Body({ sessionId }: { sessionId: string }) {
  const { trace, loading, error } = usePersistedSessionTrace(sessionId);
  if (loading) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the transcript.
      </p>
    );
  }
  if (error || !trace) {
    return (
      <p className="p-4 text-sm text-destructive">
        {error ?? "MCPJam saved no transcript for this round."} Reload the page to try again.
      </p>
    );
  }
  return (
    <TraceViewer
      trace={trace}
      frame="none"
      chromeDensity="compact"
      forcedViewMode="chat"
      hideToolbar
      hideTranscriptRevealControls
    />
  );
}

/** What MCPJam read and decided when it picked a round's change. */
export function PickerTranscript({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-[640px] max-w-full flex-col gap-0 p-0">
        <SheetHeader>
          <SheetTitle>{COPY.transcriptLink}</SheetTitle>
          <SheetDescription>How MCPJam picked this round's change.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto">{open ? <Body sessionId={sessionId} /> : null}</div>
      </SheetContent>
    </Sheet>
  );
}
