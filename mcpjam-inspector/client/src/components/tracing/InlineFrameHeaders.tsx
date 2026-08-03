/**
 * The HTTP headers a JSON-RPC frame rode in, shown under the frame itself.
 *
 * Why this exists on top of the HTTP source filter: from `2026-07-28` the
 * mirrored `Mcp-*` headers are protocol state that is NOT in the body
 * (SEP-2243), so a `-32020 HeaderMismatch` cannot be explained from the frame
 * a reader is looking at. Making them switch source filters and re-find the
 * matching exchange to answer "why did this call fail" is the wrong shape for
 * the question. The dedicated HTTP rows stay — they are the place to read an
 * exchange on its own terms, including ones that carry no single frame.
 *
 * Collapsed by default and absent when nothing correlates: the body is what
 * the row was opened for, and on every era before `2026-07-28` these headers
 * carry nothing a reader needs.
 */

import { useId, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  evaluateMcpHeaders,
  type HttpExchangeLogEvent,
  type McpHeaderAssessment,
} from "@mcpjam/sdk/browser";
import { HttpExchangeDetails } from "./HttpExchangeDetails";
import {
  findExchangeForFrame,
  type CorrelatableLogItem,
} from "./correlate-http-exchange";
import { paramCrossCheckForFrame } from "./tool-declarations-from-log";

/**
 * A header/body disagreement the server answers `-32020` to. Named on the
 * COLLAPSED row, because the reader who needs it is precisely the one who would
 * not think to open a headers section — the body they came to read looks fine.
 */
function isFailure(status: McpHeaderAssessment["status"]): boolean {
  return (
    status === "mismatch" ||
    status === "missing" ||
    status === "undecodable" ||
    status === "undeclared"
  );
}

/**
 * True when a row carries a verdict at all.
 *
 * Before `2026-07-28` nothing is mirrored, so `evaluateMcpHeaders` returns
 * every present header as `unchecked` — a legacy exchange's `Mcp-Session-Id`
 * or `Last-Event-ID` produces rows with no cross-check behind them. Those
 * headers are real, debuggable state (a missing session id or a failed resume
 * is often the bug), which is why capture keeps them for every era and the
 * dedicated HTTP row renders them in full. What they are not is a reason for
 * an INLINE disclosure: this affordance exists to surface a cross-check the
 * body cannot show, and on a legacy frame there is none to surface. Legacy
 * support is not reduced here — the same bytes stay one filter away.
 */
function isDecided(status: McpHeaderAssessment["status"]): boolean {
  return status !== "unchecked";
}

/** The collapsed row's own words: the count, or the first thing that is wrong. */
function summarize(exchange: HttpExchangeLogEvent, rows: McpHeaderAssessment[]) {
  const broken = rows.filter((row) => isFailure(row.status));
  if (broken.length > 0) {
    // `undeclared` is not a body disagreement — there is no body value it
    // could have disagreed with — so it must not be described as one.
    const undeclaredOnly = broken.every((row) => row.status === "undeclared");
    const mixed = broken.some((row) => row.status === "undeclared");
    return {
      text:
        broken.length === 1
          ? undeclaredOnly
            ? `${broken[0].name} is not declared by the tool`
            : `${broken[0].name} disagrees with the body`
          : mixed
            ? `${broken.length} MCP headers are invalid`
            : `${broken.length} headers disagree with the body`,
      failed: true,
    };
  }
  const status = exchange.response?.status;
  return {
    text: rows.length === 1 ? "1 MCP header" : `${rows.length} MCP headers`,
    // `error` is set when the fetch itself rejected — DNS, TLS, an abort — and
    // that case has NO response, so a status-only test reads a dead connection
    // as healthy. It is the one failure the reader cannot infer from the body
    // either, since no reply ever came back to log.
    failed:
      exchange.error !== undefined ||
      (status !== undefined && status >= 400),
  };
}

export function InlineFrameHeaders({
  frame,
  items,
}: {
  frame: CorrelatableLogItem;
  items: CorrelatableLogItem[];
}) {
  const [open, setOpen] = useState(false);
  // Per-instance: the Logs list mounts one of these under every expanded
  // frame, so a hard-coded id would repeat and point assistive tech at
  // whichever panel happened to render first.
  const panelId = useId();
  const exchange = useMemo(
    () => findExchangeForFrame(frame, items),
    [frame, items],
  );

  // The tool's `x-mcp-header` declarations + this call's arguments, recovered
  // from the log itself (capture stores neither). Absent when the log holds no
  // `tools/list` for the tool — the param rows then stay honestly unchecked.
  const paramCrossCheck = useMemo(
    () => paramCrossCheckForFrame(frame, items),
    [frame, items],
  );

  const mcpHeaders = useMemo(
    () =>
      exchange
        ? evaluateMcpHeaders(
            exchange.request.headers,
            exchange.bodyValues,
            paramCrossCheck,
          )
        : [],
    [exchange, paramCrossCheck],
  );

  // Nothing correlated, or nothing that was cross-checked. The second case is
  // every pre-2026 exchange (see `isDecided`) plus a modern one whose only
  // `Mcp-*` header is a session id: rows exist, but none of them judge
  // anything, so an inline disclosure would promise a verdict it does not have.
  if (!exchange || !mcpHeaders.some((row) => isDecided(row.status))) {
    return null;
  }

  const { text, failed } = summarize(exchange, mcpHeaders);

  return (
    <div className="rounded-sm border border-border/60">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/40"
        aria-expanded={open}
        aria-controls={panelId}
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 flex-shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="font-medium">HTTP headers</span>
        <span
          className={cn(
            "truncate font-mono",
            failed && "text-red-600 dark:text-red-400",
          )}
        >
          {text}
        </span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-border/60 p-2">
          <HttpExchangeDetails
            exchange={exchange}
            paramCrossCheck={paramCrossCheck}
          />
        </div>
      )}
    </div>
  );
}
