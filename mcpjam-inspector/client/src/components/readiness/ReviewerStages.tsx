/**
 * The reviewer path's rows after the credentials: each stage of the sign-in
 * with its status in words and its frame of the recording, then who the
 * identity check found. The run's recording appears once, below the rows,
 * and each frame is that recording paused at its moment.
 *
 * The recording comes from the backend's member read of the run's desktop
 * reservations. `useQuery` throws while that read is not deployed, and an
 * error boundary catches only what its children throw, so the read lives in
 * a child that hands the section what it finds.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  Check,
  CircleDashed,
  Hourglass,
  Lock,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@mcpjam/design-system/cn";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { registerArtifactUrls, useFreshArtifactUrl } from "@/lib/artifact-urls";
import { isConvexQueryUnavailable } from "@/lib/convex-error";
import {
  PATH_STATUS_WORDS,
  type Frame,
  type PathRow,
  type PathStatus,
} from "./reviewer-stages";

/** One of the run's desktop reservations, as the backend's member read gives it. */
export interface ReservationView {
  reservationId: string;
  recording: {
    url: string | null;
    meta?: { durationMs?: number };
  } | null;
}

const listForRun = makeFunctionReference<
  "query",
  { runId: string },
  ReservationView[]
>("directoryReadinessBrowserSessions:listForRun");

const LOOKS: Record<PathStatus, { icon: LucideIcon; className?: string }> = {
  established: { icon: Check },
  failed: { icon: X, className: "border-destructive/60" },
  "wrong-account": { icon: X, className: "border-destructive/60" },
  "wrong-tenant": { icon: X, className: "border-destructive/60" },
  waiting: { icon: Hourglass, className: "border-warning" },
  blocked: { icon: Lock },
  unverified: { icon: Lock },
  skipped: { icon: CircleDashed, className: "border-dashed" },
  "not-tested": { icon: CircleDashed, className: "border-dashed" },
  stale: { icon: CircleDashed, className: "border-dashed" },
};

const LINK =
  "rounded-sm text-ring underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function PathChip({ status }: { status: PathStatus }) {
  const { icon: Icon, className } = LOOKS[status];
  return (
    <Badge variant="outline" className={className}>
      <Icon aria-hidden="true" />
      {PATH_STATUS_WORDS[status]}
    </Badge>
  );
}

export function PathRowItem({
  row,
  number,
  onShow,
}: {
  row: PathRow;
  number: number;
  /** Shows the row's frame; absent when the recording cannot. */
  onShow?: () => void;
}) {
  return (
    <li className="grid grid-cols-[1.25rem_11rem_minmax(0,1fr)_auto] items-start gap-3 py-2 text-sm">
      <span className="text-xs tabular-nums text-muted-foreground">
        {number}
      </span>
      <span className="font-medium">{row.label}</span>
      <div className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
        {row.approximated ? <ApproximatedLabel /> : null}
        {row.detail}
        {onShow ? <FrameButton label={row.label} onShow={onShow} /> : null}
      </div>
      <PathChip status={row.status} />
    </li>
  );
}

/** A stage read off a sign-in page MCPJam knows only by a general rule. */
export function ApproximatedLabel() {
  return (
    <Badge
      variant="outline"
      className="mr-2 border-dashed align-text-bottom"
      title="AuthKit does not host this sign-in page. MCPJam checked it with general rules."
    >
      Approximated
    </Badge>
  );
}

