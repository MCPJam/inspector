/**
 * MCPJam's test plan, on the step where the portal asks whether every tool
 * was tested (Claude's Test & launch). The portal has no such block, so it is
 * drawn apart from the copy and marked "MCPJam": the saved revision and its
 * issues, this tab's changes until they are saved, the arguments a run
 * drafted, and what the newest run with a plan showed.
 *
 * Every tool is in a plan unless someone excludes it, and destructive calls
 * run last, on the plan's fixtures (D28). A run makes the calls of the saved
 * revision its button names, never this tab's unsaved changes.
 */
import type { ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  DIRECTORY_TEST_PLAN_LIMITS as LIMITS,
  type DirectoryFlow,
  type DirectoryFlowStep,
  type DirectoryTestPlan,
  type DirectoryTestPlanIssue,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import type { DirectoryTestPlanSession } from "@/hooks/use-directory-test-plan";
import { useTaskOwnerId } from "@/hooks/use-task-owner-id";
import { ArgumentDrafts } from "./ArgumentDrafts";
import { McpjamMark } from "./McpjamChecks";
import { editBudget } from "./test-plan-edits";
import { IssueList, TestPlanTools } from "./TestPlanTools";
import { ToolTestResults } from "./ToolTestResults";

/** The step where each flow asks about testing every tool. */
const PLAN_STEPS: Readonly<Record<string, string>> = {
  "claude-connector": "testLaunch",
};
const BUDGET = [
  { key: "maxCalls", label: "Calls per run", min: 1, max: LIMITS.maxCalls },
  {
    key: "concurrency",
    label: "Calls at a time",
    min: 1,
    max: LIMITS.maxConcurrency,
  },
  {
    key: "callTimeoutMs",
    label: "Call timeout, in milliseconds",
    min: LIMITS.minCallTimeoutMs,
    max: LIMITS.maxCallTimeoutMs,
  },
] as const;
const ago = (ms: number) => formatDistanceToNow(ms, { addSuffix: true });

/** The issues no tool, case or fixture of `plan` owns, which the plan as a whole shows. */
function unplaced(plan: DirectoryTestPlan, issues: DirectoryTestPlanIssue[]) {
  const cases = new Set(plan.cases.map(({ id }) => id));
  const tools = new Set(plan.tools.map(({ tool }) => tool));
  const fixtures = new Set(plan.fixtures.map(({ id }) => id));
  return issues.filter(({ caseId, tool, fixture }) =>
    caseId
      ? !cases.has(caseId)
      : tool
        ? !tools.has(tool)
        : !fixtures.has(fixture ?? ""),
  );
}

function Status({ session }: { session: DirectoryTestPlanSession }) {
  const you = useTaskOwnerId();
  const { saved, edited, issues, catalog } = session;
  const revision = saved?.revision;
  const who = saved?.savedBy === you ? "you" : "a project member";
  const state = !saved
    ? "This draft is not saved, so runs still call none of the server's tools. Save it to keep it."
    : edited
      ? `Your changes to revision ${revision} are not saved. Runs use revision ${revision} until you save.`
      : `Revision ${revision}, saved by ${who} ${ago(saved.savedAt)}. Run checks uses it, and starting a run authorizes every call in it.`;
  const count = issues?.length ?? 0;
  const found = count === 1 ? "1 issue" : `${count} issues`;
  // Issues come from the server's last check; edits are not checked until saved.
  const blocked = edited
    ? `The last check found ${found}, each shown where it applies. Save the plan to check your changes.`
    : `${count === 1 ? "1 issue keeps" : `${count} issues keep`} this plan from running, each shown where it applies. A run calls no tool until they are fixed in a saved revision.`;
  return (
    <div className="space-y-1 text-sm">
      <p>{state}</p>
      {catalog ? (
        <p className="text-xs text-muted-foreground">
          {`Checked against the tool list MCPJam stored ${ago(catalog.capturedAt)}.`}
        </p>
      ) : (
        <p>
          MCPJam has no tool list for this server yet, so it cannot check or
          save this plan. Connect the server in MCPJam to store its tools.
        </p>
      )}
      {count > 0 ? <p className="text-destructive">{blocked}</p> : null}
    </div>
  );
}

function SaveBar({ session }: { session: DirectoryTestPlanSession }) {
  const { edited, busy, conflict, error } = session;
  return (
    <>
      {edited ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => void session.save()}
          >
            {busy === "save" ? "Saving…" : "Save plan"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void session.discard()}
          >
            Discard changes
          </Button>
        </div>
      ) : null}
      {conflict !== null ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">
            {`Revision ${conflict} was saved in another session, so your changes were not saved. Loading revision ${conflict} replaces your changes with it.`}
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => void session.discard()}
          >
            {`Load revision ${conflict}`}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

function PlanDetails({
  session,
  plan,
}: {
  session: DirectoryTestPlanSession;
  plan: DirectoryTestPlan;
}) {
  const issues = session.issues ?? [];
  const rest = unplaced(plan, issues);
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Budget</legend>
        <div className="flex flex-wrap gap-3">
          {BUDGET.map(({ key, label, min, max }) => (
            <div key={key} className="space-y-1">
              <Label
                htmlFor={`test-plan-${key}`}
                className="text-xs text-muted-foreground"
              >
                {label}
              </Label>
              <Input
                key={plan.budget[key]}
                id={`test-plan-${key}`}
                type="number"
                min={min}
                max={max}
                defaultValue={plan.budget[key]}
                className="w-40"
                onBlur={(event) => {
                  const value = Number(event.target.value);
                  if (value === plan.budget[key]) return;
                  session.edit((current) =>
                    editBudget(current, { [key]: value }),
                  );
                }}
              />
            </div>
          ))}
        </div>
        <IssueList issues={rest} />
      </fieldset>
      <div className="space-y-1 text-sm">
        <h3 className="font-medium">Fixtures and cleanup</h3>
        <ul className="text-muted-foreground">
          {plan.fixtures.map(({ id, description, origin }) => (
            <li key={id}>
              {origin === "existing"
                ? `${id}, already in the reviewer's account: ${description}`
                : `${id}, created by the plan: ${description}`}
            </li>
          ))}
          {plan.cleanup.map(({ fixture, tool }) => (
            <li
              key={fixture}
            >{`After the cases, ${tool} removes ${fixture}.`}</li>
          ))}
          {plan.fixtures.length === 0 ? (
            <li>The plan names no fixtures.</li>
          ) : null}
        </ul>
        <IssueList
          issues={issues.filter(
            (issue) =>
              issue.fixture &&
              !issue.caseId &&
              !issue.tool &&
              !rest.includes(issue),
          )}
        />
      </div>
      <TestPlanTools
        plan={plan}
        saved={session.saved?.plan}
        issues={issues}
        edit={session.edit}
      />
    </div>
  );
}

