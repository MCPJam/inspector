/**
 * The per-check rows inside a suite: live check results, OAuth flow steps,
 * and the not-yet-run catalog preview.
 */

import { useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  MinusCircle,
} from "lucide-react";
import type {
  MCPAppsCheckResult,
  MCPCheckResult,
  MCPTasksCheckResult,
  OAuthConformanceStepResult,
} from "@mcpjam/sdk";
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
 * A check's message, once, as a box under its title. The page used to print
 * it twice — bold red text on the row, and the same text again in a box when
 * expanded — and boxed every message in red, so "not applicable to this era"
 * read as an error. Red now means a failure that counts; anything else (a
 * skip reason, an unscored check's finding) is the neutral box. Clamped while
 * the row is shut, in full once it is open.
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
        "block rounded-sm border px-2 py-1.5 text-xs whitespace-pre-wrap break-words",
        tone === "error"
          ? "border-red-500/20 bg-red-500/5 text-red-600 dark:text-red-400"
          : "border-border/60 bg-muted/30 text-muted-foreground",
        !expanded && "line-clamp-2",
      )}
    >
      {message}
    </span>
  );
}

export function pendingIdSet(
  result: { profile?: { pendingCheckIds?: string[] } } | undefined,
): Set<string> {
  return new Set(result?.profile?.pendingCheckIds ?? []);
}

export function CheckRow({
  check,
  pending = false,
}: {
  check: MCPCheckResult | MCPAppsCheckResult | MCPTasksCheckResult;
  pending?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailEntries = Object.entries(check.details ?? {});
  const warnings = "warnings" in check ? check.warnings : undefined;

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
            skipReason={check.skipReason}
            muted={pending}
          />
        </span>
        {pending ? (
          <span
            title="Reported for information only. Unscored checks don't count toward the score or the verdict."
            className="shrink-0 rounded-sm border border-border/60 px-1 py-px text-[10px] leading-none text-muted-foreground"
          >
            unscored
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "text-[13px]",
              check.status === "skipped" &&
                check.skipReason !== "could-not-run" &&
                "text-muted-foreground",
            )}
          >
            {check.title}
          </span>
          {check.error &&
          (expanded || showsMessageShut(check.status, check.skipReason)) ? (
            <ResultMessage
              message={check.error.message}
              tone={
                check.status === "failed" && !pending ? "error" : "neutral"
              }
              expanded={expanded}
            />
          ) : null}
        </span>
        {/* A skipped check never ran: its 0ms says nothing. */}
        {check.status !== "skipped" && (
          <span className="flex-shrink-0 pt-0.5 text-[10px] text-muted-foreground">
            {check.durationMs}ms
          </span>
        )}
      </button>
      <Collapse open={expanded}>
        <div className="space-y-2 pb-2 pl-14 pr-1">
          <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {check.description}
          </div>

          {detailEntries.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 space-y-1">
              {detailEntries.map(([key, value]) => (
                <div key={key} className="text-xs">
                  <span className="font-medium text-foreground/80">
                    {formatDetailLabel(key)}:
                  </span>{" "}
                  <span className="text-muted-foreground whitespace-pre-wrap break-words">
                    {formatDetailValue(value)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {warnings && warnings.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
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

export function OAuthStepRow({ step }: { step: OAuthConformanceStepResult }) {
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
          <StatusIcon status={step.status} skipReason={step.skipReason} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px]">{step.title}</span>
          {step.error &&
          (expanded || showsMessageShut(step.status, step.skipReason)) ? (
            <ResultMessage
              message={step.error.message}
              tone={step.status === "failed" ? "error" : "neutral"}
              expanded={expanded}
            />
          ) : null}
        </span>
        {step.status !== "skipped" && (
          <span className="flex-shrink-0 pt-0.5 text-[10px] text-muted-foreground">
            {step.durationMs}ms
          </span>
        )}
      </button>
      <Collapse open={expanded}>
        <div className="space-y-2 pb-2 pl-14 pr-1">
          <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {step.summary}
          </div>

          {step.teachableMoments && step.teachableMoments.length > 0 && (
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
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
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
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
            <div className="rounded-sm bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground/70">
                {step.httpAttempts.length === 1 ? "Request" : "Requests tried"}
              </div>
              <ul className="space-y-1">
                {step.httpAttempts.map((attempt, index) => (
                  <li
                    key={`${attempt.request.url}-${index}`}
                    className="flex items-baseline gap-2"
                  >
                    <span className="flex-shrink-0 font-mono text-[10px] uppercase text-foreground/60">
                      {attempt.request.method}
                    </span>
                    <span className="min-w-0 break-all font-mono text-[10px]">
                      {attempt.request.url}
                    </span>
                    {attempt.response && (
                      <span
                        className={`flex-shrink-0 font-mono text-[10px] ${
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
export function CatalogRow({ entry }: { entry: CatalogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = Boolean(entry.description);

  return (
    <div className="border-b border-border/30 last:border-0">
      <button
        type="button"
        className="w-full flex items-center gap-2 py-1.5 px-1 text-left transition-colors enabled:hover:bg-muted/30 enabled:cursor-pointer disabled:cursor-default"
        onClick={() => setExpanded((value) => !value)}
        disabled={!expandable}
        aria-expanded={expandable ? expanded : undefined}
      >
        <MinusCircle className="h-3.5 w-3.5 text-muted-foreground/50 flex-shrink-0" />
        <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground">
          {entry.title}
        </span>
        {entry.note && (
          <span className="flex-shrink-0 text-[10px] text-muted-foreground/70">
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
      <Collapse open={expanded && Boolean(entry.description)}>
        <div className="px-6 pb-2 text-xs text-muted-foreground whitespace-pre-wrap break-words">
          {entry.description}
        </div>
      </Collapse>
    </div>
  );
}

/**
 * A suite's checks as a gray list: before a run ("not run yet") and for a
 * suite that did not apply, so the reader can still see what it covers.
 */
export function CatalogList({
  catalog,
  note,
}: {
  catalog: CatalogEntry[];
  note: string;
}) {
  return (
    <div className="pl-7">
      <div className="py-1 text-[11px] text-muted-foreground">
        {catalog.length} checks in this suite — {note}
      </div>
      {catalog.map((entry) => (
        <CatalogRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
