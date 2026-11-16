import { Button } from "@mcpjam/design-system/button";
import { Check, ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { CopyableCodeBlock } from "../copyable-code-block";
import type { OwaspId } from "./evaluator-library-types";
import { SpecKeyword, type SpecKeywordValue } from "./spec-keyword";

export type ProbeResult = "passed" | "failed" | "partial" | "not_applicable";

export type ProbeStep = {
  label: string;
  /** What was expected and what came back, when they differ. */
  detail?: string;
  passed: boolean;
};

export type ProbeRowProps = {
  name: string;
  /** The attack in the MCP Security Best Practices this probe tests. */
  attack: string;
  owasp?: OwaspId;
  requirement: { keyword?: SpecKeywordValue; text: string };
  /** One line on what MCPJam sends and expects. */
  method: string;
  result: ProbeResult;
  resultDetail?: string;
  steps?: readonly ProbeStep[];
  fix?: string;
  /** Shell command to reproduce. Secrets must be shell variables. */
  reproduce?: string;
  defaultOpen?: boolean;
  onRerun?: () => void;
  onAcceptRisk?: () => void;
};

const RESULT = {
  passed: { label: "Passed", className: "bg-success/15 text-success" },
  failed: { label: "Failed", className: "bg-destructive/10 text-destructive" },
  partial: { label: "Partial", className: "bg-warning/20 text-foreground" },
  not_applicable: {
    label: "Not applicable",
    className: "border border-border text-muted-foreground",
  },
} as const;

/**
 * One server check. Collapsed it shows the requirement, how MCPJam tests it
 * and the result; expanded it shows each request, the fix and a command to
 * reproduce. A server check grades the server once per deploy, so it never
 * appears on an iteration scorecard.
 */
export function ProbeRow({
  name,
  attack,
  owasp,
  requirement,
  method,
  result,
  resultDetail,
  steps,
  fix,
  reproduce,
  defaultOpen = false,
  onRerun,
  onAcceptRisk,
}: ProbeRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const detailId = useId();
  const hasActions = Boolean(onRerun || (onAcceptRisk && result === "failed"));
  const expandable = Boolean(steps?.length || fix || reproduce || hasActions);

  return (
    <section
      aria-label={name}
      className="overflow-hidden rounded-lg border border-border bg-popover"
    >
      <div
        className={cn(
          "grid grid-cols-[24px_minmax(0,12rem)_minmax(0,1fr)_9rem] items-start gap-3 px-3.5 py-3",
          open && "border-b border-border bg-primary/5",
        )}
      >
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
            onClick={() => setOpen((v) => !v)}
            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted"
          >
            {open ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        ) : (
          <span />
        )}
        <div>
          <div className="text-sm font-medium text-card-foreground">{name}</div>
          <div className="text-xs text-muted-foreground">
            {owasp ? `${attack} · ${owasp}` : attack}
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          <p>
            {requirement.keyword ? (
              <>
                <SpecKeyword keyword={requirement.keyword} />{" "}
              </>
            ) : null}
            {requirement.text}
          </p>
          <p className="mt-1 text-xs">{method}</p>
        </div>
        <div>
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-sm px-1.5 text-[11px] font-semibold uppercase tracking-wide",
              RESULT[result].className,
            )}
          >
            {RESULT[result].label}
          </span>
          {resultDetail ? (
            <p className="mt-1 text-xs text-muted-foreground">{resultDetail}</p>
          ) : null}
        </div>
      </div>
      {expandable && open ? (
        <div
          id={detailId}
          className="grid gap-4 px-3.5 pb-4 pt-3.5 sm:grid-cols-2 sm:pl-12"
        >
          {steps?.length ? (
            <ol aria-label="Steps" className="flex flex-col gap-2">
              {steps.map((step) => (
                <li key={step.label} className="flex gap-2.5">
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded",
                      step.passed
                        ? "bg-success/15 text-success"
                        : "bg-destructive/10 text-destructive",
                    )}
                  >
                    {step.passed ? (
                      <Check aria-hidden className="size-3" />
                    ) : (
                      <X aria-hidden className="size-3" />
                    )}
                    <span className="sr-only">
                      {step.passed ? "As expected:" : "Unexpected:"}
                    </span>
                  </span>
                  <div className="text-sm">
                    {step.label}
                    {step.detail ? (
                      <div className="text-xs text-muted-foreground">
                        {step.detail}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
          <div className="flex flex-col gap-3">
            {fix ? (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  How to fix
                </h4>
                <p className="mt-1 text-sm text-muted-foreground">{fix}</p>
              </div>
            ) : null}
            {reproduce ? (
              <CopyableCodeBlock
                code={reproduce}
                copyLabel="Copy reproduce command"
                toolbarLabel="Reproduce"
              />
            ) : null}
            {hasActions ? (
              <div className="flex gap-2">
                {onRerun ? (
                  <Button size="sm" variant="outline" onClick={onRerun}>
                    <RefreshCw aria-hidden />
                    Re-run
                  </Button>
                ) : null}
                {onAcceptRisk && result === "failed" ? (
                  <Button size="sm" variant="ghost" onClick={onAcceptRisk}>
                    Accept risk
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
