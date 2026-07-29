/**
 * The expanded body of an HTTP-exchange row in Tracing.
 *
 * Deliberately NOT `HTTPHistoryEntry`: that component is shared by the OAuth
 * and XAA flow loggers and renders headers as an opaque JSON blob. What this
 * screen needs is the opposite — the mirrored `Mcp-*` headers pulled to the
 * top, sentinel values decoded, and the header/body cross-check run — so it
 * gets its own presentation rather than growing options on a shared card.
 */

import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { ScrollableJsonView } from "@/components/ui/json-editor";
import { cn } from "@/lib/utils";
import {
  classifyMcpHeader,
  decodeMcpHeaderValue,
  findMcpHeaderIssues,
  type HttpExchangeLogEvent,
  type McpHeaderFamily,
  type McpHeaderIssue,
} from "@mcpjam/sdk/browser";

/** Display order: the routing/cross-check headers first, params after. */
const FAMILY_ORDER: McpHeaderFamily[] = [
  "protocol-version",
  "method",
  "name",
  "param",
  "session",
  "resumption",
];

const FAMILY_LABEL: Record<McpHeaderFamily, string> = {
  "protocol-version": "protocol version",
  method: "routing",
  name: "routing",
  param: "mirrored argument",
  session: "session",
  resumption: "resumption",
};

type ProtocolHeaderRow = {
  name: string;
  family: McpHeaderFamily;
  raw: string;
  decoded?: string;
  decodeError?: string;
};

function collectProtocolHeaders(
  headers: Record<string, string>,
): ProtocolHeaderRow[] {
  const rows: ProtocolHeaderRow[] = [];
  for (const [name, raw] of Object.entries(headers)) {
    const family = classifyMcpHeader(name);
    if (!family) continue;
    const decoded = decodeMcpHeaderValue(raw);
    rows.push({
      name,
      family,
      raw,
      // Show the decoded value only when it adds something — an unencoded
      // value shown twice reads as if the two could differ.
      decoded: decoded.encoded ? decoded.value : undefined,
      decodeError: decoded.decodeError,
    });
  }
  return rows.sort(
    (a, b) =>
      FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) ||
      a.name.localeCompare(b.name),
  );
}

function describeIssue(issue: McpHeaderIssue): string {
  switch (issue.kind) {
    case "missing":
      return `${issue.header} is required for this request and was not sent (body has "${issue.bodyValue}")`;
    case "mismatch":
      return `${issue.header} is "${issue.headerValue}" but the body says "${issue.bodyValue}"`;
    case "undecodable":
      return `${issue.header} carries the base64 sentinel but did not decode: "${issue.headerValue}"`;
  }
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
}: {
  exchange: HttpExchangeLogEvent;
}) {
  const requestProtocolHeaders = useMemo(
    () => collectProtocolHeaders(exchange.request.headers),
    [exchange.request.headers],
  );
  const issues = useMemo(
    () => findMcpHeaderIssues(exchange.request.headers, exchange.bodyValues),
    [exchange.request.headers, exchange.bodyValues],
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

      {issues.length > 0 && (
        <div className="rounded-sm border border-red-400 bg-red-50/50 p-2 dark:border-red-500 dark:bg-red-950/20">
          <div className="mb-1 flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            Header/body disagreement — this is what a -32020 HeaderMismatch
            reports
          </div>
          <ul className="space-y-0.5">
            {issues.map((issue) => (
              <li
                key={`${issue.kind}:${issue.header}`}
                className="font-mono text-[11px] text-red-600 dark:text-red-400"
              >
                {describeIssue(issue)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {requestProtocolHeaders.length > 0 && (
        <div>
          <SectionLabel>MCP headers</SectionLabel>
          <div className="rounded-sm bg-background/60 p-2 space-y-1">
            {requestProtocolHeaders.map((row) => (
              <div
                key={row.name}
                className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]"
              >
                <span className="text-foreground">{row.name}</span>
                <span className="text-muted-foreground break-all">
                  {row.raw}
                </span>
                {row.decoded !== undefined && (
                  <span className="text-sky-600 dark:text-sky-400 break-all">
                    → {row.decoded}
                  </span>
                )}
                {row.decodeError && (
                  <span className="text-red-600 dark:text-red-400">
                    → does not decode
                  </span>
                )}
                <span className="text-muted-foreground/70">
                  {FAMILY_LABEL[row.family]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionLabel>Request headers</SectionLabel>
        <ScrollableJsonView
          value={exchange.request.headers}
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
