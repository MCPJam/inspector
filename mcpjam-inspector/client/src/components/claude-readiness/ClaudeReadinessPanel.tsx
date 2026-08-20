/**
 * Claude directory readiness — its own page, not a fifth conformance suite.
 *
 * That separation is the product decision this file has to render, so it is
 * worth stating where somebody will read it. Conformance grades a server
 * against the MCP SPEC and produces a score that pools across suites.
 * Readiness grades a connector against ANTHROPIC'S LISTING POLICY, produces no
 * score, and never enters that pooled number. A tab that showed them side by
 * side as five cards would say they are the same kind of claim, and the first
 * consequence would be somebody reading a policy preference as a protocol
 * violation.
 *
 * Three rendering rules follow from the model and are load-bearing:
 *
 *   1. COVERAGE SITS BESIDE EVERY LANE. "No violations" and "nothing was
 *      evaluated" look identical if you only render findings, and the second
 *      one is the single most damaging thing this page could imply.
 *   2. ONLY REQUIRED-CLASS FINDINGS DRIVE THE HEADLINE. Recommendations,
 *      badges and heuristics are shown, and shown as what they are; a badge
 *      that could turn the verdict red would make the verdict useless.
 *   3. EVERY FINDING CARRIES ITS SOURCE AND PROVENANCE. A grade nobody can
 *      check is an opinion, and the difference between `wire` and `declared`
 *      is the difference between "we saw this" and "they told us".
 */

import { useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  Loader2,
  MinusCircle,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type {
  ClaudeReadinessFinding,
  ClaudeReadinessLaneResult,
  ClaudeReadinessResult,
} from "@mcpjam/sdk";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  parseSubmissionProfile,
  useClaudeReadinessRun,
} from "@/hooks/use-claude-readiness-run";

/** Reading order: what blocks a listing first, what is advisory last. */
const CLASS_ORDER: Record<string, number> = {
  required: 0,
  "runtime-blocker": 1,
  recommended: 2,
  "experimental-feature": 3,
  "manual-review": 4,
  heuristic: 5,
};

const CLASS_LABEL: Record<string, string> = {
  required: "Required",
  "runtime-blocker": "Runtime blocker",
  recommended: "Recommended",
  "experimental-feature": "Experimental",
  "manual-review": "Manual review",
  heuristic: "Heuristic",
};

const LANE_LABEL: Record<string, string> = {
  "runtime-compatibility": "Runtime compatibility",
  "directory-policy": "Directory policy",
  "optional-features": "Optional features",
  "submission-artifacts": "Submission artifacts",
  "experience-insights": "Experience insights",
};

/** Which lanes can move the verdict — mirrors `CLAUDE_REQUIRED_LANES`. */
const REQUIRED_LANES = new Set([
  "runtime-compatibility",
  "directory-policy",
]);

function LaneStatusIcon({ status }: { status: string }) {
  if (status === "ready") {
    return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  }
  if (status === "not-ready") {
    return <XCircle className="h-4 w-4 text-destructive" />;
  }
  // `incomplete` is deliberately NOT an error colour. Nothing is wrong with
  // the connector; something was not looked at, and colouring it red would
  // teach people to read a coverage gap as a defect.
  return <CircleDashed className="h-4 w-4 text-amber-600" />;
}

function FindingStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "satisfied":
      return <CheckCircle2 className="h-4 w-4 text-green-600" />;
    case "violated":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "not-applicable":
      return <MinusCircle className="h-4 w-4 text-muted-foreground" />;
    case "informational":
      return <ShieldCheck className="h-4 w-4 text-muted-foreground" />;
    default:
      return <CircleDashed className="h-4 w-4 text-amber-600" />;
  }
}

/** The one dispositive line, worded so it cannot be mistaken for a score. */
function Verdict({ result }: { result: ClaudeReadinessResult }) {
  const tone =
    result.status === "ready"
      ? "text-green-600"
      : result.status === "not-ready"
        ? "text-destructive"
        : "text-amber-600";
  const label =
    result.status === "ready"
      ? "Ready to submit"
      : result.status === "not-ready"
        ? "Not ready"
        : "Incomplete";

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <LaneStatusIcon status={result.status} />
        <span className={`text-lg font-semibold ${tone}`}>{label}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{result.summary}</p>
      {/* Provenance for the GRADE itself. A verdict that cannot say which
          revision of Anthropic's docs it was made against goes silently wrong
          rather than visibly stale. */}
      <p className="mt-3 text-xs text-muted-foreground">
        Graded against Anthropic's directory requirements as of{" "}
        {result.policySnapshotDate} · engine {result.engineVersion} ·{" "}
        {result.context.authMode} run
        {result.context.capabilities.length > 0
          ? ` · ${result.context.capabilities.join(", ")}`
          : ""}
      </p>
      {/* Said plainly, on the page, because the sidebar cannot say it. */}
      <p className="mt-1 text-xs text-muted-foreground">
        This is not a conformance score and does not affect one. Nothing here is
        submitted to Anthropic.
      </p>
    </div>
  );
}

function LaneRow({ lane }: { lane: ClaudeReadinessLaneResult }) {
  const { coverage } = lane;
  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <LaneStatusIcon status={lane.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {LANE_LABEL[lane.lane] ?? lane.lane}
          </span>
          {!REQUIRED_LANES.has(lane.lane) && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              advisory
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{lane.summary}</p>
        {/* Rule 1. Rendered for every lane, always — a lane with no violations
            and nothing evaluated must not read like a lane that passed. */}
        <p className="mt-1 text-xs text-muted-foreground">
          evaluated {coverage.evaluated} · not evaluated{" "}
          {coverage.notEvaluated} · not applicable {coverage.notApplicable}
        </p>
        {coverage.missingInputs.length > 0 && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">
            Supply {coverage.missingInputs.join(", ")} to close this lane.
          </p>
        )}
      </div>
    </div>
  );
}

