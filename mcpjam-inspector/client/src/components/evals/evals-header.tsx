import type { ReactNode } from "react";
import { EvalsModeNav } from "./evals-mode-nav";
import type { EvalsMode } from "@/lib/eval-route-url";

/**
 * The Evaluate header strip, shared by both modes.
 *
 * It renders unconditionally — including on the list routes — because it now
 * carries the Suites | Runs switcher, which is how a user moves between the
 * two lenses. `children` is each mode's own breadcrumb trail on detail routes.
 */
export function EvalsHeader({
  mode,
  children,
}: {
  mode: EvalsMode;
  children?: ReactNode;
}) {
  return (
    <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2.5 sm:px-6">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <EvalsModeNav mode={mode} />
        {children}
      </div>
    </div>
  );
}
