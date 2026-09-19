import { Loader2 } from "lucide-react";

type TranscriptEmptyStateProps =
  | { kind: "streaming" | "loading" | "none" }
  | { kind: "unrecorded"; execution: "unknown" | "observed" };

/** Presentation only: the caller owns loading errors and execution evidence. */
export function TranscriptEmptyState(props: TranscriptEmptyStateProps) {
  if (props.kind === "none") return null;
  if (props.kind === "loading" || props.kind === "streaming") {
    return (
      <div
        role="status"
        aria-label={
          props.kind === "loading"
            ? "Loading transcript"
            : "Waiting for transcript"
        }
        className="flex items-center justify-center p-4 text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
      </div>
    );
  }
  return (
    <div
      role="status"
      className="space-y-1 p-4 text-center text-sm text-muted-foreground"
    >
      <p>No transcript recorded</p>
      {props.kind === "unrecorded" && props.execution === "unknown" && (
        <p className="text-xs">May not have run.</p>
      )}
    </div>
  );
}
