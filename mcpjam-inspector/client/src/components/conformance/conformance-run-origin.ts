/**
 * Where a saved run's page was opened from, so its Back returns there.
 *
 * The origin rides in the history entry's state, not the URL, so a run link
 * stays the same to share. A pasted link has no origin and goes to History.
 */

import {
  buildConformanceRunPath,
  useAppNavigate,
  useCurrentLocationState,
} from "@/lib/app-navigation";

/** The Conformance tab a run's page was opened from. */
export type ConformanceRunOrigin = "overview" | "history";

/** History state for opening a run's page from `from`. */
export function conformanceRunOriginState(from: ConformanceRunOrigin) {
  return { conformanceRunFrom: from };
}

/** Opens a run's page from History. */
export function useOpenRunFromHistory(projectId?: string | null) {
  const navigate = useAppNavigate();
  return (runId: string) =>
    navigate(buildConformanceRunPath(runId, projectId), {
      state: conformanceRunOriginState("history"),
    });
}

/** Back for a run's page: its label and where it goes. */
export function useRunBack(): {
  label: string;
  onBack: () => void;
} {
  const navigate = useAppNavigate();
  const state = useCurrentLocationState() as {
    conformanceRunFrom?: unknown;
  } | null;
  if (state?.conformanceRunFrom === "overview") {
    return { label: "Conformance", onBack: () => navigate("/conformance") };
  }
  return {
    label: "Conformance History",
    onBack: () => navigate("/conformance?view=history"),
  };
}
