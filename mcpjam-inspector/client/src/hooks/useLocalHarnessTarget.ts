/**
 * The local Claude Code execution controller: what the user asked for, what the
 * machine is doing about it, and what a turn may actually carry.
 *
 * ── Three pieces of state, deliberately not one ──────────────────────────
 * The previous shape collapsed everything into two booleans, and every bug in
 * it came from that. Here they stay apart:
 *
 *   REQUESTED TARGET — the user's explicit choice. Survives readiness,
 *     sign-out, expiry and install failure. Losing it is how an explicit "run
 *     on my machine" silently became a cloud turn.
 *   RUNTIME OPERATION — what the install is doing, shared across Inspector
 *     windows through the server's own record.
 *   AUTHORIZATION — the stored consent grant, and the in-memory approval that
 *     has been captured but not yet spent.
 *
 * `phase` is DERIVED from those three on every render. It is not a fourth
 * mutable copy: a stored phase and the facts it summarizes drift within one
 * async round trip, and the drift always shows up as a dialog that will not
 * close or a Send that will not enable.
 *
 * ── What never happens here ──────────────────────────────────────────────
 * Nothing in this hook downloads anything or mints anything on its own.
 * Mounting, polling, remounting, focusing and reconnecting are all reads.
 * A download happens on **Install & allow** and nowhere else; a grant is minted
 * only against an approval a human clicked, and only after the context it was
 * clicked under is re-checked.
 *
 * ── Why "unknown" is never resolved to a target ──────────────────────────
 * A failed availability fetch, a 401, and a first render before anything has
 * loaded are all *unknown* — not "cloud is available" and not "cloud is
 * absent". Picking a default from any of them would either hide the local
 * option on a machine that has it, or claim a cloud target that does not
 * exist. So the default is only ever chosen from a SUCCESSFUL response, and
 * everything else shows a loading or recovery state.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { HOSTED_MODE } from "@/lib/config";
import { useLocalHarnessEnabled } from "@/hooks/useComputersEnabled";
import {
  fetchLocalHarnessAvailability,
  fetchLocalHarnessRuntimeStatus,
  mintLocalHarnessConsent,
  parseStoredLocalHarnessConsent,
  persistLocalHarnessConsent,
  readLocalHarnessConsentSnapshot,
  registerLocalHarnessWorkspace,
  revokeLocalHarnessConsent,
  revokeLocalHarnessGrantId,
  startLocalHarnessRuntimeInstall,
  subscribeLocalHarnessConsent,
  type LocalHarnessAvailabilityView,
  type LocalHarnessConsentExpectations,
  type LocalHarnessError,
  type LocalHarnessRuntimeStatus,
  type StoredLocalHarnessConsent,
} from "@/lib/local-harness-consent";

export type HarnessExecutionTarget = "hosted" | "local-native";

const STORAGE_PREFIX = "mcp-local-harness-target-v1";
const TARGET_EVENT = "local-harness-target-changed";
/** How often to re-read a running install. Matches the route's Retry-After. */
const POLL_INTERVAL_MS = 1_000;

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

/**
 * What the UI renders, and what the gate reads.
 *
 * One value with a reason beside it, rather than a pile of booleans a caller
 * has to reassemble in the right order.
 */
export type LocalHarnessPhase =
  /** Nothing is known yet, or the last fetch failed and told us nothing. */
  | "loading"
  /** This Inspector cannot run Claude Code locally at all. */
  | "unavailable"
  /** A member identity is required and there is not one. */
  | "needs-signin"
  /** No folder has been chosen or registered yet. */
  | "needs-workspace"
  /** Everything is in place except a consent grant. */
  | "needs-consent"
  /** A runtime install is running (here or in another window). */
  | "installing"
  /** A grant request is in flight. */
  | "authorizing"
  /** The last install attempt failed with a named reason. */
  | "failed"
  /** The last install attempt was abandoned by its owner. */
  | "interrupted"
  /** A verified runtime and a valid grant: a turn can run. */
  | "ready";

