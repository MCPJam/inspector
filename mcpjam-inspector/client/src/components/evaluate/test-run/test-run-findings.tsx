import { ArrowUpRight, Wrench } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { TestRunFinding } from "./test-run-model";

/** Where this case broke, one card per place, each leading to an iteration. */
export function TestRunFindings({
  findings,
  onOpenIteration,
}: {
  findings: readonly TestRunFinding[];
  onOpenIteration: (iterationId: string) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <section aria-labelledby="test-run-findings" className="space-y-2">
      <h2 id="test-run-findings" className="text-sm font-semibold">
        Findings{" "}
        <span className="font-normal tabular-nums text-muted-foreground">
          {findings.length}
        </span>
      </h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {findings.map((finding) => (
          <li
            key={finding.key}
            className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="flex items-start gap-2 text-[13px]">
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning"
                />
                {finding.sentence}
              </p>
              <p className="flex items-start gap-1.5 pl-3.5 text-xs text-muted-foreground">
                <Wrench aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                <span>
                  <span className="font-medium text-foreground">
                    How to fix:
                  </span>{" "}
                  {finding.nextAction}
                </span>
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenIteration(finding.iterationId)}
            >
              Open iteration
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
