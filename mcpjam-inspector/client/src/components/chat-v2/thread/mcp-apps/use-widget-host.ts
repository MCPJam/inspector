// Tier B widget-runtime extraction — Phase 1 (services + surface + debug).
//
// `useWidgetHost` is the inspector-side adapter that implements the `WidgetHost`
// dependency-inversion contract (see ./widget-host.ts) by reading the ambient
// stores/contexts the widget renderer used to reach into directly. It is a
// COMPOSITE HOOK, not a context provider: the renderer is always already
// mounted inside whatever provider hierarchy its surface needs (chat /
// playground / chatbox / trace), so calling the same hooks the renderer calls
// works on every surface with zero new mount points.
//
// This module — the boundary adapter — is allowed to import @/stores, @/contexts
// and the api/config layer; the renderer will not. This PR covers the
// `services`, `surface`, and `debug` slices; `resolveEnvironment` (the
// security-sensitive profile/sandbox resolution) lands in the follow-up, at
// which point the return type widens to the full `WidgetHost`.

import { useMemo, useRef } from "react";
import { HOSTED_MODE, SANDBOX_ORIGIN } from "@/lib/config";
import { useIsChatboxSurface } from "@/contexts/chatbox-surface-context";
import { useWebManagedServers } from "@/contexts/web-managed-servers-context";
import { useWidgetSurface } from "@/contexts/widget-surface-context";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import { listResources, readResource } from "@/lib/apis/mcp-resources-api";
import { listPrompts } from "@/lib/apis/mcp-prompts-api";
import { listResourceTemplates } from "@/lib/apis/mcp-resource-templates-api";
import { usePersistentWidgetSurfaceHost } from "./widget-surface-context";
import { fetchMcpAppsWidgetContent } from "./fetch-widget-content";
import type {
  WidgetHost,
  WidgetHostServices,
  WidgetSurfaceInfo,
  WidgetDebugSink,
  WidgetSurfaceKind,
} from "./widget-host";

/** The slices of `WidgetHost` implemented in this PR. */
type WidgetHostServicesSurfaceDebug = Required<
  Pick<WidgetHost, "services" | "surface" | "debug">
>;

export function useWidgetHost(): WidgetHostServicesSurfaceDebug {
  // --- surface inputs --------------------------------------------------------
  const isChatboxSurface = useIsChatboxSurface();
  const widgetSurface = useWidgetSurface();
  const webManagedServers = useWebManagedServers();
  const persistentSurfaceHost = usePersistentWidgetSurfaceHost();
  const playgroundCspMode = useUIPlaygroundStore((s) => s.mcpAppsCspMode);

  // `isChatboxSurface` / `widgetSurface` are read ONLY for the renderer's CSP
  // mode derivation; collapsing them to one `kind` preserves it exactly
  // (chatbox wins over playground, see mcp-apps-renderer.tsx:741-746).
  const kind: WidgetSurfaceKind = isChatboxSurface
    ? "chatbox"
    : widgetSurface === "playground"
      ? "playground"
      : "chat";

  // Read into a ref so the memoized `services` object stays stable while the
  // listResourceTemplates guard still observes the live value (mirrors the
  // renderer's existing webManagedServersRef pattern).
  const webManagedServersRef = useRef(webManagedServers);
  webManagedServersRef.current = webManagedServers;

  const services = useMemo<WidgetHostServices>(
    () => ({
      fetchWidgetContent: fetchMcpAppsWidgetContent,
      readResource,
      listResources,
      listPrompts,
      // Host-owned: preserve the renderer's hosted/web-managed guard
      // (mcp-apps-renderer.tsx:2861-2868); the raw api fn only enforces
      // HOSTED_MODE.
      listResourceTemplates: async (serverId: string) => {
        if (HOSTED_MODE || webManagedServersRef.current) {
          throw new Error(
            "Resource templates are not supported in hosted mode",
          );
        }
        return listResourceTemplates(serverId);
      },
    }),
    [],
  );

  const surface = useMemo<WidgetSurfaceInfo>(
    () => ({
      kind,
      persistentSurfaceHost,
      webManagedServers,
      sandboxOrigin: SANDBOX_ORIGIN ?? "",
      playgroundCspMode,
    }),
    [kind, persistentSurfaceHost, webManagedServers, playgroundCspMode],
  );

  // --- debug sink (1:1 with the stores) --------------------------------------
  const recordMount = useWidgetDebugStore((s) => s.recordMount);
  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetState = useWidgetDebugStore((s) => s.setWidgetState);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);
  const setWidgetCsp = useWidgetDebugStore((s) => s.setWidgetCsp);
  const addCspViolation = useWidgetDebugStore((s) => s.addCspViolation);
  const clearCspViolations = useWidgetDebugStore((s) => s.clearCspViolations);
  const setWidgetModelContext = useWidgetDebugStore(
    (s) => s.setWidgetModelContext,
  );
  const setWidgetHtml = useWidgetDebugStore((s) => s.setWidgetHtml);
  const setSandboxApplied = useWidgetDebugStore((s) => s.setSandboxApplied);
  const appendLifecycle = useWidgetDebugStore((s) => s.appendLifecycle);
  const addTrafficLog = useTrafficLogStore((s) => s.addLog);

  const debug = useMemo<WidgetDebugSink>(
    () => ({
      recordMount,
      setWidgetDebugInfo,
      setWidgetState,
      setWidgetGlobals,
      setWidgetCsp,
      addCspViolation,
      clearCspViolations,
      setWidgetModelContext,
      setWidgetHtml,
      setSandboxApplied,
      appendLifecycle,
      addTrafficLog,
    }),
    [
      recordMount,
      setWidgetDebugInfo,
      setWidgetState,
      setWidgetGlobals,
      setWidgetCsp,
      addCspViolation,
      clearCspViolations,
      setWidgetModelContext,
      setWidgetHtml,
      setSandboxApplied,
      appendLifecycle,
      addTrafficLog,
    ],
  );

  return useMemo(
    () => ({ services, surface, debug }),
    [services, surface, debug],
  );
}
