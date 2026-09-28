import { useCallback, useMemo } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import { useOrgScopedWrite } from "@/hooks/useOrgScopedWrite";

/**
 * Trace destinations for one organization — where its traces are STREAMED.
 *
 * Reads are Convex subscriptions, which is what makes the health column and
 * the "Send test span" result live: the drain writes an outcome from a cron a
 * minute later, and the row updates itself rather than waiting for a refresh.
 *
 * Function ids are strings because this app has no generated Convex client;
 * the types below are hand-mirrored from `convex/traceDestinations.ts`
 * (`TraceDestinationView`). Keep them in sync by hand — nothing checks this at
 * build time.
 *
 * **These hooks can throw, and every call site MUST sit inside an
 * `ErrorBoundary`.** `useQuery` re-throws query errors during render, and
 * ordinary cases produce one here: the backend function is not deployed yet
 * (the two repos release independently), or the caller is not a member of the
 * org they passed — the backend refuses there deliberately. A call in a
 * component that is not itself inside a boundary takes that component's whole
 * page down. Call sites: `TraceDestinationsSection` and the `ObservabilityCard`
 * in `IntegrationsRoute`, each with its own boundary.
 *
 * Every query is gated on `useIsMemberActor` as well as `useDbUserReady`. Not
 * `useAuth().user`: the WorkOS user object flips truthy while the Convex socket
 * is still carrying the guest bearer hosted prod injects into every document,
 * and these queries are signed-in-only. That window is what put 320
 * guest-identity refusals into CONVEX-19R.
 */

/** A source of traces a destination can subscribe to. Mirrors the backend union. */
export type TraceDestinationSourceType =
  "eval" | "scenario" | "swarm" | "direct";

export interface TraceDestinationHealth {
  lastAttemptAt: number | null;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: string | null;
  lastDeliveryError: string | null;
  lastHttpStatus: number | null;
  consecutiveFailures: number;
  retryNotBefore: number | null;
  pendingCount: number;
  /** True when `pendingCount` hit the probe ceiling — show it as "N+". */
  pendingCountCapped: boolean;
  deliveredSessionCount: number;
  deliveredSpanCount: number;
  deadLetterCount: number;
}

export interface TraceDestination {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  endpointUrl: string;
  /** Header NAMES only. Values are write-only and never leave the backend. */
  headerNames: string[];
  resourceAttributes: Record<string, string>;
  sourceTypes: TraceDestinationSourceType[];
  includeContent: boolean;
  compression: "gzip" | "none";
  /** `null` means every project in the organization. */
  projectIds: string[] | null;
  preset: string | null;
  paused: { at: number; reason: string } | null;
  health: TraceDestinationHealth | null;
  lastTest: { at: number; status: string; error: string | null } | null;
  createdAt: number;
  updatedAt: number;
}

