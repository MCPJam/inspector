import { describe, expect, it } from "vitest";
import type { WidgetHost } from "@mcpjam/widget-react";
import type { ThreadAppHandle } from "../thread-app-api";
import { createThreadAppHost } from "../thread-app-host";

const host = {
  environment: {
    draftHostContext: {
      displayMode: "pip",
      availableDisplayModes: ["pip"],
      "openai/deepLink": "unowned",
      "openai/modelContext": "unowned",
      theme: "dark",
    },
  },
  surface: {},
  resolvers: {
    resolveEffectiveHostCapabilities: () => ({ serverTools: {} }),
    resolveEffectiveMcpAppsCapabilities: () => ({
      availableDisplayModes: ["inline", "fullscreen", "pip"],
      serverTools: true,
      widgetDisplayModeRequests: "decline",
    }),
  },
} as unknown as WidgetHost;
const handle = { appToolsEnabled: true } as ThreadAppHandle;

describe("owned App display contract", () => {
  it.each(["global", "thread"] as const)(
    "initializes a %s entrypoint in fullscreen only, without inherited presentation authority",
    (kind) => {
      const owned = createThreadAppHost(host, handle, "server", kind);
      expect(owned.environment.draftHostContext).toEqual({
        displayMode: "fullscreen",
        availableDisplayModes: ["fullscreen"],
        theme: "dark",
      });
      const capabilities = owned.resolvers.resolveEffectiveMcpAppsCapabilities({
        hostStyle: "chatgpt",
      });
      expect(capabilities.availableDisplayModes).toEqual(["fullscreen"]);
      expect(capabilities.widgetDisplayModeRequests).toBe("decline");
      expect(capabilities.serverTools).toBe(true);
      expect(capabilities.updateModelContext).toBe(false);
      expect(capabilities.message).toBe(false);
    },
  );
  it("preserves saved mode restrictions and denies unavailable entrypoint presentation", () => {
    const restricted = {
      ...host,
      resolvers: {
        ...host.resolvers,
        resolveEffectiveMcpAppsCapabilities: () => ({
          availableDisplayModes: ["inline"],
          widgetDisplayModeRequests: "decline",
        }),
      },
    } as unknown as WidgetHost;
    const thread = createThreadAppHost(restricted, handle, "server", "thread");
    expect(
      thread.resolvers.resolveEffectiveMcpAppsCapabilities({
        hostStyle: "chatgpt",
      }).availableDisplayModes,
    ).toEqual([]);
    expect(
      thread.resolvers.resolveEffectiveMcpAppsCapabilities({
        hostStyle: "chatgpt",
      }).widgetDisplayModeRequests,
    ).toBe("decline");
    const global = createThreadAppHost(restricted, handle, "server", "global");
    expect(
      global.resolvers.resolveEffectiveMcpAppsCapabilities({
        hostStyle: "chatgpt",
      }).availableDisplayModes,
    ).toEqual([]);
  });
  it("defaults to a fullscreen thread entrypoint and never widens disabled tool admission", () => {
    const owned = createThreadAppHost(
      host,
      { ...handle, appToolsEnabled: false },
      "server",
    );
    expect(owned.environment.draftHostContext?.displayMode).toBe("fullscreen");
    expect(
      owned.resolvers.resolveEffectiveHostCapabilities({
        hostStyle: "chatgpt",
      }),
    ).toEqual({});
    expect(
      owned.resolvers.resolveEffectiveMcpAppsCapabilities({
        hostStyle: "chatgpt",
      }).serverTools,
    ).toBe(false);
  });
});

describe("who decides an owned App's display mode", () => {
  it.each(["global", "thread"] as const)(
    "a %s entrypoint fixes fullscreen, so an App's own declaration can't refuse it",
    (kind) => {
      const owned = createThreadAppHost(host, handle, "server", kind);
      expect(owned.surface.fixedDisplayMode).toBe("fullscreen");
    },
  );
  it("a model App keeps negotiating its modes", () => {
    const owned = createThreadAppHost(host, handle, "server", "model");
    expect(owned.surface.fixedDisplayMode).toBeUndefined();
  });
});

describe("a model App in the chat", () => {
  it("keeps the client's chat display modes and request policy, so it can leave fullscreen", () => {
    const client = {
      ...host,
      resolvers: {
        ...host.resolvers,
        resolveEffectiveMcpAppsCapabilities: () => ({
          availableDisplayModes: ["inline", "fullscreen", "pip"],
          serverTools: true,
          widgetDisplayModeRequests: "accept",
        }),
      },
    } as unknown as WidgetHost;
    const owned = createThreadAppHost(client, handle, "server", "model");
    expect(owned.environment.draftHostContext).toEqual({
      displayMode: "inline",
      availableDisplayModes: [],
      theme: "dark",
    });
    const capabilities = owned.resolvers.resolveEffectiveMcpAppsCapabilities({
      hostStyle: "chatgpt",
    });
    expect(capabilities.availableDisplayModes).toEqual(["inline", "fullscreen"]);
    expect(capabilities.widgetDisplayModeRequests).toBe("accept");
    // Owned bridge services stay as narrow as an entrypoint's.
    expect(capabilities.updateModelContext).toBe(false);
    expect(capabilities.message).toBe(false);
    expect(capabilities.serverResources).toBe(false);
  });
  it("keeps the client's chat modes in host context and its saved restrictions", () => {
    const chat = {
      ...host,
      environment: {
        draftHostContext: {
          displayMode: "fullscreen",
          availableDisplayModes: ["inline", "fullscreen"],
        },
      },
      resolvers: {
        ...host.resolvers,
        resolveEffectiveMcpAppsCapabilities: () => ({
          availableDisplayModes: ["inline"],
          widgetDisplayModeRequests: "decline",
        }),
      },
    } as unknown as WidgetHost;
    const owned = createThreadAppHost(chat, handle, "server", "model");
    expect(owned.environment.draftHostContext).toEqual({
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
    });
    const capabilities = owned.resolvers.resolveEffectiveMcpAppsCapabilities({
      hostStyle: "chatgpt",
    });
    expect(capabilities.availableDisplayModes).toEqual(["inline"]);
    expect(capabilities.widgetDisplayModeRequests).toBe("decline");
  });
});

describe("window.openai in extension Apps", () => {
  it("follows the client's own Inject window.openai setting", () => {
    for (const injected of [true, false]) {
      const client = {
        ...host,
        resolvers: {
          ...host.resolvers,
          resolveEffectiveCompatRuntime: () => ({ injected }),
        },
      } as unknown as WidgetHost;
      const owned = createThreadAppHost(client, handle, "server", "thread");
      expect(
        owned.resolvers.resolveEffectiveCompatRuntime({ hostStyle: "chatgpt" }),
      ).toEqual({ injected });
    }
  });
});
