import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptureAttempt } from "@mcpjam/sdk/browser";
import { HOSTED_MODE } from "@/lib/config";
import { authFetch } from "@/lib/session-token";
import { isListFailure, type RefreshState } from "./CaptureBanner";

/** The Inspector server's canvas refresh route, hosted and local. */
export const SERVER_CANVAS_REFRESH_PATH = {
  hosted: "/api/web/servers/canvas/refresh",
  local: "/api/mcp/servers/canvas/refresh",
} as const;

/** How long the page waits for refreshed evidence before it stops waiting. */
export const REFRESH_WAIT_MS = 60_000;

function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Asks the Inspector server to re-run the background probes for one project
 * server. "accepted" means work was queued; its results arrive through the
 * evidence subscription. "disabled" means the server canvas is off for this
 * caller.
 */
export async function requestServerCanvasRefresh(body: {
  projectId: string;
  serverId: string;
}): Promise<"accepted" | "disabled"> {
  const response = await authFetch(
    HOSTED_MODE
      ? SERVER_CANVAS_REFRESH_PATH.hosted
      : SERVER_CANVAS_REFRESH_PATH.local,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // An HTML error page from a proxy has no JSON body; the status below
    // still says what happened.
  }
  if (
    response.status === 409 &&
    (data as { status?: unknown } | null)?.status === "disabled"
  )
    return "disabled";
  if (!response.ok) {
    throw new Error(
      errorMessage(data) ?? "Could not start a refresh. Try again in a moment.",
    );
  }
  return "accepted";
}

type Pending = { startedAt: number; stamp: string };

/**
 * Refresh and its inline state: "Refreshing…" from the click until the
 * saved evidence changes or a minute passes, then the latest attempt's
 * error if that attempt failed.
 */
export function useServerCanvasRefresh({
  projectId,
  serverId,
  evidenceStamp,
  latestAttempt,
}: {
  projectId: string | null;
  serverId: string | null;
  evidenceStamp: string;
  latestAttempt?: CaptureAttempt;
}): { state: RefreshState; refresh: () => void } {
  const [state, setState] = useState<RefreshState>({ status: "idle" });
  const [pending, setPending] = useState<Pending | null>(null);
  const stampRef = useRef(evidenceStamp);
  stampRef.current = evidenceStamp;
  const attemptRef = useRef(latestAttempt);
  attemptRef.current = latestAttempt;

  const finish = useCallback((startedAt: number, timedOut: boolean) => {
    setPending(null);
    const attempt = attemptRef.current;
    if (attempt?.status === "failed" && attempt.at >= startedAt) {
      setState({
        status: "failed",
        message: isListFailure(attempt.error)
          ? "The refresh failed because one of the server's lists did not load. Try again in a moment."
          : "The refresh failed. Try again in a moment.",
      });
    } else if (timedOut) {
      setState({
        status: "failed",
        message:
          "The refresh did not finish within a minute. New results appear here when it does.",
      });
    } else {
      setState({ status: "idle" });
    }
  }, []);

  useEffect(() => {
    if (pending && evidenceStamp !== pending.stamp) finish(pending.startedAt, false);
  }, [evidenceStamp, pending, finish]);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(
      () => finish(pending.startedAt, true),
      REFRESH_WAIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pending, finish]);

  const refresh = useCallback(() => {
    if (!projectId || !serverId) return;
    const startedAt = Date.now();
    const stamp = stampRef.current;
    setState({ status: "running" });
    requestServerCanvasRefresh({ projectId, serverId }).then(
      (outcome) => {
        if (outcome === "disabled") setState({ status: "disabled" });
        else setPending({ startedAt, stamp });
      },
      (error: unknown) =>
        setState({
          status: "failed",
          message:
            error instanceof Error
              ? error.message
              : "Could not start a refresh. Try again in a moment.",
        }),
    );
  }, [projectId, serverId]);

  return { state, refresh };
}