export function FrameButton({
  label,
  onShow,
}: {
  label: string;
  onShow: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Screenshot of ${label}`}
      onClick={onShow}
      className={cn("ml-2", LINK)}
    >
      Screenshot
    </button>
  );
}

/** What the section reads of the shown run's recording. */
export type Recording =
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "ready"; id: string; url: string; durationMs?: number };

function RecordingReader({
  runId,
  onRead,
}: {
  runId: string;
  onRead: (read: { runId: string; views: ReservationView[] }) => void;
}) {
  const views = useQuery(listForRun, { runId });
  useEffect(() => {
    if (!views) return;
    registerArtifactUrls(views);
    onRead({ runId, views });
  }, [runId, views, onRead]);
  return null;
}

/**
 * The recording of the run the rows show, and the player's place in it. A
 * frame is offered only once the recording it points into can be played.
 */
export function useRunRecording(
  path: { runId?: string; recordingId?: string },
  stillRunning: boolean,
) {
  const [read, setRead] = useState<{
    runId: string;
    views: ReservationView[];
  } | null>(null);
  // Kept with its run, so another run's recording opens closed.
  const [player, setPlayer] = useState<{
    runId?: string;
    open: boolean;
    at?: number;
  }>({ open: false });
  const { runId, recordingId } = path;
  const shown = player.runId === runId ? player : { open: false };
  let recording: Recording | undefined;
  if (runId && recordingId && read?.runId === runId) {
    const kept = read.views.find(
      (view) => view.reservationId === recordingId,
    )?.recording;
    if (kept?.url) {
      const durationMs = kept.meta?.durationMs;
      recording = { kind: "ready", id: recordingId, url: kept.url, durationMs };
    } else {
      // The recording is kept as the desktop is released, after the sign-in.
      recording = { kind: stillRunning ? "pending" : "none" };
    }
  }
  const reader =
    runId && recordingId ? (
      <ErrorBoundary
        key={runId}
        name="readiness-reviewer-recording"
        fallback={null}
        isExpectedError={isConvexQueryUnavailable}
      >
        <RecordingReader runId={runId} onRead={setRead} />
      </ErrorBoundary>
    ) : null;
  const playable = (frame?: Frame) =>
    recording?.kind === "ready" && frame?.recordingId === recording.id
      ? frame
      : undefined;
  return {
    recording,
    reader,
    player: shown,
    /** Opens the player at a frame, or `undefined` when it cannot. */
    show: (frame?: Frame) => {
      const at = playable(frame);
      return at
        ? () => setPlayer({ runId, open: true, at: at.seconds })
        : undefined;
    },
    toggle: () => setPlayer({ runId, open: !shown.open }),
  };
}

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The run's recording, once: a line to open it, and the player. */
export function RecordingPlayer({
  recording,
  player,
  onToggle,
}: {
  recording: Recording | undefined;
  player: { open: boolean; at?: number };
  onToggle: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const url = useFreshArtifactUrl(
    recording?.kind === "ready" ? recording.url : undefined,
  );
  const { open, at } = player;

  // A frame is the recording paused at its moment, whenever it is asked for.
  useEffect(() => {
    const element = video.current;
    if (!element || !open || at === undefined) return;
    const seek = () => {
      element.currentTime = at;
      element.pause();
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else element.addEventListener("loadedmetadata", seek, { once: true });
    element.scrollIntoView?.({ block: "nearest" });
    return () => element.removeEventListener("loadedmetadata", seek);
  }, [player, url]);

  if (!recording) return null;
  if (recording.kind !== "ready") {
    return (
      <p className="text-xs text-muted-foreground">
        {recording.kind === "pending"
          ? "MCPJam keeps the recording once the sign-in ends."
          : "No recording was kept for this rehearsal, so its stages have no screenshots."}
      </p>
    );
  }
  if (failed) {
    return (
      <p className="text-xs text-muted-foreground">
        The recording did not load. Reload the page to try again.
      </p>
    );
  }
  const length = recording.durationMs ? ` ${clock(recording.durationMs)}` : "";
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        One session in a clean browser.{" "}
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={LINK}
        >
          {`Recording${length}`}
        </button>
      </p>
      {open ? (
        <video
          ref={video}
          src={url}
          controls
          preload="metadata"
          aria-label="Recording of the reviewer sign-in"
          onError={() => setFailed(true)}
          className="w-full rounded-md border border-border bg-black"
        />
      ) : null}
    </div>
  );
}
