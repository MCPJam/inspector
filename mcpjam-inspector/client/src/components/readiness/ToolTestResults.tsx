/**
 * What the newest run that named a test plan revision showed, tool by tool.
 * Valid-input and negative cases are counted apart: a tool that only refused
 * bad input has not shown that it works (V12). A call that may have changed
 * data and never finished is named (V11), and cleanup calls are listed apart
 * from the cases.
 */
import type {
  DirectoryTestCallRecord,
  DirectoryTestCaseStatus,
  DirectoryToolTestStatus,
} from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import type { ToolTests } from "@/lib/apis/directory-test-plan-api";
import { IssueList } from "./TestPlanTools";

const TOOL: Record<DirectoryToolTestStatus, string> = {
  "valid-input-succeeded": "Valid input succeeded",
  "expected-refusal": "Refused as expected",
  "unexpected-failure": "Unexpected failure",
  ambiguous: "In doubt",
  "setup-blocked": "Setup blocked",
  excluded: "Excluded",
  untested: "Not tested",
  stale: "Stale",
};
const CASE: Record<DirectoryTestCaseStatus, string> = {
  passed: "passed",
  failed: "failed",
  ambiguous: "in doubt",
  blocked: "blocked",
  untested: "not tested",
  stale: "stale",
};
const PHASE: Record<DirectoryTestCallRecord["phase"], string> = {
  planned: "not started",
  started: "started, not finished",
  succeeded: "done",
  failed: "failed",
  ambiguous: "in doubt",
};

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** "3 passed, 1 in doubt", or "none". */
function tally(counts: Record<DirectoryTestCaseStatus, number>): string {
  const parts = (Object.keys(CASE) as DirectoryTestCaseStatus[])
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${CASE[status]}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

export function ToolTestResults({
  results,
  error,
}: {
  results: ToolTests | null;
  error: string | null;
}) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (!results?.run || results.testPlanRevision === null) {
    return (
      <p className="text-sm text-muted-foreground">
        No run has called the tools yet. Start a run with a saved plan to call
        them.
      </p>
    );
  }
  const { run, sweep, counts, inDoubt, cleanup } = results;
  const going = run.status === "pending" || run.status === "running";
  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">Calls MCPJam made to your server</h3>
      <p>
        {`From the run started ${when(run.createdAt)} with test plan revision ${results.testPlanRevision}.`}
      </p>
      {going ? (
        <p className="text-muted-foreground">
          The run is still going. These are its calls so far.
        </p>
      ) : null}
      {sweep?.status === "not-run" && sweep.reason ? (
        <p>{sweep.reason}</p>
      ) : null}
      {sweep?.status === "stopped" ? (
        <p>
          {sweep.stopped?.detail ??
            "The run stopped before every case ran. Each tool below says why."}
        </p>
      ) : null}
      <IssueList issues={sweep?.issues ?? []} />
      <p>{`Valid input: ${tally(counts.validInput)}.`}</p>
      <p>
        {`Negative cases: ${tally(counts.negative)}. A passing negative case shows that the tool refuses bad input.`}
      </p>
      {inDoubt.length > 0 ? (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-l-2 border-destructive/40 border-l-destructive bg-destructive/5 p-3"
        >
          <p className="font-medium">
            {inDoubt.length === 1
              ? "1 call in doubt"
              : `${inDoubt.length} calls in doubt`}
          </p>
          <ul className="space-y-1">
            {inDoubt.map((call) => (
              <li key={call.callKey}>
                {`${call.tool} (${call.callKey}) started${call.startedAt ? ` ${when(call.startedAt)}` : ""} and never finished, so it may have changed data. Check what it changed on your server before you run the plan again.`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {cleanup.length > 0 ? (
        <div className="space-y-1">
          <p className="font-medium">Cleanup calls</p>
          <ul className="text-muted-foreground">
            {cleanup.map((call) => (
              <li key={call.callKey}>
                {`${call.tool} removing ${call.callKey.replace(/^cleanup:/, "")}: ${PHASE[call.phase]}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="space-y-2">
        {results.tools.map((tool) => (
          <li key={tool.tool} className="space-y-1">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{tool.tool}</span>
              <Badge variant="outline">{TOOL[tool.status]}</Badge>
            </p>
            {tool.reason ? (
              <p className="text-muted-foreground">{tool.reason}</p>
            ) : null}
            <ul className="ml-4 text-xs text-muted-foreground">
              {tool.cases.map((result) => (
                <li key={result.caseId}>
                  {`${result.caseId}, ${result.kind === "valid" ? "valid input" : "negative case"}: ${CASE[result.status]}`}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
