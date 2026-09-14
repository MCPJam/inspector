/**
 * One finding, as three answers.
 *
 *   1. What happened?      the deterministic observation and its population
 *   2. What supports that? the exact evidence, one disclosure away
 *   3. What next?          a justified fix when attribution permits one, and
 *                          otherwise a specific investigation
 *
 * The observation renders FIRST and always: it is the sentence that survives
 * when narration fails, and it is the one a reader can check. Model prose sits
 * under it, labelled, and never replaces it.
 *
 * Nothing here re-derives a promotion. `isServerReady` is the backend's gate
 * and the only thing that unlocks the pinned contract or a server-fix prompt.
 */
import { useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import {
  isServerReady,
  type ActionableFinding,
  type InsightsFindingProvenance,
} from "@/lib/insights-envelope-api";
import {
  buildFindingPrompt,
  findingOffersPrompt,
  findingPromptLabel,
  type FindingPromptContext,
} from "./finding-prompts";
import {
  FindingEvidenceList,
  type FindingEvidenceLocator,
} from "./finding-evidence";
import {
  basisLabel,
  isInvestigation,
  judgeCoverageLine,
  mechanismCaveat,
  proseSourceOf,
  PROSE_SOURCE_LABEL,
  type FindingView,
  type ProseSource,
} from "./finding-provenance";

/** Ownership badge. The label answers "whose work is this?". */
const OWNER_BADGE: Record<string, { label: string; className: string }> = {
  server_ready: {
    label: "MCP server · ready to fix",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  server_investigate: {
    label: "MCP server · needs investigation",
    className: "border-warning/40 bg-warning/10 text-foreground",
  },
  agent_configuration: {
    label: "Agent / prompt",
    className: "border-info/30 bg-info/10 text-foreground",
  },
  eval_case: {
    label: "Test design",
    className: "border-border/60 bg-muted/50 text-muted-foreground",
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

function ownerKey(finding: ActionableFinding): string {
  if (isServerReady(finding)) return "server_ready";
  if (finding.actionTarget === "mcp_server") return "server_investigate";
  if (finding.actionability === "informational") return "environment";
  return finding.actionTarget;
}

function SourceTag({ source }: { source: ProseSource }) {
  return (
    <span
      className={cn(
        "rounded border px-1 py-0 text-[10px] font-medium",
        source === "ai"
          ? "border-info/40 bg-info/10 text-foreground"
          : "border-border/60 bg-muted/40 text-muted-foreground",
      )}
      data-testid="finding-prose-source"
      data-source={source}
    >
      {PROSE_SOURCE_LABEL[source]}
    </span>
  );
}

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
      className="inline-flex shrink-0 items-center gap-1 rounded border border-border/60 px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      {copied ? "Copied" : findingPromptLabel(finding)}
    </button>
  );
}

export function FindingSummary({
  finding,
  provenance,
  view,
  lead = false,
  context,
  onOpenEvidence,
}: {
  finding: ActionableFinding;
  provenance: InsightsFindingProvenance | null;
  view: FindingView;
  /** The lead finding renders open, with its evidence already expanded. */
  lead?: boolean;
  context?: FindingPromptContext;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
}) {
  const [open, setOpen] = useState(lead);
  const owner = OWNER_BADGE[ownerKey(finding)] ?? OWNER_BADGE.investigate;
  const basis = basisLabel(provenance);
  const caveat = mechanismCaveat(provenance);
  const judgeCoverage = judgeCoverageLine(provenance);
  const investigation = isInvestigation(finding);
  const titleSource = proseSourceOf(view, provenance, "title");
  const causeSource = proseSourceOf(view, provenance, "rootCause");
  const nextSource = proseSourceOf(view, provenance, "recommendation");
  const criteriaSource = proseSourceOf(view, provenance, "acceptanceCriteria");

  return (
    <article
      className={cn(
        "rounded-lg border bg-card",
        lead ? "border-border" : "border-border/60",
      )}
      data-testid={lead ? "unified-finding-lead" : "unified-finding"}
      data-action-target={finding.actionTarget}
      data-actionability={finding.actionability}
      data-finding-id={finding.id}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3.5">
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 text-[11px] font-medium",
            owner.className,
          )}
          data-testid="unified-finding-owner"
        >
          {owner.label}
        </span>
        {basis ? (
          <span
            className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title={basis.detail}
            data-testid="unified-finding-basis"
            data-basis={provenance?.basis}
          >
            {basis.label}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {finding.affected.count} of {finding.affected.total}{" "}
          {finding.affected.unit}
        </span>
      </div>

      {/* 1. What happened — the deterministic sentence, never model prose. */}
      <p
        className="px-4 pt-2 text-[13.5px] font-medium leading-relaxed text-foreground"
        data-testid="unified-finding-observed"
      >
        {finding.observed}
      </p>

      {caveat ? (
        <p
          className="px-4 pt-1 text-[12px] leading-relaxed text-muted-foreground"
          data-testid="unified-finding-caveat"
        >
          {caveat}
        </p>
      ) : null}
      {judgeCoverage ? (
        <p
          className="px-4 pt-1 text-[12px] text-muted-foreground"
          data-testid="unified-finding-judge-coverage"
        >
          {judgeCoverage}
        </p>
      ) : null}

      {/* The headline a model proposed, clearly secondary to the observation
          and clearly labelled.
          Suppressed entirely in the deterministic view: there, the finalizer
          sets the title to the observation CLAMPED to 120 characters, so a
          long observation produced a truncated echo of the sentence directly
          above it — the same claim twice, the second copy cut off mid-word. */}
      {view === "ai" && finding.title && finding.title !== finding.observed ? (
        <p
          className="flex flex-wrap items-baseline gap-2 px-4 pt-2 text-[12.5px] text-muted-foreground"
          data-testid="unified-finding-title"
        >
          <SourceTag source={titleSource} />
          <span>{finding.title}</span>
        </p>
      ) : null}

      <div className="px-4 pb-3 pt-2.5">
        <button
          type="button"
          className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          data-testid="unified-finding-toggle"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
          {open ? "Hide the evidence and next step" : "What supports this?"}
        </button>
      </div>

      {open ? (
        <div
          className="space-y-3 border-t border-border/50 bg-muted/20 px-4 py-3"
          data-testid="unified-finding-detail"
        >
          {/* 2. What supports that? */}
          <section>
            <h5 className="text-[12px] font-semibold text-foreground/80">
              Evidence
            </h5>
            <div className="mt-1.5">
              <FindingEvidenceList
                evidence={finding.evidence}
                {...(onOpenEvidence ? { onOpenEvidence } : {})}
              />
            </div>
          </section>

          {finding.rootCause ? (
            <section>
              <h5 className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-foreground/80">
                Proposed cause
                <SourceTag source={causeSource} />
              </h5>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                {finding.rootCause}
              </p>
            </section>
          ) : null}

          {/* 3. What should I do next? The heading says which kind of work
              this is; an unproven mechanism never reads as "change this". */}
          <section>
            <h5 className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-foreground/80">
              {investigation ? "What to investigate" : "What to change"}
              <SourceTag source={nextSource} />
            </h5>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
              {finding.recommendation}
            </p>
          </section>

          {finding.acceptanceCriteria.length > 0 ? (
            <section>
              <h5 className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-foreground/80">
                {investigation ? "Resolved when" : "Done when"}
                <SourceTag source={criteriaSource} />
              </h5>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-muted-foreground">
                {finding.acceptanceCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* The pinned contract, only for a promoted finding: on an unproven
              one it reads as "here is the code to change". */}
          {isServerReady(finding) && finding.target ? (
            <section
              className="rounded-md border border-border/50 bg-background/70 p-2.5"
              data-testid="unified-finding-contract"
            >
              <h5 className="font-code text-[11px] text-foreground/80">
                {finding.target.toolName
                  ? `${finding.target.toolName} · ${finding.target.surface}`
                  : finding.target.surface}
                {finding.target.fieldPath
                  ? ` · ${finding.target.fieldPath}`
                  : ""}
              </h5>
              {finding.target.currentDefinition?.description ? (
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {finding.target.currentDefinition.description}
                </p>
              ) : null}
              {finding.target.currentDefinition?.inputSchemaJson ? (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-code text-[11px] text-muted-foreground">
                  {finding.target.currentDefinition.inputSchemaJson}
                </pre>
              ) : null}
              {finding.target.currentDefinition?.outputSchemaJson ? (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-code text-[11px] text-muted-foreground">
                  {finding.target.currentDefinition.outputSchemaJson}
                </pre>
              ) : null}
              <p className="mt-1 font-code text-[10px] text-muted-foreground/70">
                snapshot {finding.target.snapshotHash}
              </p>
            </section>
          ) : null}

          <CopyPromptButton
            finding={finding}
            {...(context ? { context } : {})}
          />
        </div>
      ) : null}
    </article>
  );
}
