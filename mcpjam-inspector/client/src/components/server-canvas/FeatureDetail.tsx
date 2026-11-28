import type { ReactNode } from "react";
import { ExternalLink, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import type {
  FeatureAssessment,
  FeatureDefinition,
  FeatureEvidence,
  FeatureNextAction,
} from "@mcpjam/sdk/browser";
import { cn } from "@/lib/utils";
import { FeatureCountsBar, FeatureCountsText } from "./FeatureCounts";
import { FeatureRow } from "./FeatureRows";
import {
  FEATURE_STATE_META,
  MARKER_LABELS,
  NEXT_ACTION_LABELS,
  OWNER_LABELS,
  SOURCE_LABELS,
  formatEvidenceTime,
  needsNewerCause,
  rowStateLabels,
  type NeedsNewerCause,
} from "./feature-states";
import type { FamilyModel, FeatureSelection } from "./feature-tree";

const OUTCOME_LABELS: Record<FeatureEvidence["outcome"], string> = {
  present: "Found",
  absent: "Not found",
  failed: "Failed",
  unknown: "Unclear",
  "not-applicable": "Not applicable",
};

const SERVER_SIDE = new Set(["server", "authorization-server"]);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      <div className="text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

function EvidenceItem({
  evidence,
  onOpenRun,
}: {
  evidence: FeatureEvidence;
  onOpenRun?: (runId: string) => void;
}) {
  const runId = evidence.ref?.runId;
  const count =
    evidence.count === undefined
      ? null
      : evidence.source === "observed"
        ? `Seen ${evidence.count} ${evidence.count === 1 ? "time" : "times"}`
        : `${evidence.count} found`;
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">{SOURCE_LABELS[evidence.source]}</Badge>
        <span className="font-medium text-foreground">
          {OUTCOME_LABELS[evidence.outcome]}
        </span>
        {evidence.capturedAt ? (
          <span className="text-muted-foreground">
            {formatEvidenceTime(evidence.capturedAt)}
          </span>
        ) : null}
      </div>
      {/* A rule's detail already states its count when it has one. */}
      {evidence.detail ? (
        <p className="text-sm">{evidence.detail}</p>
      ) : count ? (
        <p className="text-xs">{count}</p>
      ) : null}
      {runId && onOpenRun ? (
        <button
          type="button"
          onClick={() => onOpenRun(runId)}
          className="inline-flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Open run <ExternalLink aria-hidden className="size-3" />
        </button>
      ) : null}
    </li>
  );
}

function DetailHeader({
  eyebrow,
  title,
  onClose,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{eyebrow}</p>
        <h2 className="break-words text-lg font-semibold text-foreground">
          {title}
        </h2>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Close details"
        onClick={onClose}
        className="size-8 shrink-0 text-muted-foreground"
      >
        <X aria-hidden className="size-4" />
      </Button>
    </div>
  );
}

function FeatureBody({
  feature,
  assessment,
  needsNewer,
  onAction,
  onOpenRun,
}: {
  feature: FeatureDefinition;
  assessment: FeatureAssessment;
  needsNewer?: NeedsNewerCause;
  onAction?: (action: FeatureNextAction) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const meta = FEATURE_STATE_META[assessment.state];
  const action = assessment.nextAction;
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline" className={cn(meta.rowClass, "opacity-100")}>
          {rowStateLabels(assessment.state, needsNewer).label}
        </Badge>
        {assessment.markers.map((marker) => (
          <Badge key={marker} variant="secondary">
            {MARKER_LABELS[marker]}
          </Badge>
        ))}
      </div>
      <p className="text-sm text-foreground">{feature.summary}</p>
      <Section title="Who provides it">{OWNER_LABELS[feature.owner]}</Section>
      <Section title="What we saw">
        {assessment.evidence.length === 0 ? (
          <p>No evidence yet for this server.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {assessment.evidence.map((evidence, index) => (
              <EvidenceItem
                key={`${evidence.source}-${index}`}
                evidence={evidence}
                onOpenRun={onOpenRun}
              />
            ))}
          </ul>
        )}
      </Section>
      {assessment.reason ? (
        <Section title="What limits this assessment">{assessment.reason}</Section>
      ) : null}
      <Section
        title={SERVER_SIDE.has(feature.owner) ? "How to add it" : "How to test it"}
      >
        {feature.howTo}
      </Section>
      {action && onAction ? (
        <Button
          type="button"
          size="sm"
          className="w-fit"
          onClick={() => onAction(action)}
        >
          {NEXT_ACTION_LABELS[action]}
        </Button>
      ) : null}
      <a
        href={feature.spec.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1 text-sm text-primary hover:underline"
      >
        Read the specification <ExternalLink aria-hidden className="size-3.5" />
      </a>
      <p className="text-xs text-muted-foreground">
        Pinned to {feature.spec.pin}, checked {feature.spec.checkedAt}.
      </p>
    </>
  );
}

/** The row's cause when the family is known, so a parent matches its row. */
function detailNeedsNewer(
  feature: FeatureDefinition,
  assessment: FeatureAssessment,
  familyModel: FamilyModel | undefined,
): NeedsNewerCause | undefined {
  const row = familyModel?.rows.find((entry) => entry.feature.id === feature.id);
  return row ? row.needsNewer : needsNewerCause(feature, assessment);
}

/**
 * What a selected feature enables, who provides it, what we saw and when,
 * what limits the assessment, how to add or test it, and its spec link. A
 * selected family shows its counts and its features instead.
 */
export function FeatureDetail({
  selection,
  assessment,
  familyModel,
  cardName,
  onClose,
  onSelect,
  onAction,
  onOpenRun,
}: {
  selection: FeatureSelection;
  /** The selected feature's assessment; unused for a family. */
  assessment?: FeatureAssessment;
  /** The selected family, or the selected feature's family. */
  familyModel?: FamilyModel;
  cardName: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onAction?: (action: FeatureNextAction) => void;
  onOpenRun?: (runId: string) => void;
}) {
  return (
    <section
      aria-label="Feature details"
      data-testid="feature-detail"
      className="flex flex-col gap-4 border-b border-border px-5 py-4"
    >
      {selection.kind === "feature" && assessment ? (
        <>
          <DetailHeader
            eyebrow={`${cardName} · ${selection.family.name}`}
            title={selection.feature.name}
            onClose={onClose}
          />
          <FeatureBody
            feature={selection.feature}
            assessment={assessment}
            needsNewer={detailNeedsNewer(selection.feature, assessment, familyModel)}
            onAction={onAction}
            onOpenRun={onOpenRun}
          />
        </>
      ) : (
        <>
          <DetailHeader
            eyebrow={cardName}
            title={selection.family.name}
            onClose={onClose}
          />
          <p className="text-sm text-foreground">{selection.family.summary}</p>
          {familyModel ? (
            <>
              <div className="flex flex-col gap-1.5">
                <FeatureCountsText counts={familyModel.counts} />
                <FeatureCountsBar counts={familyModel.counts} />
              </div>
              <ul className="flex flex-col gap-0.5">
                {familyModel.rows.map((row) => (
                  <FeatureRow
                    key={row.feature.id}
                    row={row}
                    selected={false}
                    onSelect={onSelect}
                    onOpenRun={onOpenRun}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
