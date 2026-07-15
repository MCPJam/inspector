import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Clock } from "lucide-react";

/**
 * Quiet "this server's tools changed" signal for the server detail modal
 * header. Drift = the latest persisted revision is newer than the one this
 * user last saw. The baseline is seeded on first sight (no chip the first
 * time you open a server) and advanced whenever the History tab is viewed,
 * so the chip only appears for a genuine post-baseline change — never noisy.
 *
 * Per-user, local-only (localStorage). The richer "changed since the last
 * eval/chat run that used it" signal would read `listInspectionObservations`;
 * deferred to keep v1 backend-free.
 */
const SEEN_PREFIX = "mcpjam:server-history-seen";

const seenKey = (projectId: string, serverId: string) =>
  `${SEEN_PREFIX}:${projectId}:${serverId}`;

function readSeen(key: string): number | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeSeen(key: string, value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Losing the marker only means the chip may re-surface once; harmless.
  }
}

export function ServerHistoryDriftChip({
  projectId,
  serverId,
  isViewing,
  onClick,
}: {
  projectId: string;
  serverId: string;
  /**
   * True only while the modal is open AND History is the active tab —
   * advances the "seen" baseline. Caller must gate on `isOpen` so a closed
   * modal that lingers mounted (e.g. exit animation, or a future
   * `forceMount`) can't silently advance the baseline.
   */
  isViewing: boolean;
  onClick: () => void;
}) {
  const latest = useQuery(
    "serverInspections:getLatestInspection" as never,
    {
      projectId,
      serverId,
    } as never
  ) as { currentRevisionNumber: number } | null | undefined;

  const latestRevision = latest?.currentRevisionNumber;
  const key = seenKey(projectId, serverId);
  const [seen, setSeen] = useState<number | undefined>(() => readSeen(key));

  // Reset the baseline when the modal is reused for a different server.
  useEffect(() => {
    setSeen(readSeen(key));
  }, [key]);

  // Seed on first sight, advance while viewing history.
  useEffect(() => {
    if (latestRevision === undefined) return;
    if ((seen === undefined || isViewing) && seen !== latestRevision) {
      writeSeen(key, latestRevision);
      setSeen(latestRevision);
    }
  }, [latestRevision, seen, isViewing, key]);

  const hasDrift =
    latestRevision !== undefined && seen !== undefined && latestRevision > seen;

  if (!hasDrift) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      title="This server's tools changed since you last viewed its history"
      className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
    >
      <Clock className="h-3 w-3" />
      Tools changed
    </button>
  );
}