export interface LocalHarnessPendingApproval {
  attemptId: string;
  /** What the human was shown and clicked against. */
  expectations: LocalHarnessConsentExpectations;
  projectId: string;
  workspaceGrantId: string;
  workspaceDisplayRoot: string;
  /** The signed-in user at the moment of approval. */
  userKey: string | null;
  /** The host/surface this approval was captured for. */
  scopeKey: string;
  approvedAt: number;
}

export interface LocalHarnessControllerState {
  /** The user's explicit choice, preserved through everything below. */
  requestedTarget: HarnessExecutionTarget | null;
  /** What a turn would actually run on right now. */
  effectiveTarget: HarnessExecutionTarget;
  phase: LocalHarnessPhase;
  /** Why the phase is what it is, when there is something to say. */
  reason: string | null;
  availability: LocalHarnessAvailabilityView | null;
  /** True until availability has resolved once, successfully or otherwise. */
  loading: boolean;
  /** Set when the last availability fetch failed. Not "cloud is absent". */
  availabilityError: LocalHarnessError | null;
  runtimeStatus: LocalHarnessRuntimeStatus | null;
  /** A temporary status-fetch failure, distinct from a failed install. */
  statusFetchFailed: boolean;
  consent: StoredLocalHarnessConsent | null;
  workspace: { workspaceGrantId: string; displayRoot: string } | null;
  pendingApproval: LocalHarnessPendingApproval | null;
  /** Only meaningful from a SUCCESSFUL availability response. */
  hostedAvailable: boolean | null;

  select: (target: HarnessExecutionTarget) => void;
  refresh: () => void;
  chooseWorkspace: (
    selection: { path: string } | { useSuggested: true },
  ) => Promise<{ ok: true } | LocalHarnessError>;
  /** Capture what the human approved. Does not download and does not mint. */
  captureApproval: (args: {
    expectations: LocalHarnessConsentExpectations;
    scopeKey: string;
  }) => LocalHarnessPendingApproval | null;
  /** Discard a captured approval. Setup already running is not stopped. */
  cancelApproval: () => void;
  /** Start (or join) an install for the captured approval. */
  startInstall: () => Promise<
    { ok: true; kind: "accepted" | "ready" } | LocalHarnessError
  >;
  /** Mint and persist a grant for the still-current approval. */
  authorize: () => Promise<
    { ok: true; consent: StoredLocalHarnessConsent } | LocalHarnessError
  >;
  revoke: () => Promise<void>;
  /** A fresh, re-checked snapshot for one send. Null ⇒ do not send local. */
  resolveSendTarget: () => {
    target: StoredLocalHarnessConsent["target"];
    token: string;
  } | null;
}

export interface UseLocalHarnessControllerArgs {
  projectId: string | null | undefined;
  /**
   * The signed-in member, as the surface knows it. Null ⇒ signed out.
   *
   * Not used AS an identity — the server resolves that — but a change to it
   * invalidates a captured approval, because the human who clicked is not
   * necessarily the human who would now run.
   */
  userKey: string | null;
  /** True when the previewed host/surface is in local-harness scope. */
  inScope: boolean;
  /** Identifies the host/surface an approval was captured under. */
  scopeKey: string;
}

