import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, expect, vi } from "vitest";
import { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import type { WidgetHost } from "@mcpjam/widget-react";
import type { ServerSettingsApp } from "../server-settings-api";

const f = vi.hoisted(() => ({
  peers: [] as InMemoryTransport[],
  app: undefined as ServerSettingsApp | undefined,
  host: undefined as WidgetHost | undefined,
  rows: [] as unknown[],
  mutate: vi.fn(),
  iframeMounts: 0,
  openCount: 0,
  realSettingsView: false,
  openSession: vi.fn(),
}));
vi.mock("../server-settings-api", () => ({
  createServerSettingsApi: () => ({ open: f.openSession }),
}));
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", async (original) => ({
  ...(await original<
    typeof import("@modelcontextprotocol/ext-apps/app-bridge")
  >()),
  PostMessageTransport: function () {
    const [host, guest] = InMemoryTransport.createLinkedPair();
    f.peers.push(guest);
    return host;
  },
}));
vi.mock("../../../../../../widget-react/src/sandboxed-iframe", async () => {
  const { forwardRef, useEffect, useImperativeHandle, useRef } =
    await import("react");
  return {
    SandboxedIframe: forwardRef<
      import("../../../../../../widget-react/src/sandboxed-iframe").SandboxedIframeHandle,
      import("react").ComponentProps<
        typeof import("../../../../../../widget-react/src/sandboxed-iframe").SandboxedIframe
      >
    >((props, ref) => {
      const frame = useRef<HTMLIFrameElement>(null);
      useImperativeHandle(ref, () => ({
        getIframeElement: () => frame.current,
        // The real App peer below uses the bridge transport; no guest JS executes in this iframe.
        postMessage: () => {},
      }));
      useEffect(() => {
        f.iframeMounts++;
      }, []);
      useEffect(() => {
        props.onProxyReady?.();
      }, [props.onProxyReady]);
      return <iframe ref={frame} title="Settings guest" style={props.style} />;
    }),
  };
});
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({ mutation: f.mutate }),
  useQuery: (name: string) =>
    name === "users:getCurrentUser" ? { _id: "actor" } : f.rows,
}));
vi.mock("@/lib/apis/web/base", () => ({
  webPost: async () => ({ ok: true, storageId: "answer" }),
}));
vi.mock("@/lib/use-extension-launch-health", async (original) => ({
  ...(await original<typeof import("@/lib/use-extension-launch-health")>()),
  useSettingsLaunchObservation: () => undefined,
}));
vi.mock("../use-server-settings", () => ({
  useServerSettingsAvailability: () => ({ available: true, failed: false }),
}));
vi.mock("@/components/plugins/PluginSettingsSection", () => ({
  PluginSettingsSection: () => null,
}));
vi.mock("../ServerSettingsPanel", () => ({
  ServerSettingsPanel: () =>
    f.realSettingsView ? (
      <ServerSettingsView
        scope={scope}
        serverId="server"
        serverName="CAD"
        approve={async () => true}
        host={host}
      />
    ) : (
      <SettingsHarness />
    ),
}));

import { SettingsApp } from "../SettingsApp";
import { ServerSettingsView } from "../ServerSettingsView";
import { useSettingsDialogPresentation } from "../settings-dialog-presentation";
import { ServerDetailModal } from "../../connection/ServerDetailModal";
import { OwnedPluginFormHost } from "../../elicitation/OwnedPluginFormHost";
import { __resetComposerFormStore, registerComposerSlot } from "../../elicitation/composer-form-store";
import { DEFAULT_HOST_STYLE, getHostStyleOrDefault } from "@/lib/client-styles";
import {
  clampDisplayModeToAvailableModes,
  extractHostDisplayMode,
  extractHostDisplayModes,
  extractHostTheme,
} from "@/lib/client-config";
import { resolveEffectiveMcpAppsCapabilities } from "@/lib/client-config-v2";

