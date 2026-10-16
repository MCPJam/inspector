import { useEffect, useState } from "react";
import {
  fetchLocalStudyAdmission,
  type LocalStudyAdmission,
} from "@/lib/local-study-controls";

/** Advisory only: setup and every send still require an owned reservation. */
export function useLocalStudyAdmission(args: {
  key: string;
  enabled: boolean;
  scenarioId?: string;
  accessVersion?: number;
}) {
  const [state, setState] = useState<{
    key: string;
    admission: LocalStudyAdmission | null;
  }>({ key: "", admission: null });
  useEffect(() => {
    if (!args.enabled || !args.scenarioId || args.accessVersion === undefined)
      return;
    const abort = new AbortController();
    void fetchLocalStudyAdmission(
      { scenarioId: args.scenarioId, accessVersion: args.accessVersion },
      abort.signal,
    )
      .then((admission) => {
        if (!abort.signal.aborted) setState({ key: args.key, admission });
      })
      .catch(() => {
        // Failure is not eligibility; a later identity change or reopening retries.
        if (!abort.signal.aborted) setState({ key: args.key, admission: null });
      });
    return () => abort.abort();
  }, [args.key, args.enabled, args.scenarioId, args.accessVersion]);
  return args.enabled && state.key === args.key ? state.admission : null;
}
