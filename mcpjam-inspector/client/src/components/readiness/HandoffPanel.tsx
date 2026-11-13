/**
 * The handoff summary on the review page: what a teammate or an agent needs
 * to continue from this submission's link. It reads the handoff route an
 * agent reads, so both see one record: the status someone recorded, the
 * counts, what blocks, which declarations nobody stood behind, what is
 * missing, the next actions with the operation an agent would call, and
 * what only a person can do in the directory's own portal. The export saves
 * the API's own bytes, so the page and the CLI save the same file.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import {
  directoryFlowField,
  type DirectoryEvidenceStatus,
  type DirectoryFlow,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import {
  exportDirectorySubmission,
  getDirectorySubmissionHandoff,
  type SubmissionHandoff,
  type SubmissionScope,
} from "@/lib/apis/directory-submissions-api";
import { downloadTextFile } from "@/lib/download-text-file";
import { toast } from "@/lib/toast";
import { dayOf, writerOf, type People } from "./AnswerOrigin";
import { EVIDENCE_LABELS } from "./EvidenceStatus";
import { McpjamMark } from "./McpjamChecks";
import { DIRECTORY_NAMES } from "./RehearsalBar";

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const MUTED = "block text-xs text-muted-foreground";
const EVIDENCE: DirectoryEvidenceStatus[] = [
  "established",
  "inconclusive",
  "stale",
  "not-tested",
  "blocked",
];

/** How much was evaluated, never "Ready": the directory decides. */
export function handoffHeadline(counts: SubmissionHandoff["counts"]): string {
  if (counts.findings === 0) {
    return "Nothing has been checked yet. Run checks to see what blocks this submission.";
  }
  const evaluated = counts.passed + counts.blockers + counts.likelyFlags;
  const found =
    counts.blockers === 0
      ? "No blockers found"
      : plural(counts.blockers, "blocker");
  const verb = counts.notChecked === 1 ? "needs" : "need";
  const open =
    counts.notChecked > 0
      ? `; ${counts.notChecked} still ${verb} evidence`
      : "";
  return `${found} in ${plural(evaluated, "evaluated check")}${open}.`;
}

function statusText(handoff: SubmissionHandoff, people: People): string {
  const { status } = handoff;
  if (!status) return "Not recorded";
  const state = status.state ?? "recorded";
  const name =
    status.directoryLabel ??
    `${state[0]?.toUpperCase()}${state.slice(1).replace(/-/g, " ")}`;
  const who = writerOf(people, status.actor, status.actorLabel);
  const unsure = status.uncertain ? ", uncertain" : "";
  return `${name}, ${status.reportedOrObserved} by ${who} on ${dayOf(status.createdAt)}${unsure}`;
}

function List({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactNode[];
}) {
  return (
    <div className="min-w-0 space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5 text-sm">{children}</ul>
      )}
    </div>
  );
}

