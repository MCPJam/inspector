import { ListChecks, Loader2, PlugZap, RefreshCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type {
  CaptureAttempt,
  CaptureContext,
  EvidenceContextOption,
  ProbeFailure,
  ServerProbeId,
} from "@mcpjam/sdk/browser";
import { formatEvidenceTime } from "./feature-states";

export type CaptureStatus = "never" | "disconnected" | "connected";

export type RefreshState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "failed"; message: string }
  | { status: "disabled" };

const TRANSPORT_LABELS: Record<CaptureContext["transport"], string> = {
  stdio: "stdio",
  "streamable-http": "Streamable HTTP",
  sse: "HTTP+SSE",
  unknown: "Unknown transport",
};

const PROBE_LABELS: Record<ServerProbeId, string> = {
  "http-transport": "HTTP transport",
  authorization: "authorization metadata",
  "server-card": "Server Card",
  "apps-ui-resources": "MCP Apps UI resources",
  skills: "Skills",
  "events-list": "Events list",
};

/** "2025-11-25 · Streamable HTTP · claude-desktop", for headers and pickers. */
export function describeCaptureContext(context: CaptureContext | undefined): string {
  if (!context) return "No saved context";
  const parts = [
    context.protocolVersion ?? "Unknown version",
    TRANSPORT_LABELS[context.transport],
  ];
  if (context.hostProfile) parts.push(context.hostProfile);
  if (context.accountBinding) parts.push("connected account");
  return parts.join(" · ");
}

/** Picker labels, numbered where two contexts would read the same. */
function contextLabels(contexts: readonly EvidenceContextOption[]): string[] {
  const seen = new Map<string, number>();
  return contexts.map((option) => {
    const base = describeCaptureContext(option.context);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/**
 * Saved attempts carry a fixed code, never the server's own message, so
 * only known codes are put into words and anything else is left out. Each
 * sentence that names the cause is written out whole, with its next step.
 */
export function isListFailure(error: string | undefined): boolean {
  return error === "list_failed";
}

/**
 * The failed attempt and how to try again, as one sentence pair. The shown
 * evidence, if any, is named by the capture line above it.
 */
function attemptLine(attempt: CaptureAttempt, connected: boolean): string {
  const at = formatEvidenceTime(attempt.at);
  const failed = attempt.status === "failed";
  if (isListFailure(attempt.error)) {
    if (failed)
      return connected
        ? `The capture on ${at} failed because one of the server's lists did not load. Refresh to try again.`
        : `The capture on ${at} failed because one of the server's lists did not load. Connect to try again.`;
    return connected
      ? `The capture on ${at} was incomplete because one of the server's lists did not load. Refresh to try again.`
      : `The capture on ${at} was incomplete because one of the server's lists did not load. Connect to try again.`;
  }
  if (failed)
    return connected
      ? `The capture on ${at} failed. Refresh to try again.`
      : `The capture on ${at} failed. Connect to try again.`;
  return connected
    ? `The capture on ${at} was incomplete. Refresh to try again.`
    : `The capture on ${at} was incomplete. Connect to try again.`;
}

function captureLine(
  status: CaptureStatus,
  capturedAt: number | undefined,
  attemptFailed: boolean,
): string {
  if (status === "never")
    return "This server has not been connected yet. Connect it to check its features.";
  if (status === "disconnected") {
    if (capturedAt)
      return `Disconnected. Showing what was saved on ${formatEvidenceTime(capturedAt)}.`;
    return attemptFailed
      ? "Server disconnected. Nothing was saved. Reconnect it to capture its features."
      : "Disconnected. Nothing was saved for this server yet. Connect it to check its features.";
  }
  if (capturedAt) return `Captured ${formatEvidenceTime(capturedAt)}.`;
  return attemptFailed
    ? "Nothing was saved for this server."
    : "Nothing was captured for this server yet. Refresh to capture it.";
}

/**
 * The capture state above the canvas: when the shown evidence was saved, a
 * failed attempt beside it (the last good evidence stays) or, with nothing
 * saved, the failed attempt and how to try again, probe failures,
 * the context picker when evidence exists for several contexts, and the
 * Refresh and Run checks actions.
 */
export function CaptureBanner({
  status,
  capturedAt,
  latestAttempt,
  probeFailures,
  contexts,
  selectedContextHash,
  onSelectContext,
  refresh,
  onRefresh,
  onRunChecks,
  onConnect,
  connecting = false,
}: {
  status: CaptureStatus;
  capturedAt?: number;
  latestAttempt?: CaptureAttempt;
  probeFailures: readonly ProbeFailure[];
  contexts: readonly EvidenceContextOption[];
  selectedContextHash?: string;
  onSelectContext: (contextHash: string) => void;
  refresh: RefreshState;
  onRefresh: () => void;
  onRunChecks: () => void;
  onConnect: () => void;
  connecting?: boolean;
}) {
  const labels = contextLabels(contexts);
  const failedProbes = probeFailures.filter((failure) => failure.status === "failed");
  return (
    <div
      data-testid="capture-banner"
      data-status={status}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-foreground">
          {captureLine(status, capturedAt, latestAttempt !== undefined)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {status === "connected" ? null : (
            <Button type="button" size="sm" onClick={onConnect} disabled={connecting}>
              {connecting ? (
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
              ) : (
                <PlugZap aria-hidden className="size-3.5" />
              )}
              Connect
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={status !== "connected" || refresh.status === "running"}
          >
            {refresh.status === "running" ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw aria-hidden className="size-3.5" />
            )}
            {refresh.status === "running" ? "Refreshing…" : "Refresh"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onRunChecks}>
            <ListChecks aria-hidden className="size-3.5" />
            Run checks
          </Button>
        </div>
      </div>

      {contexts.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span id="capture-context-label">Showing evidence for</span>
          <Select value={selectedContextHash} onValueChange={onSelectContext}>
            <SelectTrigger size="sm" aria-labelledby="capture-context-label" className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {contexts.map((option, index) => (
                <SelectItem key={option.contextHash} value={option.contextHash}>
                  {labels[index]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>Evidence from different contexts is never combined.</span>
        </div>
      ) : null}

      {latestAttempt ? (
        <p role="status" className="text-destructive">
          {attemptLine(latestAttempt, status === "connected")}
        </p>
      ) : null}

      {failedProbes.length > 0 ? (
        <p className="text-muted-foreground">
          {`Background checks failed for ${failedProbes
            .map((failure) => PROBE_LABELS[failure.probeId])
            .join(", ")}. Refresh to try them again.`}
        </p>
      ) : null}

      {refresh.status === "failed" ? (
        <p role="alert" className="text-destructive">
          {refresh.message}
        </p>
      ) : refresh.status === "disabled" ? (
        <p role="status" className="text-muted-foreground">
          Refresh is turned off for this account.
        </p>
      ) : null}
    </div>
  );
}
