// Tier B — `useWidgetHost`, the inspector-side adapter for the `WidgetHost`
// dependency-inversion contract (see ./widget-host.ts). It reads the ambient
// stores/contexts the widget renderer used to reach into directly and exposes
// them as `environment` (raw ENV inputs), `resolvers` (bound config/style fns),
// `services`, `surface`, and `debug`.
//
// It is a COMPOSITE HOOK, not a context provider: the renderer is always already
// mounted inside whatever provider hierarchy its surface needs (chat /
// playground / chatbox / trace), so calling the same hooks the renderer calls
// works on every surface with zero new mount points.
//
// This module — the boundary adapter — is allowed to import @/stores, @/contexts
// and the api/config layer; `mcp-apps-renderer.tsx` is not (enforced by
// check-renderer-tier-b-imports.mjs). Phase 1b routes the renderer's ambient
// reads through `environment`/`resolvers` while keeping its derivation in place;
// pre-resolving them into `WidgetHost.resolveEnvironment` is the Phase-3 target.

import { useMemo, useRef } from "react";
import { HOSTED_MODE, SANDBOX_ORIGIN } from "@/lib/config";
import { useIsChatboxSurface } from "@/contexts/chatbox-surface-context";
import { useWebManagedServers } from "@/contexts/web-managed-servers-context";
import { useWidgetSurface } from "@/contexts/widget-surface-context";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useChatboxHostStyle,
  useChatboxHostTheme,
} from "@/contexts/chatbox-client-style-context";
import { useChatboxHostCapabilitiesOverride } from "@/contexts/chatbox-client-capabilities-override-context";
import { useActiveMcpProfile } from "@/contexts/active-mcp-profile-context";
import { useHostContextStore } from "@/stores/client-context-store";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import {
  resolveEffectiveCompatRuntime,
  resolveEffectiveHostCapabilities,
  resolveEffectiveMcpAppsCapabilities,
  resolveHostInfo,
} from "@/lib/client-config-v2";
import { DEFAULT_HOST_STYLE, getHostStyleOrDefault } from "@/lib/client-styles";
import {
  clampDisplayModeToAvailableModes,
  extractHostDisplayMode,
  extractHostDisplayModes,
  extractHostTheme,
  stableStringifyJson,
} from "@/lib/client-config";
import { listResources, readResource } from "@/lib/apis/mcp-resources-api";
import { listPrompts } from "@/lib/apis/mcp-prompts-api";
import { listResourceTemplates } from "@/lib/apis/mcp-resource-templates-api";
import { usePersistentWidgetSurfaceHost } from "./widget-surface-context";
import { fetchMcpAppsWidgetContent } from "./fetch-widget-content";
import type {
  WidgetHost,
  WidgetHostEnvironmentInputs,
  WidgetHostResolvers,
  WidgetHostServices,
  WidgetSurfaceInfo,
  WidgetDebugSink,
  WidgetSurfaceKind,
} from "./widget-host";

/** The slices of `WidgetHost` implemented in this adapter. */
type WidgetHostImpl = Required<
  Pick<
    WidgetHost,
    "environment" | "resolvers" | "services" | "surface" | "debug"
  >
>;

export function useWidgetHost(): WidgetHostImpl {
  // --- surface inputs --------------------------------------------------------
  const isChatboxSurface = useIsChatboxSurface();
  const widgetSurface = useWidgetSurface();
  const webManagedServers = useWebManagedServers();
  // Mirrored into the surface bundle for completeness, but the
  // `MCPAppsRenderer` wrapper still reads `usePersistentWidgetSurfaceHost()`
  // directly — it gates persistent-vs-ephemeral routing *before*
  // `MCPAppsRendererSurface` (the `useWidgetHost()` caller) mounts. Fully
  // centralizing this read is intentionally deferred to the renderer-relocation
  // PR to avoid widening the wrapper's subscription set (it would then re-render
  // on every host input). It's a relative-import context, so it does not block
  // the Tier-B `@/stores`/`@/contexts` guard regardless.
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

  // --- environment inputs (Phase 1b raw ambient reads) -----------------------
  //
  // These are the exact fine-grained selectors / context hooks the renderer
  // used to call inline. Subscribing here (rather than in the renderer)
  // relocates the read site without changing reactivity — each selector still
  // re-renders only on its own field's change. The renderer keeps ALL of its
  // derivation (memos, ternaries, deps) and just reads `host.environment.*`.
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const sharedHostStyle = usePreferencesStore((s) => s.hostStyle);
  const chatboxHostStyle = useChatboxHostStyle();
  const chatboxHostTheme = useChatboxHostTheme();
  const hostCapabilitiesOverride = useChatboxHostCapabilitiesOverride();
  const activeMcpProfile = useActiveMcpProfile();
  const draftHostContext = useHostContextStore((s) => s.draftHostContext);
  const isPlaygroundActive = useUIPlaygroundStore((s) => s.isPlaygroundActive);
  const playgroundLocale = useUIPlaygroundStore((s) => s.globals.locale);
  const playgroundTimeZone = useUIPlaygroundStore((s) => s.globals.timeZone);
  const playgroundDisplayMode = useUIPlaygroundStore((s) => s.displayMode);
  const playgroundCapabilities = useUIPlaygroundStore((s) => s.capabilities);
  const playgroundSafeAreaInsets = useUIPlaygroundStore(
    (s) => s.safeAreaInsets,
  );
  const playgroundDeviceType = useUIPlaygroundStore((s) => s.deviceType);

  const environment = useMemo<WidgetHostEnvironmentInputs>(
    () => ({
      themeMode,
      sharedHostStyle,
      chatboxHostStyle,
      chatboxHostTheme,
      hostCapabilitiesOverride,
      activeMcpProfile,
      draftHostContext,
      isPlaygroundActive,
      playgroundLocale,
      playgroundTimeZone,
      playgroundDisplayMode,
      playgroundCapabilities,
      playgroundSafeAreaInsets,
      playgroundDeviceType,
    }),
    [
      themeMode,
      sharedHostStyle,
      chatboxHostStyle,
      chatboxHostTheme,
      hostCapabilitiesOverride,
      activeMcpProfile,
      draftHostContext,
      isPlaygroundActive,
      playgroundLocale,
      playgroundTimeZone,
      playgroundDisplayMode,
      playgroundCapabilities,
      playgroundSafeAreaInsets,
      playgroundDeviceType,
    ],
  );

  // --- resolvers (Phase 1b bound util/resolver fns) --------------------------
  // Module-level fns with stable identity; the object is frozen for the
  // adapter's lifetime so it never invalidates a renderer memo/dep.
  const resolvers = useMemo<WidgetHostResolvers>(
    () => ({
      resolveEffectiveCompatRuntime,
      resolveEffectiveMcpAppsCapabilities,
      resolveEffectiveHostCapabilities,
      resolveHostInfo,
      getHostStyleOrDefault,
      DEFAULT_HOST_STYLE,
      extractHostTheme,
      extractHostDisplayMode,
      extractHostDisplayModes,
      clampDisplayModeToAvailableModes,
      stableStringifyJson,
    }),
    [],
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
    () => ({ environment, resolvers, services, surface, debug }),
    [environment, resolvers, services, surface, debug],
  );
}
