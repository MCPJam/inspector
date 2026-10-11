import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ExtensionIcon,
  normalizeIcons,
  pickIcon,
  resolveExtensionIcon,
} from "../ExtensionIcon";

const svg = (theme?: "light" | "dark") => ({
  src: `https://plugin.example/${theme ?? "any"}.svg`,
  mimeType: "image/svg+xml",
  ...(theme ? { theme } : {}),
});

describe("extension icons", () => {
  it("picks by theme, then size, never just the first icon", () => {
    const icons = normalizeIcons([
      { src: "https://plugin.example/big.png", sizes: ["512x512"] },
      svg("dark"),
      { src: "https://plugin.example/small.png", sizes: ["16x16"] },
      { src: "https://plugin.example/right.png", sizes: ["24x24"] },
      svg("light"),
    ]);
    expect(pickIcon(icons, "light")?.src).toBe(
      "https://plugin.example/light.svg",
    );
    expect(pickIcon(icons, "dark")?.src).toBe("https://plugin.example/dark.svg");
    expect(
      pickIcon(normalizeIcons(icons.filter((icon) => !icon.theme)), "light", 20)
        ?.src,
    ).toBe("https://plugin.example/right.png");
  });

  it("drops untrusted or malformed sources", () => {
    expect(
      normalizeIcons([
        { src: "javascript:alert(1)" },
        { src: 4 },
        null,
        { src: "data:image/svg+xml;base64,AAAA", theme: "neon" },
      ]),
    ).toEqual([{ src: "data:image/svg+xml;base64,AAAA" }]);
  });

  it("applies each kind's fallback order", () => {
    const sources = {
      toolIcons: [svg()],
      serverIcons: [{ src: "https://server.example/icon.png" }],
      composerIcon: "https://plugin.example/composer.svg",
      logo: "https://plugin.example/logo.png",
      logoDark: "https://plugin.example/logo-dark.png",
    };
    expect(resolveExtensionIcon("sidebar", sources, "light")?.src).toBe(
      "https://plugin.example/any.svg",
    );
    expect(
      resolveExtensionIcon("sidebar", { ...sources, toolIcons: [] }, "light")
        ?.src,
    ).toBe("https://server.example/icon.png");
    expect(resolveExtensionIcon("composer", sources, "dark")?.src).toBe(
      "https://plugin.example/composer.svg",
    );
    expect(
      resolveExtensionIcon(
        "composer",
        { ...sources, composerIcon: undefined },
        "dark",
      )?.src,
    ).toBe("https://plugin.example/logo-dark.png");
    expect(resolveExtensionIcon("directory", sources, "light")?.src).toBe(
      "https://plugin.example/logo.png",
    );
    expect(resolveExtensionIcon("directory", {}, "light")).toBeUndefined();
  });

  it("masks SVG with currentColor, uses img otherwise, and never inlines markup", () => {
    const { container, rerender } = render(
      <ExtensionIcon
        kind="sidebar"
        theme="light"
        sources={{ toolIcons: [svg()] }}
      />,
    );
    const mask = container.querySelector("[data-extension-icon=mask]") as HTMLElement;
    expect(mask).not.toBeNull();
    expect(mask.style.backgroundColor).toBe("currentcolor");
    expect(container.querySelector("svg")).toBeNull();
    rerender(
      <ExtensionIcon
        kind="sidebar"
        theme="light"
        sources={{ serverIcons: [{ src: "https://server.example/icon.png" }] }}
      />,
    );
    expect(
      container.querySelector("img[data-extension-icon=image]"),
    ).toHaveAttribute("src", "https://server.example/icon.png");
    rerender(<ExtensionIcon kind="sidebar" theme="light" sources={{}} />);
    expect(
      container.querySelector("[data-extension-icon=generic]"),
    ).not.toBeNull();
  });
});

