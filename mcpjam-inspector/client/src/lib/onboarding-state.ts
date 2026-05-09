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
 * - No explicit hash route (empty, "#", "#/", or "#servers" which is the default)
 * - No saved servers that block first-run onboarding
 * - Onboarding has never been shown for the current identity. When a remote
 *   user row is available, that row is the source of truth; localStorage is
 *   only a fallback for runtimes without an identity.
 * - The user is not signed in with WorkOS. Hosted guests may be
 *   Convex-authenticated, but should still be eligible for first-run NUX.
 */
export function isFirstRunEligible(
  hasAnyBlockingServers: boolean,
  currentHash: string,
  isSignedInWithWorkOs = false,
  hasCompletedRemoteOnboarding?: boolean
): boolean {
  if (hasAnyBlockingServers) return false;
  if (isSignedInWithWorkOs) return false;

  const hash = currentHash.replace(/^#\/?/, "");
  if (hash && hash !== "servers") return false;

  if (hasCompletedRemoteOnboarding !== undefined) {
    return hasCompletedRemoteOnboarding !== true;
  }

  const persisted = readOnboardingState();
  if (!persisted) return true;
  if (persisted.status === "started") return true;
  if (persisted.status === "seen" && !persisted.shownAt) return true;
  return false;
}
