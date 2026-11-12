import { useEffect, useRef, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import type { PaneFrame } from "@/lib/browser-pane/input";
import { paintFrame } from "@/lib/browser-pane/frame-wire";
import type { PausedPaneState } from "@/components/browser/usePausedPane";

/** The idle window as words, or null when the backend has not said it. */
export function idleWindowText(idleMs: number | undefined): string | null {
  if (idleMs === undefined || !Number.isSafeInteger(idleMs)) return null;
  const minutes = Math.round(idleMs / 60_000);
  if (minutes < 1) return null;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Laid out like the surface's own canvas, so the picture does not jump. */
const PICTURE = "max-h-full max-w-full select-none object-contain";

/**
 * The last picture the desktop sent, drawn here rather than handed back to the
 * surface: a repaint there counts as a fresh paint in the pane's latency
 * samples, and this picture is minutes old.
 */
function LastPicture({ frame }: { frame: PaneFrame }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const { bitmap } = frame;
    if (canvasRef.current && bitmap)
      paintFrame(canvasRef.current, { ...frame, bitmap });
  }, [frame]);
  return (
    <div
      data-testid="paused-pane-picture"
      className="absolute inset-0 flex items-center justify-center"
    >
      {frame.bitmap ? (
        <canvas ref={canvasRef} className={PICTURE} />
      ) : frame.data ? (
        <img
          alt=""
          className={PICTURE}
          src={`data:image/jpeg;base64,${frame.data}`}
        />
      ) : null}
    </div>
  );
}

/**
 * Shown over the last picture once the desktop has paused for lack of use.
 * Any click on it resumes the desktop; the button is the visible way to do
 * the same, and a key press in the pane does it too (the pane listens).
 *
 * Opaque underneath, so the pane's own "waiting" message never shows through
 * a desktop that is not coming back on its own.
 */
export function PausedPaneOverlay({
  resuming,
  idleMs,
  picture,
  onResume,
}: {
  resuming: boolean;
  /** The backend's idle window, when its session reply carries one. */
  idleMs?: number;
  /** The last picture received, when there is one to show. */
  picture?: PaneFrame | null;
  onResume: () => void;
}) {
  const idleText = idleWindowText(idleMs);
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-background"
      onPointerDown={resuming ? undefined : onResume}
    >
      {picture ? <LastPicture frame={picture} /> : null}
      <div className="absolute inset-0 bg-overlay" />
      <div
        role="status"
        className="relative flex max-w-xs flex-col items-center gap-3 rounded-lg border border-border bg-background px-5 py-4 text-center text-sm text-foreground"
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

/**
 * A hosted pane that can show its desktop paused.
 *
 * While paused the overlay covers it, and a key press wakes the desktop
 * instead of reaching the pane. While awake, `onInput` hears every press and
 * click on its way through.
 */
export function PausablePane({
  state,
  idleMs,
  picture,
  onResume,
  onInput,
  className,
  children,
}: {
  state: PausedPaneState;
  idleMs?: number;
  picture?: PaneFrame | null;
  onResume: () => void;
  onInput?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("relative", className)}
      onPointerDownCapture={state === "awake" ? onInput : undefined}
      onKeyDownCapture={(event) => {
        if (state === "awake") {
          onInput?.();
          return;
        }
        event.stopPropagation();
        onResume();
      }}
    >
      {children}
      {state !== "awake" ? (
        <PausedPaneOverlay
          resuming={state === "resuming"}
          idleMs={idleMs}
          picture={picture}
          onResume={onResume}
        />
      ) : null}
    </div>
  );
}
