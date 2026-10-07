import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  PluginIconDirectoryProvider,
  entrypointIconSources,
  isRawServerId,
  pluginIconsById,
  serverDisplayName,
  serverIconSources,
  useServerIconSources,
  type PluginIconDirectory,
} from "../plugin-icon-directory";

const png = (name: string) => ({
  url: `https://cdn.example.invalid/${name}.png`,
  contentType: "image/png",
});

describe("plugin icon directory", () => {
  it("reads each plugin's manifest icons and drops unusable ones", () => {
    const byId = pluginIconsById([
      {
        pluginId: "bits",
        icons: {
          logo: png("logo"),
          logoDark: { url: "javascript:alert(1)", contentType: "image/png" },
          composerIcon: { url: png("c").url, contentType: "text/html" },
        },
      },
      { pluginId: "no-icons" },
      { pluginId: 4, icons: { logo: png("x") } },
      null,
    ]);
    expect([...byId]).toEqual([["bits", { logo: png("logo") }]]);
    expect(pluginIconsById(undefined).size).toBe(0);
  });

  it("joins a server to its owning plugin's icons through discovery", () => {
    const directory: PluginIconDirectory = {
      plugins: new Map([["bits", { composerIcon: png("composer") }]]),
      servers: {
        owned: {
          pluginId: "bits",
          serverIcons: [{ src: "https://cdn.example.invalid/server.svg" }],
        },
        plain: { serverIcons: [{ src: "https://cdn.example.invalid/p.png" }] },
        // Discovery named a plugin the project list doesn't carry (yet).
        unknown: { pluginId: "gone" },
      },
    };
    expect(serverIconSources(directory, "owned")).toEqual({
      pluginIcons: { composerIcon: png("composer") },
      serverIcons: [{ src: "https://cdn.example.invalid/server.svg" }],
    });
    expect(serverIconSources(directory, "plain")).toEqual({
      serverIcons: [{ src: "https://cdn.example.invalid/p.png" }],
    });
    expect(serverIconSources(directory, "unknown")).toEqual({});
    expect(serverIconSources(directory, "missing")).toEqual({});
    expect(serverIconSources(directory, undefined)).toEqual({});
  });

  it("orders an entrypoint's sources: tool, server (discover, else initialize), plugin logo", () => {
    const directory: PluginIconDirectory = {
      plugins: new Map([["bits", { logo: png("logo") }]]),
      servers: {
        owned: {
          pluginId: "bits",
          serverIcons: [{ src: "https://cdn.example.invalid/discover.png" }],
        },
      },
    };
    const initialize = [{ src: "https://cdn.example.invalid/initialize.png" }];
    const declaration = {
      toolName: "library",
      title: "Library",
      kind: "global",
      toolIcons: [{ src: "https://cdn.example.invalid/tool.svg" }],
    };
    expect(
      entrypointIconSources(
        directory,
        { serverId: "owned", icons: initialize },
        declaration,
      ),
    ).toEqual({
      toolIcons: [{ src: "https://cdn.example.invalid/tool.svg" }],
      serverIcons: [{ src: "https://cdn.example.invalid/discover.png" }],
      pluginIcons: { logo: png("logo") },
    });
    // Without discovered server icons, `initialize`'s.
    expect(
      entrypointIconSources(directory, { serverId: "plain", icons: initialize }),
    ).toEqual({ serverIcons: initialize });
    expect(entrypointIconSources(directory, { serverId: "plain" })).toEqual({});
  });

  it("is empty outside the provider and stable across renders inside it", () => {
    expect(
      renderHook(() => useServerIconSources("owned")).result.current,
    ).toEqual({});
    const directory: PluginIconDirectory = {
      plugins: new Map([["bits", { logo: png("logo") }]]),
      servers: { owned: { pluginId: "bits" } },
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PluginIconDirectoryProvider value={directory}>
        {children}
      </PluginIconDirectoryProvider>
    );
    const { result, rerender } = renderHook(
      () => useServerIconSources("owned"),
      { wrapper },
    );
    const first = result.current;
    expect(first).toEqual({ pluginIcons: { logo: png("logo") } });
    rerender();
    expect(result.current).toBe(first);
  });
});

describe("server display names", () => {
  const rawId = "mn7bw96zekw8ge3qgngdcx90hn8fpzw8";
  const directory: PluginIconDirectory = {
    plugins: new Map(),
    servers: { [rawId]: { name: "Bits & Bolts", pluginId: "bits" } },
  };

  it("names a server by its saved name, never its raw id", () => {
    expect(isRawServerId(rawId)).toBe(true);
    expect(isRawServerId("my-server")).toBe(false);
    expect(isRawServerId("abcdefghijklmnopqrstuvwxyzabcdef")).toBe(false);
    // The workspace's own list first, then discovery.
    expect(
      serverDisplayName(rawId, directory, [
        { serverId: rawId, name: "Saved Bits" },
      ]),
    ).toBe("Saved Bits");
    expect(serverDisplayName(rawId, directory)).toBe("Bits & Bolts");
    expect(
      serverDisplayName(`  ${rawId} `, {
        plugins: new Map(),
        servers: {},
      }),
    ).toBe("App");
  });

  it("keeps a label that is already a name", () => {
    expect(serverDisplayName("Local server", directory)).toBe("Local server");
    expect(serverDisplayName(undefined, directory)).toBe("App");
    expect(serverDisplayName("  ", directory)).toBe("App");
  });
});
