import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { useNavigate } from "react-router";
import { HostBuilderView } from "./hosts/HostBuilderView";
import { HostsConnectAddServerSlotContext } from "./hosts/HostsConnectAddServerSlotContext";
import { HostsConnectViewPhaseContext } from "./hosts/HostsConnectViewPhaseContext";
import { ConnectViewHeader } from "./hosts/ConnectViewHeader";
import { SNAPPY_RAIL } from "./hosts/transition-tokens";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useHost, useHostList, useHostMutations } from "@/hooks/useClients";
import { useProjectServers } from "@/hooks/useProjects";
import { buildHostComparePath, routePaths } from "@/lib/app-navigation";
import { getChatboxShellStyle } from "@/lib/chatbox-client-style";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { getCatalogTemplate } from "@mcpjam/sdk/host-compat";
import { cloneHostTemplateInput } from "@/lib/client-config-v2";
import { DEFAULT_CATALOG_HOST_ID } from "@/lib/host-ui-metadata";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import type {
  CreateHostInspectorCommand,
  DeleteHostInspectorCommand,
  DuplicateHostInspectorCommand,
  OpenHostEditorInspectorCommand,
  SetHostServersInspectorCommand,
} from "@/shared/inspector-command.js";

// Cap the host list surfaced to the agent so a big project doesn't bloat the
// snapshot (the model reads names/ids to resolve a host, not the whole roster).
const AGENT_SNAPSHOT_MAX_HOSTS = 30;

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
    null
  );
  // Brand shell variables apply to the server list body so cards match the
  // emulated host canvas; the tab chrome uses the app background (same as
  // the global Header).
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const { host: previewedHost } = useHost({
    isAuthenticated,
    hostId: previewedHostId,
  });
  const previewedHostStyle = previewedHost?.config?.hostStyle ?? null;
  const previewedChatUiOverride = previewedHost?.config?.chatUiOverride;
  const browseShellStyle = useMemo(
    () =>
      previewedHostStyle
        ? getChatboxShellStyle(
            previewedHostStyle,
            themeMode,
            previewedChatUiOverride
          )
        : undefined,
    [previewedHostStyle, previewedChatUiOverride, themeMode]
  );

  // Agent bridge inputs — the SAME mutations, project servers, and catalog the
  // UI uses. Read here so the handlers below act through the identical paths as
  // the buttons/dialogs (create seeds from the live catalog, exactly like the
  // New Client dialog).
  const { createHost, updateHostServers, deleteHost, duplicateHost } =
    useHostMutations();
  const { servers: projectServers } = useProjectServers({
    isAuthenticated,
    projectId,
  });
  const catalogState = useHostCatalog();
  // High-level config for the focused host (the open editor, else the previewed
  // one) — surfaced REDACTED in the snapshot. Never the system prompt text.
  const focusedHostId = selectedHostId ?? previewedHostId;
  const { host: focusedHost } = useHost({
    isAuthenticated,
    hostId: focusedHostId,
  });

  // Reset host selection only when the project actually changes mid-session,
  // not on first mount — otherwise a deep-link like `/hosts/:hostId` gets
  // wiped right after the page loads.
  //
  // useRef(projectId) captures the value at first render; if auth hasn't
  // resolved yet that's `null`, so the very next render (auth resolves →
  // projectId becomes a real id) would otherwise look like a project
  // switch and clear the deep-linked selection. Treat any transition
  // involving a null side as initial hydration, not a real switch.
  const prevProjectIdRef = useRef(projectId);
  useEffect(() => {
    const prev = prevProjectIdRef.current;
    prevProjectIdRef.current = projectId;
    if (prev === projectId) return;
    if (prev == null || projectId == null) return;
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

  // --- Agent tool group (surface "hosts") -------------------------------
  //
  // HostsTab also wraps the /servers hub, but the bridge always registers the
  // literal "hosts" surface id and never shares a state hook with another
  // surface, so the group can't be mis-scoped. Handlers resolve the host (and
  // server names) from the payload against the live host list / project
  // servers and call the SAME useHostMutations callbacks the UI uses.
  const agentOperable = isAuthenticated && Boolean(projectId);
  const requireAgentOperable = () => {
    if (!agentOperable) {
      throw createInspectorCommandClientError(
        "unsupported_in_mode",
        "The Hosts tools are locked here — sign in and select a project first.",
      );
    }
  };

  // Exact resolution against the loaded host list — unknown or ambiguous →
  // invalid_request, never a fuzzy guess.
  const resolveHost = (raw: unknown) => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Missing required 'host' string (a host name or id).",
      );
    }
    const wanted = raw.trim();
    const wantedLower = wanted.toLowerCase();
    const matches = hosts.filter(
      (h) => h.hostId === wanted || h.name.toLowerCase() === wantedLower,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `No host matches "${wanted}". Use a host name or id from this screen (list them with ui_snapshot_app).`,
      );
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      `${matches.length} hosts match "${wanted}" — pass the host id instead (ids are in ui_snapshot_app).`,
    );
  };

  // Resolve every requested server NAME against the project's servers. The
  // whole call is rejected on the first unknown name rather than partially
  // applied.
  const resolveServerIds = (names: string[]): string[] => {
    const available = projectServers ?? [];
    return names.map((name) => {
      const wantedLower = name.toLowerCase();
      const match =
        available.find((s) => s.name === name) ??
        available.find((s) => s.name.toLowerCase() === wantedLower);
      if (!match) {
        throw createInspectorCommandClientError(
          "invalid_request",
          `No project server named "${name}". Attach only existing project servers (see ui_snapshot_app for the list); add new ones on the Connect screen first.`,
        );
      }
      return match._id;
    });
  };

  useSurfaceAgentBridge({
    surfaceId: "hosts",
    handlers: {
      createHost: async (command) => {
        requireAgentOperable();
        const pid = projectId;
        if (!pid) {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            "No project is selected.",
          );
        }
        const { payload } = command as CreateHostInspectorCommand;
        const name =
          typeof payload?.name === "string" ? payload.name.trim() : "";
        if (!name) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "Missing required 'name' string.",
          );
        }
        if (catalogState.status !== "live") {
          throw createInspectorCommandClientError(
            "execution_failed",
            "Client templates are unavailable right now — try again once the catalog has loaded.",
          );
        }
        const templateId =
          typeof payload?.template === "string" && payload.template.trim()
            ? payload.template.trim()
            : DEFAULT_CATALOG_HOST_ID;
        const templateInput = getCatalogTemplate(
          catalogState.catalog,
          templateId,
        );
        if (!templateInput) {
          throw createInspectorCommandClientError(
            "invalid_request",
            `Unknown template "${templateId}". Use a catalog template id (e.g. 'claude', 'cursor', 'mcpjam').`,
          );
        }
        // The SAME seed the New Client dialog uses; new hosts start with no
        // attached servers (attach afterward with ui_set_host_servers).
        const seed = cloneHostTemplateInput(templateInput, { themeMode });
        try {
          const { hostId } = await createHost({
            projectId: pid,
            name,
            input: { ...seed, serverIds: [] },
          });
          setPreviewedHostId(hostId);
          onSelectHost(hostId);
          return {
            status: "host_created",
            hostId,
            name,
            template: templateId,
            note: "The new host's editor is open. Change its model, system prompt, or behavior there; attach servers with ui_set_host_servers.",
          };
        } catch (e) {
          throw createInspectorCommandClientError(
            "execution_failed",
            e instanceof Error ? e.message : "Failed to create the host.",
          );
        }
      },
      openHostEditor: async (command) => {
        requireAgentOperable();
        const { payload } = command as OpenHostEditorInspectorCommand;
        const host = resolveHost(payload?.host);
        setPreviewedHostId(host.hostId);
        onSelectHost(host.hostId);
        return {
          status: "editor_opened",
          hostId: host.hostId,
          name: host.name,
          note: "The host's editor is open for the user to change its model, system prompt, and behavior.",
        };
      },
      setHostServers: async (command) => {
        requireAgentOperable();
        const { payload } = command as SetHostServersInspectorCommand;
        const host = resolveHost(payload?.host);
        if (!Array.isArray(payload?.servers)) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "Missing required 'servers' array of project server names.",
          );
        }
        const names = payload.servers.map((s) =>
          typeof s === "string" ? s.trim() : "",
        );
        if (names.some((n) => n.length === 0)) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "'servers' must be non-empty project server names.",
          );
        }
        const serverIds = resolveServerIds(names);
        try {
          await updateHostServers({ hostId: host.hostId, serverIds });
          return {
            status: "host_servers_set",
            hostId: host.hostId,
            serverCount: serverIds.length,
            note: "The host now has exactly these servers attached.",
          };
        } catch (e) {
          throw createInspectorCommandClientError(
            "execution_failed",
            e instanceof Error ? e.message : "Failed to update the host's servers.",
          );
        }
      },
      deleteHost: async (command) => {
        requireAgentOperable();
        const { payload } = command as DeleteHostInspectorCommand;
        const host = resolveHost(payload?.host);
        try {
          await deleteHost({ hostId: host.hostId });
          // Drop the reference immediately so the canvas doesn't linger on the
          // deleted host (the reconcile effect also covers this).
          if (selectedHostId === host.hostId) onSelectHost(null);
          if (previewedHostId === host.hostId) setPreviewedHostId(null);
          return { status: "host_deleted", hostId: host.hostId, name: host.name };
        } catch (e) {
          throw createInspectorCommandClientError(
            "execution_failed",
            e instanceof Error ? e.message : "Failed to delete the host.",
          );
        }
      },
      duplicateHost: async (command) => {
        requireAgentOperable();
        const { payload } = command as DuplicateHostInspectorCommand;
        const host = resolveHost(payload?.host);
        if (payload?.name !== undefined && typeof payload.name !== "string") {
          throw createInspectorCommandClientError(
            "invalid_request",
            "'name' must be a string when provided.",
          );
        }
        const name =
          typeof payload?.name === "string" ? payload.name.trim() : "";
        try {
          const { hostId } = await duplicateHost({
            hostId: host.hostId,
            ...(name ? { name } : {}),
          });
          setPreviewedHostId(hostId);
          onSelectHost(hostId);
          return {
            status: "host_duplicated",
            sourceHostId: host.hostId,
            hostId,
            note: "The duplicate's editor is open.",
          };
        } catch (e) {
          throw createInspectorCommandClientError(
            "execution_failed",
            e instanceof Error ? e.message : "Failed to duplicate the host.",
          );
        }
      },
    },
    // Redacted STATE, not payloads: host names/ids, model + behavior flags, and
    // counts only. The system prompt is user content — reported as a boolean +
    // length, NEVER its text. No tokens, no keys, no PII.
    snapshot: () => {
      if (!agentOperable) {
        return {
          gated: true,
          reason: "Sign in and select a project to use the Hosts tools.",
        };
      }
      const cfg = focusedHost?.config ?? null;
      return {
        viewPhase: selectedHostId ? "host" : "servers",
        selectedHostId: selectedHostId ?? null,
        previewedHostId: previewedHostId ?? null,
        hostCount: hosts.length,
        hosts: hosts.slice(0, AGENT_SNAPSHOT_MAX_HOSTS).map((h) => ({
          id: h.hostId,
          name: h.name,
          modelId: h.modelId,
          serverCount: h.serverCount,
        })),
        projectServers: (projectServers ?? []).map((s) => s.name),
        focusedHost:
          focusedHostId && cfg
            ? {
                id: focusedHostId,
                name: focusedHost?.name ?? null,
                modelId: cfg.modelId,
                temperature: cfg.temperature,
                requireToolApproval: cfg.requireToolApproval,
                respectToolVisibility: cfg.respectToolVisibility ?? true,
                progressiveToolDiscovery:
                  cfg.progressiveToolDiscovery ?? null,
                serverCount: cfg.serverIds.length,
                optionalServerCount: cfg.optionalServerIds.length,
                builtInToolCount: cfg.builtInToolIds?.length ?? 0,
                hasComputer: Boolean(cfg.computer),
                hasHarness: Boolean(cfg.harness),
                // System prompt is user content: presence + length only, never
                // the text.
                hasSystemPrompt: cfg.systemPrompt.trim().length > 0,
                systemPromptLength: cfg.systemPrompt.length,
              }
            : null,
      };
    },
  });

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
                className="absolute inset-0 flex flex-col [transform-origin:50%_30%]"
              >
                {/* The Host/Compare segmented pill now lives inline in the
                    host canvas header (HostBuilderViewRedesigned) so the
                    section nav is a single row, not stacked above the canvas. */}
                <div className="min-h-0 flex-1">
                  <HostBuilderView
                    hostId={selectedHostId}
                    projectId={projectId}
                  />
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="host-browse"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={SNAPPY_RAIL}
                className="absolute inset-0 flex min-h-0 flex-col bg-background text-foreground"
              >
                <HostsConnectAddServerSlotContext.Provider
                  value={addServerSlotEl}
                >
                  <ConnectViewHeader
                    value="servers"
                    previewedHostId={previewedHostId}
                    onChange={(next) => {
                      // `onSelectHost` is wired to `handleSelectHost` in
                      // HostsRoute, which itself calls `navigate(buildHostsPath(...))`
                      // — calling `navigate` here too pushes a duplicate
                      // history entry, breaking the browser Back button.
                      if (next === "host" && previewedHostId) {
                        onSelectHost(previewedHostId);
                      } else if (next === "servers") {
                        navigate(routePaths.servers);
                      } else if (next === "compare") {
                        navigate(buildHostComparePath());
                      } else if (next === "computer") {
                        navigate(routePaths.computer);
                      }
                    }}
                    rightSlot={
                      <div
                        ref={setAddServerSlotEl}
                        className="flex min-w-0 flex-wrap items-center justify-center gap-3 md:justify-end"
                        data-testid="hosts-tab-add-server-slot"
                      />
                    }
                  />
                  <div
                    className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
                    style={browseShellStyle}
                    data-host-style={previewedHostStyle ?? undefined}
                  >
                    <div className="min-h-0 flex-1">{serversTabElement}</div>
                  </div>
                </HostsConnectAddServerSlotContext.Provider>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </LayoutGroup>
    </HostsConnectViewPhaseContext.Provider>
  );
}
