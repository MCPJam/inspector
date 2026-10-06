/**
 * OpenAI plugin icons: `interface.logo` / `logoDark` (directory icon, light
 * and dark) and `interface.composerIcon`, read from the top-level `interface`
 * block or `extensions["com.openai"].interface`, with the `com.mcpjam`
 * namespace overriding `logo`.
 */

import { describe, expect, it } from "vitest";
import {
  parsePluginBundle,
  pluginComposerIconPath,
  pluginDirectoryIconPath,
} from "../../src/plugin-bundle/index.js";
import { encode, minimalBundle, PNG_BYTES } from "./fixtures.js";

const SVG_BYTES = encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0h20v20H0z"/></svg>'
);

const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code);

describe("OpenAI interface icons", () => {
  it("reads directory and composer icons from the top-level interface block", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        {
          "assets/icon.svg": SVG_BYTES,
          "assets/icon-dark.svg": SVG_BYTES,
          "assets/composer.png": PNG_BYTES,
        },
        {
          interface: {
            displayName: "Bits & Bolts",
            logo: "./assets/icon.svg",
            logoDark: "./assets/icon-dark.svg",
            composerIcon: "./assets/composer.png",
          },
        }
      )
    );
    expect(parsed.manifest).toMatchObject({
      logo: "assets/icon.svg",
      logoDark: "assets/icon-dark.svg",
      composerIcon: "assets/composer.png",
    });
    // `interface` is handled, not reported as an unknown field, and a full
    // light/dark pair raises no icon warning.
    expect(codes(parsed.warnings)).toEqual([]);
    expect(parsed.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "assets/icon.svg", kind: "logo" }),
        expect.objectContaining({ path: "assets/icon-dark.svg", kind: "logo" }),
        expect.objectContaining({ path: "assets/composer.png", kind: "icon" }),
      ])
    );
  });

  it("prefers the com.openai namespace over the top level, and com.mcpjam over both", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        {
          "assets/a.png": PNG_BYTES,
          "assets/b.png": PNG_BYTES,
          "assets/c.png": PNG_BYTES,
          "assets/dark.png": PNG_BYTES,
        },
        {
          interface: { logo: "assets/a.png", logoDark: "assets/dark.png" },
          extensions: {
            "com.openai": { interface: { logo: "assets/b.png" } },
            "com.mcpjam": { logo: "assets/c.png" },
          },
        }
      )
    );
    expect(parsed.manifest.logo).toBe("assets/c.png");
    expect(parsed.manifest.logoDark).toBe("assets/dark.png");
  });

  it("warns when an OpenAI plugin has no directory icon or misses a variant", async () => {
    const none = await parsePluginBundle(
      minimalBundle({}, { interface: { displayName: "No icons" } })
    );
    expect(codes(none.warnings)).toContain("MANIFEST_DIRECTORY_ICON_MISSING");

    const lightOnly = await parsePluginBundle(
      minimalBundle(
        { "assets/icon.png": PNG_BYTES },
        { extensions: { "com.openai": { interface: { logo: "assets/icon.png" } } } }
      )
    );
    expect(codes(lightOnly.warnings)).toContain(
      "MANIFEST_DIRECTORY_ICON_VARIANT_MISSING"
    );
    expect(
      lightOnly.warnings.find(
        (w) => w.code === "MANIFEST_DIRECTORY_ICON_VARIANT_MISSING"
      )?.message
    ).toMatch(/dark variant/);
  });

  it("does not hold plain Agent Plugins bundles to OpenAI's icon rules", async () => {
    const parsed = await parsePluginBundle(minimalBundle());
    expect(parsed.warnings).toEqual([]);
  });

  it("drops a bad OpenAI icon with a warning instead of failing the import", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        {
          "assets/icon.png": "not really a png",
          "assets/readme.md": "# notes",
          "assets/dark.png": PNG_BYTES,
        },
        {
          interface: {
            logo: "assets/icon.png",
            logoDark: "assets/dark.png",
            composerIcon: "assets/readme.md",
          },
        }
      )
    );
    expect(parsed.manifest.logo).toBeUndefined();
    expect(parsed.manifest.composerIcon).toBeUndefined();
    expect(parsed.manifest.logoDark).toBe("assets/dark.png");
    expect(codes(parsed.warnings)).toEqual(
      expect.arrayContaining(["ASSET_CONTENT_MISMATCH", "ASSET_UNSUPPORTED_TYPE"])
    );
  });

  it("warns on missing or escaping OpenAI icon paths", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        {},
        { interface: { logo: "assets/missing.png", logoDark: "../outside.png" } }
      )
    );
    expect(parsed.manifest.logo).toBeUndefined();
    expect(parsed.manifest.logoDark).toBeUndefined();
    expect(codes(parsed.warnings)).toEqual(
      expect.arrayContaining(["MANIFEST_MISSING_FILE", "PATH_ESCAPES_ROOT"])
    );
  });
});

describe("icon resolvers", () => {
  it("picks the directory icon by theme with a cross-variant fallback", () => {
    const both = { logo: "light.png", logoDark: "dark.png" };
    expect(pluginDirectoryIconPath(both, "light")).toBe("light.png");
    expect(pluginDirectoryIconPath(both, "dark")).toBe("dark.png");
    expect(pluginDirectoryIconPath({ logo: "light.png" }, "dark")).toBe(
      "light.png"
    );
    expect(pluginDirectoryIconPath({}, "light")).toBeUndefined();
  });

  it("falls back from the composer icon to the directory icon", () => {
    expect(
      pluginComposerIconPath({ composerIcon: "c.svg", logo: "l.png" }, "light")
    ).toBe("c.svg");
    expect(pluginComposerIconPath({ icon: "i.png", logo: "l.png" }, "light")).toBe(
      "i.png"
    );
    expect(
      pluginComposerIconPath({ logo: "l.png", logoDark: "d.png" }, "dark")
    ).toBe("d.png");
  });
});