/** The pack as the API wrote it: its own bytes, its own file name. */
function ExportButtons({ scope }: { scope: SubmissionScope }) {
  const [busy, setBusy] = useState(false);
  const save = async (format: "json" | "markdown") => {
    setBusy(true);
    try {
      const file = await exportDirectorySubmission(scope, format);
      const type = `${file.mediaType};charset=utf-8`;
      downloadTextFile(file.filename, file.content, type);
    } catch (failure) {
      toast.error(
        `The export did not download. ${messageOf(failure)} Try exporting it again.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {(["json", "markdown"] as const).map((format) => (
        <Button
          key={format}
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void save(format)}
        >
          <Download aria-hidden="true" />
          {format === "json" ? "Export JSON" : "Export Markdown"}
        </Button>
      ))}
    </div>
  );
}

function Summary({
  flow,
  scope,
  handoff,
  people,
}: {
  flow: DirectoryFlow;
  scope: SubmissionScope;
  handoff: SubmissionHandoff;
  people: People;
}) {
  // The review page's words, as the handoff's own lists use them.
  const labelOf = (key: string) => {
    const field = directoryFlowField(flow, key);
    return field?.reviewLabel ?? field?.label ?? key;
  };
  const titleOf = (step: string) =>
    flow.steps.find((entry) => entry.id === step)?.title ?? step;
  const note = (text?: string) =>
    text ? <span className={MUTED}>{text}</span> : null;
  const where = (step: string) => note(titleOf(step));
  const { counts, verdict } = handoff;
  const evidence = EVIDENCE.flatMap((status) => {
    const count = counts.byEvidence[status];
    return count > 0
      ? [`${count} ${EVIDENCE_LABELS[status].toLowerCase()}`]
      : [];
  });
  const more = verdict.failing.length - handoff.blockers.length;
  const missing: Array<{
    key: string;
    step: string;
    label: string;
    why?: string;
  }> = [
    ...handoff.missingRequired,
    ...handoff.invalidAnswers.map((entry) => ({
      key: entry.key,
      step: entry.step,
      label: labelOf(entry.key),
      why: entry.message,
    })),
  ];
  return (
    <>
      <p className="text-sm">{handoffHeadline(counts)}</p>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd>{statusText(handoff, people)}</dd>
        <dt className="text-muted-foreground">Evidence</dt>
        <dd>{evidence.join(" · ") || "No results yet"}</dd>
      </dl>
      <div className="grid gap-6 md:grid-cols-3">
        <List title="Blockers" empty="None found">
          {[
            ...handoff.blockers.map((entry) => (
              <li key={entry.checkId}>
                {entry.title}
                {where(entry.step)}
              </li>
            )),
            ...(more > 0 ? [<li key="more">{`and ${more} more`}</li>] : []),
          ]}
        </List>
        <List title="Unconfirmed declarations" empty="None">
          {handoff.unconfirmedDeclarations.map((entry) => (
            <li key={entry.key}>
              {entry.label}
              {where(entry.step)}
            </li>
          ))}
        </List>
        <List title="Missing answers" empty="None">
          {missing.map((entry) => (
            <li key={entry.key}>
              {entry.label}
              {where(entry.step)}
              {note(entry.why)}
            </li>
          ))}
        </List>
      </div>
      <List title="Next actions in MCPJam" empty="None">
        {handoff.nextActions.map((action, index) => (
          <li key={index} className="flex flex-wrap items-baseline gap-x-2">
            <code className="rounded bg-muted px-1.5 py-0.5 font-code text-xs">
              {action.operation}
            </code>
            <span className="min-w-0 flex-1">
              {action.why}
              {action.fields ? (
                <span className={MUTED}>
                  {`Fields: ${action.fields.map(labelOf).join(", ")}`}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </List>
      <div className="grid gap-6 md:grid-cols-2">
        <List
          title={`Left to do in the ${DIRECTORY_NAMES[flow.directory]} portal`}
          empty="Nothing"
        >
          {handoff.remainingPortalActions.map((action, index) => (
            <li key={index}>
              {action.label}
              {action.label === titleOf(action.step)
                ? null
                : where(action.step)}
              {note(
                action.secretName &&
                  `Type the value of the project secret ${action.secretName} there.`,
              )}
              {note(action.why)}
            </li>
          ))}
        </List>
        <List title="Still unknown" empty="Nothing">
          {handoff.unknowns.map((entry, index) => (
            <li key={index}>{entry.detail}</li>
          ))}
        </List>
      </div>
      <ExportButtons scope={scope} />
    </>
  );
}

export function HandoffPanel({
  flow,
  scope,
  version,
  people,
}: {
  flow: DirectoryFlow;
  scope: SubmissionScope;
  /** Read again whenever this changes: the record's revision and runs. */
  version: string;
  people: People;
}) {
  const [handoff, setHandoff] = useState<SubmissionHandoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { projectId, submissionId } = scope;
  useEffect(() => {
    const controller = new AbortController();
    const read = { projectId, submissionId };
    getDirectorySubmissionHandoff(read, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setHandoff(next);
        setError(null);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(failure));
      },
    );
    return () => controller.abort();
  }, [projectId, submissionId, version, attempt]);

  let body: ReactNode;
  if (handoff) {
    body = (
      <Summary flow={flow} scope={scope} handoff={handoff} people={people} />
    );
  } else if (error) {
    body = (
      <p className="text-sm">
        {`The handoff summary did not load. ${error} Try loading it again.`}{" "}
        <Button
          type="button"
          size="sm"
          variant="link"
          onClick={() => setAttempt((count) => count + 1)}
        >
          Try again
        </Button>
      </p>
    );
  } else {
    body = (
      <p className="text-sm text-muted-foreground">
        Reading the handoff summary…
      </p>
    );
  }
  return (
    <section
      aria-label="Handoff summary"
      className="space-y-4 rounded-lg border border-dashed border-border px-4 py-3"
    >
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <McpjamMark />
        <span className="text-sm font-medium text-foreground">
          Handoff summary
        </span>
        What a teammate or an agent needs to continue from this link.
      </p>
      {body}
    </section>
  );
}
