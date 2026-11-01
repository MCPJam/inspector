/**
 * The widget host hands its iframes the sandbox origin the SERVER configured
 * (`MCPJAM_SANDBOX_ORIGIN`, served in the runtime config) over the one the
 * bundle was built with, and the build-time one when the server names none.
 *
 * Unlike `use-widget-host.test.tsx`, `@/lib/config` is the real module here:
 * what is under test is the path from the document's runtime config to the
 * iframe's `src`, and a mocked config would skip exactly that.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { render, renderHook } from "@testing-library/react";

vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/apis/mcp-resource-templates-api", () => ({
  listResourceTemplates: vi.fn(),
}));
vi.mock("@/lib/apis/mcp-resources-api", () => ({
  readResource: vi.fn(),
  listResources: vi.fn(),
}));
vi.mock("@/lib/apis/mcp-prompts-api", () => ({ listPrompts: vi.fn() }));
vi.mock("../fetch-widget-content", () => ({
  fetchMcpAppsWidgetContent: vi.fn(),
}));

const ORIGINAL_LOCATION = window.location;

/** Off `localhost`, whose dev-only origin swap would answer for the sandbox. */
function setLocation(origin: string): void {
  const url = new URL(origin);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...ORIGINAL_LOCATION,
      hostname: url.hostname,
      port: url.port,
      protocol: url.protocol,
      origin: url.origin,
      href: `${url.origin}/`,
    },
  });
}

async function hostedWidgetIframe(options: {
  runtime?: string;
  build?: string;
}) {
  vi.resetModules();
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  vi.stubEnv("VITE_MCPJAM_SANDBOX_ORIGIN", options.build ?? "");
  if (options.runtime === undefined) {
    delete window.__MCP_RUNTIME_CONFIG__;
  } else {
    window.__MCP_RUNTIME_CONFIG__ = { sandboxOrigin: options.runtime };
  }
  const { useWidgetHost } = await import("../use-widget-host");
  const { PreferencesStoreProvider } = await import(
    "@/stores/preferences/preferences-provider"
  );
  const { SandboxedIframe } = await import("@/components/ui/sandboxed-iframe");

  const { result } = renderHook(() => useWidgetHost(), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        {children}
      </PreferencesStoreProvider>
    ),
  });
  const { surface } = result.current;
  const { container } = render(
    <SandboxedIframe
      html={null}
      onMessage={() => {}}
      hostedMode={surface.hostedMode}
      sandboxOrigin={surface.sandboxOrigin}
    />,
  );
  const src = container.querySelector("iframe")?.getAttribute("src");
  return { surface, src: src ? new URL(src) : null };
}

afterEach(() => {
  delete window.__MCP_RUNTIME_CONFIG__;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: ORIGINAL_LOCATION,
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the widget host's sandbox origin", () => {
  it("is the server's runtime origin, over the build-time one", async () => {
    const { surface, src } = await hostedWidgetIframe({
      runtime: "https://sandbox.customer.example",
      build: "https://sandbox.mcpjam.com",
    });

    expect(surface.sandboxOrigin).toBe("https://sandbox.customer.example");
    expect(src?.origin).toBe("https://sandbox.customer.example");
    expect(src?.pathname).toBe("/api/web/apps/mcp-apps/sandbox-proxy");
  });

  it("is the build-time origin when the server names none", async () => {
    const { surface, src } = await hostedWidgetIframe({
      build: "https://sandbox.mcpjam.com",
    });

    expect(surface.sandboxOrigin).toBe("https://sandbox.mcpjam.com");
    expect(src?.origin).toBe("https://sandbox.mcpjam.com");
  });

  it("falls back to same-origin, with the warning, when neither names one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setLocation("https://inspector.customer.example");
    const { surface, src } = await hostedWidgetIframe({});

    expect(surface.sandboxOrigin).toBe("");
    expect(src?.origin).toBe("https://inspector.customer.example");
    expect(warn).toHaveBeenCalled();
  });
});
