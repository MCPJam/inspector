import { useEffect, useRef } from "react";
import { useConvexAuth } from "convex/react";

import { useHost } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { applyHostConfigToPlayground } from "@/lib/playground/apply-client-defaults";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

interface PlaygroundPreviewedHostSyncProps {
  projectId: string | null;
}

/**
 * Subscribe to the project's previewed-host id (the named host picked in
 * `PlaygroundHeader`'s `HostPicker` dropdown — backed by the same
 * localStorage key Connect's `HostOverlayBar` uses), resolve that host's
 * persisted config via `useHost`, and snapshot its defaults into the
 * playground top-bar chip state whenever the resolved id changes.
 *
 * Applies the same underlying `applyHostConfigToPlayground` helper used for
 * playground host snapshots. This component resolves the persisted host config
 * via Convex and runs in an effect when the resolved config first becomes
 * available for a new id.
 *
 * Renders nothing.
 *
 * Caveat: when no host is picked (`previewedHostId === null`), this is a
 * no-op — we don't reset chips to anything. The seam is "host changed",
 * not "no-host means project default." Initial chip state is still owned
 * by `ProjectClientConfigSync`.
 */
export function PlaygroundPreviewedClientSync({
  projectId,
}: PlaygroundPreviewedHostSyncProps) {
  const { isAuthenticated } = useConvexAuth();
  const [previewedHostId] = usePreviewedHostId(projectId);
  const { host } = useHost({ isAuthenticated, hostId: previewedHostId });
  const setHostStyle = usePreferencesStore((state) => state.setHostStyle);
  const setHostCapabilitiesOverride = usePreferencesStore(
    (state) => state.setHostCapabilitiesOverride
  );
  const setChatUiOverride = usePreferencesStore(
    (state) => state.setChatUiOverride
  );

  // Track the last (id, configId) tuple we applied so the effect only
  // fires on actual host changes — not on every re-render or on
  // re-emissions of the same Convex doc. We key on configId in addition
  // to hostId so an edit to the host's underlying config (re-saving from
  // the Hosts editor while the playground is open) triggers a re-snapshot.
  const lastAppliedRef = useRef<{ hostId: string; configId: string } | null>(
    null
  );

  useEffect(() => {
    // When the user clears the previewed host, drop the dedupe anchor so
    // a later hostA → null → hostA flow re-applies the snapshot instead
    // of being treated as a no-op against stale state.
    if (!previewedHostId) {
      lastAppliedRef.current = null;
      return;
    }
    if (!host) return;
    const configId = host.config.id;
    const last = lastAppliedRef.current;
    if (last && last.hostId === previewedHostId && last.configId === configId) {
      return;
    }
    applyHostConfigToPlayground(host.config, {
      setHostStyle,
      setHostCapabilitiesOverride,
      setChatUiOverride,
    });
    lastAppliedRef.current = { hostId: previewedHostId, configId };
  }, [
    previewedHostId,
    host,
    setHostStyle,
    setHostCapabilitiesOverride,
    setChatUiOverride,
  ]);

  return null;
}
