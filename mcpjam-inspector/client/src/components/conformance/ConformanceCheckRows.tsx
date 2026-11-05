/**
 * The per-check rows inside a suite: live check results, OAuth flow steps,
 * and the not-yet-run catalog preview.
 */

import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  MinusCircle,
} from "lucide-react";
import type { OAuthConformanceStepResult } from "@mcpjam/sdk";
import {
  isTimedOutCheck,
  isMissingInputCheck,
  missingInputMessage,
} from "@mcpjam/sdk/browser";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Button } from "@mcpjam/design-system/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { Collapse, StatusIcon } from "./conformance-ui";

/** One row in a suite's "what this will run" preview, before any run. */
export interface CatalogEntry {
  id: string;
  title: string;
  /** One-line explanation, revealed on click. */
  description?: string;
  /** Era restriction, shown only when no version is pinned. */
  note?: string;
}

function formatDetailLabel(label: string) {
  if (label === "probes") return "Requests tested";
  if (label === "taskId") return "Task ID";
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

function formatDetailValue(value: unknown) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * The shut-row preview gives failures context without opening the row. The
 * full message stays mounted inside Collapse so it slides with the explanation
 * and details; only one message is visible at a time. Red means a failure that
 * counts; skip reasons and unscored findings use the neutral box.
 *
 * A shut row shows the box only when it says something to act on: a failure,
 * or why a check that applies could not run. A not-applicable reason waits
 * for the row to open, or every era-skipped row would carry a box of noise.
 */
function showsMessageShut(status: string, skipReason?: string): boolean {
  return status === "failed" || skipReason === "could-not-run";
}

function ResultMessage({
  message,
  tone,
  expanded,
}: {
  message: string;
  tone: "error" | "neutral";
  expanded: boolean;
}) {
  return (
    <span
      className={cn(
        "block rounded-sm border px-2 py-1.5 text-sm whitespace-pre-wrap break-words",
        tone === "error"
          ? "border-red-500/20 bg-red-500/5 text-red-600 dark:text-red-400"
          : "border-border/60 bg-muted/30 text-muted-foreground",
      )}
    >
      {/* Clamped inside the padded box: clamped on the box itself, a third
          line shows through the bottom padding. */}
      <span className={cn(!expanded && "line-clamp-2")}>{message}</span>
    </span>
  );
}

export function pendingIdSet(
  result: { profile?: { pendingCheckIds?: string[] } } | undefined,
): Set<string> {
  return new Set(result?.profile?.pendingCheckIds ?? []);
}

/** Says a result row opens: nothing else on it does. */
function RowChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn(
        "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
        expanded && "rotate-90",
      )}
    />
  );
}

/**
 * The tag on a result that does not count toward the score: a check the
 * profile does not score yet, or an OAuth step the server's settings leave out.
 */
export function UnscoredTag() {
  return (
    <span
      title="Reported for information only. Unscored checks don't count toward the score or the verdict."
      className="shrink-0 rounded-sm border border-border/60 px-1 py-px text-xs leading-none text-muted-foreground"
    >
      unscored
    </span>
  );
}

/** On a check the server did not answer in time: untested, not failed. */
export function TimedOutTag() {
  return (
    <span
      title="The server did not answer in time, so this check is untested. It does not count as a failure."
      className="shrink-0 rounded-sm border border-warning/50 bg-warning/10 px-1 py-px text-xs leading-none text-warning-foreground"
    >
      Timed out
    </span>
  );
}

/**
 * On a check that needs an input before it can run (a tool to call). Amber
 * while a picked check has none, so it shows before anything is opened.
 */
export function NeedsInputTag({
  status,
  picked = true,
  advice = false,
}: {
  status: "missing" | "set";
  picked?: boolean;
  /** On an advice row, which is left out, not "could not run", without one. */
  advice?: boolean;
}) {
  const missing = status === "missing";
  return (
    <span
      title={
        advice
          ? missing
            ? "Select a tool and fill in its required arguments before running this check."
            : "This advice calls the tool set for it."
          : missing
            ? "Select a tool and fill its required arguments before this check can run."
            : "This check calls the tool set for it."
      }
      className={cn(
        "shrink-0 rounded-sm border px-1 py-px text-xs leading-none",
        missing && picked
          ? "border-warning/50 bg-warning/10 text-warning-foreground"
          : "border-border/60 text-muted-foreground",
      )}
    >
      {missing ? "Needs input" : "Input set"}
    </span>
  );
}

