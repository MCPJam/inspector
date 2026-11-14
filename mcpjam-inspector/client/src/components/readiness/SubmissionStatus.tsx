/**
 * Where the real submission stands, as the people and agents who saw it
 * recorded it: the portal's receipt right after submitting, the status now,
 * every change with who recorded it and how they knew, and what the
 * directory said in its own words. MCPJam never changes a status by itself.
 */
import { Check, ExternalLink } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { SectionLabel } from "@/components/shared/section-label";
import type { SubmissionEvents } from "@/hooks/use-submission-events";
import type { SubmissionEvent } from "@/lib/apis/directory-submissions-api";
import { dayOf, writerOf, type People } from "./AnswerOrigin";
import { sentenceOf } from "./error-sentence";
import { McpjamBlock } from "./McpjamChecks";

/** Every status the backend records, in the order a submission moves. */
export const STATUS_LABELS: Record<string, string> = {
  submitted: "Submitted",
  "in-review": "In review",
  "changes-requested": "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
  withdrawn: "Withdrawn",
};

const TONE: Record<string, string> = {
  submitted: "border-info/40 bg-info/5",
  "in-review": "border-info/40 bg-info/5",
  "changes-requested": "border-warning/70 bg-warning/10",
  approved: "border-success/50 bg-success/10",
  published: "border-success/50 bg-success/10",
  rejected: "border-destructive/40 bg-destructive/5",
};

/** The portal's own page after submitting, as captured. */
const RECEIPT: Partial<Record<string, { title: string; body: string }>> = {
  "claude-connector": {
    title: "Server submitted for review",
    body: "Your MCP server has been received. The review team will evaluate it and reach out at the contact email you provided. Track it from Submissions.",
  },
};

const VIA: Record<string, string> = {
  email: "By email",
  portal: "In the portal",
  other: "Another way",
};

/** What the status asks of the person next. */
function nextStep(state: string | undefined, directory: string): string {
  switch (state) {
    case "changes-requested":
      return `${directory} asked for changes. Fix them here, then send the update through the portal.`;
    case "rejected":
      return `${directory} did not approve this submission. Fix what it raised, then submit again.`;
    case "approved":
      return `${directory} approved this submission. Record it here once the listing is published.`;
    case "published":
      return `The listing is published in the ${directory} directory.`;
    case "withdrawn":
      return "This submission was withdrawn from review.";
    default:
      return `${directory} decides on approval and publication. Record the status here when you hear back.`;
  }
}

function linkText(url: string): string {
  try {
    return `Open on ${new URL(url).host}`;
  } catch {
    // The server stores only https addresses; show anything else as given.
    return url;
  }
}

function Link({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-ring underline underline-offset-2"
    >
      {linkText(href)}
      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
    </a>
  );
}

export function StatusPanel({
  flowId,
  directory,
  people,
  events,
  onRecord,
}: {
  flowId: string;
  directory: string;
  people: People;
  events: SubmissionEvents;
  /** Opens the form for the next status. */
  onRecord: () => void;
}) {
  const { error, loaded, status, findings } = events;
  if (error && !loaded) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The status history did not load. {sentenceOf(error)} Reload the page to
        try again.
      </p>
    );
  }
  // Nothing recorded yet: "Mark as submitted" waits with the page's buttons.
  if (status.length + findings.length === 0) return null;
  const current = status[0];
  const submitted = status.find((event) => event.state === "submitted");
  const receipt = current?.state === "submitted" ? RECEIPT[flowId] : undefined;
  const writer = (event: SubmissionEvent) =>
    writerOf(people, event.actor, event.actorLabel);

  return (
    <div className="space-y-6">
      {receipt ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success">
            <Check aria-hidden="true" className="size-6" />
          </span>
          <h2 className="font-serif text-2xl">{receipt.title}</h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            {receipt.body}
          </p>
        </div>
      ) : null}
      {current?.state ? (
        <section
          aria-labelledby="submission-status-title"
          className={cn(
            "rounded-lg border border-border p-4",
            TONE[current.state],
          )}
        >
          <SectionLabel id="submission-status-title">
            Submission status
          </SectionLabel>
          <div className="mt-2 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1 basis-80 space-y-1 text-sm">
              <p className="text-lg font-semibold">
                {STATUS_LABELS[current.state] ?? current.state}
              </p>
              {submitted ? (
                <p className="flex flex-wrap gap-x-2 text-muted-foreground">
                  <span>Submitted {dayOf(submitted.createdAt)}</span>
                  {submitted.reference ? (
                    <span>Reference {submitted.reference}</span>
                  ) : null}
                  {submitted.link ? <Link href={submitted.link} /> : null}
                </p>
              ) : null}
              <p>{nextStep(current.state, directory)}</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onRecord}
            >
              Record a new status
            </Button>
          </div>
        </section>
      ) : null}
      {status.length > 0 ? (
        <McpjamBlock
          title="Status history"
          note="Recorded by a person or an agent. MCPJam never changes a status by itself."
        >
          <ol className="divide-y divide-border/70">
            {status.map((event) => (
              <li
                key={event.id}
                className="grid grid-cols-[10rem_minmax(0,1fr)_auto] items-start gap-3 py-2 text-sm"
              >
                <span className="font-medium">
                  {STATUS_LABELS[event.state ?? ""] ?? event.state}
                </span>
                <span className="min-w-0 space-y-0.5 text-muted-foreground">
                  {event.directoryLabel ? (
                    <span className="block text-foreground">
                      {directory} called it “{event.directoryLabel}”
                    </span>
                  ) : null}
                  {event.reference ? (
                    <span className="block">Reference {event.reference}</span>
                  ) : null}
                  {event.detail ? (
                    <span className="block whitespace-pre-wrap">
                      {event.detail}
                    </span>
                  ) : null}
                  {event.link ? <Link href={event.link} /> : null}
                  <span className="block text-xs">
                    Recorded by {writer(event)} on {dayOf(event.createdAt)}
                    {event.uncertain ? ". Outcome unclear." : ""}
                  </span>
                </span>
                <span
                  title={
                    event.reportedOrObserved === "observed"
                      ? "Seen first hand by whoever recorded it"
                      : "Passed on by the directory or someone else"
                  }
                  className="rounded-full bg-accent px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {event.reportedOrObserved === "observed"
                    ? "Observed"
                    : "Reported"}
                </span>
              </li>
            ))}
          </ol>
        </McpjamBlock>
      ) : null}
      {findings.length > 0 ? (
        <McpjamBlock
          title={`What ${directory} said`}
          note="In its own words, kept apart from MCPJam's results."
        >
          <ul className="divide-y divide-border/70">
            {findings.map((event) => (
              <li key={event.id} className="space-y-1 py-2 text-sm">
                <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-3">
                  {event.finding?.text}
                </blockquote>
                <span className="block text-xs text-muted-foreground">
                  {[
                    VIA[event.finding?.via ?? "other"],
                    event.finding?.severity,
                    `imported by ${writer(event)}`,
                    dayOf(event.createdAt),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </McpjamBlock>
      ) : null}
    </div>
  );
}