const unexpected = async () => {
  throw new Error("Unexpected service request");
};
export const host: WidgetHost = {
  environment: {
    themeMode: "light",
    sharedHostStyle: "chatgpt",
    scenarioHostStyle: null,
    scenarioHostTheme: null,
    hostCapabilitiesOverride: undefined,
    profileKey: "settings",
    profileSandbox: undefined,
    profileHostInfo: undefined,
    draftHostContext: { availableDisplayModes: ["inline", "fullscreen"] },
    isPlaygroundActive: true,
    playgroundLocale: "en-US",
    playgroundTimeZone: "UTC",
    playgroundDisplayMode: "inline",
    playgroundCapabilities: { hover: true, touch: false },
    playgroundSafeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    playgroundDeviceType: "desktop",
  },
  resolvers: {
    resolveEffectiveCompatRuntime: () => ({ injected: false }),
    resolveEffectiveHostCapabilities: () => ({ serverTools: {} }),
    resolveEffectiveMcpAppsCapabilities: () => ({
      ...resolveEffectiveMcpAppsCapabilities({
        profile: undefined,
        hostStyle: "chatgpt",
      }),
      availableDisplayModes: ["inline", "fullscreen"],
      widgetDisplayModeRequests: "accept",
    }),
    resolveHostInfo: () => ({ name: "Settings QA", version: "1" }),
    getHostStyleOrDefault,
    DEFAULT_HOST_STYLE,
    extractHostTheme,
    extractHostDisplayMode,
    extractHostDisplayModes,
    clampDisplayModeToAvailableModes,
    stableStringifyJson: (value) => JSON.stringify(value) ?? "",
  },
  services: {
    fetchWidgetContent: unexpected,
    readResource: unexpected,
    listResources: unexpected,
    listPrompts: unexpected,
    listResourceTemplates: unexpected,
    authFetch: unexpected,
  },
  surface: {
    kind: "playground",
    persistentSurfaceHost: false,
    webManagedServers: false,
    hostedMode: false,
    sandboxOrigin: "",
    playgroundCspMode: "widget-declared",
  },
};
export const scope = {
  projectId: "project",
  hostId: "host",
  threadId: "settings",
  pluginWorkspace: { version: 1 as const, workspaceId: "settings-private" },
};
export function appFor(
  modes: ("inline" | "fullscreen")[],
  preferredDisplayMode?: "inline" | "fullscreen",
): ServerSettingsApp {
  return {
    childToken: "child",
    resourceUri: "ui://settings",
    appToolsEnabled: true,
    toolMetadata: {},
    widgetContent: {
      mimeTypeValid: true,
      html: "<!doctype html><div>Settings fixture</div>",
      resourceDisplayHints: {
        availableDisplayModes: modes,
        ...(preferredDisplayMode ? { preferredDisplayMode } : {}),
      },
    },
    result: { content: [{ type: "text", text: "Settings ready" }] },
    call: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => {}),
  };
}
export function SettingsHarness() {
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const parent = useSettingsDialogPresentation();
  useLayoutEffect(
    () => parent && slot ? registerComposerSlot(scope.pluginWorkspace.workspaceId, slot) : undefined,
    [!!parent, slot],
  );
  const app = f.app;
  if (!app) throw new Error("Test app missing");
  return (
    <>
      {parent && <div ref={setSlot} />}
      <section hidden={parent?.active}>
        <textarea aria-label="Settings draft" defaultValue="keep draft" />
        <button
          onClick={() => {
            f.openCount++;
            setOpen(true);
          }}
        >
          Open Settings App
        </button>
      </section>
      {open && (
        <SettingsApp
          app={app}
          host={f.host ?? host}
          serverId="server"
          serverName="CAD"
          toolName="settings"
          signal={new AbortController().signal}
          scope={scope}
          onClose={() => {
            void app.close();
            setOpen(false);
          }}
        />
      )}
      <OwnedPluginFormHost projectId="project" workspaceId="settings-private" />
    </>
  );
}
const plugin = {
  pluginId: "plugin",
  pluginLabel: "Bits",
  serverId: "server",
  serverName: "CAD",
};
const mountedApps: App[] = [];
afterEach(async () => {
  cleanup();
  for (const app of mountedApps.splice(0)) await app.close();
  __resetComposerFormStore();
  f.peers = [];
  f.rows = [];
  f.mutate.mockReset();
  f.iframeMounts = 0;
  f.openCount = 0;
  f.app = undefined;
  f.host = undefined;
  f.realSettingsView = false;
  f.openSession.mockReset();
});
export async function open(
  parent = true,
  capabilities: ConstructorParameters<typeof App>[1] = {},
) {
  const view = render(settingsSurface(parent));
  const opener = screen.getByRole("button", { name: "Open Settings App" });
  opener.focus();
  fireEvent.click(opener);
  const { guest, frame } = await connectGuest(capabilities);
  return { view, guest, frame };
}

export async function connectGuest(
  capabilities: ConstructorParameters<typeof App>[1] = {},
) {
  await waitFor(() => expect(f.peers).toHaveLength(1));
  const guest = new App(
    { name: "Settings test guest", version: "1" },
    capabilities,
    { autoResize: false },
  );
  const frame = screen.getByTitle("Settings guest");
  mountedApps.push(guest);
  await act(async () => {
    await guest.connect(f.peers[0]);
  });
  return { guest, frame };
}

export function settingsSurface(parent = true) {
  return parent ? (
    <ServerDetailModal
      isOpen
      plugin={plugin}
      onClose={() => {}}
      projectId="project"
      extensionSettingsScope={scope}
    />
  ) : (
    <SettingsHarness />
  );
}
export { f };
