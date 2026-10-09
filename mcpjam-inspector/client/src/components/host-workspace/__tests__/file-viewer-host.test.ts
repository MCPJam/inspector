import { describe, expect, it, vi } from "vitest";
import type { WidgetHost } from "@mcpjam/widget-react";
import type { ThreadAppHandle } from "../thread-app-api";
import { withFileViewerHost } from "../file-viewer-host";

const owned = {
  services: {},
  resolvers: {
    resolveEffectiveHostCapabilities: () => ({}),
    resolveEffectiveMcpAppsCapabilities: () => ({ serverResources: false }),
  },
} as unknown as WidgetHost;
const handle = {
  file: { name: "part.stl", resourceUri: "host-resource://owned" },
} as ThreadAppHandle;
const services = {
  readResourceV2: async () => ({ contents: [] }),
  configureAppBridge: () => undefined,
};
const args = { hostStyle: "chatgpt" } as const;
describe("owned file viewer capabilities", () => {
  it.each([false, true])("preserves saved resource policy %s", (allowed) => {
    const policy = {
      ...owned,
      resolvers: {
        resolveEffectiveHostCapabilities: () => ({ serverResources: {} }),
        resolveEffectiveMcpAppsCapabilities: () => ({
          serverResources: allowed,
        }),
      },
    } as unknown as WidgetHost;
    const host = withFileViewerHost(owned, policy, handle, services);
    expect(
      !!host.resolvers.resolveEffectiveHostCapabilities(args).serverResources,
    ).toBe(allowed);
    expect(
      host.resolvers.resolveEffectiveMcpAppsCapabilities(args).serverResources,
    ).toBe(allowed);
    expect(host.services.readResourceV2).toBe(services.readResourceV2);
  });
  it("retains the original bridge lifecycle beside file services", () => {
    const originalCleanup = vi.fn(),
      fileCleanup = vi.fn();
    const original = vi.fn(() => originalCleanup),
      file = vi.fn(() => fileCleanup);
    const host = withFileViewerHost(
      {
        ...owned,
        services: { configureAppBridge: original },
      } as unknown as WidgetHost,
      owned,
      handle,
      { ...services, configureAppBridge: file },
    );
    const cleanup = host.services.configureAppBridge!({} as any, {});
    expect(original).toHaveBeenCalledOnce();
    expect(file).toHaveBeenCalledOnce();
    cleanup?.();
    expect(originalCleanup).toHaveBeenCalledOnce();
    expect(fileCleanup).toHaveBeenCalledOnce();
  });
  it("preserves other admitted extension capabilities", () => {
    const existing = {
      ...owned,
      resolvers: {
        ...owned.resolvers,
        resolveEffectiveHostCapabilities: () => ({
          experimental: { "other/extension": {} },
        }),
      },
    } as WidgetHost;
    const policy = {
      ...owned,
      resolvers: {
        resolveEffectiveHostCapabilities: () => ({ serverResources: {} }),
        resolveEffectiveMcpAppsCapabilities: () => ({ serverResources: true }),
      },
    } as unknown as WidgetHost;
    expect(
      withFileViewerHost(
        existing,
        policy,
        handle,
        services,
      ).resolvers.resolveEffectiveHostCapabilities(args).experimental,
    ).toEqual({ "other/extension": {}, "openai/resource": {} });
  });
  it("does not advertise resources without both target and services", () => {
    expect(withFileViewerHost(owned, owned, handle, undefined)).toBe(owned);
    expect(
      withFileViewerHost(owned, owned, {} as ThreadAppHandle, services),
    ).toBe(owned);
  });
});
