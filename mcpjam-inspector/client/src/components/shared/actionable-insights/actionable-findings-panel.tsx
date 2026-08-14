/**
 * The unified actionable-findings panel — ONE presentation for Eval runs,
 * Swarm waves, and User Testing windows.
 *
 * Ordering is the argument: server fixes that are ready to make, then server
 * issues that still need investigating, then work that belongs to the agent,
 * the eval case, or the environment. A reader scanning top-down meets the
 * things they can act on first, and never has to guess whether a row is
 * telling them to edit their server.
 *
 * Every non-deterministic element is gated on the backend's own promotion
 * gate rather than re-derived here: only `mcp_server` + `ready` shows the
 * pinned contract and offers a server-fix prompt, and a section header never
 * says "fix your MCP server" over mixed ownership.
 */
import { useMemo, useState } from "react";
import { ChevronRight, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import {
  findingGroup,
  isServerReady,
  sortFindingsForDisplay,
  type ActionableFinding,
  type InsightsEnvelope,
} from "@/lib/insights-envelope-api";
import {
  buildFindingPrompt,
  findingOffersPrompt,
  findingPromptLabel,
  type FindingPromptContext,
} from "./finding-prompts";

const VISIBLE_ROWS = 4;

/** Ownership badge. The label is the ANSWER to "whose work is this?", which
 * is the question the attribution ladder exists to settle. */
const GROUP_BADGE: Record<
  string,
  { label: string; className: string; note?: string }
> = {
  server_ready: {
    label: "MCP server",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
    note: "Ready to fix",
  },
  server_investigate: {
    label: "MCP server",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    note: "Needs investigation",
  },
  agent_configuration: {
    label: "Agent / prompt",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  },
  eval_case: {
    label: "Test design",
    className:
      "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
  },
  environment: {
    label: "Environment",
    className: "border-border/60 bg-muted/40 text-muted-foreground",
  },
  investigate: {
    label: "Investigate",
    className: "border-border/60 bg-muted/40 text-muted-foreground",
  },
};

const SECTION_TITLES: Array<{ group: string; title: string; blurb: string }> = [
  {
    group: "server_ready",
    title: "Fix in your MCP server",
    blurb: "Grounded in failing sessions, pinned to the tool contract.",
  },
  {
    group: "server_investigate",
    title: "Suspected server issues",
    blurb: "The evidence points at the server but not yet at a mechanism.",
  },
  {
    group: "agent_configuration",
    title: "Agent and prompt",
    blurb: "The server behaved; the agent's configuration is what to change.",
  },
  {
    group: "eval_case",
    title: "Test design",
    blurb: "The check itself is what produced the failure.",
  },
  { group: "investigate", title: "Worth investigating", blurb: "" },
  { group: "environment", title: "Environment", blurb: "" },
];

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

function CopyPromptButton({
  finding,
  context,
}: {
  finding: ActionableFinding;
  context?: FindingPromptContext;
}) {
  const [copied, setCopied] = useState(false);
  if (!findingOffersPrompt(finding)) return null;
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      data-testid="finding-copy-prompt"
      data-server-fix={isServerReady(finding) ? "true" : "false"}
      onClick={() => {
        void copyToClipboard(buildFindingPrompt(finding, context)).then(
          (ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
        );
      }}
    >
      {copied ? (
        <Check className="size-3" aria-hidden="true" />
      ) : (
        <Copy className="size-3" aria-hidden="true" />
      )}
      {copied ? "Copied" : findingPromptLabel(finding)}
    </button>
  );
}

function FindingRow({
  finding,
  context,
  onOpenSession,
}: {
  finding: ActionableFinding;
  context?: FindingPromptContext;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const badge = GROUP_BADGE[findingGroup(finding)] ?? GROUP_BADGE.investigate;
  const target = finding.target;

  return (
    <div
      className="border-b border-border/40 last:border-b-0"
      data-testid="actionable-finding"
      data-action-target={finding.actionTarget}
      data-actionability={finding.actionability}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          data-testid="actionable-finding-headline"
        >
          <ChevronRight
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 space-y-0.5">
            <span className="block text-sm font-medium text-foreground">
              {finding.title}
            </span>
            {/* The deterministic sentence, always visible: it is the part
                that is true regardless of what the model wrote. */}
            <span
              className="block text-xs text-muted-foreground"
              data-testid="actionable-finding-observed"
            >
              {finding.observed}
            </span>
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn(
              "rounded border px-1 py-0 text-[10px] font-medium",
              badge.className,
            )}
            data-testid="actionable-finding-badge"
          >
            {badge.label}
            {badge.note ? ` · ${badge.note}` : ""}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {CONFIDENCE_LABEL[finding.confidence]}
          </span>
        </span>
      </div>

      {expanded ? (
        <div
          className="space-y-2 bg-muted/20 px-3 py-2 pl-8"
          data-testid="actionable-finding-detail"
        >
          {finding.rootCause ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">Why: </span>
              {finding.rootCause}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">
              {isServerReady(finding) ? "Change: " : "Next step: "}
            </span>
            {finding.recommendation}
          </p>

          {finding.acceptanceCriteria.length > 0 ? (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">Done when:</span>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                {finding.acceptanceCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* The pinned contract renders only for a promoted finding: on an
              unproven one it would read as "here is the code to change". */}
          {isServerReady(finding) && target ? (
            <div
              className="rounded border border-border/50 bg-background/60 p-2 text-[11px]"
              data-testid="actionable-finding-contract"
            >
              <div className="font-medium text-foreground/80">
                {target.toolName
                  ? `${target.toolName} · ${target.surface}`
                  : target.surface}
                {target.fieldPath ? ` · ${target.fieldPath}` : ""}
              </div>
              {target.currentDefinition?.description ? (
                <p className="mt-1 text-muted-foreground">
                  {target.currentDefinition.description}
                </p>
              ) : null}
              {target.currentDefinition?.inputSchemaJson ? (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                  {target.currentDefinition.inputSchemaJson}
                </pre>
              ) : null}
              {/* An output_schema repair needs the output schema in front of
                  it; showing only the input one made the "pinned definition"
                  incomplete for exactly the finding that targets it. */}
              {target.currentDefinition?.outputSchemaJson ? (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                  {target.currentDefinition.outputSchemaJson}
                </pre>
              ) : null}
              <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                snapshot {target.snapshotHash}
              </div>
            </div>
          ) : null}

          {finding.evidence.length > 0 ? (
            <div className="space-y-1">
              {finding.evidence.map((evidence, index) => (
                <div
                  key={`${
                    evidence.sessionId ?? evidence.iterationId ?? "e"
                  }-${index}`}
                  className="text-[11px] text-muted-foreground"
                  data-testid="actionable-finding-evidence"
                >
                  <span className="text-foreground/70">
                    {evidence.kind.replace(/_/g, " ")}
                    {evidence.toolName ? ` · ${evidence.toolName}` : ""}
                    {": "}
                  </span>
                  <span className="break-words">{evidence.excerpt}</span>
                  {evidence.sessionId && onOpenSession ? (
                    <button
                      type="button"
                      className="ml-1 rounded border border-border/50 px-1 text-[10px] hover:bg-muted"
                      onClick={() => onOpenSession(evidence.sessionId!)}
                      data-testid="actionable-finding-session-link"
                    >
                      Open session
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <CopyPromptButton finding={finding} context={context} />
        </div>
      ) : null}
    </div>
  );
}

export function ActionableFindingsPanel({
  envelope,
  context,
  onOpenSession,
}: {
  /** `undefined` while the query is in flight; `null` when the surface has
   * no envelope (an older backend, or a resource that never had one). */
  envelope: InsightsEnvelope | null | undefined;
  context?: FindingPromptContext;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(
    () => sortFindingsForDisplay(envelope?.findings ?? []),
    [envelope?.findings],
  );

  if (!envelope) return null;

  // Every non-completed state says what it is rather than rendering an empty
  // list, which would read as "nothing is wrong".
  if (envelope.status !== "completed") {
    const message =
      envelope.status === "pending"
        ? "Analyzing this run for actionable findings…"
        : envelope.status === "failed"
        ? `Analysis failed${
            envelope.error ? `: ${envelope.error.message}` : "."
          }${envelope.retryable ? " You can request it again." : ""}`
        : envelope.status === "not_requested"
        ? "No analysis has been requested for this yet."
        : "Actionable findings appear once this finishes and is analyzed.";
    return (
      <p
        className="px-3 py-2 text-xs text-muted-foreground"
        data-testid="actionable-findings-status"
        data-status={envelope.status}
      >
        {message}
      </p>
    );
  }

  if (sorted.length === 0) {
    return (
      <p
        className="px-3 py-2 text-xs text-muted-foreground"
        data-testid="actionable-findings-empty"
      >
        {envelope.coverage.truncated || envelope.coverage.lowConfidence
          ? "No actionable findings surfaced, but this analysis did not see everything — treat it as incomplete rather than clean."
          : "No actionable findings. Nothing here needs a change."}
      </p>
    );
  }

  const visible = showAll ? sorted : sorted.slice(0, VISIBLE_ROWS);
  const sections = SECTION_TITLES.map((section) => ({
    ...section,
    rows: visible.filter((finding) => findingGroup(finding) === section.group),
  })).filter((section) => section.rows.length > 0);

  return (
    <div data-testid="actionable-findings">
      {sections.map((section) => (
        <div key={section.group} className="mb-2 last:mb-0">
          <div className="px-3 pb-1 pt-2">
            <h4 className="text-xs font-semibold tracking-tight text-foreground">
              {section.title}
            </h4>
            {section.blurb ? (
              <p className="text-[11px] text-muted-foreground">
                {section.blurb}
              </p>
            ) : null}
          </div>
          <div className="rounded-md border border-border/50">
            {section.rows.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                context={context}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        </div>
      ))}

      {sorted.length > VISIBLE_ROWS ? (
        <button
          type="button"
          className="px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setShowAll((prev) => !prev)}
          data-testid="actionable-findings-toggle"
        >
          {showAll ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      ) : null}

      {/* Says what was actually dropped. A contract-only clip previously
          reported "0 findings, 0 evidence records", which reads as a bug. */}
      {envelope.truncation.truncated ? (
        <p className="px-3 pb-1 text-[11px] text-muted-foreground">
          {[
            envelope.truncation.omittedFindings > 0
              ? `${envelope.truncation.omittedFindings} findings`
              : null,
            envelope.truncation.omittedEvidence > 0
              ? `${envelope.truncation.omittedEvidence} evidence records`
              : null,
          ].filter(Boolean).length > 0
            ? `Omitted for size: ${[
                envelope.truncation.omittedFindings > 0
                  ? `${envelope.truncation.omittedFindings} findings`
                  : null,
                envelope.truncation.omittedEvidence > 0
                  ? `${envelope.truncation.omittedEvidence} evidence records`
                  : null,
              ]
                .filter(Boolean)
                .join(", ")}.`
            : "A tool definition was shortened for size."}
          {envelope.truncation.contractTruncated &&
          (envelope.truncation.omittedFindings > 0 ||
            envelope.truncation.omittedEvidence > 0)
            ? " A tool definition was also shortened."
            : ""}
        </p>
      ) : null}
    </div>
  );
}