describe("sidebar icons from discovery", () => {
  it("follows the host's ranking and falls through broken images to the generic icon", () => {
    const toolIcons = [
      { src: "https://plugin.example/tool-dark.png", theme: "dark" },
      { src: "https://plugin.example/tool.png" },
    ];
    const serverIcons = [{ src: "https://plugin.example/server.png" }];
    const { container } = render(
      <ExtensionIcon
        kind="sidebar"
        theme="light"
        sources={{ toolIcons, serverIcons }}
      />,
    );
    const image = () =>
      container.querySelector("img[data-extension-icon=image]");
    // The dark variant is never used in light theme.
    expect(image()).toHaveAttribute("src", "https://plugin.example/tool.png");
    fireEvent.error(image()!);
    expect(image()).toHaveAttribute("src", "https://plugin.example/server.png");
    fireEvent.error(image()!);
    expect(container.querySelector("[data-extension-icon=generic]")).not.toBeNull();
  });
});

describe("sidebar icon fallback order", () => {
  const pluginIcons = {
    logo: { url: "https://plugin.example/logo.png", contentType: "image/png" },
    logoDark: {
      url: "https://plugin.example/logo-dark.png",
      contentType: "image/png",
    },
    // Composer chips only; never an entrypoint icon.
    composerIcon: {
      url: "https://plugin.example/composer.png",
      contentType: "image/png",
    },
  };
  const shown = (container: HTMLElement) =>
    container.querySelector<HTMLImageElement>(
      "img[data-extension-icon=image], img[data-testid=plugin-icon]",
    );

  it("tries the tool icon, the server icon, the plugin's logo, then generic", () => {
    const { container } = render(
      <ExtensionIcon
        kind="sidebar"
        theme="light"
        sources={{
          toolIcons: [{ src: "https://plugin.example/tool.png" }],
          serverIcons: [{ src: "https://plugin.example/server.png" }],
          pluginIcons,
        }}
      />,
    );
    const order: (string | null)[] = [];
    for (let step = 0; step < 4 && shown(container); step++) {
      const image = shown(container)!;
      // Advisory images never send the page as referrer.
      expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
      order.push(image.getAttribute("src"));
      fireEvent.error(image);
    }
    expect(order).toEqual([
      "https://plugin.example/tool.png",
      "https://plugin.example/server.png",
      "https://plugin.example/logo.png",
      // The other theme's logo before giving up.
      "https://plugin.example/logo-dark.png",
    ]);
    expect(
      container.querySelector("[data-extension-icon=generic]"),
    ).not.toBeNull();
  });

  it("shows the plugin's logo for the theme when no MCP icon is declared", () => {
    const { container, rerender } = render(
      <ExtensionIcon kind="sidebar" theme="dark" sources={{ pluginIcons }} />,
    );
    expect(shown(container)).toHaveAttribute(
      "src",
      "https://plugin.example/logo-dark.png",
    );
    rerender(
      <ExtensionIcon kind="sidebar" theme="light" sources={{ pluginIcons }} />,
    );
    expect(shown(container)).toHaveAttribute(
      "src",
      "https://plugin.example/logo.png",
    );
    // A plain MCP server without icons gets the generic icon.
    rerender(<ExtensionIcon kind="sidebar" theme="light" sources={{}} />);
    expect(
      container.querySelector("[data-extension-icon=generic]"),
    ).not.toBeNull();
  });

  it("falls from a broken SVG mask to the next candidate", () => {
    const { container } = render(
      <ExtensionIcon
        kind="sidebar"
        theme="light"
        sources={{
          toolIcons: [svg()],
          serverIcons: [{ src: "https://plugin.example/server.png" }],
        }}
      />,
    );
    const probe = container.querySelector<HTMLImageElement>(
      "[data-extension-icon=mask] img[data-extension-icon=probe]",
    );
    expect(probe).toHaveAttribute("src", "https://plugin.example/any.svg");
    expect(probe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(probe!.hidden).toBe(true);
    fireEvent.error(probe!);
    expect(container.querySelector("[data-extension-icon=mask]")).toBeNull();
    expect(shown(container)).toHaveAttribute(
      "src",
      "https://plugin.example/server.png",
    );
  });
});
