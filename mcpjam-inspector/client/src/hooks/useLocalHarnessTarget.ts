/**
 * The Hosted⇄Native execution-target choice for a Claude Code harness turn,
 * resolved for a project.
 *
 * ONE rule, applied everywhere the target is read, so the badge can never say
 * "on this machine" while the turn runs in a cloud sandbox:
 *
 *   1. HOSTED_MODE ⇒ hosted. Selector hidden, storage never read: a hosted
 *      replica running a harness on ITS machine is the structural thing the
 *      whole design forbids.
 *   2. The `local-harness-enabled` PostHog flag gates local CANDIDACY. Until a
 *      user is flagged in, `local-native` is never available or selectable, so
 *      the selector, the consent sheet, the installer and the attribution all
 *      stay dark even though the server may advertise the target.
 *   3. Candidates in order: stored preference → server default → local →
 *      hosted. The first that is AVAILABLE — and for `local-native`, whose
 *      consent capability EXISTS — wins.
 *   4. Nothing qualifies ⇒ `hosted`.
 *
 * ── The two answers, and why there are two ───────────────────────────────
 * `target` is consent-GATED and drives execution. `selectedTarget` is
 * consent-BLIND and drives which face renders.
 *
 * Without the split, picking "Native on this machine" before consenting would
 * resolve back to hosted and bounce the user to the hosted face — so the
 * consent sheet they were trying to reach would never appear, and the selector
 * would look broken. `useComputerEngine` learned this first; the shape is
 * copied deliberately rather than re-derived.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { useLocalHarnessEnabled } from "@/hooks/useComputersEnabled";
import {
  fetchLocalHarnessAvailability,
  loadStoredLocalHarnessConsent,
  subscribeLocalHarnessConsent,
  type LocalHarnessAvailabilityView,
  type StoredLocalHarnessConsent,
} from "@/lib/local-harness-consent";

export type HarnessExecutionTarget = "hosted" | "local-native";

const STORAGE_PREFIX = "mcp-local-harness-target-v1";
const TARGET_EVENT = "local-harness-target-changed";

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}:${projectId}`;
}

export function loadStoredHarnessTarget(
  projectId: string,
): HarnessExecutionTarget | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    return raw === "hosted" || raw === "local-native" ? raw : null;
  } catch {
    return null;
  }
}

export function saveHarnessTarget(
  projectId: string,
  target: HarnessExecutionTarget,
): void {
  try {
    localStorage.setItem(storageKey(projectId), target);
    window.dispatchEvent(new CustomEvent(TARGET_EVENT));
  } catch {
    // A preference we cannot store is a preference that resets next load. The
    // resolution below still honours it for this session because it is read
    // through the same subscription that just fired.
  }
}

function subscribeTarget(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(STORAGE_PREFIX)) callback();
  };
  window.addEventListener(TARGET_EVENT, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TARGET_EVENT, callback);
    window.removeEventListener("storage", onStorage);
  };
}

export interface LocalHarnessTargetState {
  /** Consent-gated. What a turn actually runs on. */
  target: HarnessExecutionTarget;
  /** Consent-blind. Which face renders, so the consent sheet is reachable. */
  selectedTarget: HarnessExecutionTarget;
  /** Whether the local target is offerable at all on this machine right now. */
  localAvailable: boolean;
  /** Server's own answer, for the reason text when it is not. */
  availability: LocalHarnessAvailabilityView | null;
  consent: StoredLocalHarnessConsent | null;
  /** True until availability has been fetched once. */
  loading: boolean;
  select: (target: HarnessExecutionTarget) => void;
  refresh: () => void;
}

export function useLocalHarnessTarget(
  projectId: string | null | undefined,
): LocalHarnessTargetState {
  const flagEnabled = useLocalHarnessEnabled();
  const [availability, setAvailability] =
    useState<LocalHarnessAvailabilityView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  // Consent and the stored preference are read through `useSyncExternalStore`
  // so a grant in another tab — or in this one — re-renders every consumer at
  // once, with no polling and no effect ordering to get wrong.
  const consentSnapshot = useSyncExternalStore(
    subscribeLocalHarnessConsent,
    () => (projectId ? localStorage.getItem(`mcp-local-harness-consent-v1:${projectId}`) : null),
    () => null,
  );
  const storedTarget = useSyncExternalStore(
    subscribeTarget,
    () => (projectId ? loadStoredHarnessTarget(projectId) : null),
    () => null,
  );

  const consent = useMemo(
    () => (projectId ? loadStoredLocalHarnessConsent(projectId) : null),
    // `consentSnapshot` is the raw storage string; parsing happens here so the
    // subscription compares a stable primitive rather than a fresh object.
    [projectId, consentSnapshot],
  );

  useEffect(() => {
    // Never ask the server about a capability the flag says the user does not
    // have: the route would answer, and the answer would be a fact about this
    // machine that a dark-launched user has no business learning.
    if (HOSTED_MODE || !flagEnabled) {
      setAvailability(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchLocalHarnessAvailability().then((result) => {
      if (cancelled) return;
      setAvailability(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [flagEnabled, refreshToken]);

  const localAvailable =
    !HOSTED_MODE && flagEnabled && availability?.available === true;

  // The candidate race. `serverDefault` is deliberately absent for now — the
  // server has no opinion about which target a project should prefer, and
  // inventing one here would be a preference nobody set.
  const selectedTarget: HarnessExecutionTarget = useMemo(() => {
    if (HOSTED_MODE || !flagEnabled) return "hosted";
    if (storedTarget === "local-native" && localAvailable) return "local-native";
    if (storedTarget === "hosted") return "hosted";
    return "hosted";
  }, [flagEnabled, storedTarget, localAvailable]);

  // Consent-gated: the same answer, except that `local-native` additionally
  // requires a stored grant. This is what a turn reads.
  const target: HarnessExecutionTarget =
    selectedTarget === "local-native" && consent !== null
      ? "local-native"
      : "hosted";

  const select = useCallback(
    (next: HarnessExecutionTarget) => {
      if (!projectId) return;
      saveHarnessTarget(projectId, next);
    },
    [projectId],
  );

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  return {
    target,
    selectedTarget,
    localAvailable,
    availability,
    consent,
    loading,
    select,
    refresh,
  };
}
