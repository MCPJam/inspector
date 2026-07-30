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

import { useMemo, useState } from "react";
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

/**
 * A header/body disagreement the server answers `-32020` to. Named on the
 * COLLAPSED row, because the reader who needs it is precisely the one who would
 * not think to open a headers section — the body they came to read looks fine.
 */
function isFailure(status: McpHeaderAssessment["status"]): boolean {
  return (
    status === "mismatch" || status === "missing" || status === "undecodable"
  );
}

/** The collapsed row's own words: the count, or the first thing that is wrong. */
function summarize(exchange: HttpExchangeLogEvent, rows: McpHeaderAssessment[]) {
  const broken = rows.filter((row) => isFailure(row.status));
  if (broken.length > 0) {
    return {
      text:
        broken.length === 1
          ? `${broken[0].name} disagrees with the body`
          : `${broken.length} headers disagree with the body`,
      failed: true,
    };
  }
  const status = exchange.response?.status;
  return {
    text: rows.length === 1 ? "1 MCP header" : `${rows.length} MCP headers`,
    failed: status !== undefined && status >= 400,
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
  const exchange = useMemo(
    () => findExchangeForFrame(frame, items),
    [frame, items],
  );

  const mcpHeaders = useMemo(
    () =>
      exchange
        ? evaluateMcpHeaders(exchange.request.headers, exchange.bodyValues)
        : [],
    [exchange],
  );

  // Nothing correlated, or the exchange carries no MCP headers at all (a
  // legacy-era exchange whose only headers are `content-type` and a session
  // id). Either way there is nothing here a reader needs; the dedicated HTTP
  // row still shows the raw exchange.
  if (!exchange || mcpHeaders.length === 0) {
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
        <div className="border-t border-border/60 p-2">
          <HttpExchangeDetails exchange={exchange} />
        </div>
      )}
    </div>
  );
}
