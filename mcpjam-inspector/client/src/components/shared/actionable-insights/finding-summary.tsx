/** A finding's problem and suggested fix. */
import { useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, Check, Copy, Wrench } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
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
import { type FindingEvidenceLocator } from "./finding-evidence";
import {
  AffectedIterationsList,
  type AffectedIterationRow,
} from "./affected-iterations-list";
import { FindingText } from "./finding-text";
import {
  judgeCoverageLine,
  mechanismCaveat,
  proseSourceOf,
  type FindingView,
  verificationLine,
  recurrenceLine,
} from "./finding-provenance";

export function CopyFindingPrompt({
  finding,
  context,
}: {
  finding: ActionableFinding;
  context?: FindingPromptContext;
}) {
  const [copied, setCopied] = useState(false);
  if (!findingOffersPrompt(finding)) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-9 shadow-none"
      title={findingPromptLabel(finding)}
      data-testid="finding-copy-prompt"
      data-server-fix={isServerReady(finding) ? "true" : "false"}
      onClick={() => {
        void copyToClipboard(buildFindingPrompt(finding, context)).then(
          (ok) => {
            if (ok) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          },
        );
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy fix prompt"}
    </Button>
  );
}

const SURFACES: Record<string, string> = {
  description: "Tool description",
  input_schema: "Input schema",
  output_schema: "Output schema",
  handler: "Tool handler",
  server_instructions: "Server instructions",
  capability: "Server capability",
};
const OWNERS: Record<string, string> = {
  mcp_server: "MCP server",
  agent_configuration: "Agent / prompt",
  eval_case: "Test design",
  environment: "Environment",
  investigate: "Investigation",
};
const linkClass =
  "inline-flex min-h-9 items-center gap-1 text-xs font-medium text-foreground hover:underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4";

function FindingDetailsLink({
  onOpen,
}: {
  onOpen: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={linkClass}
      onClick={onOpen}
      data-testid="unified-finding-toggle"
    >
      See details
      <ArrowUpRight className="size-3.5" aria-hidden="true" />
    </button>
  );
}

export function findingTargetLabel(finding: ActionableFinding): string | null {
  const target = finding.target;
  if (target) {
    return [SURFACES[target.surface], target.toolName, target.fieldPath]
      .filter(Boolean)
      .join(" · ");
  }
  return finding.actionTarget === "investigate"
    ? null
    : OWNERS[finding.actionTarget] ?? null;
}

export function FindingDetailsContent({
  finding,
  provenance,
  view,
  iterationRows = {},
  onOpenEvidence,
  findingsById,
}: {
  finding: ActionableFinding;
  provenance: InsightsFindingProvenance | null;
  view: FindingView;
  iterationRows?: Record<string, AffectedIterationRow>;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  /** Every finding in the envelope by id, so a consolidated finding can name
   * the measured groups it was built from. */
  findingsById?: ReadonlyMap<string, ActionableFinding>;
}) {
  const sourceIds = provenance?.sourceCandidateIds ?? [];
  const sources = sourceIds
    .map((id) => findingsById?.get(id))
    .filter((source): source is ActionableFinding => source !== undefined);
  const affectedIds = [
    ...new Set(
      provenance?.affectedIterationIds ??
        finding.evidence
          .filter((e) => e.kind !== "contrast" && e.iterationId)
          .map((e) => e.iterationId!),
    ),
  ];
  const affectedRows: AffectedIterationRow[] = affectedIds.map(
    (id) =>
      iterationRows[id] ?? {
        iterationId: id,
        caseTitle: "Iteration not loaded on this page",
        iterationNumber: null,
        client: null,
        model: null,
        result: "unknown",
        canOpen: false,
      },
  );
  const judgeCoverage = judgeCoverageLine(provenance);
  const caveat = mechanismCaveat(provenance);
  const verification = verificationLine(provenance);
  const recurrence = view === "ai" ? recurrenceLine(provenance) : null;
  const aiWording = provenance?.proseOrigin?.observed === "ai";
  const aiUnproven = view === "ai";
  const notes =
    aiWording ||
    aiUnproven ||
    Boolean(caveat) ||
    Boolean(judgeCoverage) ||
    Boolean(verification) ||
    Boolean(recurrence);
  const target = finding.target;
  const targetLabel = findingTargetLabel(finding);
  const discovered = view === "ai" && provenance?.groupKind === "ai_discovery";
  const aiTitle =
    view === "ai" &&
    (discovered || proseSourceOf(view, provenance, "title") === "ai");
  return (
    <div
      className="space-y-6 px-6 pb-8 text-sm leading-relaxed"
      data-testid="unified-finding-detail"
    >
      <section>
        <h5 className="mb-3 font-semibold">What broke</h5>
        <p className="break-words text-[15px] leading-7">
          {aiTitle && finding.title !== finding.observed ? (
            <>
              <strong className="font-semibold">
                <FindingText text={finding.title} />
              </strong>
              {/[.!?]$/.test(finding.title) ? " " : ". "}
            </>
          ) : null}
          <FindingText text={finding.observed} />
        </p>
      </section>
      <section className="border-t border-border/60 pt-5">
        <h5 className="mb-3 font-semibold">How to fix</h5>
        <p className="break-words text-[15px] leading-7">
          <FindingText text={finding.recommendation} />
        </p>
        {targetLabel ? (
          <p className="mt-3 break-words text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {finding.actionability === "ready" ? "Change" : "Investigate"}:
            </span>{" "}
            {targetLabel}
          </p>
        ) : null}
      </section>
      <section className="border-t border-border/60 pt-5">
        <h5 className="mb-3 font-semibold">
          {finding.affected.count === 1
            ? "Affected iteration"
            : `Affected iterations · ${finding.affected.count} of ${finding.affected.total}`}
        </h5>
        <AffectedIterationsList
          rows={affectedRows}
          total={finding.affected.count}
          ariaLabel="Affected iterations"
          {...(onOpenEvidence
            ? {
                onOpen: (id: string) =>
                  onOpenEvidence({ kind: "iteration", id }),
              }
            : {})}
        />
      </section>
      {sourceIds.length > 0 ? (
        <section
          className="border-t border-border/60 pt-5"
          data-testid="unified-finding-sources"
        >
          <h5 className="font-semibold">
            Consolidated from {sourceIds.length} error groups
          </h5>
          <p className="mt-1 text-xs text-muted-foreground">
            These recorded groups were judged to share one cause; every trial
            counted above was verified under the combined explanation.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {sources.map((source) => (
              <li key={source.id}>
                <FindingText text={source.observed} />
              </li>
            ))}
            {sources.length < sourceIds.length ? (
              <li className="text-muted-foreground">
                {sourceIds.length - sources.length} not shown in this view
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
      {finding.rootCause ? (
        <section className="border-t border-border/60 pt-5">
          <h5 className="font-semibold">Why this change?</h5>
          <p className="mt-2">
            <FindingText
              text={
                finding.rootCause === "agent_or_prompt"
                  ? "Agent or prompt behavior needs investigation."
                  : finding.rootCause
              }
            />
          </p>
        </section>
      ) : null}
      {finding.acceptanceCriteria.length > 0 ? (
        <section className="border-t border-border/60 pt-5">
          <h5 className="font-semibold">How to verify</h5>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {finding.acceptanceCriteria.map((c) => (
              <li key={c}>
                <FindingText text={c} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {isServerReady(finding) && target?.currentDefinition ? (
        <section
          className="border-t border-border/60 pt-5"
          data-testid="unified-finding-contract"
        >
          <h5 className="font-semibold">Recorded tool definition</h5>
          {target.currentDefinition.description ? (
            <p className="mt-2">{target.currentDefinition.description}</p>
          ) : null}
          {[
            target.currentDefinition.inputSchemaJson,
            target.currentDefinition.outputSchemaJson,
          ]
            .filter(Boolean)
            .map((json, i) => (
              <pre
                key={i}
                className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--code-bg)] p-3 font-code text-xs text-[var(--code-text)]"
              >
                {json}
              </pre>
            ))}
        </section>
      ) : null}
      {notes ? (
        <div className="space-y-2 border-l-2 border-border pl-3 text-xs text-muted-foreground">
          {aiWording ? <p>Wording by AI from cited evidence.</p> : null}
          {aiUnproven ? (
            <p>
              Suggested cause, not proven. Rerun the affected iterations to test
              the change.
            </p>
          ) : null}
          {caveat ? <p data-testid="unified-finding-caveat">{caveat}</p> : null}
          {recurrence ? (
            <p data-testid="unified-finding-recurrence">{recurrence}</p>
          ) : null}
          {verification ? (
            <p data-testid="unified-finding-verification">{verification}</p>
          ) : null}
          {judgeCoverage ? (
            <p data-testid="unified-finding-judge-coverage">
              {judgeCoverage}. Ungraded iterations are not counted as passing
              this judge.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FindingSummary({
  finding,
  provenance,
  view,
  lead = false,
  showCopy = !lead,
  context,
  onOpenEvidence,
  iterationRows = {},
  findingsById,
}: {
  finding: ActionableFinding;
  provenance: InsightsFindingProvenance | null;
  view: FindingView;
  lead?: boolean;
  /** Header Copy tracks the current slide; slides omit their own button. */
  showCopy?: boolean;
  context?: FindingPromptContext;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  /** Recorded iterations by id, for the affected list. */
  iterationRows?: Record<string, AffectedIterationRow>;
  findingsById?: ReadonlyMap<string, ActionableFinding>;
}) {
  const [drawer, setDrawer] = useState<"why" | null>(null);
  const drawerTrigger = useRef<HTMLButtonElement | null>(null);
  const discovered = view === "ai" && provenance?.groupKind === "ai_discovery";
  const aiTitle =
    view === "ai" &&
    (discovered || proseSourceOf(view, provenance, "title") === "ai");
  const targetLabel = findingTargetLabel(finding);
  const openEvidence = onOpenEvidence
    ? (locator: FindingEvidenceLocator) => {
        drawerTrigger.current = null;
        setDrawer(null);
        onOpenEvidence(locator);
      }
    : undefined;
  const openWhy = (event: React.MouseEvent<HTMLButtonElement>) => {
    drawerTrigger.current = event.currentTarget;
    setDrawer("why");
  };

  return (
    <article
      data-testid={lead ? "unified-finding-lead" : "unified-finding"}
      data-finding-id={finding.id}
      data-action-target={finding.actionTarget}
      data-actionability={finding.actionability}
    >
      <div
        className="grid grid-cols-1 md:grid-cols-2"
        aria-label={lead ? "Primary finding" : "Additional finding"}
      >
        <section className="min-w-0 pb-5 md:pr-7 md:pb-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            What broke
          </h4>
          <p
            className="mt-3 break-words text-[15px] leading-7 md:min-h-20"
            data-testid="unified-finding-observed"
          >
            {aiTitle && finding.title !== finding.observed ? (
              <>
                <strong
                  className="font-semibold"
                  data-testid={
                    discovered
                      ? "unified-finding-discovered-title"
                      : "unified-finding-title"
                  }
                >
                  <FindingText text={finding.title} />
                </strong>
                {/[.!?]$/.test(finding.title) ? " " : ". "}
              </>
            ) : null}
            <FindingText text={finding.observed} />
          </p>
        </section>
        <section className="min-w-0 border-t border-border/60 pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-7">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <Wrench
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            How to fix
          </h4>
          <p className="mt-3 break-words text-[15px] leading-7 md:min-h-20">
            <FindingText text={finding.recommendation} />
          </p>
          {targetLabel ? (
            <p className="mt-3 break-words text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {finding.actionability === "ready" ? "Change" : "Investigate"}:
              </span>{" "}
              {targetLabel}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <FindingDetailsLink onOpen={openWhy} />
            {showCopy ? (
              <CopyFindingPrompt finding={finding} context={context} />
            ) : null}
          </div>
        </section>
      </div>
      <Sheet
        open={drawer !== null}
        onOpenChange={(open) => {
          if (!open) setDrawer(null);
        }}
      >
        <SheetContent
          className="w-full gap-0 overflow-y-auto sm:max-w-[620px]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            drawerTrigger.current?.focus();
          }}
        >
          <SheetHeader className="sticky top-0 z-10 bg-background px-6 pt-6 pb-5 pr-12">
            <SheetTitle className="text-lg">Finding details</SheetTitle>
            <SheetDescription>{targetLabel ?? finding.title}</SheetDescription>
          </SheetHeader>
          <FindingDetailsContent
            finding={finding}
            provenance={provenance}
            view={view}
            iterationRows={iterationRows}
            onOpenEvidence={openEvidence}
            findingsById={findingsById}
          />
        </SheetContent>
      </Sheet>
    </article>
  );
}
