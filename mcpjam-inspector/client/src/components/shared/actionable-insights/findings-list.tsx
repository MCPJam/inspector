import { useId, useState, type ReactElement } from "react";
import { Button } from "@mcpjam/design-system/button";
import type {
  ActionableFinding,
  FindingProblem,
  InsightsFindingProvenance,
} from "@/lib/insights-envelope-api";
import { ProblemSummary } from "./problem-summary";
import { FindingSummary } from "./finding-summary";
import type { FindingPromptContext } from "./finding-prompts";
import type { FindingEvidenceLocator } from "./finding-evidence";
import type { AffectedIterationRow } from "./affected-iterations-list";
import type { FindingView } from "./finding-provenance";

const INITIAL_FINDINGS = 5;

function ExpandableFindings({ children }: { children: ReactElement[] }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  return (
    <div>
      <ul
        id={listId}
        aria-label="Findings"
        className="space-y-5 select-text [&>li+li]:border-t [&>li+li]:border-border [&>li+li]:pt-5"
      >
        {expanded ? children : children.slice(0, INITIAL_FINDINGS)}
      </ul>
      {children.length > INITIAL_FINDINGS ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer" : `Show all ${children.length} findings`}
        </Button>
      ) : null}
    </div>
  );
}

export function FindingsList({
  findings,
  provenanceById,
  view,
  context,
  onOpenEvidence,
  iterationRows,
  findingsById,
}: {
  findings: readonly ActionableFinding[];
  provenanceById: ReadonlyMap<string, InsightsFindingProvenance>;
  view: FindingView;
  context?: FindingPromptContext;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  iterationRows?: Record<string, AffectedIterationRow>;
  findingsById?: ReadonlyMap<string, ActionableFinding>;
}) {
  return (
    <ExpandableFindings>
      {findings.map((finding, index) => (
        <li key={finding.id}>
          <FindingSummary
            finding={finding}
            provenance={provenanceById.get(finding.id) ?? null}
            view={view}
            lead={index === 0}
            context={context}
            onOpenEvidence={onOpenEvidence}
            iterationRows={iterationRows}
            findingsById={findingsById}
          />
        </li>
      ))}
    </ExpandableFindings>
  );
}

/** Preserve the backend's problem order. */
export function ProblemsList({
  problems,
  context,
  onOpenEvidence,
  iterationRows,
  caveats,
}: {
  problems: readonly FindingProblem[];
  /** The sampling caveat for each problem, keyed by problem id. */
  caveats?: ReadonlyMap<string, string>;
  context?: FindingPromptContext;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  iterationRows?: Record<string, AffectedIterationRow>;
}) {
  return (
    <ExpandableFindings>
      {problems.map((problem, index) => (
        <li key={problem.id}>
          <ProblemSummary
            problem={problem}
            lead={index === 0}
            context={context}
            onOpenEvidence={onOpenEvidence}
            iterationRows={iterationRows}
            caveat={caveats?.get(problem.id) ?? null}
          />
        </li>
      ))}
    </ExpandableFindings>
  );
}
