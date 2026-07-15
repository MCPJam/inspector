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
}

const STORAGE_KEY = "mcp-onboarding-state";

export function readOnboardingState(): OnboardingPersistedState | null {
  const stored = localStorage.getItem(STORAGE_KEY);
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
      };
    }
    return null;
  } catch {
    return null;
  }
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

export function clearOnboardingState(): void {
  localStorage.removeItem(STORAGE_KEY);
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
  isNewSignedInAccount = false
): boolean {
  if (hasAnyBlockingServers) return false;
  if (isSignedInWithWorkOs && !isNewSignedInAccount) return false;

  // Drop query strings and trailing slashes so `connect?foo=bar` and
  // `/connect/` still pass the allowlist — both land on the same hub route.
  const rawRoute = currentRouteTab.replace(/^#?\/?/, "");
  const [routePath = ""] = rawRoute.split("?");
  const routeTab = routePath.replace(/\/+$/, "");
  if (
    routeTab !== "servers" &&
    routeTab !== "connect" &&
    routeTab !== "clients" &&
    routeTab !== "hosts" &&
    routeTab !== "home" &&
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
