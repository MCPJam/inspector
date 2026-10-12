import { useEffect, useState } from "react";
import { fetchArtifact } from "@/lib/artifact-urls";
import { hydrateRecordedToolSnapshots } from "@/shared/recorded-tool-snapshots";

export function useRecordedToolSnapshots<
  T extends { recordedContext?: Record<string, unknown> },
>(resource: T | null | undefined): T | null | undefined {
  const [loaded, setLoaded] = useState<{ source: T; value: T } | null>(null);
  useEffect(() => {
    const context = resource?.recordedContext;
    if (!resource || !context) return;
    const controller = new AbortController();
    void hydrateRecordedToolSnapshots(
      context,
      async (url) => {
        const response = await fetchArtifact(url, {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Tool snapshot download failed (${response.status})`);
        return await response.json();
      },
      (error) => {
        if (!controller.signal.aborted)
          console.debug("Recorded tool snapshot unavailable", error);
      },
    ).then((recordedContext) => {
      if (!controller.signal.aborted)
        setLoaded({
          source: resource,
          value: { ...resource, recordedContext },
        });
    });
    return () => controller.abort();
  }, [resource]);
  return resource && loaded?.source === resource ? loaded.value : resource;
}
