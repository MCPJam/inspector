/**
 * The copy of ChatGPT's "Review information" drawer, opened from the plugin
 * page's toolbar: the portal's steps from the flow's layout, one at a time,
 * with Back, Next and "Save details".
 *
 * - Reviewer credentials: the portal's fields, with the password entered
 *   through MCPJam's reviewer path, which saves it as a project secret and
 *   rehearses the sign-in, then MCPJam's own reviewer check.
 * - Test cases, the video and the release notes: the package manages them,
 *   so they are read only, each with where the package keeps it.
 *
 * MCPJam's results sit under the field they read, marked "MCPJam". One that
 * reads no field shows on the first step holding a field its check reads.
 */
import { Fragment, useState, type ReactNode } from "react";
import {
  directoryPlacementOf,
  type DirectoryAnswerValue,
  type DirectoryFieldIssue,
  type DirectoryFlow,
  type DirectoryFlowField,
  type DirectoryFlowStep,
  type DirectoryLayoutBlock,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import type { DirectorySubmissionSession } from "@/hooks/use-directory-submission";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import { McpjamChecks, McpjamMark, openResult } from "./McpjamChecks";
import { FindingsDot } from "./OpenAiFindings";
import { PackageField } from "./OpenAiMetadata";
import { PortalField, REQUIRED } from "./PortalField";
import { SaveNote } from "./PortalFrame";
import { McpjamNote } from "./PortalWidgets";
import { ReviewerSection } from "./ReviewerSection";

interface Page {
  heading: string;
  note?: string;
  /** The heading's block, then any without a heading: MCPJam's own fields. */
  blocks: DirectoryLayoutBlock[];
}

/** Each block with a heading opens a step of the drawer. */
function pagesOf(step: DirectoryFlowStep): Page[] {
  const pages: Page[] = [];
  for (const block of step.layout?.blocks ?? []) {
    if (block.widget) continue;
    if (block.heading) {
      pages.push({ heading: block.heading, note: block.note, blocks: [block] });
    } else {
      pages[pages.length - 1]?.blocks.push(block);
    }
  }
  return pages;
}

const keysOf = (page: Page) => page.blocks.flatMap((block) => block.fields ?? []);

/** Where the package keeps one case: `plugin.json: test_cases.positive[0]`. */
export function casePath(path: string, index: number): string {
  const [file, pointer = ""] = path.split("#/");
  return `${file}: ${pointer.split("/").slice(-2).join(".")}[${index}]`;
}

function IssueLine({ issue }: { issue?: DirectoryFieldIssue }) {
  return issue ? (
    <p className="text-sm text-destructive">Error: {issue.message}</p>
  ) : null;
}

/** The package's cases, read only, each as the package spells it. */
function TestCases({
  field,
  value,
}: {
  field: DirectoryFlowField;
  value: DirectoryAnswerValue | undefined;
}) {
  const cases = (Array.isArray(value) ? value : []).filter(
    (row): row is Record<string, string> => typeof row === "object" && row !== null,
  );
  if (cases.length === 0) {
    return <McpjamNote>No test cases are imported from this version's package.</McpjamNote>;
  }
  return (
    <ol className="space-y-3">
      {cases.map((row, index) => (
        <li key={index} className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            {Object.entries(row).map(([key, text]) => (
              <Fragment key={key}>
                <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
                <dd className="whitespace-pre-wrap break-words">{text}</dd>
              </Fragment>
            ))}
          </dl>
          {field.packagePath ? (
            <p
              title={`${field.packagePath}/${index}`}
              className="truncate font-mono text-xs text-muted-foreground"
            >
              {casePath(field.packagePath, index)}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function OpenAiReview({
  flow,
  step,
  view,
  session,
  issues,
  findings,
  open,
  onClose,
}: {
  flow: DirectoryFlow;
  /** The flow's "Review information" step. */
  step: DirectoryFlowStep;
  view: SubmissionView;
  session: DirectorySubmissionSession;
  issues: readonly DirectoryFieldIssue[];
  /** MCPJam's results on this step. */
  findings: readonly PlacedFinding[];
  open: boolean;
  onClose: () => void;
}) {
  const pages = pagesOf(step);
  // Open on the first step with fields to fill: one whose fields were never
  // captured holds only a note.
  const [at, setAt] = useState(() =>
    Math.max(0, pages.findIndex((each) => keysOf(each).length > 0)),
  );
  const page = pages[at];
  const actions =
    step.layout?.blocks?.find((block) => block.widget === "drawer-actions")?.text ?? {};
  const pageOf = (entry: PlacedFinding) => {
    const key = entry.field ?? directoryPlacementOf(flow, entry.finding.id)?.reads?.[0];
    return Math.max(0, pages.findIndex((each) => keysOf(each).some((other) => other === key)));
  };
  const flagged = (each: Page, index: number) =>
    issues.some((issue) => keysOf(each).includes(issue.key)) ||
    findings.some((entry) => openResult(entry) && pageOf(entry) === index);
  const fieldsOf = (block: DirectoryLayoutBlock) =>
    (block.fields ?? []).flatMap((key) => step.fields.filter((field) => field.key === key));

  const fieldView = (field: DirectoryFlowField): ReactNode => {
    const issue = issues.find((entry) => entry.key === field.key);
    const under = findings.filter((entry) => entry.field === field.key);
    const value = session.values[field.key];
    if (field.control === "rows") {
      return (
        <div key={field.key} className="space-y-2">
          <TestCases field={field} value={value} />
          <IssueLine issue={issue} />
          <McpjamChecks findings={under} />
        </div>
      );
    }
    if (field.managedBy === "package") {
      return (
        <div key={field.key} className="space-y-2">
          <dl>
            <PackageField field={field} value={value} findings={under} />
          </dl>
          <IssueLine issue={issue} />
        </div>
      );
    }
    // The password is a project secret: MCPJam's reviewer path saves it and
    // names it in this answer, and nothing on the page holds it.
    if (field.control === "secret") {
      return (
        <div key={field.key} className="space-y-2">
          <p className="text-sm font-medium">
            {field.label}
            {field.required ? REQUIRED : null}
          </p>
          <ReviewerSection
            step={step}
            projectId={view.projectId}
            submissionId={view.id}
            values={session.values}
            onAnswer={session.setAnswer}
            steps={view.steps}
          />
          <IssueLine issue={issue} />
          <McpjamChecks findings={under} />
        </div>
      );
    }
    return (
      <PortalField
        key={field.key}
        field={field}
        value={value}
        issue={issue}
        findings={under}
        onChange={(next) => session.setAnswer(field.key, next)}
      />
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent className="portal-openai w-full gap-0 bg-popover text-popover-foreground sm:max-w-2xl">
        <SheetHeader className="gap-2 px-6 pt-6">
          <SheetTitle className="text-xl">{step.title}</SheetTitle>
          <SheetDescription className="flex items-center gap-2 text-xs">
            <McpjamMark />
            Your answers save to this rehearsal. Nothing is sent to ChatGPT.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
          <ol aria-label={`${step.title} steps`} className="grid auto-cols-fr grid-flow-col gap-2">
            {pages.map((entry, index) => (
              <li key={entry.heading}>
                <button
                  type="button"
                  aria-current={index === at ? "step" : undefined}
                  onClick={() => setAt(index)}
                  className="flex w-full flex-col items-center gap-1.5 rounded-md text-center text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full font-medium tabular-nums",
                      index === at ? "bg-ring text-background" : "bg-accent text-muted-foreground",
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className={cn(index !== at && "text-muted-foreground")}>
                    {entry.heading}
                    {flagged(entry, index) ? (
                      <FindingsDot className="ml-1 inline-block align-middle" />
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <p className="rounded-lg bg-accent px-4 py-3 text-sm">{step.intro}</p>
          {page ? (
            <section aria-label={page.heading} className="space-y-5">
              <div className="space-y-1">
                <h3 className="font-medium">{`${at + 1}. ${page.heading}`}</h3>
                {/* A step whose fields were never captured carries MCPJam's note. */}
                {page.note && keysOf(page).length === 0 ? (
                  <McpjamNote>{page.note}</McpjamNote>
                ) : null}
                {page.note && keysOf(page).length > 0 ? (
                  <p className="text-sm text-muted-foreground">{page.note}</p>
                ) : null}
              </div>
              {page.blocks.map((block, index) =>
                block.heading ? (
                  <Fragment key={index}>{fieldsOf(block).map(fieldView)}</Fragment>
                ) : (
                  <div
                    key={index}
                    className="space-y-4 rounded-lg border border-dashed border-border px-4 py-3"
                  >
                    <McpjamNote>Reviewer check</McpjamNote>
                    {fieldsOf(block).map(fieldView)}
                  </div>
                ),
              )}
              <McpjamChecks
                findings={findings.filter((entry) => !entry.field && pageOf(entry) === at)}
              />
            </section>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-4">
          <Button type="button" variant="outline" disabled={at === 0} onClick={() => setAt(at - 1)}>
            {actions.back}
          </Button>
          <span role="status" className="min-w-0 flex-1 text-sm text-muted-foreground">
            <SaveNote session={session} />
          </span>
          <Button type="button" variant="outline" onClick={() => void session.saveNow()}>
            {actions.save}
          </Button>
          {at < pages.length - 1 ? (
            <Button type="button" onClick={() => setAt(at + 1)}>
              {actions.next}
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