function FindingRow({ finding }: { finding: ClaudeReadinessFinding }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-2 p-3 text-left"
      >
        <Chevron className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <FindingStatusIcon status={finding.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{finding.title}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {CLASS_LABEL[finding.class] ?? finding.class}
            </span>
            {/* Rule 3, in the collapsed row: `declared` next to a satisfied
                finding is the difference between a check and a promise. */}
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {finding.provenance}
            </span>
          </div>
          {finding.status === "not-evaluated" && finding.notEvaluatedReason && (
            <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-500">
              {finding.notEvaluatedReason}
            </p>
          )}
        </div>
      </button>

      {open && (
        <div className="space-y-2 border-t px-3 py-2 text-xs">
          <p className="text-muted-foreground">
            <span className="font-mono">{finding.id}</span> ·{" "}
            {LANE_LABEL[finding.lane] ?? finding.lane} · evaluated{" "}
            {new Date(finding.evaluatedAt).toLocaleString()}
          </p>
          {finding.remediation && (
            <p className="text-foreground">{finding.remediation}</p>
          )}
          {finding.source?.url && (
            <a
              href={finding.source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {finding.source.section ?? "Anthropic's documentation"}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function ClaudeReadinessTab({
  server,
}: {
  server: ServerWithName | null;
}) {
  const { state, run } = useClaudeReadinessRun(server);
  const [profileText, setProfileText] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [showSatisfied, setShowSatisfied] = useState(false);

  const result = state.phase === "done" ? state.result : null;

  const findings = useMemo(() => {
    if (!result) return [];
    const visible = showSatisfied
      ? result.findings
      : result.findings.filter((finding) => finding.status !== "satisfied");
    // Rule 2's rendering half: blocking first, advisory last, so the top of
    // the list is always the work that decides the verdict.
    return [...visible].sort(
      (a, b) => (CLASS_ORDER[a.class] ?? 9) - (CLASS_ORDER[b.class] ?? 9),
    );
  }, [result, showSatisfied]);

  const onRun = () => {
    const parsed = parseSubmissionProfile(profileText);
    if (!parsed.ok) {
      setProfileError(parsed.message);
      return;
    }
    setProfileError(null);
    void run(
      parsed.value !== undefined
        ? { submissionProfile: parsed.value }
        : undefined,
    );
  };

  if (!server) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Connect a server to grade it"
        description="Readiness grades an HTTP connector as Claude's directory would see it. Select a connected server to start."
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Claude directory readiness</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Grades <span className="font-medium">{server.name}</span> against
          Anthropic's requirements for the Claude connectors directory. It
          dials the connector, follows its redirects and auth metadata, and
          opens one MCP connection. Nothing is submitted anywhere.
        </p>
      </div>

      <div className="rounded-lg border p-4">
        <label
          htmlFor="readiness-submission-profile"
          className="text-sm font-medium"
        >
          Submission profile{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The listing metadata a submission would carry — name, description,
          categories, policy URLs, screenshots. Without it the submission
          lane reports as incomplete rather than passing, because those
          requirements cannot be checked against nothing.
        </p>
        <textarea
          id="readiness-submission-profile"
          value={profileText}
          onChange={(event) => setProfileText(event.target.value)}
          rows={4}
          spellCheck={false}
          placeholder='{ "name": "Acme Issues", "categories": ["Developer tools"], … }'
          className="mt-2 w-full rounded-md border bg-background p-2 font-mono text-xs"
        />
        {profileError && (
          <p className="mt-1 text-xs text-destructive">{profileError}</p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Button onClick={onRun} disabled={state.phase === "running"}>
            {state.phase === "running" && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {state.phase === "running" ? "Grading…" : "Grade this connector"}
          </Button>
          {state.phase === "running" && (
            <span className="text-xs text-muted-foreground">
              Dialling the connector — this takes tens of seconds.
            </span>
          )}
        </div>
      </div>

      {state.phase === "error" && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="text-sm font-medium">The grade did not complete</p>
            {/* NOT rendered as a verdict. A run that failed to finish has
                established nothing, and showing "not ready" here would file an
                outage as a policy failure. */}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {state.message}
            </p>
          </div>
        </div>
      )}

      {result && (
        <>
          <Verdict result={result} />

          <div className="space-y-2">
            <h2 className="text-sm font-medium">Lanes</h2>
            {result.lanes.map((lane) => (
              <LaneRow key={lane.lane} lane={lane} />
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">
                Findings{" "}
                <span className="font-normal text-muted-foreground">
                  ({findings.length})
                </span>
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowSatisfied((value) => !value)}
              >
                {showSatisfied ? "Hide satisfied" : "Show satisfied"}
              </Button>
            </div>
            {findings.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing outstanding. Toggle “Show satisfied” to see what was
                checked.
              </p>
            ) : (
              findings.map((finding) => (
                <FindingRow key={finding.id} finding={finding} />
              ))
            )}
          </div>

          {result.badges.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-medium">Capabilities</h2>
              {/* Badges, never requirements. An absent capability is not a
                  defect, which is the entire difference between these and the
                  findings above. */}
              <p className="text-xs text-muted-foreground">
                Optional features. An unsupported one is not a defect and does
                not affect the verdict.
              </p>
              <div className="flex flex-wrap gap-2">
                {result.badges.map((badge) => (
                  <span
                    key={badge.id}
                    title={badge.detail}
                    className="rounded border px-2 py-1 text-xs"
                  >
                    {badge.title}
                    <span className="ml-1 text-muted-foreground">
                      {badge.state}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
