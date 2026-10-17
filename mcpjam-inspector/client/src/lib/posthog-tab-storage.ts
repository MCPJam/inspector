import { POSTHOG_PROJECT_KEY } from "../../../shared/posthog-project";

// A separate name also prevents migration from the old shared cookie/blob.
export const POSTHOG_TAB_PERSISTENCE_NAME = `${POSTHOG_PROJECT_KEY}_tab`;
export const POSTHOG_TAB_STORAGE_KEY = `ph_${POSTHOG_TAB_PERSISTENCE_NAME}`;

export function getPostHogTabStorageOptions() {
  let persistence: "sessionStorage" | "memory" = "memory";
  try {
    const probe = `${POSTHOG_TAB_STORAGE_KEY}_probe`;
    window.sessionStorage.setItem(probe, "1");
    window.sessionStorage.removeItem(probe);
    persistence = "sessionStorage";
  } catch {
    // The SDK otherwise falls back to shared localStorage/cookies, which
    // lets another actor's tab replace this tab's server-evaluated flags.
  }
  return { persistence, persistence_name: POSTHOG_TAB_PERSISTENCE_NAME };
}
