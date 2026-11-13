/**
 * The copy of the portal's form around one submission: the Submissions link
 * and the saved note, the step rail, the serif step title, and Back and Next.
 * Every step renders from the flow's layout, so a portal change is a data
 * change. The last step is the portal's review page, where MCPJam's copy
 * button stands in for the portal's submit.
 */
import { useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type {
  DirectoryAnswer,
  DirectoryFieldIssue,
  DirectoryFlow,
  DirectoryFlowField,
  DirectoryFlowStep,
  DirectoryLayoutBlock,
  PlacedFinding,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import type {
  AnswerValues,
  DirectorySubmissionSession,
} from "@/hooks/use-directory-submission";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import { AnswerOrigin, NO_PEOPLE, type People } from "./AnswerOrigin";
import { ConflictNotice } from "./ConflictNotice";
import { HandoffPanel } from "./HandoffPanel";
import { McpjamChecks } from "./McpjamChecks";
import { PortalField } from "./PortalField";
import { CopyForPortal, PortalReview, portalText } from "./PortalReview";
import { portalMarks, PortalStepRail } from "./PortalStepRail";
import { PortalWidget } from "./PortalWidgets";
import { DIRECTORY_NAMES } from "./RehearsalBar";

function StepBody({
  flow,
  step,
  values,
  answers,
  issues,
  findings,
  server,
  people,
  onAnswer,
  onConfirm,
}: {
  flow: DirectoryFlow;
  step: DirectoryFlowStep;
  values: AnswerValues;
  /** Each answer with where it came from, for the mark under its field. */
  answers: ReadonlyMap<string, DirectoryAnswer>;
  /** Only once the step is marked, as the portal shows them. */
  issues: readonly DirectoryFieldIssue[];
  findings: readonly PlacedFinding[];
  server: { url?: string; name?: string };
  people: People;
  onAnswer: (key: string, value: AnswerValues[string]) => void;
  onConfirm: (key: string) => void;
}) {
  const blocks: DirectoryLayoutBlock[] =
    step.layout?.blocks ??
    step.fields.map((field) => ({ fields: [field.key] }));
  const shown = new Set(blocks.flatMap((block) => block.fields ?? []));
  const fieldsOf = (block: DirectoryLayoutBlock) =>
    step.fields.filter((field) => block.fields?.includes(field.key));
  const renderField = (field: DirectoryFlowField, label?: string) => {
    const issue = issues.find((entry) => entry.key === field.key);
    return (
      <PortalField
        key={field.key}
        field={field}
        label={label}
        value={values[field.key]}
        issue={issue}
        findings={findings.filter((entry) => entry.field === field.key)}
        serverUrl={server.url}
        serverName={server.name}
        mark={
          <AnswerOrigin
            field={field}
            answer={answers.get(field.key)}
            issue={issue}
            people={people}
            onConfirm={() => onConfirm(field.key)}
          />
        }
        onChange={(value) => onAnswer(field.key, value)}
      />
    );
  };
  return (
    <div className="space-y-7">
      {blocks.map((block, index) => (
        <div key={index} className="space-y-3">
          {block.heading ? (
            <div className="space-y-1">
              <h2 className="text-sm font-medium">{block.heading}</h2>
              {block.note ? (
                <p className="text-sm text-muted-foreground">{block.note}</p>
              ) : null}
            </div>
          ) : null}
          {block.widget ? (
            <PortalWidget
              block={block}
              flow={flow}
              step={step}
              fields={fieldsOf(block)}
              values={values}
              findings={findings}
              renderField={renderField}
            />
          ) : (
            <div
              className={cn(
                "grid gap-6",
                (block.fields?.length ?? 0) > 1 && "md:grid-cols-2",
              )}
            >
              {fieldsOf(block).map((field) => renderField(field))}
            </div>
          )}
        </div>
      ))}
      <McpjamChecks
        findings={findings.filter(
          (entry) => !entry.field || !shown.has(entry.field),
        )}
      />
    </div>
  );
}

function SaveNote({ session }: { session: DirectorySubmissionSession }) {
  if (session.saving) return <>Saving draft…</>;
  if (session.error) {
    return (
      <>
        Your last change was not saved. {session.error}{" "}
        <Button
          type="button"
          size="sm"
          variant="link"
          onClick={() => void session.saveNow()}
        >
          Try again
        </Button>
      </>
    );
  }
  if (!session.savedAt) return null;
  const time = new Date(session.savedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return <>Draft saved at {time}</>;
}

export function PortalFrame({
  flow,
  view,
  session,
  serverUrl,
  serverName,
  people = NO_PEOPLE,
  onClose,
}: {
  flow: DirectoryFlow;
  view: SubmissionView;
  session: DirectorySubmissionSession;
  serverUrl?: string;
  serverName?: string;
  /** Who wrote each answer, by name; ids alone read as "a project member". */
  people?: People;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const [left, setLeft] = useState<ReadonlySet<number>>(new Set());
  const directory = DIRECTORY_NAMES[flow.directory];
  const last = flow.steps.length - 1;
  const step = flow.steps[Math.min(active, last)];
  const review = Boolean(step.layout?.review);
  const missing = step.layout?.blocks?.find(
    (block) => block.widget === "submit",
  )?.text?.missing;
  const marked = portalMarks(left, active, last, Boolean(view.lastRunId));
  const placed = (id: string) => view.steps.find((entry) => entry.step === id);
  const issuesOf = (id: string) =>
    session.issues.filter((issue) => issue.step === id);
  const go = (index: number) => {
    if (index === active) return;
    setLeft((current) => new Set(current).add(active));
    setActive(index);
  };
  const rail = flow.steps.map((entry) => {
    const counts = placed(entry.id)?.counts;
    return {
      id: entry.id,
      title: entry.title,
      toFix: issuesOf(entry.id).length + (counts?.blockers ?? 0),
      likelyFlags: counts?.likelyFlags ?? 0,
      notChecked: counts?.notChecked ?? 0,
    };
  });
  const answers = new Map(
    session.answers.map((answer) => [answer.key, answer]),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 px-10 py-3">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-2 rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Submissions
        </button>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground" role="status">
            <SaveNote session={session} />
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Save and exit
          </Button>
        </div>
      </div>
      <ConflictNotice flow={flow} session={session} people={people} />
      <div className="flex min-h-0 flex-1 gap-10 px-10 pb-6">
        <PortalStepRail
          label={`${directory} submission steps`}
          steps={rail}
          active={active}
          marked={marked}
          onSelect={go}
        />
        <div
          key={step.id}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-2"
        >
          <div className="max-w-[46rem] space-y-6 pb-10">
            <header className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {flow.title} · Step {active + 1} of {flow.steps.length}
              </p>
              <h1 className="font-serif text-[1.75rem] leading-tight">
                {step.title}
              </h1>
              <p className="text-muted-foreground">{step.intro}</p>
            </header>
            {review ? (
              <>
                <HandoffPanel
                  flow={flow}
                  scope={{ projectId: view.projectId, submissionId: view.id }}
                  version={`${view.revision}:${view.resultsRunId}:${view.lastRunId}`}
                  people={people}
                />
                <PortalReview
                  flow={flow}
                  step={step}
                  values={session.values}
                  issues={session.reviewIssues}
                  placed={view.steps}
                  onEdit={(id) =>
                    go(flow.steps.findIndex((entry) => entry.id === id))
                  }
                />
                <McpjamChecks findings={placed(step.id)?.findings ?? []} />
              </>
            ) : (
              <StepBody
                flow={flow}
                step={step}
                values={session.values}
                answers={answers}
                issues={marked(active) ? issuesOf(step.id) : []}
                findings={placed(step.id)?.findings ?? []}
                server={{ url: serverUrl, name: serverName }}
                people={people}
                onAnswer={session.setAnswer}
                onConfirm={session.confirm}
              />
            )}
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                disabled={active === 0}
                onClick={() => go(active - 1)}
              >
                Back
              </Button>
              {active < last ? (
                <Button type="button" onClick={() => go(active + 1)}>
                  Next
                </Button>
              ) : (
                <>
                  {review ? (
                    <CopyForPortal
                      text={() => portalText(flow, session.values)}
                    />
                  ) : null}
                  <a
                    href={view.submissionUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 inline-flex items-center gap-1 text-sm text-ring underline underline-offset-2"
                  >
                    Open the real {directory} portal
                    <ExternalLink aria-hidden="true" className="size-3.5" />
                  </a>
                </>
              )}
              {missing && session.reviewIssues.length > 0 ? (
                <p className="w-full text-sm text-muted-foreground">
                  {missing}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
