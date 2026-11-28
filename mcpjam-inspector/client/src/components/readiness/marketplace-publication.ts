import {
  listSubmissionEvents,
  type SubmissionEvent,
  type SubmissionScope,
} from "@/lib/apis/directory-submissions-api";
import { STATUS_LABELS } from "./SubmissionStatus";

export async function readPublicationEvents(
  scope: SubmissionScope,
  signal: AbortSignal,
) {
  const [snapshots, statuses] = await Promise.all([
    listSubmissionEvents(scope, "snapshot", signal),
    listSubmissionEvents(scope, "status", signal),
  ]);
  return [...snapshots, ...statuses].sort((a, b) => b.createdAt - a.createdAt);
}

function publicationTime(event: SubmissionEvent) {
  const recordedDate =
    event.evidence?.kind === "text" &&
    event.evidence.value.match(
      /^Published on (\d{4}-\d{2}-\d{2})(?:$|\n)/,
    )?.[1];
  const time = recordedDate ? Date.parse(recordedDate) : NaN;
  return Number.isFinite(time) ? time : event.createdAt;
}

export function publishedReleases(events: SubmissionEvent[]) {
  return events
    .filter(
      (event) => event.snapshot?.label === "published" && !event.uncertain,
    )
    .sort(
      (a, b) =>
        publicationTime(b) - publicationTime(a) || b.createdAt - a.createdAt,
    );
}

const statusColors: Record<string, string> = {
  published: "bg-success",
  approved: "bg-success",
  submitted: "bg-info",
  "in-review": "bg-info",
  "changes-requested": "bg-warning",
  rejected: "bg-destructive",
};

export function publicationBadge(events: SubmissionEvent[]) {
  const event = events.find(
    (item) => item.snapshot?.label === "published" || item.kind === "status",
  );
  const state = event?.snapshot ? "published" : event?.state;
  if (!state || event?.uncertain)
    return { label: "Status unknown", color: "bg-muted-foreground" };
  const version =
    state === "published" &&
    publishedReleases(events)[0]?.snapshot?.note?.match(/^Version (.+)$/)?.[1];
  return {
    label: version ? `Published · ${version}` : (STATUS_LABELS[state] ?? state),
    color: statusColors[state] ?? "bg-muted-foreground",
  };
}
