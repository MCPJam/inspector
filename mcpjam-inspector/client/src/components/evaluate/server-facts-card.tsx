/**
 * The run's SERVER FACTS, under the stage strip.
 *
 * ── WHAT THIS IS, AND WHAT IT REFUSES TO BE ──────────────────────────────────
 *
 * A description of the server the run was taken against, shown beside the
 * run's verdict and never as part of it. Nothing on this card passes or fails:
 * a 57-tool surface is not a defect, a 3-second connect is not a failure, and
 * a precheck is a signal. The only `attention` tone belongs to a failed setup
 * phase and to `spec_required` findings, which are the two things here that
 * genuinely claim something is wrong.
 *
 * ── COLLAPSED BY DEFAULT ─────────────────────────────────────────────────────
 *
 * One line — servers, tools, an estimated share of a reference window — is
 * what most readers want, and it is a fact about the whole run rather than
 * about the stage they happen to have selected. Expanding shows the lines for
 * the selected stage, so Connection and Discovery finally have something to
 * say beyond "observed by the runner".
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EvalRunServerFactsV1 } from "@mcpjam/sdk/contract";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import {
  connectionLines,
  discoveryLines,
  groupPrechecksByTool,
  precheckQualifier,
  precheckTone,
  summarizeServerFacts,
  unavailableReasonCopy,
  type RunFactLine,
} from "./server-facts-model";

const TONE_CLASS: Record<RunFactLine["tone"], string> = {
  set: "text-foreground",
  empty: "text-muted-foreground",
  attention: "text-amber-700 dark:text-amber-400",
};

function FactLines({ lines }: { lines: RunFactLine[] }) {
  if (lines.length === 0) return null;
  return (
    <dl className="grid gap-1.5">
      {lines.map((line) => (
        <div key={line.id} className="grid gap-0.5">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[11px] text-muted-foreground">{line.label}</dt>
            <dd className={cn("text-[12px] tabular-nums", TONE_CLASS[line.tone])}>
              {line.value}
            </dd>
          </div>
          {line.note ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {line.note}
            </p>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

export function ServerFactsCard({
  document,
  stageFilter,
  className,
}: {
  document: EvalRunServerFactsV1;
  /**
   * Which stage the run page is filtered to.
   *
   * Only `connection` and `discovery` have facts here; every other stage
   * expands to the whole set, because a reader who opened the card while
   * looking at `response` still asked to see the server.
   */
  /**
   * Accepts a bare string because the run page holds its filter as one. Only
   * the two stage names below select a subset; anything else expands to the
   * whole set, which is the right default for a filter this card does not
   * recognize.
   */
  stageFilter?: UserValueStage | string | null;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const reason = unavailableReasonCopy(document);
  const connection = connectionLines(document);
  const discovery = discoveryLines(document);
  const lines =
    stageFilter === "connection"
      ? connection
      : stageFilter === "discovery"
        ? discovery
        : [...connection, ...discovery];

  return (
    <section
      className={cn("border-t border-border/40 px-5 py-2.5", className)}
      data-testid="server-facts-card"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center gap-1.5 text-left text-[12px] text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <span className="font-medium text-foreground">Server</span>
        <span data-testid="server-facts-summary">
          {summarizeServerFacts(document)}
        </span>
      </button>

      {expanded ? (
        <div className="mt-2.5 grid gap-3 pl-5">
          {reason ? (
            <p
              className="text-[11px] leading-snug text-muted-foreground"
              data-testid="server-facts-reason"
            >
              {reason}
            </p>
          ) : null}

          <FactLines lines={lines} />

          {document.servers.map((server) => {
            const groups = groupPrechecksByTool(server);
            if (groups.length === 0) return null;
            return (
              <div key={server.serverId} className="grid gap-1.5">
                <p className="text-[11px] font-medium text-foreground">
                  Tool metadata signals · {server.serverId}
                </p>
                {/*
                  SIGNALS, not violations — except where the class says
                  otherwise. Rendering them all in one alarming colour would
                  turn "this description is short" into a bug report.
                */}
                {groups.map((group) => (
                  <div key={group.toolName} className="grid gap-0.5">
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {group.toolName}
                    </p>
                    <ul className="grid gap-0.5">
                      {group.rows.map((row) => (
                        <li
                          key={`${group.toolName}:${row.code}`}
                          className={cn(
                            "text-[11px] leading-snug",
                            TONE_CLASS[precheckTone(row)],
                          )}
                        >
                          {row.code}
                          {precheckQualifier(row) ? (
                            <span className="text-muted-foreground">
                              {" "}
                              — {precheckQualifier(row)}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            );
          })}

          {document.servers.some(
            (server) => server.relatedAssessments.length > 0,
          ) ? (
            <div className="grid gap-1">
              <p className="text-[11px] font-medium text-foreground">
                Related assessments
              </p>
              {/*
                LINKED, never graded. The join is by server id alone, so these
                may describe a different server version, environment or auth
                context — each row says when it was taken and the caption says
                what the match actually establishes.
              */}
              <p className="text-[11px] leading-snug text-muted-foreground">
                Matched by server only. These are separate runs, not this
                run&apos;s verdict.
              </p>
              <ul className="grid gap-0.5">
                {document.servers.flatMap((server) =>
                  server.relatedAssessments.map((assessment) => (
                    <li
                      key={`${server.serverId}:${assessment.kind}:${assessment.createdAt}`}
                      className="text-[11px] text-muted-foreground"
                    >
                      {assessment.kind === "conformance"
                        ? "Protocol conformance"
                        : "Client readiness"}{" "}
                      · {new Date(assessment.createdAt).toLocaleDateString()}
                      {assessment.protocolVersion
                        ? ` · ${assessment.protocolVersion}`
                        : ""}
                    </li>
                  )),
                )}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
