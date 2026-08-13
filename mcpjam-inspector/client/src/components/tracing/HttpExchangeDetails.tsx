/**
 * The expanded body of an HTTP-exchange row in Tracing.
 *
 * Deliberately NOT `HTTPHistoryEntry`: that component is shared by the OAuth
 * and XAA flow loggers and renders headers as an opaque JSON blob. What this
 * screen needs is the opposite — the mirrored `Mcp-*` headers pulled to the
 * top, sentinel values decoded, and the header/body cross-check run — so it
 * gets its own presentation rather than growing options on a shared card.
 *
 * Each mirrored header is one line: name, value, verdict. The third slot
 * carries the only thing `2026-07-28` added that a reader cannot see for
 * themselves — whether the header still agrees with the body it was copied
 * from — rather than restating the family the header name already implies.
 */

import { useMemo } from "react";
import { ScrollableJsonView } from "@/components/ui/json-editor";
import { cn } from "@/lib/utils";
import {
  classifyMcpHeader,
  evaluateMcpHeaders,
  type HttpExchangeLogEvent,
  type McpHeaderAssessment,
  type McpHeaderFamily,
  type McpParamCrossCheck,
} from "@mcpjam/sdk/browser";
import type { CorrelatableLogItem } from "./correlate-http-exchange";
import { paramCrossCheckForExchangeItem } from "./tool-declarations-from-log";

/**
 * Fallback slot text for a header no cross-check applies to: a legacy request
 * mirrors nothing, and `Mcp-Param-*` body values are not captured. Naming the
 * family is all that can honestly be said there.
 */
const FAMILY_LABEL: Record<McpHeaderFamily, string> = {
  "protocol-version": "protocol version",
  method: "routing",
  name: "routing",
  param: "mirrored argument",
  session: "session",
  resumption: "resumption",
};

/** The verdict slot: what the cross-check concluded, in the row's own words. */
function verdictText(
  row: McpHeaderAssessment,
  paramsCheckable: boolean,
): string {
  switch (row.status) {
    case "match":
      return "✓ matches body";
    case "mismatch":
      return `✕ body says ${row.bodyValue} → -32020`;
    case "missing":
      return `✕ not sent, body says ${row.bodyValue} → -32020`;
    case "undecodable":
      return "✕ does not decode → -32020";
    case "undeclared":
      // Not a header/body disagreement: the tool's schema never declared this
      // param at all, so no argument could have produced it.
      return "✕ not declared by the tool → -32020";
    case "not-required":
      return "not required here";
    case "unchecked":
      // A param row with no verdict must never read as a pass, and the reason
      // differs: either the tool's schema could not be recovered from the log,
      // or the request was never eligible for the cross-check at all (a
      // pre-2026 exchange mirrors nothing). Name whichever applies.
      if (row.family !== "param") return FAMILY_LABEL[row.family];
      return paramsCheckable
        ? "unchecked — not cross-checked on this request"
        : "unchecked — tool schema unavailable";
  }
}

function isFailure(status: McpHeaderAssessment["status"]): boolean {
  return (
    status === "mismatch" ||
    status === "missing" ||
    status === "undecodable" ||
    status === "undeclared"
  );
}

/**
 * The mirrored headers are rendered above with their verdicts, so leaving them
 * in the raw map prints them twice on one screen.
 */
function withoutMirroredHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !classifyMcpHeader(name)),
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-medium text-muted-foreground mb-1">
      {children}
    </div>
  );
}

