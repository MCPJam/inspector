import { useEffect, useState } from "react";
import { listBrowserProfiles } from "@/lib/browser-profiles/client";

/** Resolve a label only; opening configuration never starts a browser. */
export function useBrowserProfileName(
  projectId?: string | null,
  profileId?: string,
) {
  const [result, setResult] = useState<{ key: string; name?: string } | null>(
    null,
  );
  const key = `${projectId}:${profileId}`;
  useEffect(() => {
    if (!projectId || !profileId) return;
    let cancelled = false;
    void listBrowserProfiles(projectId)
      .then((profiles) => {
        if (!cancelled)
          setResult({
            key,
            name: profiles.find((p) => p.profileId === profileId)?.name,
          });
      })
      .catch(() => {
        if (!cancelled) setResult({ key });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, profileId, key]);
  return result?.key === key ? result.name : undefined;
}