export function TestPlanSection({
  flow,
  step,
  session,
}: {
  flow: DirectoryFlow;
  step: DirectoryFlowStep;
  session: DirectoryTestPlanSession;
}) {
  if (PLAN_STEPS[flow.id] !== step.id) return null;
  const { saved, plan, busy, error } = session;
  let body: ReactNode;
  if (saved === undefined) {
    body = (
      <p role={error ? "alert" : "status"} className="text-sm">
        {error ?? "Reading the test plan…"}
      </p>
    );
  } else if (!plan) {
    body = (
      <div className="space-y-2 text-sm">
        <p>
          No test plan is saved, so runs call none of this server's tools. Draft
          a plan with every tool, destructive calls last. Nothing is saved until
          you save it.
        </p>
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={() => void session.draft()}
        >
          {busy === "draft" ? "Drafting…" : "Draft a plan"}
        </Button>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <Status session={session} />
        <SaveBar session={session} />
      </div>
    );
  }
  // What needs the person comes first; the plan's long tool list comes last.
  return (
    <section
      aria-label="MCPJam test plan"
      className="space-y-5 rounded-lg border border-dashed border-border px-4 py-3"
    >
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <McpjamMark />
        Test plan
      </h2>
      {body}
      <ArgumentDrafts session={session} />
      <ToolTestResults results={session.results} error={session.resultsError} />
      {plan ? <PlanDetails session={session} plan={plan} /> : null}
    </section>
  );
}