export interface TraceDestinationBackfillJob {
  _id: string;
  destinationId: string;
  organizationId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  sinceMs: number;
  scanned: number;
  enqueued: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

/**
 * `'enabled' | 'disabled' | 'unavailable'` once resolved; `undefined` while
 * loading or while the query is skipped.
 *
 * The tri-state is load-bearing. `disabled` means the backend said no,
 * `unavailable` means the caller is not a member, and `undefined` means we
 * have not asked yet. Treating the last as the first would hide the section
 * from a legitimately-flagged admin who cold-loads the URL directly.
 */
export type TraceDestinationsAvailability =
  | { state: "enabled" | "disabled" | "unavailable"; canEdit: boolean }
  | undefined;

/** Create/update payload. `headers` present ⇒ REPLACES the stored set. */
export interface TraceDestinationInput {
  name: string;
  endpointUrl: string;
  headers?: Record<string, string>;
  resourceAttributes?: Record<string, string>;
  sourceTypes?: TraceDestinationSourceType[];
  includeContent?: boolean;
  projectIds?: string[];
  compression?: "gzip" | "none";
  preset?: string;
  enabled?: boolean;
}

export function useTraceDestinationsAvailability(
  organizationId: string | null | undefined,
): TraceDestinationsAvailability {
  const isMember = useIsMemberActor();
  const isUserReady = useDbUserReady();
  const canQuery = Boolean(isMember && isUserReady && organizationId);

  return useQuery(
    "traceDestinations:getAvailability" as any,
    canQuery ? ({ organizationId } as any) : "skip",
  ) as TraceDestinationsAvailability;
}

export interface UseOrgTraceDestinationsResult {
  destinations: TraceDestination[] | undefined;
  isLoading: boolean;
  /** The last write's failure, cleared when the next write starts. */
  error: string | null;
  isSaving: boolean;
  createDestination: (input: TraceDestinationInput) => Promise<void>;
  updateDestination: (
    destinationId: string,
    input: Partial<TraceDestinationInput> & { allProjects?: boolean },
  ) => Promise<void>;
  deleteDestination: (destinationId: string) => Promise<void>;
  setEnabled: (destinationId: string, enabled: boolean) => Promise<void>;
  pauseDestination: (destinationId: string) => Promise<void>;
  /** Resolves with the instant the pause began, so the caller can offer a backfill. */
  resumeDestination: (destinationId: string) => Promise<number | null>;
  sendTestSpan: (destinationId: string) => Promise<void>;
  startBackfill: (destinationId: string, days: number) => Promise<void>;
}

export function useOrgTraceDestinations(
  organizationId: string | null,
): UseOrgTraceDestinationsResult {
  const isMember = useIsMemberActor();
  const isUserReady = useDbUserReady();
  const canQuery = Boolean(isMember && isUserReady && organizationId);

  const destinations = useQuery(
    "traceDestinations:listDestinations" as any,
    canQuery ? ({ organizationId } as any) : "skip",
  ) as TraceDestination[] | undefined;

  // Create and update are ACTIONS, not mutations: both write the header values
  // into the encrypted secret store, which needs Node.
  const create = useAction("traceDestinations:createDestination" as any);
  const update = useAction("traceDestinations:updateDestination" as any);
  const remove = useMutation("traceDestinations:deleteDestination" as any);
  const setEnabledMutation = useMutation("traceDestinations:setEnabled" as any);
  const pause = useMutation("traceDestinations:pauseDestination" as any);
  const resume = useMutation("traceDestinations:resumeDestination" as any);
  const test = useMutation("traceDestinations:sendTestSpan" as any);
  const backfill = useMutation("traceDestinations:startBackfill" as any);

  const { error, isSaving, run } = useOrgScopedWrite(organizationId);

  const createDestination = useCallback(
    async (input: TraceDestinationInput) => {
      if (!organizationId) return;
      await run(() => create({ organizationId, ...input } as any));
    },
    [create, organizationId, run],
  );

  const updateDestination = useCallback(
    async (
      destinationId: string,
      input: Partial<TraceDestinationInput> & { allProjects?: boolean },
    ) => {
      await run(() => update({ destinationId, ...input } as any));
    },
    [run, update],
  );

  const deleteDestination = useCallback(
    async (destinationId: string) => {
      await run(() => remove({ destinationId } as any));
    },
    [remove, run],
  );

  const setEnabled = useCallback(
    async (destinationId: string, enabled: boolean) => {
      await run(() => setEnabledMutation({ destinationId, enabled } as any));
    },
    [run, setEnabledMutation],
  );

  const pauseDestination = useCallback(
    async (destinationId: string) => {
      await run(() => pause({ destinationId } as any));
    },
    [pause, run],
  );

  const resumeDestination = useCallback(
    async (destinationId: string): Promise<number | null> => {
      let pausedSince: number | null = null;
      await run(async () => {
        const result = (await resume({ destinationId } as any)) as {
          pausedSince: number | null;
        } | null;
        pausedSince = result?.pausedSince ?? null;
      });
      return pausedSince;
    },
    [resume, run],
  );

  const sendTestSpan = useCallback(
    async (destinationId: string) => {
      await run(() => test({ destinationId } as any));
    },
    [run, test],
  );

  const startBackfill = useCallback(
    async (destinationId: string, days: number) => {
      await run(() => backfill({ destinationId, days } as any));
    },
    [backfill, run],
  );

  return useMemo(
    () => ({
      destinations,
      // "Not asked yet" is still NO ANSWER, not an org with no destinations.
      // `canQuery` stays false while the member/db-user checks settle, and a
      // consumer told isLoading=false in that window renders its empty state
      // and invites an admin to create a destination they may already have.
      isLoading: Boolean(organizationId) && destinations === undefined,
      error,
      isSaving,
      createDestination,
      updateDestination,
      deleteDestination,
      setEnabled,
      pauseDestination,
      resumeDestination,
      sendTestSpan,
      startBackfill,
    }),
    [
      createDestination,
      deleteDestination,
      destinations,
      error,
      isSaving,
      organizationId,
      pauseDestination,
      resumeDestination,
      sendTestSpan,
      setEnabled,
      startBackfill,
      updateDestination,
    ],
  );
}

export function useTraceDestinationBackfills(
  destinationId: string | null,
): TraceDestinationBackfillJob[] | undefined {
  const isMember = useIsMemberActor();
  const isUserReady = useDbUserReady();
  const canQuery = Boolean(isMember && isUserReady && destinationId);

  return useQuery(
    "traceDestinations:listBackfillJobs" as any,
    canQuery ? ({ destinationId } as any) : "skip",
  ) as TraceDestinationBackfillJob[] | undefined;
}
