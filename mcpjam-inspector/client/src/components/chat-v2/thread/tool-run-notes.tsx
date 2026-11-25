import { useToolRunNotes } from "@/stores/tool-notification-store";

/**
 * The progress and log lines a server sends while its tool call runs, shown
 * on the call's card until the result arrives.
 */
export function ToolRunNotes({
  toolCallId,
}: {
  toolCallId: string | undefined;
}) {
  const notes = useToolRunNotes(toolCallId);
  if (!notes || (!notes.progress && notes.logs.length === 0)) return null;
  const { progress } = notes;
  const percent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.progress / progress.total) * 100))
      : undefined;
  return (
    <div
      className="mx-3 mb-2 space-y-1 rounded-md bg-muted/40 px-2 py-1 text-[11px] leading-4 text-muted-foreground"
      data-testid="tool-run-notes"
    >
      {progress ? (
        <div data-testid="tool-run-progress">
          {progress.total
            ? `Progress ${progress.progress} of ${progress.total}`
            : `Progress ${progress.progress}`}
          {progress.message ? `: ${progress.message}` : ""}
          {percent !== undefined ? (
            <div
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="mt-0.5 h-1 overflow-hidden rounded bg-muted"
            >
              <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}
      {notes.logs.slice(-6).map((line, index) => (
        <div
          key={`${index}-${line.text}`}
          className="font-mono"
          data-testid="tool-run-log"
        >
          <span className="uppercase">{line.level}</span>
          {line.logger ? ` ${line.logger}` : ""}: {line.text}
        </div>
      ))}
    </div>
  );
}