export function HttpExchangeDetails({
  exchange,
  paramCrossCheck,
  items,
  exchangeItem,
}: {
  exchange: HttpExchangeLogEvent;
  /**
   * The call's arguments + the tool's `x-mcp-header` declarations, when the
   * caller could recover them. Supplying it turns the `Mcp-Param-*` rows from
   * listed into judged; omitting it leaves them explicitly unchecked, because
   * capture never stores request bodies and the schema is not in the exchange.
   *
   * Callers that already hold a correlated frame (the inline disclosure) pass
   * this directly. The dedicated HTTP row has no frame, so it passes
   * `exchangeItem` + `items` instead and lets this component derive it — INSIDE
   * a `useMemo`, because the reverse correlation is the expensive direction and
   * recomputing it in a list render body would run it on every keystroke.
   */
  paramCrossCheck?: McpParamCrossCheck;
  /** Full log list, for the `exchangeItem` derivation. */
  items?: CorrelatableLogItem[];
  /** This exchange's own log row, when the caller has no correlated frame. */
  exchangeItem?: CorrelatableLogItem;
}) {
  const derivedParamCrossCheck = useMemo(
    () =>
      paramCrossCheck ??
      (exchangeItem && items
        ? paramCrossCheckForExchangeItem(exchangeItem, items)
        : undefined),
    [paramCrossCheck, exchangeItem, items],
  );
  const mcpHeaders = useMemo(
    () =>
      evaluateMcpHeaders(
        exchange.request.headers,
        exchange.bodyValues,
        derivedParamCrossCheck,
      ),
    [exchange.request.headers, exchange.bodyValues, derivedParamCrossCheck],
  );
  const otherRequestHeaders = useMemo(
    () => withoutMirroredHeaders(exchange.request.headers),
    [exchange.request.headers],
  );

  const status = exchange.response?.status;
  const statusColor =
    status === undefined
      ? "text-muted-foreground"
      : status >= 500
        ? "text-red-700 dark:text-red-500"
        : status >= 400
          ? "text-red-600 dark:text-red-400"
          : status >= 300
            ? "text-yellow-600 dark:text-yellow-400"
            : "text-green-600 dark:text-green-400";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 font-mono text-xs">
        <span className="text-foreground">{exchange.request.method}</span>
        <span className="text-muted-foreground truncate">
          {exchange.request.url}
        </span>
        {exchange.response ? (
          <span className={cn("flex-shrink-0", statusColor)}>
            {exchange.response.status} {exchange.response.statusText}
          </span>
        ) : (
          <span className="flex-shrink-0 text-red-600 dark:text-red-400">
            {exchange.error ?? "no response"}
          </span>
        )}
        <span className="flex-shrink-0 text-muted-foreground">
          {exchange.durationMs}ms
        </span>
      </div>

      {mcpHeaders.length > 0 && (
        <div>
          <SectionLabel>MCP headers</SectionLabel>
          <div className="rounded-sm bg-background/60 p-2 space-y-1">
            {mcpHeaders.map((row) => (
              <div
                key={row.name}
                className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]"
              >
                <span className="text-foreground">{row.name}</span>
                <span
                  className={cn(
                    "break-all",
                    row.raw === undefined
                      ? "text-muted-foreground/50"
                      : "text-muted-foreground",
                  )}
                >
                  {row.raw ?? "—"}
                </span>
                {row.decoded !== undefined && (
                  <span className="text-sky-600 dark:text-sky-400 break-all">
                    → {row.decoded}
                  </span>
                )}
                <span
                  className={cn(
                    "break-all",
                    isFailure(row.status)
                      ? "text-red-600 dark:text-red-400"
                      : row.status === "match"
                        ? "text-green-600 dark:text-green-400"
                        : "text-muted-foreground/70",
                  )}
                >
                  {verdictText(row, derivedParamCrossCheck !== undefined)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionLabel>Other request headers</SectionLabel>
        <ScrollableJsonView
          value={otherRequestHeaders}
          containerClassName="rounded-sm bg-background/60 p-2 max-h-[200px]"
        />
      </div>

      {exchange.response && (
        <div>
          <SectionLabel>Response headers</SectionLabel>
          <ScrollableJsonView
            value={exchange.response.headers}
            containerClassName="rounded-sm bg-background/60 p-2 max-h-[200px]"
          />
        </div>
      )}
    </div>
  );
}
