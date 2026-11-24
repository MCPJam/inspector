import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ClimbForOption, FailedRun } from "@mcpjam/sdk/climbs";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import { ruleSentence } from "./climb-format";
import type { Climb } from "./climb-types";
import { FailedRunSheet } from "./failed-run-sheet";
import { optionDisabledReason } from "./ready-model";

/**
 * "Climb for" as one list: each option says what it measures and shows the
 * number behind it. The chosen one shows its rule in words and up to three
 * failed runs from steering cases, each opening its transcript.
 */
export function ClimbForList({
  climb,
  labels,
  selected,
  onSelect,
  onNext,
}: {
  climb: Climb;
  labels: Record<string, string>;
  selected: string | undefined;
  onSelect: (option: ClimbForOption) => void;
  onNext: () => void;
}) {
  const [opened, setOpened] = useState<FailedRun | null>(null);
  const options = climb.climbFor ?? [];
  const chosen = options.find((option) => option.id === selected);
  const disabled = climb.state === "stopped";
  return (
    <section className="flex flex-col gap-3" aria-label="Climb for">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Climb for</h2>
          <p className="text-xs text-muted-foreground">Pick one. Each option says what it measures.</p>
        </div>
        <Button onClick={onNext} disabled={disabled || !chosen}>
          Choose a change <ChevronRight aria-hidden />
        </Button>
      </div>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The options appear once the baseline has settled and the server has been read.
        </p>
      ) : (
        <RadioGroup
          value={selected}
          onValueChange={(id) => {
            const option = options.find((candidate) => candidate.id === id);
            if (option) onSelect(option);
          }}
          className="grid grid-cols-1 items-start gap-x-6 gap-y-0 md:grid-cols-2"
        >
          {options.map((option) => {
            const reason = optionDisabledReason(climb, option);
            return (
              <label
                key={option.id}
                htmlFor={`climb-for-${option.id}`}
                className={cn(
                  "flex items-start gap-3 rounded-md border-b border-border px-2 py-2.5",
                  reason ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                  selected === option.id && "bg-accent",
                )}
              >
                <RadioGroupItem
                  id={`climb-for-${option.id}`}
                  value={option.id}
                  className="mt-0.5"
                  disabled={Boolean(reason) || disabled}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{reason ?? option.number.text}</span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      )}
      {chosen ? <p className="text-sm">{ruleSentence(chosen.measure, climb.minImprovementBps)}</p> : null}
      {chosen && chosen.failedRuns.length > 0 ? (
        <div className="flex flex-col gap-1">
          <div>
            <h3 className="text-sm font-medium">Failed runs</h3>
            <p className="text-xs text-muted-foreground">From steering cases.</p>
          </div>
          {chosen.failedRuns.map((run) => (
            <Button
              key={run.iterationId}
              type="button"
              variant="ghost"
              onClick={() => setOpened(run)}
              className="h-auto w-full justify-between gap-3 rounded-none border-b border-border px-2 py-2 text-left font-normal"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{run.caseTitle ?? "A steering case"}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {labels[run.environmentId] ?? "Environment"} · {run.reason}
                </span>
              </span>
              <ChevronRight className="text-muted-foreground" aria-hidden />
            </Button>
          ))}
        </div>
      ) : null}
      <FailedRunSheet
        run={opened}
        environment={opened ? (labels[opened.environmentId] ?? "Environment") : ""}
        onClose={() => setOpened(null)}
      />
    </section>
  );
}
