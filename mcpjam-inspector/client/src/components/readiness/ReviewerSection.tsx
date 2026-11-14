/**
 * MCPJam's reviewer path, on the step where the portal asks for a way in
 * (Claude's Test & launch). The portal has no such block, so it is drawn
 * apart from the copy and marked "MCPJam":
 *
 * - the reviewer's credentials, written straight to project secrets and never
 *   shown again, as the portal keeps its own secret;
 * - answers the flow keeps on this step outside the portal's own layout, so
 *   none of them goes unasked;
 * - the sign-in rehearsal's state in words and, when it waits for a person,
 *   what they must do and how a teammate or an agent resumes it.
 *
 * The credential inputs are uncontrolled: a value stays in its input until
 * the save reads it, and no component state ever holds it.
 */
import { useState, type FormEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import type { DirectoryFlow, DirectoryFlowStep } from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import type {
  AnswerValues,
  DirectorySubmissionSession,
} from "@/hooks/use-directory-submission";
import {
  useReviewerAttempt,
  type ReviewerFailure,
  type ReviewerRehearsal,
} from "@/hooks/use-reviewer-attempt";
import {
  useReviewerCredentials,
  type ReviewerCredentials,
} from "@/hooks/use-reviewer-credentials";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import type {
  ReviewerAttempt,
  ReviewerSignIn,
} from "@/lib/apis/reviewer-attempts-api";
import { copyToClipboard } from "@/lib/clipboard";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";
import { sentenceOf } from "./error-sentence";
import { McpjamMark } from "./McpjamChecks";
import { PortalField } from "./PortalField";
import {
  rehearsalSignIn,
  reviewerDetail,
  reviewerStatus,
} from "./reviewer-status";

/** The step where each flow asks for a reviewer's way in. */
const REVIEWER_STEPS: Readonly<Record<string, string>> = {
  "claude-connector": "testLaunch",
};

type Scope = { projectId: string; submissionId: string };

function failureText({ action, error }: ReviewerFailure): string {
  const why = sentenceOf(error);
  switch (action) {
    case "load":
      return `The reviewer sign-in status did not load. ${why} Reload the page to try again.`;
    case "start":
      return `The reviewer sign-in rehearsal did not start. ${why} Try starting it again.`;
    case "resume":
      return `The rehearsal did not resume. ${why} Try resuming it again.`;
    case "cancel":
      return `The rehearsal was not cancelled. ${why} Try cancelling it again.`;
  }
}

/** Answers the flow keeps on this step outside the portal's own layout. */
function mcpjamAnswers(step: DirectoryFlowStep) {
  const blocks = step.layout?.blocks;
  if (!blocks) return [];
  const shown = new Set(blocks.flatMap((block) => block.fields ?? []));
  return step.fields.filter((field) => !shown.has(field.key));
}

function CredentialsForm({
  credentials,
  onSaved,
  onCancel,
}: {
  credentials: ReviewerCredentials;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await credentials.save(
        String(fields.get("email") ?? ""),
        String(fields.get("password") ?? ""),
      );
      form.reset();
      onSaved();
    } catch (failure) {
      const why = sentenceOf(
        convexErrMessage(failure, "Check your connection."),
      );
      setError(`The credentials were not saved. ${why} Try saving them again.`);
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !credentials.canSave;
  return (
    <form
      aria-label="Reviewer credentials"
      className="space-y-3"
      onSubmit={(event) => void submit(event)}
    >
      <fieldset disabled={disabled} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="reviewer-email">Reviewer email</Label>
          <Input
            id="reviewer-email"
            name="email"
            required
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reviewer-password">Reviewer password</Label>
          <Input
            id="reviewer-password"
            name="password"
            type="password"
            required
            autoComplete="new-password"
          />
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        {credentials.personal
          ? "MCPJam saves them as your personal secrets and doesn't show them again. Only you can rehearse with them."
          : "MCPJam saves them as project secrets and doesn't show them again."}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={disabled}>
          Save credentials
        </Button>
        {onCancel ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** The path's first stage: the credentials, as names and never as values. */
function CredentialsRow({
  credentials,
  names,
  here,
  onSaved,
}: {
  credentials: ReviewerCredentials;
  /** The secrets the next rehearsal signs in with, if any. */
  names: string[];
  /** Saved under this submission's names, rather than only an agent's. */
  here: boolean;
  onSaved: () => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const saved = names.length > 0;
  const kind = here && credentials.personal ? "your personal" : "project";
  let body;
  if (saved && !replacing) {
    body = (
      <>
        <p className="[overflow-wrap:anywhere]">
          {`Saved as ${kind} ${names.length > 1 ? "secrets" : "secret"} ${names.join(" and ")}.`}
        </p>
        <p className="text-muted-foreground">
          No screen, API or export returns them, so type the password into the
          portal yourself.
        </p>
        {credentials.canSave ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setReplacing(true)}
          >
            Replace credentials
          </Button>
        ) : null}
      </>
    );
  } else if (credentials.member === false) {
    body = (
      <p className="text-muted-foreground">
        Not saved. A project member can save them here.
      </p>
    );
  } else {
    body = (
      <CredentialsForm
        credentials={credentials}
        onSaved={() => {
          setReplacing(false);
          onSaved();
        }}
        onCancel={replacing ? () => setReplacing(false) : undefined}
      />
    );
  }
  return (
    <li className="grid grid-cols-[1.25rem_11rem_minmax(0,1fr)_auto] items-start gap-3 py-2 text-sm">
      <span className="text-xs tabular-nums text-muted-foreground">1</span>
      <span className="font-medium">Reviewer credentials</span>
      <div className="min-w-0 space-y-2">{body}</div>
      <Badge variant="outline" className={cn(!saved && "border-dashed")}>
        {saved ? "Established" : "Not tested"}
      </Badge>
    </li>
  );
}

/** What a paused attempt needs, and how anyone else picks it up. */
function Paused({
  attempt,
  scope,
}: {
  attempt: ReviewerAttempt;
  scope: Scope;
}) {
  const command = `mcpjam readiness reviewer resume ${scope.submissionId} --attempt ${attempt.id} --project ${scope.projectId}`;
  const copy = async () => {
    if (await copyToClipboard(command)) {
      toast.success("Resume command copied.");
    } else {
      toast.error(
        "The resume command was not copied. Copy the attempt id from this page.",
      );
    }
  };
  const { waitingFor } = attempt;
  return (
    <div className="space-y-2 rounded-md border border-warning/70 bg-warning/10 p-3">
      {waitingFor ? (
        <>
          <p>{waitingFor.reason}</p>
          <p className="font-medium">{waitingFor.action}</p>
          <p className="text-xs text-muted-foreground">
            {`Paused ${formatDistanceToNow(waitingFor.since, { addSuffix: true })}.`}
          </p>
        </>
      ) : null}
      <p className="text-muted-foreground">
        A teammate or an agent can resume this attempt with its id.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Attempt id</span>
        <code className="font-code">{attempt.id}</code>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void copy()}
        >
          Copy resume command
        </Button>
      </div>
    </div>
  );
}

function RehearsalState({
  rehearsal,
  saved,
  signIn,
  canAct,
  scope,
}: {
  rehearsal: ReviewerRehearsal;
  saved: boolean;
  signIn: ReviewerSignIn | null;
  canAct: boolean;
  scope: Scope;
}) {
  const attempt = rehearsal.attempt ?? null;
  const waiting = attempt?.state === "waiting-for-person" ? attempt : null;
  const open = attempt?.state === "running" || waiting ? attempt : null;
  const detail = reviewerDetail(attempt);
  const { busy } = rehearsal;
  return (
    <div className="space-y-2 text-sm">
      <p role="status" className="font-medium">
        {reviewerStatus(saved, attempt)}
      </p>
      {detail ? <p className="text-muted-foreground">{detail}</p> : null}
      {waiting ? <Paused attempt={waiting} scope={scope} /> : null}
      {canAct ? (
        <div className="flex flex-wrap gap-2">
          {waiting ? (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void rehearsal.resume(waiting)}
            >
              Resume
            </Button>
          ) : null}
          {!open && signIn ? (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void rehearsal.start(signIn)}
            >
              Rehearse reviewer sign-in
            </Button>
          ) : null}
          {open ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void rehearsal.cancel(open)}
            >
              Cancel rehearsal
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ReviewerSection({
  step,
  projectId,
  submissionId,
  values,
  onAnswer,
}: Scope & {
  step: DirectoryFlowStep;
  values: AnswerValues;
  onAnswer: (key: string, value: AnswerValues[string]) => void;
}) {
  const scope = { projectId, submissionId };
  const credentials = useReviewerCredentials(scope);
  const rehearsal = useReviewerAttempt(scope);
  // The secrets list answers a moment after a save; this tab knows sooner.
  const [savedHere, setSavedHere] = useState(false);
  const attempt = rehearsal.attempt ?? null;
  const here = Boolean(credentials.saved || savedHere);
  const signIn = rehearsalSignIn(here ? credentials.names : null, attempt);
  const loading =
    rehearsal.attempt === undefined ||
    (credentials.saved === undefined && !savedHere);
  return (
    <section
      aria-label="Reviewer path"
      className="space-y-3 rounded-lg border border-dashed border-border px-4 py-3"
    >
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <McpjamMark />
        <span className="text-sm font-medium text-foreground">
          Reviewer path
        </span>
        Tested as the reviewer, from a clean browser. Never on your own
        connection.
      </p>
      {loading ? (
        <p className="text-sm text-muted-foreground">
          Reading the reviewer sign-in…
        </p>
      ) : (
        <>
          <ol className="divide-y divide-border/70">
            <CredentialsRow
              credentials={credentials}
              names={[
                signIn?.usernameSecretName,
                signIn?.passwordSecretName,
              ].filter((name): name is string => Boolean(name))}
              here={here}
              onSaved={() => setSavedHere(true)}
            />
          </ol>
          {mcpjamAnswers(step).map((field) => (
            <PortalField
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={(value) => onAnswer(field.key, value)}
            />
          ))}
          <RehearsalState
            rehearsal={rehearsal}
            saved={signIn !== null}
            signIn={signIn}
            canAct={credentials.member === true}
            scope={scope}
          />
        </>
      )}
      {rehearsal.failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failureText(rehearsal.failure)}
        </p>
      ) : null}
    </section>
  );
}

/** The reviewer path on the flow's reviewer step, and nothing on any other. */
export function ReviewerPath({
  flow,
  step,
  view,
  session,
}: {
  flow: DirectoryFlow;
  step: DirectoryFlowStep;
  view: Pick<SubmissionView, "id" | "projectId">;
  session: Pick<DirectorySubmissionSession, "values" | "setAnswer">;
}) {
  if (REVIEWER_STEPS[flow.id] !== step.id) return null;
  return (
    <ReviewerSection
      key={view.id}
      step={step}
      projectId={view.projectId}
      submissionId={view.id}
      values={session.values}
      onAnswer={session.setAnswer}
    />
  );
}
