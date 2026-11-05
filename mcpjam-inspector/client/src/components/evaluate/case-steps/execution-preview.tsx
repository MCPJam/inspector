/**
 * The execution preview: the case as it runs, top to bottom. Each item opens
 * the editor at the step it names. The editor docks it beside the steps; the
 * Test run page can mount the same panel.
 */

import { useState } from "react";
import { ChevronDown, Diamond, Flag, Info, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { ProvenanceChip } from "../case-scorecard/provenance-chip";
import type { EditorAnchor, ExecutionPreviewItem } from "./case-steps-model";
import { assertionSummary } from "./editor-rows";

function itemLabel(item: ExecutionPreviewItem): string {
  switch (item.kind) {
    case "assertion":
      return assertionSummary(item.step);
    case "outcome":
      return "Expected outcome";
    case "endOfRun":
      return "End-of-run evaluation";
    default:
      return `Step ${item.stepNumber} · ${item.title}`;
  }
}

function ItemMarker({ item }: { item: ExecutionPreviewItem }) {
  if (item.kind === "assertion")
    return <Diamond className="size-3.5 text-success" aria-hidden="true" />;
  if (item.kind === "outcome")
    return (
      <Flag className="size-3.5 text-muted-foreground" aria-hidden="true" />
    );
  const agent =
    item.kind === "endOfRun" ||
    ("performer" in item && item.performer === "agent");
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2.5 rounded-full",
        agent ? "bg-primary" : "border border-muted-foreground",
      )}
    />
  );
}

function ItemDetail({ item }: { item: ExecutionPreviewItem }) {
  if (item.kind === "endOfRun") {
    const judge =
      item.judge.state === "runs"
        ? "The judge grades the expected outcome."
        : item.judge.state === "skipped"
          ? "The judge is skipped for this case."
          : "No judge runs.";
    return (
      <div className="space-y-1.5">
        <p>{judge}</p>
        {item.assertions.map(({ row, provenance }) => (
          <p key={row.key} className="flex items-center gap-1.5">
            <ProvenanceChip provenance={provenance} />
            <span className="truncate">{row.label}</span>
          </p>
        ))}
      </div>
    );
  }
  if (item.kind === "outcome")
    return <p>{item.expectedOutput || "No goal sentence yet."}</p>;
  if (item.kind === "assertion")
    return (
      <p>
        {item.gradesStep === null
          ? "Runs before the first step."
          : `Grades step ${item.gradesStep}.`}{" "}
        {item.blocking
          ? "A miss fails the run."
          : "Advisory: a miss only warns."}
      </p>
    );
  return (
    <p>
      {item.performer === "agent"
        ? "The agent runs and chooses tools."
        : "MCPJam runs this with no model."}
    </p>
  );
}

export function ExecutionPreviewPanel({
  items,
  onSelect,
  onClose,
}: {
  items: ExecutionPreviewItem[];
  onSelect: (anchor: EditorAnchor) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <aside
      aria-label="Execution preview"
      className="rounded-xl border border-border bg-card"
      data-testid="execution-preview"
    >
      <header className="flex items-start gap-2 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Execution preview</h2>
          <p className="text-sm text-muted-foreground">
            How this case runs, in order. Click a step to open it in the test
            case.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close execution preview"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      <ol className="space-y-1 px-3 py-3">
        {items.map((item) => (
          <li key={`${item.number}:${item.anchor}`}>
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs">
                {item.number}
              </span>
              <ItemMarker item={item} />
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                onClick={() => onSelect(item.anchor)}
              >
                {itemLabel(item)}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                aria-expanded={open === item.number}
                aria-label={`Details for item ${item.number}`}
                onClick={() =>
                  setOpen(open === item.number ? null : item.number)
                }
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    open === item.number && "rotate-180",
                  )}
                />
              </Button>
            </div>
            {open === item.number ? (
              <div className="ml-11 px-2 pb-2 text-xs text-muted-foreground">
                <ItemDetail item={item} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <footer className="space-y-2 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-primary" /> Agent runs
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full border border-muted-foreground" />{" "}
            No model
          </span>
          <span className="flex items-center gap-1">
            <Diamond className="size-3 text-success" /> Assertion
          </span>
        </p>
        <p className="flex items-start gap-1.5">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Suite settings configure grading; they are not a step in the run.
        </p>
      </footer>
    </aside>
  );
}
