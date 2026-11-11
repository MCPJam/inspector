import { withModelAppResources } from "../model-app-resources";
import { describe, expect, it, vi } from "vitest";
import type { WidgetHost } from "@mcpjam/widget-react";
import type { ThreadAppHandle } from "../thread-app-api";
import { createThreadAppHost } from "../thread-app-host";
import * as sessionToken from "@/lib/session-token";
import * as apiContext from "@/lib/apis/web/context";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSandboxView } from "../../../../../../widget-react/src/use-sandbox-view";

const logged = vi.hoisted(() => ({ event: vi.fn() }));
vi.mock("../extension-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extension-log")>()),
  logExtensionEvent: logged.event,
}));

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
const OPENAI_RULES = { hints: "openai/ui", start: "hint-first" } as const;
const CLAUDE_RULES = { hints: "ui", start: "inline-then-move" } as const;

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
  it("applies the client's display behavior only when the Display modes toggle is on", () => {
    for (const kind of ["model", "global", "thread"] as const) {
      expect(
        createThreadAppHost(host, handle, "server", kind).surface
          .displayBehavior,
      ).toBeUndefined();
      for (const displayBehavior of [OPENAI_RULES, CLAUDE_RULES])
        expect(
          createThreadAppHost(host, handle, "server", kind, {
            displayBehavior,
          }).surface.displayBehavior,
        ).toBe(displayBehavior);
    }
  });
  it("lets OpenAI's rules pick a model App's starting mode instead of forcing inline", () => {
    const ruled = createThreadAppHost(host, handle, "server", "model", {
      displayBehavior: OPENAI_RULES,
    });
    expect(ruled.environment.draftHostContext?.displayMode).toBe("pip");
    const plain = createThreadAppHost(host, handle, "server", "model");
    expect(plain.environment.draftHostContext?.displayMode).toBe("inline");
    // Claude's rule starts every App inline.
    const claude = createThreadAppHost(host, handle, "server", "model", {
      displayBehavior: CLAUDE_RULES,
    });
    expect(claude.environment.draftHostContext?.displayMode).toBe("inline");
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


it("uses the owned resource service and refuses other servers and expired instances", async () => {
  const source = { ...handle, resourcesEnabled: true };
  const controller = new AbortController();
  const resource = vi.fn(async () => ({ contents: [] }));
  const owned = withModelAppResources(createThreadAppHost(host, source, "original", "model"), host, source, "original", { resource }, controller.signal);
  await expect(owned.services.readResource("original", "test://item")).resolves.toEqual({ content: { contents: [] } });
  expect(resource).toHaveBeenCalledWith(source, { method: "resources/read", uri: "test://item" }, controller.signal);
  await expect(owned.services.readResource("other", "test://item")).rejects.toThrow("App resource unavailable");
  controller.abort();
  await expect(owned.services.readResource("original", "test://item")).rejects.toThrow();
  expect(resource).toHaveBeenCalledOnce();
});

describe("owned App document admission", () => {
  it("keeps the admitted origin through base-host and theme changes", async () => {
    const prepared = {
      admissionId: "retained-view",
      proxyUrl: "http://127.0.0.1:53001/api/apps/mcp-apps/sandbox-proxy",
      htmlSha256: "a".repeat(64),
      expiresAt: Date.now() + 2 * 60 * 60_000,
    };
    const fetch = vi.spyOn(sessionToken, "authFetch").mockImplementation(async (_url, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(prepared),
    );
    const owner = {
      ...handle, operationId: "owned-operation", resourceUri: "ui://owned",
      widgetContent: { html: "<p>Retained App</p>" },
    };
    const request = {
      source: { serverId: "hidden-server", resourceUri: owner.resourceUri, toolCallId: "model-call" },
      html: owner.widgetContent.html, mode: "declared" as const, policy: { permissive: false },
    };
    const mounted = renderHook((base: WidgetHost) => {
      const owned = createThreadAppHost(base, owner, "hidden-server", "thread", { projectId: "owner-project" });
      return { services: owned.services, view: useSandboxView({ services: owned.services, request }) };
    }, { initialProps: host });
    try {
      await waitFor(() => expect(mounted.result.current.view.result).toEqual(prepared));
      const initial = mounted.result.current.services;
      mounted.rerender({
        ...host,
        environment: { ...host.environment, draftHostContext: { theme: "light" } },
        services: { ...host.services },
      });
      await act(async () => { await Promise.resolve(); });
      expect(mounted.result.current.services.prepareSandboxView).toBe(initial.prepareSandboxView);
      expect(mounted.result.current.services.releaseSandboxView).toBe(initial.releaseSandboxView);
      expect(mounted.result.current.view.result?.proxyUrl).toBe(prepared.proxyUrl);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(createThreadAppHost(host, owner, "hidden-server", "thread", { projectId: "other-project" })
        .services.prepareSandboxView).not.toBe(initial.prepareSandboxView);
      mounted.unmount();
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(fetch.mock.calls[1][1]?.method).toBe("DELETE");
    } finally {
      mounted.unmount();
      fetch.mockRestore();
    }
  });

  it("uses the captured project for a hidden server even when ambient lookup cannot resolve it", async () => {
    const fetch = vi.spyOn(sessionToken, "authFetch").mockResolvedValue(Response.json({
      admissionId: "owned-view",
      proxyUrl: "http://127.0.0.1:53001/api/apps/mcp-apps/sandbox-proxy",
      htmlSha256: "a".repeat(64),
      expiresAt: Date.now() + 60_000,
    }));
    const lookup = vi.spyOn(apiContext, "buildServerRequest").mockImplementation(() => {
      throw new Error("No ambient server");
    });
    try {
      const owned = createThreadAppHost(host, {
        ...handle,
        operationId: "owned-operation",
        resourceUri: "ui://owned",
        widgetContent: { html: "<p>App</p>" },
      }, "hidden-server", "global", { projectId: "owner-project" });
      await owned.services.prepareSandboxView!({
        viewInstanceId: "7e482e93-8c7d-4e88-b673-091d97320cb0",
        source: { serverId: "hidden-server", resourceUri: "ui://owned", toolCallId: "model-call" },
        html: "<p>App</p>", hostOrigin: "http://localhost:5173", mode: "declared", policy: { permissive: false },
      });
      expect(fetch.mock.calls[0][0]).toBe("/api/web/apps/mcp-apps/view-admissions");
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
        projectId: "owner-project", serverId: "hidden-server",
        source: { serverId: "hidden-server", resourceUri: "ui://owned", toolCallId: "owned-operation" },
      });
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      lookup.mockRestore();
    }
  });

  it.each(["global", "thread", "model"] as const)(
    "preserves scoped preparation and cleanup for a %s App",
    async (presentation) => {
      const prepared = {
        admissionId: "owned-view",
        proxyUrl: "http://127.0.0.1:53001/api/apps/mcp-apps/sandbox-proxy",
        htmlSha256: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
      };
      const prepareSandboxView = vi.fn(async () => prepared);
      const releaseSandboxView = vi.fn(async () => {});
      const base = { ...host, services: { ...host.services, prepareSandboxView, releaseSandboxView } };
      const content = { html: "<p>Owned App</p>" };
      const owned = createThreadAppHost(
        base,
        { ...handle, operationId: "owned-operation", resourceUri: "ui://owned", widgetContent: content },
        "server",
        presentation,
      );
      const request = {
        viewInstanceId: "7e482e93-8c7d-4e88-b673-091d97320cb0",
        source: { serverId: "server", resourceUri: "ui://owned", toolCallId: "call" },
        html: content.html,
        hostOrigin: "http://localhost:6274",
        mode: "declared" as const,
        policy: { permissive: false },
      };
      const signal = new AbortController().signal;
      await expect(owned.services.prepareSandboxView!(request, signal)).resolves.toEqual(prepared);
      expect(prepareSandboxView).toHaveBeenCalledWith({
        ...request,
        source: { ...request.source, toolCallId: "owned-operation" },
      }, signal);
      await expect(owned.services.prepareSandboxView!({ ...request, source: { ...request.source, serverId: "other" } })).rejects.toThrow("App resource changed");
      await expect(owned.services.prepareSandboxView!({ ...request, source: { ...request.source, resourceUri: "ui://other" } })).rejects.toThrow("App resource changed");
      await expect(owned.services.prepareSandboxView!({ ...request, html: "<p>Other App</p>" })).rejects.toThrow("App resource changed");
      expect(prepareSandboxView).toHaveBeenCalledOnce();
      await owned.services.releaseSandboxView!({ admissionId: "another-owner" });
      expect(releaseSandboxView).not.toHaveBeenCalled();
      await owned.services.releaseSandboxView!({ admissionId: prepared.admissionId });
      await owned.services.releaseSandboxView!({ admissionId: prepared.admissionId });
      expect(releaseSandboxView).toHaveBeenCalledExactlyOnceWith({ admissionId: prepared.admissionId });
      await expect(owned.services.authFetch("/unscoped")).rejects.toThrow("unavailable");
    },
  );
});

describe("a _meta.ui.preferredDisplayMode that isn't a mode", () => {
  const ignoring = () =>
    ({
      ...handle,
      toolTitle: "Weather",
      resourceUri: "ui://weather",
      widgetContent: {
        html: "<p>weather</p>",
        ignoredPreferredDisplayMode: '"sidebar"',
      },
    }) as ThreadAppHandle;
  const request = {
    serverId: "server",
    resourceUri: "ui://weather",
  } as Parameters<WidgetHost["services"]["fetchWidgetContent"]>[0];

  it("is one display-mode warning in Logs for a client that reads _meta.ui", async () => {
    logged.event.mockClear();
    const owned = createThreadAppHost(host, ignoring(), "server", "model", {
      displayBehavior: CLAUDE_RULES,
    });
    await owned.services.fetchWidgetContent(request);
    await owned.services.fetchWidgetContent(request);
    expect(logged.event).toHaveBeenCalledTimes(1);
    expect(logged.event).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server",
        label: "display-mode",
        level: "warning",
        message:
          'Weather\'s resource sets _meta.ui.preferredDisplayMode to "sidebar", which MCPJam ignores. Set it to "fullscreen" or "inline".',
      }),
    );
  });

  it("stays out of Logs for clients that read openai/ui", async () => {
    logged.event.mockClear();
    for (const displayBehavior of [OPENAI_RULES, undefined])
      await createThreadAppHost(host, ignoring(), "server", "model", {
        displayBehavior,
      }).services.fetchWidgetContent(request);
    expect(logged.event).not.toHaveBeenCalled();
  });
});
