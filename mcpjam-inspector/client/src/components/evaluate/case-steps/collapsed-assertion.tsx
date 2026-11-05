import { useState, type ReactNode } from "react";
import {
  CircleCheck,
  MonitorSmartphone,
  MoreHorizontal,
  Wrench,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { isWidgetAssertion, type AssertStep } from "@/shared/steps";
import { assertionSummary } from "./editor-rows";

function Summary({ step }: { step: AssertStep }) {
  const assertion = step.assertion;
  if (!isWidgetAssertion(assertion) && assertion.type === "toolCalledWith") {
    const argCount = Object.keys(assertion.args?.args ?? {}).length;
    return (
      <>
        <Wrench className="size-4 shrink-0 text-success" aria-hidden="true" />
        <span className="shrink-0 text-sm font-medium">
          Tool was called with:
        </span>
        <code className="truncate rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-sm">
          {assertion.toolName || "…"}
        </code>
        <span className="shrink-0 text-sm text-muted-foreground">
          {argCount === 0
            ? "any arguments"
            : `${argCount} argument${argCount === 1 ? "" : "s"}`}
        </span>
      </>
    );
  }
  const Icon = isWidgetAssertion(assertion) ? MonitorSmartphone : CircleCheck;
  return (
    <>
      <Icon className="size-4 shrink-0 text-success" aria-hidden="true" />
      <span className="truncate text-sm font-medium">
        {assertionSummary(step)}
      </span>
    </>
  );
}

/**
 * One assertion as a single line. Its editor (the shared spine row) opens
 * underneath on demand; a new assertion opens straight away.
 */
export function CollapsedAssertion({
  step,
  defaultOpen,
  children,
}: {
  step: AssertStep;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
        <Summary step={step} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-7 shrink-0"
          aria-expanded={open}
          aria-label={open ? "Close assertion" : "Edit assertion"}
          onClick={() => setOpen(!open)}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </div>
      {open ? (
        <div className="border-t border-border px-1 pb-2">{children}</div>
      ) : null}
    </div>
  );
}
