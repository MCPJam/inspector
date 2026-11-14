/**
 * MCPJam's check results, under the portal field they read. The portal has
 * no such block, so it is drawn apart from the copy and marked "MCPJam".
 *
 * Each result says three separate things: its source (how MCPJam knows), the
 * directory's severity, and how far the evidence still holds. An unsure model
 * answer reads as a likely flag, never as a blocker.
 */
import type { ReactNode } from "react";
import type { PlacedFinding } from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@mcpjam/design-system/cn";
import { EvidenceNote, EvidenceStatusBadge } from "./EvidenceStatus";
import { ShowEvidence } from "./ShowEvidence";

export const SOURCE: Record<string, string> = {
  wire: "Verified on your server",
  browser: "Seen in a browser",
  static: "Checked without calling your server",
  declared: "From your answers",
  manual: "Recorded by a person",
  llm: "Read by a model, not verified",
};

type Tone = "fail" | "flag" | "pass" | "idle";

const TONE: Record<Tone, string> = {
  fail: "border border-l-2 border-destructive/40 border-l-destructive bg-destructive/5 p-3",
  flag: "border border-warning/70 bg-warning/10 p-3",
  pass: "py-1",
  idle: "border border-dashed border-muted-foreground/60 p-3",
};

/** The directory's severity, in the words its portal would use. */
export function severityOf({ finding }: PlacedFinding): {
  label?: string;
  tone: Tone;
} {
  const dispositive =
    finding.class === "required" || finding.class === "runtime-blocker";
  if (finding.status === "violated") {
    return dispositive
      ? { label: "Blocker", tone: "fail" }
      : { label: "Likely flag", tone: "flag" };
  }
  if (finding.status === "informational" && finding.provenance === "llm") {
    return { label: "Likely flag", tone: "flag" };
  }
  if (finding.status === "satisfied") return { label: "Passed", tone: "pass" };
  if (finding.status === "not-applicable") {
    return { label: "Does not apply", tone: "pass" };
  }
  return { tone: finding.status === "informational" ? "pass" : "idle" };
}

/**
 * A blocker or likely flag on current evidence, as the step counts them: the
 * results the review page lists. Stale and untested ones stay on their step.
 */
export function openResult(entry: PlacedFinding): string | undefined {
  const current =
    entry.evidenceStatus === "established" ||
    entry.evidenceStatus === "inconclusive";
  const { label } = severityOf(entry);
  return current && (label === "Blocker" || label === "Likely flag")
    ? label
    : undefined;
}

export function McpjamMark({ children }: { children?: ReactNode }) {
  return (
    <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-xs font-medium text-foreground">
      MCPJam{children ? <> · {children}</> : null}
    </span>
  );
}

/** A dashed block marked "MCPJam" for what MCPJam adds to the copied page. */
export function McpjamBlock(props: {
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 rounded-lg border border-dashed border-border px-4 py-3">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <McpjamMark />
        <span className="text-sm font-medium text-foreground">
          {props.title}
        </span>
        {props.note}
      </p>
      {props.children}
    </section>
  );
}

function CheckResult({ entry }: { entry: PlacedFinding }) {
  const { finding, evidenceStatus } = entry;
  const severity = severityOf(entry);
  // A result without a verdict says why in its evidence note instead.
  const detail =
    finding.status === "violated"
      ? finding.remediation
      : finding.status === "not-evaluated"
        ? undefined
        : finding.notEvaluatedReason;
  return (
    <li className={cn("rounded-md text-sm", TONE[severity.tone])}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{finding.title}</span>
        {severity.label ? (
          <Badge variant="outline">{severity.label}</Badge>
        ) : null}
        <EvidenceStatusBadge status={evidenceStatus} />
      </div>
      <p className="text-xs text-muted-foreground">
        {SOURCE[finding.provenance] ?? finding.provenance}
        <ShowEvidence entry={entry} />
      </p>
      {detail ? <p className="mt-1">{detail}</p> : null}
      <EvidenceNote entry={entry} />
    </li>
  );
}

export function McpjamChecks({
  findings,
}: {
  findings: readonly PlacedFinding[];
}) {
  if (findings.length === 0) return null;
  return (
    <div className="rounded-lg border border-dashed border-border px-3 py-2.5">
      <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <McpjamMark />
        Checked in this rehearsal. The portal does not show these.
      </p>
      <ul className="space-y-2">
        {findings.map((entry) => (
          <CheckResult key={entry.finding.id} entry={entry} />
        ))}
      </ul>
    </div>
  );
}
