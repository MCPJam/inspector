import { useEffect, useState } from "react";
import { subscribeLocalHarnessConsent } from "@/lib/local-harness-consent";
import { HOSTED_MODE } from "@/lib/config";
import { authFetch } from "@/lib/session-token";

export type UnattendedVenue = "checking" | "local" | "hosted" | "unavailable";

export function useUnattendedHarnessVenue(
  projectId: string,
  harnessId: string,
): UnattendedVenue {
  const [revision, setRevision] = useState(0);
  const key = `${projectId}:${harnessId}:${revision}`;
  useEffect(() => {
    if (HOSTED_MODE) return;
    const refresh = () => setRevision((value) => value + 1);
    const unsubscribe = subscribeLocalHarnessConsent(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const [state, setState] = useState<{ key: string; venue: UnattendedVenue }>({
    key,
    venue: "checking",
  });
  useEffect(() => {
    if (HOSTED_MODE) return;
    const controller = new AbortController();
    setState({ key, venue: "checking" });
    void (async () => {
      try {
        const query = new URLSearchParams({
          projectId,
          harnessId,
          scope: "unattended",
        });
        const response = await authFetch(
          `/api/mcp/local-harness/availability?${query}`,
          { signal: controller.signal },
        );
        const body: unknown = response.ok ? await response.json() : null;
        const value =
          body && typeof body === "object" && "unattendedVenue" in body
            ? body.unattendedVenue
            : null;
        const venue =
          value === "local" || value === "hosted" ? value : "unavailable";
        if (!controller.signal.aborted) setState({ key, venue });
      } catch {
        // A failed read cannot authorize a local venue or imply a cloud fallback.
        if (!controller.signal.aborted) setState({ key, venue: "unavailable" });
      }
    })();
    return () => controller.abort();
  }, [key, projectId, harnessId]);
  return HOSTED_MODE ? "hosted" : state.key === key ? state.venue : "checking";
}
