import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PluginIcon,
  selectPluginIcon,
} from "../PluginIcon";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";

const png = (name: string) => ({
  url: `https://site.example/web/artifact?t=${name}`,
  contentType: "image/png",
});

describe("selectPluginIcon", () => {
  const icons: PluginIcons = {
    logo: png("light"),
    logoDark: png("dark"),
    composerIcon: png("composer"),
  };

  it("picks the directory icon for the theme, falling back across variants", () => {
    expect(selectPluginIcon(icons, "directory", "light")?.url).toMatch(/light/);
    expect(selectPluginIcon(icons, "directory", "dark")?.url).toMatch(/dark/);
    expect(
      selectPluginIcon({ logo: png("light") }, "directory", "dark")?.url,
    ).toMatch(/light/);
    expect(selectPluginIcon(undefined, "directory", "light")).toBeUndefined();
  });

  it("prefers the composer icon for composer chips, else the directory icon", () => {
    expect(selectPluginIcon(icons, "composer", "light")?.url).toMatch(
      /composer/,
    );
    expect(
      selectPluginIcon({ logoDark: png("dark") }, "composer", "light")?.url,
    ).toMatch(/dark/);
  });
});

describe("PluginIcon", () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:plugin-icon");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    // Unmount first: the icon revokes its blob URL on cleanup.
    cleanup();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.unstubAllGlobals();
  });

  it("renders the fallback without icons", () => {
    render(<PluginIcon icons={undefined} fallback={<span>generic</span>} />);
    expect(screen.getByText("generic")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-icon")).toBeNull();
  });

  it("loads raster icons straight from their link", () => {
    render(
      <PluginIcon icons={{ logo: png("light") }} fallback={<span>generic</span>} />,
    );
    expect(screen.getByTestId("plugin-icon")).toHaveAttribute(
      "src",
      "https://site.example/web/artifact?t=light",
    );
  });

  it("falls from a failed composer icon to the logo, then the fallback", () => {
    render(
      <PluginIcon
        kind="composer"
        icons={{ logo: png("light"), composerIcon: png("composer") }}
        fallback={<span>generic</span>}
      />,
    );
    const icon = () => screen.queryByTestId("plugin-icon");
    expect(icon()).toHaveAttribute(
      "src",
      "https://site.example/web/artifact?t=composer",
    );
    expect(icon()).toHaveAttribute("referrerpolicy", "no-referrer");
    fireEvent.error(icon()!);
    expect(icon()).toHaveAttribute(
      "src",
      "https://site.example/web/artifact?t=light",
    );
    fireEvent.error(icon()!);
    expect(icon()).toBeNull();
    expect(screen.getByText("generic")).toBeInTheDocument();
  });

  it("moves past an SVG that can't be fetched to the next icon", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    render(
      <PluginIcon
        kind="composer"
        icons={{
          composerIcon: {
            url: "https://site.example/web/artifact?t=gone",
            contentType: "image/svg+xml",
          },
          logo: png("light"),
        }}
        fallback={<span>generic</span>}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("plugin-icon")).toHaveAttribute(
        "src",
        "https://site.example/web/artifact?t=light",
      ),
    );
  });

  it("renders SVG from a typed blob, never inline markup", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("<svg/>").buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <PluginIcon
        icons={{
          logo: {
            url: "https://site.example/web/artifact?t=svg",
            contentType: "image/svg+xml",
          },
        }}
        fallback={<span>generic</span>}
      />,
    );
    // Generic icon while the SVG loads.
    expect(screen.getByText("generic")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("plugin-icon")).toHaveAttribute(
        "src",
        "blob:plugin-icon",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://site.example/web/artifact?t=svg",
    );
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Blob;
    expect(blob.type).toBe("image/svg+xml");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("keeps the fallback when the SVG can't be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    render(
      <PluginIcon
        icons={{
          logo: {
            url: "https://site.example/web/artifact?t=gone",
            contentType: "image/svg+xml",
          },
        }}
        fallback={<span>generic</span>}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("generic")).toBeInTheDocument();
  });
});
