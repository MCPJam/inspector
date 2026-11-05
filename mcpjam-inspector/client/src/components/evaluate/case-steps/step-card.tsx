/**
 * One numbered step on the steps editor's rail: the number on the rail, and a
 * card that is either the full step (the case spine's `ActionRow`, with its
 * assertions nested underneath) or a single summary line when collapsed.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { summarizeStep } from "@/components/evals/step-fields";

export function StepRail({
  marker,
  label,
  children,
  testId,
}: {
  /** The step number, or a symbol for an unnumbered section. */
  marker: ReactNode;
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <li className="relative flex gap-4" data-testid={testId}>
      <div className="flex flex-col items-center">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-sm font-semibold text-card-foreground"
          aria-label={label}
        >
          {marker}
        </span>
        <span className="w-px flex-1 bg-border" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 pb-6">{children}</div>
    </li>
  );
}

export function StepCard({
  ordinal,
  label,
  step,
  assertionCount,
  serverNamesById,
  focused = false,
  children,
}: {
  ordinal: number;
  label: string;
  step: Parameters<typeof summarizeStep>[0];
  assertionCount: number;
  serverNamesById?: Map<string, string>;
  /** The step a link asked to open at: shown expanded and scrolled to. */
  focused?: boolean;
  /** The expanded body: the step row and its nested assertions. */
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focused) return;
    setCollapsed(false);
    sectionRef.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);
  const Toggle = collapsed ? ChevronRight : ChevronDown;
  return (
    <StepRail
      marker={ordinal}
      label={`Step ${ordinal}`}
      testId="case-steps-step"
    >
      <section
        ref={sectionRef}
        className={cn(
          "relative rounded-xl border border-border bg-card",
          collapsed ? "px-4 py-2.5" : "px-5 pb-4 pt-4",
        )}
        aria-label={`Step ${ordinal}: ${label}`}
        data-collapsed={collapsed || undefined}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 size-7 text-muted-foreground"
          aria-expanded={!collapsed}
          aria-label={
            collapsed ? `Expand step ${ordinal}` : `Collapse step ${ordinal}`
          }
          onClick={() => setCollapsed((value) => !value)}
        >
          <Toggle className="size-4" aria-hidden="true" />
        </Button>
        {collapsed ? (
          <p className="flex min-w-0 items-center gap-2 pr-8 text-sm">
            <span className="shrink-0 font-semibold text-card-foreground">
              {label}
            </span>
            <span className="truncate text-muted-foreground">
              {summarizeStep(step, serverNamesById)}
            </span>
            {assertionCount > 0 ? (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {assertionCount === 1
                  ? "1 assertion"
                  : `${assertionCount} assertions`}
              </span>
            ) : null}
          </p>
        ) : (
          <div className="pr-8">{children}</div>
        )}
      </section>
    </StepRail>
  );
}
