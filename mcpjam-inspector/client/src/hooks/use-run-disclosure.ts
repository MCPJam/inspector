import { useEffect, useRef, useState } from "react";
import { isPlatformApiError } from "@mcpjam/sdk/platform";
import type { PlatformEvalRunDisclosure } from "@mcpjam/sdk/platform";
import { fetchRunDisclosure } from "@/lib/apis/eval-disclosure-api";
import { getHostedProjectId } from "@/lib/apis/web/context";

/**
 * Fetch hook for the pre-run disclosure hint — same shape as
 * `use-run-cost-estimate.ts`'s `useFetchOnOpenEstimate`: fetch once when the
 * hint opens, re-fetch when the arguments change while it is still open, and
 * drop the subscription entirely when it closes. Out-of-order responses are
 * discarded by request id, same reason: rapidly opening, changing targets,
 * and re-opening must never paint a stale disclosure over a newer one.
 *
 * Over `authFetch` (via `eval-disclosure-api.ts`'s wrapped `PlatformApiClient`),
 * NOT `useConvex()` — this is a v1 REST read, not a Convex query, and the
 * inspector composes `execution.locus` onto it server-side.
 */

export type RunDisclosureStatus = "idle" | "loading" | "ready" | "error";

export interface RunDisclosureErrorInfo {
  message: string;
  /**
   * True when the backend predates the pre-run disclosure contract
   * (`FEATURE_NOT_SUPPORTED` / `details.reason === "contract_unavailable"`) —
   * distinct from a transient fetch failure, so a caller can render "not
   * available on this deployment" rather than "couldn't load".
   */
  contractUnavailable: boolean;
  /**
   * True when the launch fans out across SEVERAL targets, so the contract has
   * no single plan to answer for — never a fetch failure. The disclosure
   * covers one launch plan, and a "Run all" spanning hosts has no single
   * engine or model set to describe. Mirrors the SDK's
   * `isMultiTargetHostLaunch` skip in `runEvalSuiteOperation`.
   *
   * Named for the multi-target limit rather than the host axis: a SINGLE
   * attached host is fetched and disclosed like any environment since G4c
   * (`getRunDisclosure` takes `namedHostId`), so the old `hostAxisUnavailable`
   * spelling named a case that no longer refuses.
   *
   * Optional — every REAL fetch failure (the only place this hook itself
   * constructs one) sets it explicitly to `false`; only the static
   * multi-target state in `run-disclosure-hint.tsx` sets it `true`.
   */
  multiTargetUnavailable?: boolean;
}

export interface RunDisclosureState {
  status: RunDisclosureStatus;
  disclosure: PlatformEvalRunDisclosure | null;
  error: RunDisclosureErrorInfo | null;
  /** Call when the hint opens (`true`) or closes (`false`). */
  setOpen: (open: boolean) => void;
  open: boolean;
}

function isContractUnavailableError(error: unknown): boolean {
  if (!isPlatformApiError(error) || error.code !== "FEATURE_NOT_SUPPORTED") {
    return false;
  }
  return (
    (error.details as Record<string, unknown> | undefined)?.reason ===
    "contract_unavailable"
  );
}

export function useRunDisclosure({
  enabled,
  suiteId,
  caseIds,
  environmentIds,
  namedHostId,
}: {
  enabled: boolean;
  suiteId: string | null | undefined;
  caseIds?: readonly string[];
  environmentIds?: readonly string[];
  /**
   * Disclose for a HOST-axis launch (G4c) — the single attached host "Run
   * all" would target when the suite has no attached environments. Mutually
   * exclusive with `environmentIds` by construction at the callsite: the
   * environment axis always wins when both are attached, the same rule
   * `computeRunTargets` uses.
   */
  namedHostId?: string;
}): RunDisclosureState {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RunDisclosureStatus>("idle");
  const [disclosure, setDisclosure] =
    useState<PlatformEvalRunDisclosure | null>(null);
  const [error, setError] = useState<RunDisclosureErrorInfo | null>(null);

  // Monotonic request id. Only the newest in-flight request may write state —
  // see `use-run-cost-estimate.ts` for the same guard and the same reason.
  const requestIdRef = useRef(0);

  const caseIdsKey = caseIds ? JSON.stringify([...caseIds]) : "";
  const environmentIdsKey = environmentIds
    ? JSON.stringify([...environmentIds])
    : "";
  const active = enabled && open && Boolean(suiteId);

  useEffect(() => {
    if (!active) {
      // Closing (or being disabled) invalidates any in-flight request as well
      // as the painted value — reopening always re-fetches rather than
      // flashing a stale disclosure.
      requestIdRef.current += 1;
      setStatus("idle");
      setDisclosure(null);
      setError(null);
      return;
    }

    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const controller = new AbortController();
    setStatus("loading");
    setError(null);

    void (async () => {
      try {
        const projectId = getHostedProjectId();
        const result = await fetchRunDisclosure(
          {
            projectId,
            suiteId: suiteId as string,
            ...(caseIds && caseIds.length > 0 ? { caseIds } : {}),
            ...(environmentIds && environmentIds.length > 0
              ? { environmentIds }
              : {}),
            ...(namedHostId ? { namedHostId } : {}),
          },
          controller.signal,
        );
        if (requestId !== requestIdRef.current) return;
        setDisclosure(result);
        setStatus("ready");
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setDisclosure(null);
        setError({
          message: err instanceof Error ? err.message : String(err),
          contractUnavailable: isContractUnavailableError(err),
          multiTargetUnavailable: false,
        });
        setStatus("error");
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, suiteId, caseIdsKey, environmentIdsKey, namedHostId]);

  return { status, disclosure, error, open, setOpen };
}
