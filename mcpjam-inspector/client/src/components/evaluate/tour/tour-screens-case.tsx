import {
  ArrowLeft,
  MessageSquare,
  Play,
  Target,
  Trash2,
  Wrench,
} from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import {
  EXAMPLE_CASE,
  EXAMPLE_ITERATION,
  EXAMPLE_SUITE,
  type ExampleStageStatus,
} from "./tour-example-data";
import {
  ExampleDataPill,
  FakeButton,
  StatusTag,
  TourBreadcrumb,
} from "./tour-screen-chrome";

function caseCrumbs(last: string, suiteAnchor?: string) {
  return [
    { label: "Evaluate" },
    { label: EXAMPLE_SUITE.name, anchor: suiteAnchor },
    { label: `Run #${EXAMPLE_ITERATION.runNumber}` },
    { label: EXAMPLE_CASE.title },
    { label: last },
  ];
}

function CaseTrailing() {
  return (
    <>
      <ExampleDataPill />
      <FakeButton>
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to test run
      </FakeButton>
    </>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-code text-xs text-foreground">
      {children}
    </code>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="mt-3 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted-foreground">
      {n}
    </span>
  );
}

/** Editing the example case: the prompt, its checks, the expected outcome, then Run. */
export function TourCaseScreen() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TourBreadcrumb
        crumbs={caseCrumbs("Edit test case")}
        trailing={<ExampleDataPill />}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-4 py-5 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-foreground">
            {EXAMPLE_CASE.title}
          </h1>
          <div className="flex items-center gap-2">
            <FakeButton className="px-2">
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </FakeButton>
            <FakeButton>Test Case Evaluators</FakeButton>
            <FakeButton variant="primary" anchor="case-run">
              <Play className="h-3.5 w-3.5" aria-hidden />
              Run
            </FakeButton>
          </div>
        </div>
        <div className="flex max-w-2xl flex-col gap-4">
          <div className="flex gap-3">
            <StepNumber n={1} />
            <div
              data-tour-anchor="case-prompt"
              className="min-w-0 flex-1 space-y-3 rounded-xl border border-border bg-card p-4"
            >
              <p className="text-sm">
                <span className="font-semibold text-foreground">
                  User prompt
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  The agent runs and chooses tools.
                </span>
              </p>
              <p className="rounded-md border border-border bg-background px-3 py-2 font-code text-xs leading-relaxed text-foreground">
                {EXAMPLE_CASE.prompt}
              </p>
              <p className="text-xs text-muted-foreground">
                Assertions at this point
              </p>
              <ul className="space-y-1.5">
                {EXAMPLE_CASE.assertions.map((assertion) => (
                  <li
                    key={assertion.value}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground"
                  >
                    {assertion.kind === "tool" ? (
                      <Wrench
                        className="h-3.5 w-3.5 text-success"
                        aria-hidden
                      />
                    ) : (
                      <MessageSquare
                        className="h-3.5 w-3.5 text-success"
                        aria-hidden
                      />
                    )}
                    {assertion.label}
                    <Code>{assertion.value}</Code>
                    {assertion.kind === "tool" ? (
                      <span className="text-muted-foreground">
                        any arguments
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <span className="inline-flex rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground">
                + Add assertion
              </span>
            </div>
          </div>
          <div className="flex gap-3">
            <StepNumber n={2} />
            <div className="min-w-0 flex-1 space-y-2 rounded-xl border border-border bg-card p-4">
              <p className="text-sm">
                <span className="font-semibold text-foreground">Interact</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  MCPJam acts in the rendered view. No model.
                </span>
              </p>
              <p className="rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground">
                <Code>{EXAMPLE_CASE.interaction.action}</Code>
                <span className="ml-2 text-muted-foreground">
                  in {EXAMPLE_CASE.interaction.view}
                </span>
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="w-7 shrink-0" aria-hidden />
            <div
              data-tour-anchor="case-outcome"
              className="scroll-my-4 min-w-0 flex-1 space-y-2 rounded-xl border border-border bg-card p-4"
            >
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Target className="h-4 w-4" aria-hidden />
                Expected outcome
              </p>
              <p className="text-xs text-muted-foreground">
                Describe what success looks like. An AI judge checks whether
                this goal was met.
              </p>
              <p className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground">
                {EXAMPLE_CASE.expectedOutcome}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const STAGE_DOT: Record<ExampleStageStatus, string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground",
};

/** One iteration's six-step scorecard, failing at Selection. */
export function TourDiagnoseScreen() {
  const { failure } = EXAMPLE_ITERATION;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TourBreadcrumb
        crumbs={caseCrumbs(
          `Iteration #${EXAMPLE_ITERATION.iteration}`,
          "diagnose-suite-crumb",
        )}
        trailing={<CaseTrailing />}
      />
      <div className="min-h-0 flex-1 overflow-hidden px-4 py-5 sm:px-6">
        <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
          <div className="px-1">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              #{EXAMPLE_ITERATION.runNumber} {EXAMPLE_SUITE.name}
              <StatusTag status="failed" />
            </p>
            <p className="text-xs text-muted-foreground">
              Run {EXAMPLE_ITERATION.runId} · {EXAMPLE_ITERATION.model} ·{" "}
              {EXAMPLE_ITERATION.ago}
            </p>
          </div>
          <div className="flex gap-1 rounded-md bg-muted p-1 text-xs">
            {EXAMPLE_ITERATION.tabs.map((tab, index) => (
              <span
                key={tab}
                className={cn(
                  "rounded px-2.5 py-1",
                  index === 0
                    ? "bg-background font-medium text-foreground shadow-xs"
                    : "text-muted-foreground",
                )}
              >
                {tab}
              </span>
            ))}
          </div>
          <div
            data-tour-anchor="diagnose-scorecard"
            className="grid grid-cols-[170px_1fr] gap-5 rounded-xl bg-card p-3"
          >
            <ol className="space-y-1 text-sm">
              {EXAMPLE_ITERATION.stages.map((stage) => (
                <li
                  key={stage.id}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5",
                    stage.status === "failed" && "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      STAGE_DOT[stage.status],
                    )}
                  />
                  <span className="font-code text-xs text-muted-foreground">
                    {stage.id}
                  </span>
                  <span className="text-foreground">{stage.label}</span>
                </li>
              ))}
            </ol>
            <div className="min-w-0 space-y-3">
              <div>
                <p className="flex items-center gap-2 text-base font-semibold text-foreground">
                  {failure.stage}
                  <StatusTag status="failed" />
                </p>
                <p className="text-xs text-muted-foreground">
                  {failure.question}
                </p>
              </div>
              <p className="flex items-center justify-between gap-2 text-sm font-semibold text-foreground">
                {failure.check}
                <StatusTag status="failed" />
              </p>
              <dl className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-1.5 text-xs">
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                  Expected
                </dt>
                <dd className="text-foreground">{failure.expected}</dd>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                  Actual
                </dt>
                <dd className="text-foreground">{failure.actual}</dd>
              </dl>
              <div className="rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-foreground">
                <p className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
                  Fix in your MCP server
                </p>
                {failure.fix.before} <Code>{failure.fix.tool}</Code>{" "}
                {failure.fix.after}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
