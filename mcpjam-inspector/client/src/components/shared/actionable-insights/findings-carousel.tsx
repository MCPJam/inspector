/**
 * Every finding as a FindingSummary slide. Details (iterations + evidence)
 * open from See details.
 */
import { useEffect, useState, type Ref, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
} from "@/components/ui/carousel";
import type {
  ActionableFinding,
  InsightsFindingProvenance,
} from "@/lib/insights-envelope-api";
import type { FindingPromptContext } from "./finding-prompts";
import {
  FindingDetailsContent,
  FindingSummary,
  findingTargetLabel,
} from "./finding-summary";
import type { FindingEvidenceLocator } from "./finding-evidence";
import type { AffectedIterationRow } from "./affected-iterations-list";
import type { FindingView } from "./finding-provenance";

export function useFindingsCarousel() {
  const [api, setApi] = useState<CarouselApi>();
  const [selected, setSelected] = useState(0);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  useEffect(() => {
    if (!api) return;
    const sync = () => {
      setSelected(api.selectedScrollSnap());
      setCanPrev(api.canScrollPrev());
      setCanNext(api.canScrollNext());
    };
    sync();
    api.on("select", sync);
    api.on("reInit", sync);
    return () => {
      api.off("select", sync);
      api.off("reInit", sync);
    };
  }, [api]);

  return {
    setApi,
    selected,
    canPrev,
    canNext,
    scrollPrev: () => api?.scrollPrev(),
    scrollNext: () => api?.scrollNext(),
  };
}

export function FindingsPager({
  selected,
  count,
  canPrev,
  canNext,
  onPrev,
  onNext,
  onSeeAll,
  seeAllRef,
}: {
  selected: number;
  count: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSeeAll?: () => void;
  seeAllRef?: Ref<HTMLButtonElement>;
}) {
  if (count <= 1) return null;
  return (
    <div className="flex items-center gap-2">
      <span
        className="text-xs tabular-nums text-muted-foreground"
        data-testid="unified-findings-carousel-index"
        aria-live="polite"
      >
        {selected + 1} of {count}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-11"
        disabled={!canPrev}
        onClick={onPrev}
        aria-label="Previous finding"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-11"
        disabled={!canNext}
        onClick={onNext}
        aria-label="Next finding"
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </Button>
      {onSeeAll ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 px-3"
          onClick={onSeeAll}
          ref={seeAllRef}
          data-testid="unified-findings-see-all"
        >
          See all
        </Button>
      ) : null}
    </div>
  );
}

export function FindingsAllSheet({
  open,
  onOpenChange,
  findings,
  provenanceById,
  view,
  onOpenEvidence,
  iterationRows,
  findingsById,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  findings: readonly ActionableFinding[];
  provenanceById: ReadonlyMap<string, InsightsFindingProvenance>;
  view: FindingView;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  iterationRows?: Record<string, AffectedIterationRow>;
  findingsById?: ReadonlyMap<string, ActionableFinding>;
  trigger: RefObject<HTMLElement | null>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    findings.find((finding) => finding.id === selectedId) ?? null;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelectedId(null);
        onOpenChange(next);
      }}
    >
      <SheetContent
        className="w-full gap-0 overflow-y-auto sm:max-w-[620px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
      >
        <SheetHeader className="sticky top-0 z-10 bg-background px-6 pt-6 pb-5 pr-12">
          {selected ? (
            <>
              <button
                type="button"
                className="mb-3 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-foreground hover:underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4"
                onClick={() => setSelectedId(null)}
                data-testid="unified-findings-all-back"
              >
                <ChevronLeft className="size-3.5" aria-hidden="true" />
                All findings
              </button>
              <SheetTitle className="text-lg">Finding details</SheetTitle>
              <SheetDescription>
                {findingTargetLabel(selected) ?? selected.title}
              </SheetDescription>
            </>
          ) : (
            <>
              <SheetTitle className="text-lg">All findings</SheetTitle>
              <SheetDescription>
                {findings.length} findings. Open one for iterations and
                evidence.
              </SheetDescription>
            </>
          )}
        </SheetHeader>
        {selected ? (
          <FindingDetailsContent
            finding={selected}
            provenance={provenanceById.get(selected.id) ?? null}
            view={view}
            iterationRows={iterationRows}
            findingsById={findingsById}
            onOpenEvidence={
              onOpenEvidence
                ? (locator) => {
                    setSelectedId(null);
                    onOpenChange(false);
                    onOpenEvidence(locator);
                  }
                : undefined
            }
          />
        ) : (
          <div className="px-6 pb-8" data-testid="unified-findings-all-list">
            <div className="overflow-x-auto rounded-lg border border-border">
              <div className="min-w-[420px]">
                <div
                  className="grid grid-cols-[48px_minmax(0,1fr)_72px] items-center gap-2 bg-muted px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground"
                  aria-hidden="true"
                >
                  <span>#</span>
                  <span>Finding</span>
                  <span>Affected</span>
                </div>
                {findings.map((finding, index) => (
                  <button
                    key={finding.id}
                    type="button"
                    className="grid w-full grid-cols-[48px_minmax(0,1fr)_72px] items-center gap-2 border-t border-border px-3 py-2.5 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`Open finding ${index + 1} of ${
                      findings.length
                    }`}
                    onClick={() => setSelectedId(finding.id)}
                    data-testid="unified-findings-all-preview"
                    data-finding-id={finding.id}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={`size-1.5 shrink-0 rounded-full ${
                          finding.severity === "high"
                            ? "bg-destructive"
                            : finding.severity === "medium"
                            ? "bg-warning"
                            : "bg-muted-foreground"
                        }`}
                      />
                      <span className="text-[13px] font-medium tabular-nums text-card-foreground">
                        {index + 1}
                      </span>
                    </span>
                    <span className="flex min-w-0 flex-col gap-px">
                      <span className="line-clamp-2 text-[13px] font-medium leading-5 text-card-foreground">
                        {finding.observed}
                      </span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {finding.recommendation}
                      </span>
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {finding.affected.count}/{finding.affected.total}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function FindingsCarousel({
  findings,
  provenanceById,
  view,
  context,
  onOpenEvidence,
  iterationRows,
  findingsById,
  setApi,
}: {
  findings: readonly ActionableFinding[];
  provenanceById: ReadonlyMap<string, InsightsFindingProvenance>;
  view: FindingView;
  context?: FindingPromptContext;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
  iterationRows?: Record<string, AffectedIterationRow>;
  findingsById?: ReadonlyMap<string, ActionableFinding>;
  setApi?: (api: CarouselApi) => void;
}) {
  const count = findings.length;
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <div data-testid="unified-findings-carousel">
      <Carousel
        opts={{
          align: "start",
          containScroll: "trimSnaps",
          duration: reducedMotion ? 0 : 20,
        }}
        setApi={setApi}
        className="w-full"
        aria-label="Findings"
      >
        <CarouselContent>
          {findings.map((finding, index) => (
            <CarouselItem
              key={finding.id}
              aria-label={`Finding ${index + 1} of ${count}`}
            >
              <FindingSummary
                finding={finding}
                provenance={provenanceById.get(finding.id) ?? null}
                view={view}
                lead={index === 0}
                showCopy={false}
                context={context}
                onOpenEvidence={onOpenEvidence}
                iterationRows={iterationRows}
                findingsById={findingsById}
              />
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>
    </div>
  );
}
