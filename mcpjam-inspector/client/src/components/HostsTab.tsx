import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { HostBuilderView } from "./hosts/HostBuilderView";
import { HostsConnectAddServerSlotContext } from "./hosts/HostsConnectAddServerSlotContext";
import { ViewModeSelector } from "./shared/view-mode-selector";
import { usePreviewedHostId } from "@/hooks/use-previewed-host-id";
import { useHost, useHostList } from "@/hooks/useHosts";
import { getChatboxShellStyle } from "@/lib/chatbox-host-style";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

interface HostsTabProps {
  projectId: string | null;
  isAuthenticated: boolean;
  selectedHostId: string | null;
  onSelectHost: (hostId: string | null) => void;
  serversTabElement: ReactNode;
}

/**
 * Camera-style transition between the browsing state (server list) and the
 * host architecture canvas. Servers shrink toward where the canvas's "Servers
 * hub" will sit (≈70% down, horizontally centered) so the swap reads as a
 * zoom-out reveal of the bigger machine. Canvas exits by pushing past the
 * camera (scale > 1) to feel like the camera is moving back in.
 */
const TRANSITION = {
  duration: 0.7,
  ease: [0.32, 0.72, 0, 1] as [number, number, number, number],
};

export function HostsTab({
  projectId,
  isAuthenticated,
  selectedHostId,
  onSelectHost,
  serversTabElement,
}: HostsTabProps) {
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);
  const { hosts, isLoading: isHostListLoading } = useHostList({
    isAuthenticated,
    projectId,
  });
  const [addServerSlotEl, setAddServerSlotEl] = useState<HTMLDivElement | null>(
    null,
  );
  // Match the Host canvas's brand-tinted backdrop on the Servers view: read
  // the previewed host's style and cascade brand `--background`, `--primary`,
  // `--card`, etc. into the subtree so the Servers chrome inherits the host's
  // accent (orange for Claude, blue for ChatGPT, …) without per-component
  // theming code. Mirrors `HostBuilderViewRedesigned.canvasShellStyle`.
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const { host: previewedHost } = useHost({
    isAuthenticated,
    hostId: previewedHostId,
  });
  const previewedHostStyle = previewedHost?.config?.hostStyle ?? null;
  const browseShellStyle = useMemo(
    () =>
      previewedHostStyle
        ? getChatboxShellStyle(previewedHostStyle, themeMode)
        : undefined,
    [previewedHostStyle, themeMode],
  );

  useEffect(() => {
    if (selectedHostId) onSelectHost(null);
    // selectedHostId/onSelectHost intentionally omitted: this effect resets
    // host context when the active project changes, not when the selection
    // changes within the same project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Reconcile stale selections against the live host list. If the host the
  // user was viewing (or had previewed) was deleted elsewhere, drop the
  // reference so the canvas doesn't get stuck on a missing id — without
  // this, HostBuilderViewRedesigned's `!draftConfig` guard renders skeletons
  // forever because the seed effect bails on a null host.
  useEffect(() => {
    if (isHostListLoading) return;
    const exists = (id: string | null) =>
      id !== null && hosts.some((h) => h.hostId === id);
    if (selectedHostId && !exists(selectedHostId)) onSelectHost(null);
    if (previewedHostId && !exists(previewedHostId)) setPreviewedHostId(null);
  }, [
    hosts,
    isHostListLoading,
    selectedHostId,
    previewedHostId,
    onSelectHost,
    setPreviewedHostId,
  ]);

  if (!projectId) return null;

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <AnimatePresence initial={false} mode="sync">
        {selectedHostId ? (
          <motion.div
            key="host-canvas"
            initial={{ opacity: 0, scale: 1.06 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.18 }}
            transition={TRANSITION}
            className="absolute inset-0 [transform-origin:50%_42%]"
          >
            <HostBuilderView
              hostId={selectedHostId}
              projectId={projectId}
              onBack={() => onSelectHost(null)}
            />
          </motion.div>
        ) : (
          <motion.div
            key="host-browse"
            initial={{ opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.42 }}
            transition={TRANSITION}
            data-host-style={previewedHostStyle ?? undefined}
            style={browseShellStyle}
            className="absolute inset-0 flex min-h-0 flex-col bg-background text-foreground [transform-origin:50%_70%]"
          >
            <HostsConnectAddServerSlotContext.Provider value={addServerSlotEl}>
              <div
                className="relative shrink-0 border-b border-border/40 px-8 py-2.5"
                data-testid="hosts-tab-header-chrome"
              >
                <div className="flex min-w-0 items-center justify-end gap-3">
                  <div
                    ref={setAddServerSlotEl}
                    className="flex shrink-0 items-center gap-2"
                    data-testid="hosts-tab-add-server-slot"
                  />
                </div>
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="pointer-events-auto">
                    <ViewModeSelector
                      value="servers"
                      ariaLabel="Connect view"
                      onChange={(next) => {
                        if (next === "host" && previewedHostId) {
                          onSelectHost(previewedHostId);
                        }
                      }}
                      options={[
                        { value: "servers", label: "Servers" },
                        {
                          value: "host",
                          label: "Host",
                          disabled: !previewedHostId,
                        },
                      ]}
                    />
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1">{serversTabElement}</div>
            </HostsConnectAddServerSlotContext.Provider>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
