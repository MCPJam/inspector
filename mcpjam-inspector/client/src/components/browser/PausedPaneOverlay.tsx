import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";

/** The idle window as words, or null when the backend has not said it. */
export function idleWindowText(idleMs: number | undefined): string | null {
  if (idleMs === undefined || !Number.isSafeInteger(idleMs)) return null;
  const minutes = Math.round(idleMs / 60_000);
  if (minutes < 1) return null;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * Shown over the last picture once the desktop has paused for lack of use.
 * Any click on it resumes the desktop; the button is the visible way to do
 * the same, and a key press in the pane does it too (the pane listens).
 */
export function PausedPaneOverlay({
  resuming,
  idleMs,
  onResume,
}: {
  resuming: boolean;
  /** The backend's idle window, when its session reply carries one. */
  idleMs?: number;
  onResume: () => void;
}) {
  const idleText = idleWindowText(idleMs);
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-overlay"
      onPointerDown={resuming ? undefined : onResume}
    >
      <div
        role="status"
        className="flex max-w-xs flex-col items-center gap-3 rounded-lg border border-border bg-background px-5 py-4 text-center text-sm text-foreground"
      >
        {resuming ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Resuming…
          </span>
        ) : (
          <>
            <strong className="font-medium">Browser paused</strong>
            <span className="text-muted-foreground">
              {idleText ? `No input for ${idleText}. ` : ""}
              Click or press any key to resume.
            </span>
            <Button size="sm" onClick={onResume}>
              Resume
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
