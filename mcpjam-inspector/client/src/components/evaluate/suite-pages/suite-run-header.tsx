import type { ReactNode } from "react";
import { Layers, SlidersHorizontal } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { EvalHeaderActions, EvalHeaderBack } from "../nav/eval-header-actions";
import { openEvalNavPage, useEvalNavBack } from "../nav/eval-nav-link";

/**
 * The Suite run page's header: "Suite Run #4" with its suite in a pill. Suite
 * settings, the run actions and Back to wherever the reader came from sit in
 * the breadcrumb bar. No overflow menu: the improve prompt lives in Findings.
 */
export function SuiteRunNavHeader({
  title,
  runLabel,
  suiteId,
  suiteName,
  scope,
  canEditSuite,
  actions,
}: {
  title: string;
  /** How Back on the pages this one opens names it, e.g. "run #4". */
  runLabel: string;
  suiteId: string;
  suiteName?: string;
  scope?: string | null;
  /** Off for readers who cannot change the suite. */
  canEditSuite: boolean;
  /** Compare and the run or cancel button, in that order. */
  actions: ReactNode;
}) {
  const back = useEvalNavBack({
    label: "suite",
    route: { type: "suite-overview", suiteId },
  });
  return (
    <header
      className="flex flex-col gap-3 px-5 py-4"
      data-testid="evaluate-run-header"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h2 className="min-w-0 truncate text-2xl font-bold leading-8 tracking-tight text-foreground">
              {title}
            </h2>
            {suiteName ? (
              <span
                className="inline-flex h-7 max-w-[20rem] items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 text-[12.5px] text-muted-foreground"
                data-testid="suite-run-suite-pill"
              >
                <Layers className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{suiteName}</span>
              </span>
            ) : null}
          </div>
          {scope ? (
            <p
              className="text-[12.5px] text-muted-foreground"
              data-testid="evaluate-run-scope"
            >
              {scope}
            </p>
          ) : null}
        </div>
        <EvalHeaderActions>
          {canEditSuite ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="suite-run-settings"
              onClick={() =>
                openEvalNavPage(
                  { type: "suite-settings", suiteId, tab: "settings" },
                  runLabel,
                )
              }
            >
              <SlidersHorizontal className="size-3.5" aria-hidden />
              Suite settings
            </Button>
          ) : null}
          {actions}
          <EvalHeaderBack
            label={back.label}
            onClick={back.go}
            testId="suite-run-back"
          />
        </EvalHeaderActions>
      </div>
    </header>
  );
}
