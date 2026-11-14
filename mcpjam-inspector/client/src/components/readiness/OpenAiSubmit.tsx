/**
 * The copy of ChatGPT's "Submit for review" dialog: the developer identity,
 * the six policy attestations in the portal's words, the non-blocking
 * findings, and the note to the review team, each saved as an answer.
 *
 * Nothing is sent to ChatGPT, so the portal's Submit stays disabled. Once the
 * person has submitted in the real portal, MCPJam's "Mark as submitted"
 * records that they did, as a status event: MCPJam never records a status by
 * itself.
 */
import { Fragment, useState } from "react";
import { ExternalLink } from "lucide-react";
import type {
  DirectoryFieldIssue,
  DirectoryFlowStep,
  PlacedFinding,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import type { DirectorySubmissionSession } from "@/hooks/use-directory-submission";
import {
  recordSubmissionEvent,
  type SubmissionEvent,
  type SubmissionView,
} from "@/lib/apis/directory-submissions-api";
import { toast } from "@/lib/toast";
import { sentenceOf } from "./error-sentence";
import { McpjamChecks, McpjamMark } from "./McpjamChecks";
import { findingRows } from "./OpenAiFindings";
import { PortalField } from "./PortalField";

export function OpenAiSubmit({
  step,
  view,
  session,
  issues,
  findings,
  recorded,
  onRecorded,
  open,
  onClose,
}: {
  /** The flow's "Submit for review" step. */
  step: DirectoryFlowStep;
  view: SubmissionView;
  session: DirectorySubmissionSession;
  issues: readonly DirectoryFieldIssue[];
  /** MCPJam's results on this step. */
  findings: readonly PlacedFinding[];
  /** The submitted status this page recorded, if any. */
  recorded: SubmissionEvent | null;
  onRecorded: (event: SubmissionEvent) => void;
  open: boolean;
  onClose: () => void;
}) {
  // One key for this page's mark: a retry replays the first write.
  const [key] = useState(() => `ui-status-${crypto.randomUUID()}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocks = step.layout?.blocks ?? [];
  const words = (widget: string) => blocks.find((block) => block.widget === widget)?.text ?? {};
  const listed = words("non-blocking-findings");
  const buttons = words("submit");
  // The portal lists what does not block; MCPJam's own, from every step.
  const nonBlocking = findingRows([], view.steps.flatMap((entry) => entry.findings)).filter(
    (row) => !row.blocking,
  );

  const mark = async () => {
    setBusy(true);
    setError(null);
    try {
      const event = await recordSubmissionEvent(
        { projectId: view.projectId, submissionId: view.id },
        { kind: "status", state: "submitted", reportedOrObserved: "observed", idempotencyKey: key },
      );
      onRecorded(event);
      toast.success("Marked as submitted.");
    } catch (failure) {
      setError(`The status was not recorded. ${sentenceOf(failure)} Try marking it again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="portal-openai max-h-[90vh] overflow-y-auto rounded-2xl bg-popover text-popover-foreground sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{step.title}</DialogTitle>
          <DialogDescription className="flex items-center gap-2 text-xs">
            <McpjamMark />
            Nothing is sent to ChatGPT from this rehearsal. Submit in the real portal, then mark it
            as submitted here.
          </DialogDescription>
        </DialogHeader>
        {blocks.map((block, index) => (
          <Fragment key={index}>
            {block.widget === "non-blocking-findings" && nonBlocking.length > 0 ? (
              <div className="rounded-xl border border-border bg-accent/60 p-4 text-sm">
                <p className="font-medium">{listed.title}</p>
                <p className="mt-1 text-muted-foreground">{listed.body}</p>
                <ul className="mt-2 space-y-1.5">
                  {nonBlocking.map((row) => (
                    <li key={row.id} className="flex items-start gap-2">
                      <McpjamMark />
                      <span className="min-w-0 flex-1">{row.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {step.fields
              .filter((field) => block.fields?.includes(field.key))
              .map((field) => (
                <PortalField
                  key={field.key}
                  field={field}
                  value={session.values[field.key]}
                  issue={issues.find((issue) => issue.key === field.key)}
                  findings={findings.filter((entry) => entry.field === field.key)}
                  onChange={(value) => session.setAnswer(field.key, value)}
                />
              ))}
          </Fragment>
        ))}
        <McpjamChecks findings={findings.filter((entry) => !entry.field)} />
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2.5">
          <McpjamMark />
          <Button
            type="button"
            size="sm"
            disabled={busy || Boolean(recorded) || issues.length > 0}
            onClick={() => void mark()}
          >
            {recorded ? "Marked as submitted" : "Mark as submitted"}
          </Button>
          <a
            href={view.submissionUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-ring underline underline-offset-2"
          >
            Open the real ChatGPT portal
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
          {error ? (
            <p role="alert" className="w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {buttons.cancel}
          </Button>
          <Button type="button" disabled>
            {buttons.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
