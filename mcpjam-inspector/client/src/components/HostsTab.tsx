import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { useNavigate } from "react-router";
import { HostBuilderView } from "./hosts/HostBuilderView";
import { HostsConnectAddServerSlotContext } from "./hosts/HostsConnectAddServerSlotContext";
import { HostsConnectViewPhaseContext } from "./hosts/HostsConnectViewPhaseContext";
import { SNAPPY_RAIL } from "./hosts/transition-tokens";
import { ViewModeSelector } from "./shared/view-mode-selector";
import { usePreviewedHostId } from "@/hooks/use-previewed-host-id";
import { useHost, useHostList } from "@/hooks/useHosts";
import { buildHostsPath, routePaths } from "@/lib/app-navigation";
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
 * host architecture canvas. Server cards morph 1:1 into the canvas's pills
 * via shared `layoutId` (see transition-tokens.ts) while the logs rail slides
 * out and the host chrome staggers in — so the wrapper itself only needs a
 * gentle opacity/y fade to soften the cut.
 */

export function HostsTab({
  projectId,
  isAuthenticated,
  selectedHostId,
  onSelectHost,
  serversTabElement,
}: HostsTabProps) {
  const navigate = useNavigate();
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

  // Reset host selection only when the project actually changes mid-session,
  // not on first mount — otherwise a deep-link like `/hosts/:hostId` gets
  // wiped right after the page loads.
  const prevProjectIdRef = useRef(projectId);
  useEffect(() => {
    const prev = prevProjectIdRef.current;
    prevProjectIdRef.current = projectId;
    if (prev === projectId) return;
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

  // When the project id hasn't resolved yet (signed-out, between-project
  // hydration, etc.) we still want to render *something* in the hub —
  // the Servers list works without project state and is the natural
  // fallback the user expects on `#connect`/`#servers`.
  if (!projectId) return <>{serversTabElement}</>;

  const viewPhase = selectedHostId ? "host" : "servers";

  return (
    <HostsConnectViewPhaseContext.Provider value={viewPhase}>
    <LayoutGroup id="connect-servers-host">
    <div className="relative h-full min-h-0 overflow-hidden">
      <AnimatePresence initial={false} mode="sync">
        {selectedHostId ? (
          <motion.div
            key="host-canvas"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.97 }}
            transition={SNAPPY_RAIL}
            className="absolute inset-0 [transform-origin:50%_30%]"
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
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={SNAPPY_RAIL}
            data-host-style={previewedHostStyle ?? undefined}
            style={browseShellStyle}
            className="absolute inset-0 flex min-h-0 flex-col bg-background text-foreground"
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
                          navigate(buildHostsPath(previewedHostId));
                        } else if (next === "servers") {
                          navigate(routePaths.servers);
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
    </LayoutGroup>
    </HostsConnectViewPhaseContext.Provider>
  );
}
