import { useConvex } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { SWARM_QUERIES } from "@/lib/swarm-api";

/**
 * The launch quote for the New swarm create flow.
 *
 * One-shot `convex.query` calls, the `use-run-cost-estimate` pattern rather
 * than a live subscription: the quote reads balances and run history, and
 * nothing about it needs to move while the user looks at it. It re-quotes
 * whenever the plan changes, and a slower answer to an older plan never paints
 * over a newer one.
 *
 * The quote advises; it does not decide. Launch admission re-checks each run
 * against the organization's credits, so a quote that fails to load must never
 * block a launch.
 */

/** One run the flow would launch, in the backend's argument vocabulary. */
export interface SwarmQuotePlannedRun {
  /** Echoed back on the run's quote. */
  key: string;
  journeyId?: string;
  environmentIds?: string[];
  sessionsPerTarget?: number;
  maxTurns?: number;
  setupWrites?: boolean;
}

export interface SwarmLaunchQuote {
  sessions: number;
  /** Sessions MCPJam funds as free starter conversations. */
  starterSessions: number;
  creditSessions: number;
  creditsRequiredP50: number;
  creditsRequiredP90: number;
  /** What admission needs available to launch the whole plan. */
  admitThreshold: number;
  creditsAvailable: number;
  /** Sessions, in plan order, the available credits admit. */
  maxAffordableSessions: number;
  fits: boolean;
  /** When the organization's daily credits refill. */
  resetsAt: number | null;
}

export type SwarmLaunchQuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; quote: SwarmLaunchQuote }
  | { status: "error" };

const COUNT_FIELDS = [
  "sessions",
  "starterSessions",
  "creditSessions",
  "creditsRequiredP50",
  "creditsRequiredP90",
  "admitThreshold",
  "creditsAvailable",
  "maxAffordableSessions",
] as const;

/**
 * The fields the flow reads, shape-checked. Anything else (an older backend's
 * answer, a malformed one) is no quote at all, which the flow treats like a
 * failed one: it says so and lets the launch go ahead.
 */
export function readSwarmLaunchQuote(raw: unknown): SwarmLaunchQuote | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const counts: Partial<Record<(typeof COUNT_FIELDS)[number], number>> = {};
  for (const field of COUNT_FIELDS) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return null;
    }
    counts[field] = value;
  }
  if (typeof record.fits !== "boolean") return null;
  const resetsAt =
    typeof record.resetsAt === "number" && Number.isFinite(record.resetsAt)
      ? record.resetsAt
      : null;
  return {
    ...(counts as Record<(typeof COUNT_FIELDS)[number], number>),
    fits: record.fits,
    resetsAt,
  };
}

export function useSwarmLaunchQuote({
  projectId,
  plannedRuns,
}: {
  projectId: string | null | undefined;
  /** `null` when there is no plan to price yet; nothing is fetched. */
  plannedRuns: SwarmQuotePlannedRun[] | null;
}): {
  state: SwarmLaunchQuoteState;
  /** Price another plan once, without touching `state` (the fit check). */
  quotePlan: (runs: SwarmQuotePlannedRun[]) => Promise<SwarmLaunchQuote | null>;
} {
  const convex = useConvex();
  const [state, setState] = useState<SwarmLaunchQuoteState>({
    status: "idle",
  });
  const requestIdRef = useRef(0);
  const argsKey =
    projectId && plannedRuns && plannedRuns.length > 0
      ? JSON.stringify([projectId, plannedRuns])
      : null;

  const quotePlan = useCallback(
    async (runs: SwarmQuotePlannedRun[]) => {
      if (!projectId || runs.length === 0) return null;
      try {
        return readSwarmLaunchQuote(
          await convex.query(
            SWARM_QUERIES.quoteSwarmLaunch as any,
            { projectId, plannedRuns: runs } as any,
          ),
        );
      } catch {
        return null;
      }
    },
    // `useConvex()` may return a new object each render; the client is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );

  useEffect(() => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    if (argsKey === null) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    const [, runs] = JSON.parse(argsKey) as [string, SwarmQuotePlannedRun[]];
    void quotePlan(runs).then((quote) => {
      if (requestId !== requestIdRef.current) return;
      setState(quote ? { status: "ready", quote } : { status: "error" });
    });
  }, [argsKey, quotePlan]);

  return { state, quotePlan };
}