export function NotRunTag() {
  return (
    <span
      title="This check needs an input before it can run."
      className="shrink-0 rounded-sm border border-border/60 px-1 py-px text-xs leading-none text-muted-foreground"
    >
      Not run
    </span>
  );
}

/** Display fields shared by live checks and saved report cases. */
export interface CheckRowResult {
  id: string;
  title: string;
  status: string;
  skipReason?: string;
  description?: string;
  durationMs?: number;
  error?: { message: string };
  details?: unknown;
  warnings?: string[];
}

export function CheckRow({
  check,
  pending = false,
}: {
  check: CheckRowResult;
  pending?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const missingInput = isMissingInputCheck(check);
  const detailEntries = Object.entries(check.details ?? {}).filter(
    ([key]) => key !== "missingInput",
  );
  const warnings = check.warnings;

  return (
    <div className="border-b border-border/60 last:border-0">
      <button
        type="button"
        className="w-full flex items-start gap-2.5 py-1.75 pl-7 pr-1 text-left hover:bg-muted/30 transition-colors cursor-pointer"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="mt-0.5">
          <StatusIcon
            status={check.status}
            skipReason={missingInput ? undefined : check.skipReason}
            muted={pending}
          />
        </span>
        {missingInput ? <NotRunTag /> : pending ? <UnscoredTag /> : null}
        {isTimedOutCheck(check) ? <TimedOutTag /> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "text-sm",
              check.status === "skipped" &&
                (missingInput || check.skipReason !== "could-not-run") &&
                "text-muted-foreground",
            )}
          >
            {check.title}
          </span>
          {check.error &&
          !expanded && showsMessageShut(check.status, check.skipReason) ? (
            <ResultMessage
              message={missingInputMessage(check) ?? check.error.message}
              tone={
                check.status === "failed" && !pending ? "error" : "neutral"
              }
              expanded={false}
            />
          ) : null}
        </span>
        {/* A skipped check never ran: its 0ms says nothing. */}
        {check.status !== "skipped" && check.durationMs !== undefined && (
          <span className="flex-shrink-0 pt-0.5 text-xs text-muted-foreground">
            {check.durationMs}ms
          </span>
        )}
        <RowChevron expanded={expanded} />
      </button>
      <Collapse open={expanded}>
        <div className="space-y-2 pb-2 pl-14 pr-1">
          <div className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
            {check.description}
          </div>
          {check.error && (
            <ResultMessage
              message={missingInputMessage(check) ?? check.error.message}
              tone={
                check.status === "failed" && !pending ? "error" : "neutral"
              }
              expanded
            />
          )}

          {detailEntries.length > 0 && (
            <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 h-auto gap-1 px-2 py-1 text-sm text-muted-foreground"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 transition-transform motion-reduce:transition-none",
                      detailsOpen && "rotate-90",
                    )}
                  />
                  More details
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent forceMount>
                <Collapse open={detailsOpen}>
                  <div className="mt-1 rounded-sm bg-muted/20 px-2 py-1.5 space-y-1">
                    {detailEntries.map(([key, value]) => (
                      <div key={key} className="text-sm">
                        <span className="font-medium text-foreground/80">
                          {formatDetailLabel(key)}:
                        </span>{" "}
                        <span className="text-muted-foreground whitespace-pre-wrap break-words">
                          {formatDetailValue(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </Collapse>
              </CollapsibleContent>
            </Collapsible>
          )}

          {warnings && warnings.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-sm text-muted-foreground">
              <div className="mb-1 flex items-center gap-1 font-medium text-foreground/70">
                <AlertTriangle className="h-3 w-3" />
                Warnings
              </div>
              <ul className="space-y-1 pl-4 list-disc">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

        </div>
      </Collapse>
    </div>
  );
}

export function OAuthStepRow({
  step,
  pending = false,
}: {
  step: OAuthConformanceStepResult;
  /** Left out of the score by the server's settings: it ran, but is unscored. */
  pending?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border/60 last:border-0">
      <button
        type="button"
        className="w-full flex items-start gap-2.5 py-1.75 pl-7 pr-1 text-left hover:bg-muted/30 transition-colors cursor-pointer"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="mt-0.5">
          <StatusIcon
            status={step.status}
            skipReason={step.skipReason}
            muted={pending}
          />
        </span>
        {pending ? <UnscoredTag /> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm">{step.title}</span>
          {step.error &&
          !expanded && showsMessageShut(step.status, step.skipReason) ? (
            <ResultMessage
              message={step.error.message}
              // An unscored failure is reported, not counted: grey, as in CheckRow.
              tone={step.status === "failed" && !pending ? "error" : "neutral"}
              expanded={false}
            />
          ) : null}
        </span>
        {step.status !== "skipped" && (
          <span className="flex-shrink-0 pt-0.5 text-xs text-muted-foreground">
            {step.durationMs}ms
          </span>
        )}
        <RowChevron expanded={expanded} />
      </button>
      <Collapse open={expanded}>
        <div className="space-y-2 pb-2 pl-14 pr-1">
          <div className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
            {step.summary}
          </div>
          {step.error && (
            <ResultMessage
              message={step.error.message}
              tone={step.status === "failed" && !pending ? "error" : "neutral"}
              expanded
            />
          )}

          {typeof step.error?.details === "string" && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-sm text-muted-foreground">
              <div className="mb-1 font-medium text-foreground/70">Details</div>
              <div className="whitespace-pre-wrap break-all font-mono text-xs">
                {step.error.details}
              </div>
            </div>
          )}

          {step.teachableMoments && step.teachableMoments.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-sm text-muted-foreground">
              <div className="mb-1 font-medium text-foreground/70">
                Why this matters
              </div>
              <ul className="space-y-1 pl-4 list-disc">
                {step.teachableMoments.map((moment) => (
                  <li key={moment}>{moment}</li>
                ))}
              </ul>
            </div>
          )}

          {step.warnings && step.warnings.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-sm text-muted-foreground">
              <div className="mb-1 flex items-center gap-1 font-medium text-foreground/70">
                <AlertTriangle className="h-3 w-3" />
                Warnings
              </div>
              <ul className="space-y-1 pl-4 list-disc">
                {step.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* What was actually probed. Without this a reader is told the
              server "does not implement" something without learning which
              URLs were tried — the difference between a verdict and a fix. */}
          {step.httpAttempts && step.httpAttempts.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-sm text-muted-foreground">
              <div className="mb-1 font-medium text-foreground/70">
                {step.httpAttempts.length === 1 ? "Request" : "Requests tried"}
              </div>
              <ul className="space-y-1">
                {step.httpAttempts.map((attempt, index) => (
                  <li
                    key={`${attempt.request.url}-${index}`}
                    className="flex items-baseline gap-2"
                  >
                    <span className="flex-shrink-0 font-mono text-xs uppercase text-foreground/60">
                      {attempt.request.method}
                    </span>
                    <span className="min-w-0 break-all font-mono text-xs">
                      {attempt.request.url}
                    </span>
                    {attempt.response && (
                      <span
                        className={`flex-shrink-0 font-mono text-xs ${
                          attempt.response.status >= 400
                            ? "text-red-400"
                            : "text-foreground/60"
                        }`}
                      >
                        {attempt.response.status}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

        </div>
      </Collapse>
    </div>
  );
}

/**
 * A not-yet-run check. Mirrors {@link CheckRow}'s interaction so the preview
 * and the real results read as the same list in two states.
 */
export function CatalogRow({
  entry,
  selected,
  onSelectedChange,
  children,
  tag,
  notApplicable,
}: {
  entry: CatalogEntry;
  /** Shown under the row, e.g. the tool a picked check will call. */
  children?: ReactNode;
  /** Shown after the title, e.g. that the check needs an input. */
  tag?: ReactNode;
  /**
   * Set, the row carries a checkbox showing whether it runs. Without
   * `onSelectedChange` the checkbox is disabled: the suite's own checkbox
   * decides for every row.
   */
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /**
   * Why the check has nothing to test on this server. Set, the row is shaded
   * and the reason shows as a tooltip; the checkbox still works.
   */
  notApplicable?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const expandable = Boolean(entry.description);
  const selectable = selected !== undefined;
  const title = (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left transition-colors enabled:hover:bg-muted/30 enabled:cursor-pointer disabled:cursor-default"
      onClick={() => setExpanded((value) => !value)}
      // A shaded row keeps its title focusable, so keyboard and screen reader
      // users can reach the reason it does not apply.
      disabled={!expandable && !notApplicable}
      aria-expanded={expandable ? expanded : undefined}
    >
      {selectable ? null : (
        <MinusCircle className="h-3.5 w-3.5 text-muted-foreground/50 flex-shrink-0" />
      )}
      <span className="flex-1 min-w-0 truncate text-sm text-muted-foreground">
        {entry.title}
      </span>
      {tag}
      {entry.note && (
        <span className="flex-shrink-0 text-xs text-muted-foreground/70">
          {entry.note}
        </span>
      )}
      {expandable &&
        (expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        ))}
    </button>
  );

  return (
    <div className="border-b border-border/30 last:border-0">
      <div
        className={cn(
          "flex items-center gap-2 px-1",
          notApplicable && "opacity-50",
        )}
      >
        {selectable ? (
          // A 24px target around the box: the label passes its clicks on.
          <label className="flex size-6 shrink-0 cursor-pointer items-center justify-center has-[:disabled]:cursor-default">
            <Checkbox
              checked={selected}
              disabled={!onSelectedChange}
              onCheckedChange={(value) => onSelectedChange?.(value === true)}
              aria-label={`Run ${entry.title}`}
            />
          </label>
        ) : null}
        {notApplicable ? (
          <Tooltip>
            <TooltipTrigger asChild>{title}</TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              {notApplicable}
            </TooltipContent>
          </Tooltip>
        ) : (
          title
        )}
      </div>
      <Collapse open={expanded && Boolean(entry.description)}>
        <div className="px-6 pb-2 text-sm text-muted-foreground whitespace-pre-wrap break-words">
          {entry.description}
        </div>
      </Collapse>
      {children ? <div className="pr-1 pb-2 pl-8">{children}</div> : null}
    </div>
  );
}

/**
 * A suite's checks as a gray list: before a run ("not run yet") and for a
 * suite that did not apply, so the reader can still see what it covers.
 */
export function CatalogList({
  catalog,
  note = ".",
  heading,
  isSelected,
  onSelectedChange,
  renderExtra,
  renderTag,
  notApplicableReason,
}: {
  catalog: CatalogEntry[];
  /** The rest of the line after "N checks in this suite", punctuation included. */
  note?: string;
  /** Replaces that line, for a list that is not the suite's checks. */
  heading?: string;
  /** What a row shows under it; see `CatalogRow`'s children. */
  renderExtra?: (entry: CatalogEntry) => ReactNode;
  /** What a row shows after its title; see `CatalogRow`'s tag. */
  renderTag?: (entry: CatalogEntry) => ReactNode;
  /** Why a row's check does not apply; see `CatalogRow`'s notApplicable. */
  notApplicableReason?: (entry: CatalogEntry) => string | undefined;
  /**
   * Each row carries a checkbox showing whether it runs; with
   * `onSelectedChange` too, the user picks rows one by one.
   */
  isSelected?: (id: string) => boolean;
  onSelectedChange?: (id: string, selected: boolean) => void;
}) {
  return (
    <div className="pl-7">
      <div className="py-1 text-xs text-muted-foreground">
        {heading ?? `${catalog.length} checks in this suite${note}`}
      </div>
      {catalog.map((entry) => (
        <CatalogRow
          key={entry.id}
          entry={entry}
          {...(isSelected ? { selected: isSelected(entry.id) } : {})}
          {...(isSelected && onSelectedChange
            ? {
                onSelectedChange: (selected: boolean) =>
                  onSelectedChange(entry.id, selected),
              }
            : {})}
          tag={renderTag?.(entry)}
          notApplicable={notApplicableReason?.(entry)}
        >
          {renderExtra?.(entry)}
        </CatalogRow>
      ))}
    </div>
  );
}
