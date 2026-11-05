import type { ReactNode } from "react";
import { ChevronRight, Diamond, Flag, Info, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import type {
  EditorAnchor,
  EndOfRunAssertion,
  ExecutionPreviewItem,
  PreviewEndOfRun,
} from "../case-steps/case-steps-model";
import { previewAssertionLabel } from "./test-run-model";

const PROVENANCE_LABEL: Record<EndOfRunAssertion["provenance"], string> = {
  route: "Route",
  suite: "Suite",
  case: "This case",
  snapshot: "Run snapshot",
};

function PerformerDot({ agent }: { agent: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2.5 shrink-0 rounded-full",
        agent ? "bg-primary" : "border border-muted-foreground bg-transparent",
      )}
    />
  );
}

function ProvenanceChip({
  provenance,
}: {
  provenance: EndOfRunAssertion["provenance"];
}) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        provenance === "case"
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground",
      )}
    >
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}

function endOfRunDetail(item: PreviewEndOfRun): string {
  const parts = [
    item.judge.state === "runs"
      ? "Judge runs"
      : item.judge.state === "skipped"
        ? "Judge skipped for this case"
        : "No judge",
    `${item.assertions.length} ${item.assertions.length === 1 ? "assertion" : "assertions"}`,
  ];
  return parts.join(" · ");
}

function ItemLine({ item }: { item: ExecutionPreviewItem }): ReactNode {
  switch (item.kind) {
    case "assertion":
      return (
        <>
          <Diamond aria-hidden className="size-3.5 shrink-0 text-success" />
          <span className="min-w-0 font-medium">
            {previewAssertionLabel(item.step)}
            {item.blocking ? null : (
              <span className="font-normal text-muted-foreground">
                {" "}
                · advisory
              </span>
            )}
          </span>
        </>
      );
    case "outcome":
      return (
        <>
          <Flag aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-medium">Expected outcome</span>
            {item.expectedOutput ? (
              <span className="block truncate text-xs text-muted-foreground">
                {item.expectedOutput}
              </span>
            ) : null}
          </span>
        </>
      );
    case "endOfRun":
      return (
        <>
          <PerformerDot agent />
          <span className="min-w-0">
            <span className="font-medium">End-of-run evaluation</span>
            <span className="block text-xs text-muted-foreground">
              {endOfRunDetail(item)}
            </span>
            {item.assertions.length > 0 ? (
              <span className="mt-1 flex flex-wrap gap-1">
                {item.assertions.map((assertion) => (
                  <ProvenanceChip
                    key={assertion.row.key}
                    provenance={assertion.provenance}
                  />
                ))}
              </span>
            ) : null}
          </span>
        </>
      );
    default:
      return (
        <>
          <PerformerDot agent={item.performer === "agent"} />
          <span className="min-w-0 font-medium">
            Step {item.stepNumber} · {item.title}
            <span className="font-normal text-muted-foreground">
              {item.performer === "agent" ? " · agent runs" : " · no model"}
            </span>
          </span>
        </>
      );
  }
}

/**
 * The case's steps in the order it runs, docked beside a test run. A step
 * opens the case editor at that step.
 */
export function ExecutionPreviewPanel({
  items,
  onOpenStep,
  onClose,
}: {
  items: readonly ExecutionPreviewItem[];
  onOpenStep?: (anchor: EditorAnchor) => void;
  onClose: () => void;
}) {
  return (
    <aside
      className="flex flex-col rounded-xl border border-border bg-card"
      aria-label="Execution preview"
      data-testid="test-run-execution-preview"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h3 className="text-[15px] font-semibold">Execution preview</h3>
          <p className="text-[13px] text-muted-foreground">
            How this case runs, in order.
            {onOpenStep ? " Click a step to open it in the test case." : ""}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close execution preview"
          onClick={onClose}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      <ol className="flex flex-col gap-1 px-3 py-3">
        {items.map((item) => (
          <li key={`${item.number}:${item.anchor}`}>
            <button
              type="button"
              disabled={!onOpenStep}
              onClick={() => onOpenStep?.(item.anchor)}
              className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left text-[13px] hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent"
              data-testid="execution-preview-step"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs tabular-nums">
                {item.number}
              </span>
              <span className="flex min-w-0 flex-1 items-start gap-2 pt-0.5">
                <ItemLine item={item} />
              </span>
              {onOpenStep ? (
                <ChevronRight
                  aria-hidden
                  className="mt-1 size-3.5 shrink-0 text-muted-foreground"
                />
              ) : null}
            </button>
          </li>
        ))}
      </ol>
      <div className="mx-5 flex flex-col gap-2 border-t border-border py-3 text-xs text-muted-foreground">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5">
            <PerformerDot agent /> Agent runs
          </span>
          <span className="flex items-center gap-1.5">
            <PerformerDot agent={false} /> No model
          </span>
          <span className="flex items-center gap-1.5">
            <Diamond aria-hidden className="size-3 text-success" /> Assertion
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ProvenanceChip provenance="suite" /> Suite default
          <ProvenanceChip provenance="case" /> This case only
        </span>
        <span className="flex items-start gap-1.5">
          <Info aria-hidden className="mt-0.5 size-3 shrink-0" />
          Suite settings configure grading; they are not a step in the run.
        </span>
      </div>
    </aside>
  );
}
