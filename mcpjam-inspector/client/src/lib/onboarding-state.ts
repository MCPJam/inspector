export type OnboardingPhase =
  | "first_run_eligible"
  | "welcome"
  | "connecting_excalidraw"
  | "connected_guided"
  | "connect_error"
  | "manual_modal_open"
  | "completed"
  | "dismissed";

export interface OnboardingPersistedState {
  status: "seen" | "dismissed" | "completed";
  completedAt?: number;
}

const STORAGE_KEY = "mcp-onboarding-state";

export function readOnboardingState(): OnboardingPersistedState | null {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<OnboardingPersistedState>;
    if (
      parsed.status === "seen" ||
      parsed.status === "dismissed" ||
      parsed.status === "completed"
    ) {
      return {
        status: parsed.status,
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

export function clearOnboardingState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Returns true when the user is eligible for first-run onboarding:
 * - No explicit hash route (empty, "#", "#/", or "#servers" which is the default)
 * - No connected servers
 * - Onboarding has never been started (no localStorage entry)
 */
export function isFirstRunEligible(
  hasConnectedServers: boolean,
  currentHash: string,
): boolean {
  if (hasConnectedServers) return false;

  const hash = currentHash.replace(/^#\/?/, "");
  if (hash && hash !== "servers") return false;

  const persisted = readOnboardingState();
  if (persisted) return false;

  return true;
}
