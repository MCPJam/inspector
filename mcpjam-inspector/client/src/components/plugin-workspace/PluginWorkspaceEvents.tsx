import { parsePluginWorkspaceRecording } from "@/shared/plugin-workspace-recording";

/** Metadata stays in the trace detail pane; replay displays captured pixels only. */
export function PluginWorkspaceEvents({ recording }: { recording: unknown }) {
  let capture;
  try {
    capture = parsePluginWorkspaceRecording(recording);
  } catch {
    return null;
  }
  return (
    <section aria-label="Workspace events" className="mt-4 space-y-2 text-xs">
      <p className="font-medium">Workspace events</p>
      {capture.droppedEvents > 0 && (
        <p className="text-muted-foreground">
          {capture.droppedEvents} earlier events omitted.
        </p>
      )}
      {capture.events.map((event) => (
        <div
          key={event.sequence}
          className="flex gap-2 border-b border-border py-2"
        >
          <span className="tabular-nums text-muted-foreground">
            {event.sequence}
          </span>
          <span>
            {event.kind}
            {"feature" in event && event.feature
              ? ` · ${event.feature} (${event.fidelity})`
              : ""}
            {"outcome" in event && event.outcome ? ` · ${event.outcome}` : ""}
            {"display" in event && event.display
              ? ` · ${event.display.displayMode ?? "unavailable"} · cursor ${
                  event.display.interactionCursor
                }`
              : ""}
          </span>
        </div>
      ))}
    </section>
  );
}
