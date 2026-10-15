import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The connected server's `initialize` icons, by server name.
const appState = vi.hoisted(() => ({
  servers: {} as Record<string, unknown>,
}));
vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => ({ servers: appState.servers }),
}));

import { PluginServerIcon } from "../plugin-server-icon";

const png = (name: string) => ({
  url: `https://cdn.test/${name}.png`,
  contentType: "image/png",
});
const shown = () => document.querySelector("img")?.getAttribute("src") ?? null;
/** The image sources a chip walks through as each one fails to load. */
function walk(): (string | null)[] {
  const order: (string | null)[] = [];
  for (let step = 0; step < 8 && document.querySelector("img"); step++) {
    const image = document.querySelector("img")!;
    // Advisory images never send the page as referrer.
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    order.push(image.getAttribute("src"));
    fireEvent.error(image);
  }
  return order;
}

afterEach(() => {
  appState.servers = {};
  document.documentElement.classList.remove("dark");
});

describe("composer plugin icon", () => {
  it("prefers the plugin's composer icon and falls back on failure", async () => {
    render(
      <PluginServerIcon
        serverName="Bits & Bolts"
        pluginIcons={{
          logo: { url: "https://cdn.test/logo.png", contentType: "image/png" },
          composerIcon: {
            url: "https://cdn.test/composer.png",
            contentType: "image/png",
          },
        }}
      />,
    );
    const icon = await screen.findByTestId("plugin-icon");
    expect(icon).toHaveAttribute("src", "https://cdn.test/composer.png");
    fireEvent.error(icon);
    // A failed composer icon falls to the plugin's logo, not to generic.
    expect(screen.getByTestId("plugin-icon")).toHaveAttribute(
      "src",
      "https://cdn.test/logo.png",
    );
    fireEvent.error(screen.getByTestId("plugin-icon"));
    expect(screen.queryByTestId("plugin-icon")).toBeNull();
    // The generic mark stands in once every plugin icon fails.
    expect(document.querySelector("svg")).not.toBeNull();
  });

  it("uses the server's own MCP icon without plugin icons", () => {
    render(
      <PluginServerIcon icons={[{ src: "https://cdn.test/result.png" }]} />,
    );
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.test/result.png",
    );
  });

  it("walks composer icon, logo, server icon, then generic", () => {
    render(
      <PluginServerIcon
        serverName="Bits & Bolts"
        pluginIcons={{ composerIcon: png("composer"), logo: png("logo") }}
        serverIcons={[{ src: "https://cdn.test/server.png" }]}
      />,
    );
    expect(walk()).toEqual([
      "https://cdn.test/composer.png",
      "https://cdn.test/logo.png",
      "https://cdn.test/server.png",
    ]);
    expect(document.querySelector("svg")).not.toBeNull();
  });

  it("uses the logo when the plugin declares no composer icon, per theme", () => {
    document.documentElement.classList.add("dark");
    render(
      <PluginServerIcon
        pluginIcons={{ logo: png("logo"), logoDark: png("logo-dark") }}
      />,
    );
    expect(shown()).toBe("https://cdn.test/logo-dark.png");
  });

  it("reads discovered server icons first, then the server's initialize icons", () => {
    appState.servers = {
      Plain: {
        initializationInfo: {
          serverVersion: {
            icons: [{ src: "https://cdn.test/initialize.png" }],
          },
        },
      },
    };
    const { rerender } = render(
      <PluginServerIcon
        serverName="Plain"
        serverIcons={[
          { src: "https://cdn.test/discover-a.png" },
          { src: "https://cdn.test/discover-b.png" },
        ]}
      />,
    );
    // A plain MCP server: its discovered icons, each failure to the next.
    expect(walk()).toEqual([
      "https://cdn.test/discover-a.png",
      "https://cdn.test/discover-b.png",
    ]);
    expect(document.querySelector("svg")).not.toBeNull();
    // Without discovered icons, `initialize`'s.
    rerender(<PluginServerIcon serverName="Plain" />);
    expect(shown()).toBe("https://cdn.test/initialize.png");
  });
});
