import { useEffect, useRef, useState } from "react";
import type { HostListItem } from "@/hooks/useClients";

/** How long a lead written elsewhere may name a client this list lacks. */
export const LIST_CATCH_UP_MS = 2_000;

/**
 * Points the lead at a listed client when it names one the list does not
 * have: a deleted client, or a stale stored id.
 *
 * Another tab sharing the storage can write a lead naming a client it just
 * created before this tab's own host list has it. Replacing that lead at once
 * would write this tab's fallback back to every tab, so a lead that changes
 * while the list is loaded gets LIST_CATCH_UP_MS to appear. A lead that is
 * already missing when the list loads, or whose client leaves the list, is
 * replaced at once.
 */
export function useMissingLeadFallback({
  enabled,
  projectId,
  hosts,
  previewedHostId,
  setPreviewedHostId,
  resolveFallbackHostId,
}: {
  enabled: boolean;
  projectId: string | null;
  hosts: HostListItem[];
  previewedHostId: string | null;
  setPreviewedHostId: (hostId: string) => void;
  resolveFallbackHostId: (hosts: HostListItem[]) => string | null;
}) {
  // The lead the loaded list was last checked against, per project.
  const checkedRef = useRef<{ projectId: string; lead: string | null } | null>(
    null,
  );
  const waitRef = useRef<{ lead: string; until: number } | null>(null);
  const [waitsOver, setWaitsOver] = useState(0);

  useEffect(() => {
    if (!enabled || !projectId || hosts.length === 0) return;
    const checked =
      checkedRef.current?.projectId === projectId ? checkedRef.current : null;
    checkedRef.current = { projectId, lead: previewedHostId };
    if (
      previewedHostId !== null &&
      hosts.some((host) => host.hostId === previewedHostId)
    ) {
      waitRef.current = null;
      return;
    }
    if (
      previewedHostId !== null &&
      checked &&
      checked.lead !== previewedHostId
    ) {
      waitRef.current = {
        lead: previewedHostId,
        until: Date.now() + LIST_CATCH_UP_MS,
      };
    }
    const wait = waitRef.current;
    if (wait?.lead === previewedHostId && Date.now() < wait.until) {
      const timer = setTimeout(
        () => setWaitsOver((count) => count + 1),
        wait.until - Date.now(),
      );
      return () => clearTimeout(timer);
    }
    const fallbackHostId = resolveFallbackHostId(hosts);
    if (fallbackHostId) setPreviewedHostId(fallbackHostId);
  }, [
    enabled,
    projectId,
    hosts,
    previewedHostId,
    setPreviewedHostId,
    resolveFallbackHostId,
    waitsOver,
  ]);
}
