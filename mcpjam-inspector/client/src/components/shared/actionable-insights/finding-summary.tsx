import {
  USER_VALUE_STAGE_LABELS,
  STAGE_REASON_CHIP_LABELS,
} from "@mcpjam/sdk/contract";
/** A finding's problem and suggested fix, with recorded evidence one click away. */
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
import {
  FindingEvidenceList,
  type FindingEvidenceLocator,
} from "./finding-evidence";
import {
  AffectedIterationsList,
  type AffectedIterationRow,
} from "./affected-iterations-list";
import {
  basisLabel,
  judgeCoverageLine,
  mechanismCaveat,
  proseSourceOf,
  PROSE_SOURCE_LABEL,
  type FindingView,
} from "./finding-provenance";

/** Limited inline formatting; recorded/model text never becomes HTML or links. */
function FindingText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith("`") ? (
          <code
            key={i}
            className="rounded bg-muted px-1 font-code text-[0.85em]"
          >
            {part.slice(1, -1)}
          </code>
        ) : part.startsWith("**") ? (
          <strong key={i} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        ) : (
          part
        ),
      )}
    </>
  );
}

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

export function FindingSummary({
  finding,
  provenance,
  view,
  lead = false,
  context,
  onOpenEvidence,
  iterationRows = {},
}: {
  finding: ActionableFinding;
  provenance: InsightsFindingProvenance | null;
  view: FindingView;
  lead?: boolean;
  context?: FindingPromptContext;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  /** Recorded iterations by id, for the affected list. */
  iterationRows?: Record<string, AffectedIterationRow>;
}) {
  const [drawer, setDrawer] = useState<"why" | null>(null);
  const drawerTrigger = useRef<HTMLButtonElement | null>(null);
  const discovered = view === "ai" && provenance?.groupKind === "ai_discovery";
  const aiTitle =
    view === "ai" &&
    (discovered || proseSourceOf(view, provenance, "title") === "ai");
  const aiFix = proseSourceOf(view, provenance, "recommendation") === "ai";
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
  const evidence = finding.evidence.filter((e) => e.kind !== "contrast");
  const contrasts = finding.evidence.filter((e) => e.kind === "contrast");
  const judgeCoverage = judgeCoverageLine(provenance);
  const caveat = mechanismCaveat(provenance);
  const target = finding.target;
  const targetLabel = target
    ? [SURFACES[target.surface], target.toolName, target.fieldPath]
        .filter(Boolean)
        .join(" · ")
    : finding.actionTarget === "investigate"
      ? null
      : OWNERS[finding.actionTarget];
  const openEvidence = onOpenEvidence
    ? (locator: FindingEvidenceLocator) => {
        drawerTrigger.current = null;
        setDrawer(null);
        onOpenEvidence(locator);
      }
    : undefined;

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
          <div className="flex items-center justify-between gap-4">
            <h4 className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              What broke
            </h4>
            <span
              className="text-right text-xs text-muted-foreground"
              data-testid="unified-finding-basis"
              data-basis={provenance?.basis}
            >
              {basisLabel(provenance)?.label ?? "Unattributed"}
            </span>
          </div>
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
          <p
            className="mt-3 text-xs text-muted-foreground"
            data-testid="unified-finding-origin"
          >
            {provenance?.stage && USER_VALUE_STAGE_LABELS[provenance.stage]
              ? `${USER_VALUE_STAGE_LABELS[provenance.stage]}${
                  provenance.reason &&
                  STAGE_REASON_CHIP_LABELS[provenance.reason]
                    ? ` · ${STAGE_REASON_CHIP_LABELS[provenance.reason]}`
                    : ""
                }`
              : finding.category.replace(/_/g, " ")}
          </p>
        </section>
        <section className="min-w-0 border-t border-border/60 pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-7">
          <div className="flex items-center justify-between gap-4">
            <h4 className="flex items-center gap-2 text-sm font-semibold">
              <Wrench
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              How to fix
            </h4>
            <span
              className="text-xs text-muted-foreground"
              data-testid="finding-prose-source"
              data-source={
                aiFix ? "ai" : proseSourceOf(view, provenance, "recommendation")
              }
            >
              {aiFix
                ? PROSE_SOURCE_LABEL.ai
                : view === "deterministic" ||
                    proseSourceOf(view, provenance, "recommendation") ===
                      "deterministic"
                  ? PROSE_SOURCE_LABEL.deterministic
                  : PROSE_SOURCE_LABEL.unknown}
            </span>
          </div>
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
            <button
              type="button"
              className={linkClass}
              onClick={(event) => {
                drawerTrigger.current = event.currentTarget;
                setDrawer("why");
              }}
              data-testid="unified-finding-toggle"
            >
              Why this fix?
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </button>
            {!lead ? (
              <CopyFindingPrompt finding={finding} context={context} />
            ) : null}
          </div>
        </section>
      </div>
      <div className="mt-4 border-t border-border/50 pt-3">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {finding.affected.count === 1
            ? "Affected iteration"
            : `Affected iterations · ${finding.affected.count} of ${finding.affected.total}`}
        </p>
        <AffectedIterationsList
          rows={affectedRows}
          total={finding.affected.count}
          ariaLabel="Affected iterations"
          {...(openEvidence
            ? {
                onOpen: (id: string) => openEvidence({ kind: "iteration", id }),
              }
            : {})}
        />
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
            <SheetTitle className="text-lg">Why this fix?</SheetTitle>
            <SheetDescription>{targetLabel ?? finding.title}</SheetDescription>
          </SheetHeader>
          <div
            className="space-y-6 px-6 pb-8 text-sm leading-relaxed"
            data-testid="unified-finding-detail"
          >
            <section>
              <h5 className="mb-3 font-semibold">Recorded evidence</h5>
              <FindingEvidenceList
                evidence={evidence}
                onOpenEvidence={openEvidence}
                variant="drawer"
              />
            </section>
            {contrasts.length > 0 ? (
              <section className="border-t border-border/60 pt-5">
                <h5 className="mb-3 font-semibold">Successful comparison</h5>
                <FindingEvidenceList
                  evidence={contrasts}
                  onOpenEvidence={openEvidence}
                  variant="drawer"
                />
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
            <div className="space-y-2 border-l-2 border-border pl-3 text-xs text-muted-foreground">
              <p>{finding.observed}</p>
              {provenance?.proseOrigin?.observed === "ai" && (
                <p>Wording by AI from cited evidence.</p>
              )}
              {view === "ai" ? (
                <p>
                  Suggested cause, not proven. Rerun the affected iterations to
                  test the change.
                </p>
              ) : null}
              {caveat ? (
                <p data-testid="unified-finding-caveat">{caveat}</p>
              ) : null}
              {judgeCoverage ? (
                <p data-testid="unified-finding-judge-coverage">
                  {judgeCoverage}. Ungraded iterations are not counted as
                  passing this judge.
                </p>
              ) : null}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </article>
  );
}
