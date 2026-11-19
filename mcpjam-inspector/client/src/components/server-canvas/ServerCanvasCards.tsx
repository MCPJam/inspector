import { Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { FeatureCountsBar, FeatureCountsText } from "./FeatureCounts";
import { FeatureFamilyGroup } from "./FeatureRows";
import type { CardModel } from "./feature-tree";

export interface FeatureCardHandlers {
  isExpanded: (familyId: string) => boolean;
  selectedId: string | null;
  onActivateFamily: (familyId: string) => void;
  onSelect: (featureId: string) => void;
  onOpenRun?: (runId: string) => void;
}

/** One spec section: its counts, a count-split bar and its families. */
export function ServerFeatureCard({
  card,
  handlers,
  className,
}: {
  card: CardModel;
  handlers: FeatureCardHandlers;
  className?: string;
}) {
  const headingId = `feature-card-${card.id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-card={card.id}
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground",
        className,
      )}
    >
      <header className="flex flex-col gap-1.5">
        <h3 id={headingId} className="text-[14.5px] font-semibold">
          {card.name}
        </h3>
        <FeatureCountsText counts={card.counts} />
        <FeatureCountsBar counts={card.counts} />
      </header>
      <div className="flex flex-col gap-0.5">
        {card.families.map((family) => (
          <FeatureFamilyGroup
            key={family.family.id}
            model={family}
            expanded={handlers.isExpanded(family.family.id)}
            selectedId={handlers.selectedId}
            onActivate={handlers.onActivateFamily}
            onSelect={handlers.onSelect}
            onOpenRun={handlers.onOpenRun}
          />
        ))}
      </div>
    </section>
  );
}

export interface ServerRootSummary {
  name: string;
  version?: string;
  protocolVersion?: string;
  /** Leaf features in the catalog. */
  featureCount: number;
}

/** The canvas root: which server, and what the counts below describe. */
export function ServerRootCard({ summary }: { summary: ServerRootSummary }) {
  const details = [
    summary.version ? `v${summary.version}` : null,
    summary.protocolVersion,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-4 py-3.5 text-card-foreground">
      <div className="flex items-center gap-2">
        <Server aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-[16px] font-semibold">{summary.name}</span>
      </div>
      {details.length > 0 ? (
        <span className="font-mono text-xs text-muted-foreground">
          {details.join(" · ")}
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {summary.featureCount} features · scoped to this client and account
      </span>
    </div>
  );
}