export function useLocalHarnessController(
  args: UseLocalHarnessControllerArgs,
): LocalHarnessControllerState {
  const { projectId, userKey, inScope, scopeKey } = args;
  const flagEnabled = useLocalHarnessEnabled();
  const offerable = !HOSTED_MODE && flagEnabled;

  const [availability, setAvailability] =
    useState<LocalHarnessAvailabilityView | null>(null);
  const [availabilityError, setAvailabilityError] =
    useState<LocalHarnessError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  const [runtimeStatus, setRuntimeStatus] =
    useState<LocalHarnessRuntimeStatus | null>(null);
  const [statusFetchFailed, setStatusFetchFailed] = useState(false);
  /**
   * The attempt this hook is observing.
   *
   * A REF, not state: nothing renders from it, and a re-render on every poll
   * would be a render per second for a value only the poll compares against.
   * Its job is to let a late response from a superseded attempt be dropped.
   */
  const observedAttemptRef = useRef<string | null>(null);

  const [workspace, setWorkspace] = useState<{
    workspaceGrantId: string;
    displayRoot: string;
  } | null>(null);

  const [pendingApproval, setPendingApproval] =
    useState<LocalHarnessPendingApproval | null>(null);
  const pendingApprovalRef = useRef<LocalHarnessPendingApproval | null>(null);
  pendingApprovalRef.current = pendingApproval;

  const [authorizing, setAuthorizing] = useState(false);

  // ── Consent, read through the store so another tab re-renders us ─────────
  //
  // The snapshot is the raw STRING: `useSyncExternalStore` compares snapshots
  // by identity, and a fresh parsed object on every read is an infinite render
  // loop.
  const consentSnapshot = useSyncExternalStore(
    subscribeLocalHarnessConsent,
    () => readLocalHarnessConsentSnapshot(projectId),
    () => null,
  );
  const storedTarget = useSyncExternalStore(
    subscribeTarget,
    () => (projectId ? loadStoredHarnessTarget(projectId) : null),
    () => null,
  );

  // ── Expiry ───────────────────────────────────────────────────────────────
  //
  // A grant expires by the CLOCK, and no storage event fires when it does. The
  // memo below is keyed on this counter as well as the snapshot string, so a
  // timer (or a focus, or a pre-send check) forces a re-parse — re-reading the
  // same string cannot notice that time passed, because the expiry comparison
  // lives inside the parse.
  const [expiryTick, setExpiryTick] = useState(0);
  const consent = useMemo(
    () => parseStoredLocalHarnessConsent(consentSnapshot),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `expiryTick` is
    // the invalidation signal; it is intentionally read for its identity only.
    [consentSnapshot, expiryTick],
  );

  useEffect(() => {
    if (consent === null) return;
    const expiresAt = Date.parse(consent.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const delay = Math.max(0, expiresAt - Date.now());
    // A background tab's timers are throttled and a sleeping laptop's do not
    // run at all, so the timer is a convenience rather than the guarantee. The
    // guarantees are the focus listener below and the pre-send re-check in
    // `resolveSendTarget`.
    const timer = setTimeout(
      () => setExpiryTick((n) => n + 1),
      Math.min(delay + 250, 2_147_483_000),
    );
    return () => clearTimeout(timer);
  }, [consent]);

  useEffect(() => {
    const recheck = () => setExpiryTick((n) => n + 1);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("online", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("online", recheck);
    };
  }, []);

  // ── Availability ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!offerable || !inScope) {
      setAvailability(null);
      setAvailabilityError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchLocalHarnessAvailability().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAvailability(result.availability);
        setAvailabilityError(null);
        setRuntimeStatus(result.availability.runtimeStatus);
      } else {
        // Kept as an ERROR, never folded into "no local target". A 401 means
        // sign in; a network failure means retry; neither means this machine
        // cannot run Claude Code.
        setAvailability(null);
        setAvailabilityError(result);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [offerable, inScope, refreshToken]);

  // Re-read on remount, focus and reconnect. Cheap, and it is what makes a
  // second window notice the first one's finished install.
  useEffect(() => {
    if (!offerable || !inScope) return;
    const reconcile = () => setRefreshToken((n) => n + 1);
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    return () => {
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
    };
  }, [offerable, inScope]);

  // ── Polling a running install ────────────────────────────────────────────
  //
  // Runs whenever the OPERATION is active, regardless of whether a dialog is
  // open or a workspace has been chosen: the install is a machine-wide fact,
  // and a user who closed the dialog still needs the composer to say what is
  // happening. Stops at a terminal result. Never starts work.
  const operationActive =
    runtimeStatus?.state === "downloading" || runtimeStatus?.state === "verifying";

  useEffect(() => {
    if (!offerable || !inScope || !operationActive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const result = await fetchLocalHarnessRuntimeStatus();
      if (cancelled) return;
      if (!result.ok) {
        // A status fetch that failed is NOT a failed install. Saying so would
        // turn a flaky loopback read into "your download failed", and the user
        // would retry something that is still running.
        setStatusFetchFailed(true);
      } else {
        setStatusFetchFailed(false);
        const observed = observedAttemptRef.current;
        const incoming = result.status.attemptId ?? null;
        // A late response from a SUPERSEDED attempt is dropped. Without this a
        // slow poll from the previous attempt can overwrite the state of the
        // retry that replaced it.
        if (
          observed !== null &&
          incoming !== null &&
          incoming !== observed &&
          result.status.state !== "ready"
        ) {
          return;
        }
        setRuntimeStatus(result.status);
        if (incoming !== null && observed === null) {
          observedAttemptRef.current = incoming;
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [offerable, inScope, operationActive]);

  // ── Invalidating a captured approval ─────────────────────────────────────
  //
  // Everything a human's click was ABOUT. If any of it changes, the click no
  // longer describes what would happen, so the approval is discarded and the
  // dialog is the way back. Kept in one effect so a new invalidation reason is
  // added in one place rather than three.
  useEffect(() => {
    if (pendingApproval === null) return;
    const stale =
      pendingApproval.projectId !== (projectId ?? "") ||
      pendingApproval.userKey !== userKey ||
      pendingApproval.scopeKey !== scopeKey ||
      !inScope ||
      !offerable ||
      (workspace !== null &&
        workspace.workspaceGrantId !== pendingApproval.workspaceGrantId);
    if (stale) setPendingApproval(null);
  }, [
    pendingApproval,
    projectId,
    userKey,
    scopeKey,
    inScope,
    offerable,
    workspace,
  ]);

  // A change in the runtime or policy the approval named invalidates it too:
  // approving version 3.4.0 is not approving 3.5.0.
  useEffect(() => {
    if (pendingApproval === null || availability === null) return;
    const expected = availability.expectedPack;
    const drifted =
      (expected !== null &&
        (expected.packVersion !== pendingApproval.expectations.packVersion ||
          expected.treeDigest !== pendingApproval.expectations.treeDigest)) ||
      availability.policyVersion !== pendingApproval.expectations.policyVersion ||
      availability.permissionProfile !==
        pendingApproval.expectations.permissionProfile ||
      (availability.machineId !== null &&
        availability.machineId !== pendingApproval.expectations.machineId);
    if (drifted) setPendingApproval(null);
  }, [pendingApproval, availability]);

  // ── The requested target ─────────────────────────────────────────────────
  const hostedAvailable = availability?.hostedAvailable ?? null;

  const requestedTarget: HarnessExecutionTarget | null = useMemo(() => {
    if (!offerable || !inScope) return null;
    if (storedTarget !== null) return storedTarget;
    // A default is chosen ONLY from a successful response that says no cloud
    // target exists. Loading, a failed fetch and a 401 all leave this null —
    // none of them is evidence either way, and inventing an answer from one is
    // how a machine with no data plane ends up showing a cloud option, or a
    // machine with one silently loses the choice.
    if (availability !== null && availability.hostedAvailable === false) {
      return "local-native";
    }
    return null;
  }, [offerable, inScope, storedTarget, availability]);

  const effectiveTarget: HarnessExecutionTarget =
    requestedTarget === "local-native" && consent !== null
      ? "local-native"
      : "hosted";

  // ── The derived phase ────────────────────────────────────────────────────
  const { phase, reason } = useMemo((): {
    phase: LocalHarnessPhase;
    reason: string | null;
  } => {
    if (!offerable || !inScope) return { phase: "unavailable", reason: null };
    if (availabilityError !== null) {
      if (
        availabilityError.kind === "unauthenticated" ||
        availabilityError.kind === "forbidden"
      ) {
        return { phase: "needs-signin", reason: availabilityError.message };
      }
      if (availabilityError.kind === "not-found") {
        return {
          phase: "unavailable",
          reason: "Running Claude Code on this machine is off on this server.",
        };
      }
      // A network failure or a 5xx tells us nothing about this machine, so the
      // honest phase is "we do not know yet", not "unavailable".
      return { phase: "loading", reason: availabilityError.message };
    }
    if (loading || availability === null) return { phase: "loading", reason: null };
    if (userKey === null) {
      return {
        phase: "needs-signin",
        reason:
          "Sign in to authorize Claude Code to run on this machine.",
      };
    }
    if (
      availability.status === "platform-not-supported" ||
      availability.status === "ownership-unprovable" ||
      availability.runtimeStatus.state === "unsupported-platform"
    ) {
      return { phase: "unavailable", reason: availability.message };
    }

    const status = runtimeStatus ?? availability.runtimeStatus;
    if (status.state === "downloading" || status.state === "verifying") {
      return { phase: "installing", reason: null };
    }
    if (status.state === "failed") {
      return { phase: "failed", reason: status.message ?? null };
    }
    if (status.state === "interrupted") {
      return { phase: "interrupted", reason: status.message ?? null };
    }
    if (authorizing) return { phase: "authorizing", reason: null };
    if (consent !== null) return { phase: "ready", reason: null };
    if (workspace === null && availability.suggestedWorkspace === null) {
      return { phase: "needs-workspace", reason: null };
    }
    return { phase: "needs-consent", reason: null };
  }, [
    offerable,
    inScope,
    availabilityError,
    loading,
    availability,
    userKey,
    runtimeStatus,
    authorizing,
    consent,
    workspace,
  ]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const select = useCallback(
    (next: HarnessExecutionTarget) => {
      if (!projectId) return;
      saveHarnessTarget(projectId, next);
    },
    [projectId],
  );

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  const chooseWorkspace = useCallback(
    async (
      selection: { path: string } | { useSuggested: true },
    ): Promise<{ ok: true } | LocalHarnessError> => {
      const result = await registerLocalHarnessWorkspace(selection);
      if (!result.ok) return result;
      setWorkspace({
        workspaceGrantId: result.workspaceGrantId,
        displayRoot: result.displayRoot,
      });
      return { ok: true };
    },
    [],
  );

  const captureApproval = useCallback(
    (capture: {
      expectations: LocalHarnessConsentExpectations;
      scopeKey: string;
    }): LocalHarnessPendingApproval | null => {
      if (!projectId || workspace === null) return null;
      const approval: LocalHarnessPendingApproval = {
        attemptId: `approval_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
        expectations: capture.expectations,
        projectId,
        workspaceGrantId: workspace.workspaceGrantId,
        workspaceDisplayRoot: workspace.displayRoot,
        userKey,
        scopeKey: capture.scopeKey,
        approvedAt: Date.now(),
      };
      pendingApprovalRef.current = approval;
      setPendingApproval(approval);
      return approval;
    },
    [projectId, workspace, userKey],
  );

  const cancelApproval = useCallback(() => {
    // Only the APPROVAL is discarded. A download that is already authorized
    // and running is left to finish into the shared cache — cancelling a
    // transfer is a separate capability this pass does not add — but without an
    // approval it can no longer mint consent or run a turn for this flow.
    pendingApprovalRef.current = null;
    setPendingApproval(null);
  }, []);

  const startInstall = useCallback(async () => {
    const approval = pendingApprovalRef.current;
    const result = await startLocalHarnessRuntimeInstall({
      expectedPack:
        approval === null
          ? null
          : {
              packVersion: approval.expectations.packVersion,
              treeDigest: approval.expectations.treeDigest,
            },
    });
    if (!result.ok) return result;
    // The acknowledgement names the attempt to observe. Selecting it here,
    // after awaiting, is what keeps a late poll from a previous attempt from
    // overwriting this one.
    observedAttemptRef.current =
      result.kind === "accepted" ? (result.attemptId ?? null) : null;
    setRuntimeStatus(result.status);
    setStatusFetchFailed(false);
    return { ok: true as const, kind: result.kind };
  }, []);

  const authorize = useCallback(async () => {
    const approval = pendingApprovalRef.current;
    if (approval === null || !projectId) {
      return {
        ok: false as const,
        kind: "forbidden" as const,
        status: null,
        message:
          "Nothing was approved for this authorization, so none was requested.",
      };
    }
    setAuthorizing(true);
    try {
      const result = await mintLocalHarnessConsent({
        projectId: approval.projectId,
        workspaceGrantId: approval.workspaceGrantId,
        expect: approval.expectations,
      });
      if (!result.ok) return result;

      // ── Re-check BEFORE persisting ───────────────────────────────────────
      //
      // The mint was a network round trip, and everything can have moved: the
      // approval cancelled, the user switched, the project changed, another tab
      // revoked. A grant that arrives into a context that no longer matches is
      // not consent — it is a capability nobody currently authorizes — so it is
      // discarded and THAT grant id alone is revoked. Clearing storage here
      // would be the cancel silently destroying a newer, valid grant.
      const still = pendingApprovalRef.current;
      const contextHolds =
        still !== null &&
        still.attemptId === approval.attemptId &&
        still.projectId === projectId &&
        still.userKey === userKey;
      if (!contextHolds) {
        void revokeLocalHarnessGrantId(result.consent.grantId);
        return {
          ok: false as const,
          kind: "conflict" as const,
          status: null,
          message:
            "Authorization was cancelled while it was being granted, so " +
            "nothing was stored.",
        };
      }

      if (!persistLocalHarnessConsent(projectId, result.consent)) {
        // Storage is disabled or full. Failing to persist leaves the grant
        // unusable next render, so this is an authorization FAILURE rather
        // than a ready state that will mysteriously stop working.
        void revokeLocalHarnessGrantId(result.consent.grantId);
        return {
          ok: false as const,
          kind: "malformed" as const,
          status: null,
          message:
            "This browser would not store the authorization, so Claude Code " +
            "cannot run on this machine from here.",
        };
      }
      pendingApprovalRef.current = null;
      setPendingApproval(null);
      return { ok: true as const, consent: result.consent };
    } finally {
      setAuthorizing(false);
    }
  }, [projectId, userKey]);

  const revoke = useCallback(async () => {
    if (!projectId) return;
    pendingApprovalRef.current = null;
    setPendingApproval(null);
    await revokeLocalHarnessConsent(projectId);
  }, [projectId]);

  // ── The send snapshot ────────────────────────────────────────────────────
  //
  // Re-derived from storage at call time rather than read off this render's
  // closure. A transport built before Allow, before a sign-out, or before an
  // expiry holds a value that was true then; the send has to know what is true
  // now.
  const resolveSendTarget = useCallback(() => {
    if (!offerable || !inScope || !projectId) return null;
    if (userKey === null) return null;
    const fresh = parseStoredLocalHarnessConsent(
      readLocalHarnessConsentSnapshot(projectId),
    );
    if (fresh === null) return null;
    return { target: fresh.target, token: fresh.token };
  }, [offerable, inScope, projectId, userKey]);

  return {
    requestedTarget,
    effectiveTarget,
    phase,
    reason,
    availability,
    loading,
    availabilityError,
    runtimeStatus: runtimeStatus ?? availability?.runtimeStatus ?? null,
    statusFetchFailed,
    consent,
    // A grant already names a workspace, so a reload does not have to re-pick
    // one; an explicit choice this session outranks it.
    workspace:
      workspace ??
      (consent !== null
        ? {
            workspaceGrantId: consent.target.workspaceGrantId,
            displayRoot: consent.workspaceDisplayRoot,
          }
        : null),
    pendingApproval,
    hostedAvailable,
    select,
    refresh,
    chooseWorkspace,
    captureApproval,
    cancelApproval,
    startInstall,
    authorize,
    revoke,
    resolveSendTarget,
  };
}

export type { LocalHarnessError };
