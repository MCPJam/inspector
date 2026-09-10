export type OnboardingPhase =
  | "first_run_eligible"
  | "connecting_excalidraw"
  | "connected_guided"
  | "connect_error"
  | "completed"
  | "dismissed";

export interface OnboardingPersistedState {
  status: "started" | "seen" | "dismissed" | "completed";
  startedAt?: number;
  shownAt?: number;
  completedAt?: number;
  attemptedServerName?: string;
}

const STORAGE_KEY = "mcp-onboarding-state";
const FIRST_RUN_SERVER_CHOICE_STORAGE_KEY = "mcp-first-run-server-choice-state";

function readPersistedState(
  storageKey: string,
): OnboardingPersistedState | null {
  const stored = localStorage.getItem(storageKey);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<OnboardingPersistedState>;
    if (
      parsed.status === "started" ||
      parsed.status === "seen" ||
      parsed.status === "dismissed" ||
      parsed.status === "completed"
    ) {
      return {
        status: parsed.status,
        startedAt:
          typeof parsed.startedAt === "number" ? parsed.startedAt : undefined,
        shownAt:
          typeof parsed.shownAt === "number" ? parsed.shownAt : undefined,
        completedAt:
          typeof parsed.completedAt === "number"
            ? parsed.completedAt
            : undefined,
        attemptedServerName:
          typeof parsed.attemptedServerName === "string"
            ? parsed.attemptedServerName
            : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function readOnboardingState(): OnboardingPersistedState | null {
  return readPersistedState(STORAGE_KEY);
}

export function writeOnboardingState(state: OnboardingPersistedState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function markOnboardingStarted(): void {
  const current = readOnboardingState();
  if (
    current?.status === "completed" ||
    current?.status === "dismissed" ||
    (current?.status === "seen" && current.shownAt)
  ) {
    return;
  }
  writeOnboardingState({ status: "started", startedAt: Date.now() });
}

export function markOnboardingShown(): void {
  const current = readOnboardingState();
  if (current?.status === "completed" || current?.status === "dismissed") {
    return;
  }
  writeOnboardingState({ status: "seen", shownAt: Date.now() });
}

/**
 * Records an explicit decision to leave the first-run flow.
 *
 * This stays local for now. A later account-level onboarding pass can persist
 * the same decision remotely once the sign-in and guest-promotion surfaces are
 * part of the flow; writing it here keeps a guest from being trapped in the
 * overlay during this first UI slice.
 */
export function markOnboardingDismissed(): void {
  const current = readOnboardingState();
  if (current?.status === "completed") return;
  writeOnboardingState({ status: "dismissed" });
}

export function clearOnboardingState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * State for the explicit first-run server-choice flow. It deliberately does
 * not reuse the legacy guided-Excalidraw key or remote `hasSeenOnboarding`
 * flag: those record an automatic background flow, not a user's choice here.
 */
export function readFirstRunServerChoiceState(): OnboardingPersistedState | null {
  return readPersistedState(FIRST_RUN_SERVER_CHOICE_STORAGE_KEY);
}

function writeFirstRunServerChoiceState(state: OnboardingPersistedState): void {
  localStorage.setItem(
    FIRST_RUN_SERVER_CHOICE_STORAGE_KEY,
    JSON.stringify(state),
  );
}

export function markFirstRunServerChoiceStarted(
  attemptedServerName?: string,
): void {
  const current = readFirstRunServerChoiceState();
  if (current?.status === "completed" || current?.status === "dismissed") {
    return;
  }
  writeFirstRunServerChoiceState({
    status: "started",
    startedAt: current?.startedAt ?? Date.now(),
    shownAt: current?.shownAt,
    attemptedServerName:
      attemptedServerName ?? current?.attemptedServerName,
  });
}

/**
 * Records that the one-time welcome was rendered. A completed state
 * without this marker came from an older automatic flow, so it must not hide
 * the explicit welcome screen.
 */
export function markFirstRunServerChoiceWelcomeShown(): void {
  const current = readFirstRunServerChoiceState();
  if (current?.status === "completed" || current?.status === "dismissed") {
    return;
  }
  writeFirstRunServerChoiceState({
    status: "started",
    startedAt: current?.startedAt ?? Date.now(),
    shownAt: Date.now(),
    attemptedServerName: current?.attemptedServerName,
  });
}

/** Kept as the semantic action used when Continue or the timer advances. */
export function markFirstRunServerChoiceWelcomeAcknowledged(): void {
  markFirstRunServerChoiceWelcomeShown();
}

export function markFirstRunServerChoiceDismissed(): void {
  if (readFirstRunServerChoiceState()?.status === "completed") return;
  writeFirstRunServerChoiceState({ status: "dismissed" });
}

export function markFirstRunServerChoiceCompleted(): void {
  const current = readFirstRunServerChoiceState();
  writeFirstRunServerChoiceState({
    status: "completed",
    completedAt: Date.now(),
    shownAt: current?.shownAt,
  });
}

export function isFirstRunServerChoiceEligible(
  hasAnyBlockingServers: boolean,
  currentRouteTab: string,
  isSignedInWithWorkOs = false,
  isNewSignedInAccount = false,
): boolean {
  if (isSignedInWithWorkOs && !isNewSignedInAccount) return false;

  const rawRoute = currentRouteTab.replace(/^#?\/?/, "");
  const [routePath = ""] = rawRoute.split("?");
  const routeTab = routePath.replace(/\/+$/, "");
  if (
    routeTab !== "servers" &&
    routeTab !== "connect" &&
    routeTab !== "clients" &&
    routeTab !== "hosts" &&
    routeTab !== "home" &&
    routeTab !== "playground" &&
    routeTab
  ) {
    return false;
  }

  const persisted = readFirstRunServerChoiceState();
  if (persisted?.status === "dismissed") return false;

  // A completion written before the explicit welcome existed (or before the
  // visitor reached its choice step) must not make the welcome disappear.
  if (persisted?.status === "completed" && persisted.shownAt) return false;

  // Once the explicit flow is visibly underway, a server record arriving
  // during project hydration must not dismiss it. Successful connected rows
  // are repaired to `completed` by App; failed or disconnected rows need the
  // recovery UI to stay reachable.
  if (persisted?.status === "started" && persisted.shownAt) return true;

  return !hasAnyBlockingServers;
}

/**
 * Returns true when the user is eligible for first-run onboarding:
 * - No explicit hash route (empty, "#", "#/", the default hub hash
 *   `#servers`/`#connect`/legacy `#hosts`, or the `#home` landing route)
 * - No saved servers that block first-run onboarding
 * - Onboarding has never been shown for the current identity. When a remote
 *   user row is available, that row is the source of truth; localStorage is
 *   only a fallback for runtimes without an identity.
 * - The user is either a hosted guest (Convex-authenticated, no WorkOS) or a
 *   freshly-created signed-in account. Signed-in users land on Home by default;
 *   only brand-new accounts (`isNewSignedInAccount`) get the first-run NUX so
 *   returning users — including older accounts whose onboarding flag was never
 *   set — are never bounced off Home.
 */
export function isFirstRunEligible(
  hasAnyBlockingServers: boolean,
  currentRouteTab: string,
  isSignedInWithWorkOs = false,
  hasSeenRemoteOnboarding?: boolean,
  isNewSignedInAccount = false,
): boolean {
  if (hasAnyBlockingServers) return false;
  if (isSignedInWithWorkOs && !isNewSignedInAccount) return false;

  // Drop query strings and trailing slashes so `connect?foo=bar` and
  // `/connect/` still pass the allowlist — both land on the same hub route.
  // Playground is also an entry route: a fresh visitor can arrive there from
  // the local preview URL, and must be sent through the explicit server-choice
  // flow before the legacy Playground bootstrap can do anything on their behalf.
  const rawRoute = currentRouteTab.replace(/^#?\/?/, "");
  const [routePath = ""] = rawRoute.split("?");
  const routeTab = routePath.replace(/\/+$/, "");
  if (
    routeTab !== "servers" &&
    routeTab !== "connect" &&
    routeTab !== "clients" &&
    routeTab !== "hosts" &&
    routeTab !== "home" &&
    routeTab !== "playground" &&
    routeTab
  )
    return false;

  // Read localStorage before the remote check. A locally-completed or
  // dismissed state is authoritative — it prevents re-triggering the NUX in
  // a fresh guest Convex session where the user row starts with
  // hasSeenOnboarding: false and would otherwise bypass localStorage.
  const persisted = readOnboardingState();
  if (persisted?.status === "completed" || persisted?.status === "dismissed")
    return false;

  if (hasSeenRemoteOnboarding !== undefined) {
    return hasSeenRemoteOnboarding !== true;
  }

  if (!persisted) return true;
  if (persisted.status === "started") return true;
  if (persisted.status === "seen" && !persisted.shownAt) return true;
  return false;
}
