import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLIENT_SRC } from "@/components/hosts/__tests__/support/client-tsx";

/**
 * Plugin parts live where their kind lives: servers on the Servers tab,
 * skills on the Skills tab, lifecycle in a server's Settings. The plugin
 * group card and its section are gone, and nothing may bring them back
 * through a stale import.
 */
const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("plugin group card removal", () => {
  it("deleted the group card and its section", () => {
    expect(existsSync(join(PLUGINS_DIR, "PluginGroupCard.tsx"))).toBe(false);
    expect(existsSync(join(PLUGINS_DIR, "PluginsSection.tsx"))).toBe(false);
  });

  it("leaves no import of either", () => {
    const importers = readdirSync(CLIENT_SRC, { recursive: true })
      .map(String)
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) =>
        /from ["'][^"']*\/(PluginGroupCard|PluginsSection)["']/.test(
          readFileSync(join(CLIENT_SRC, file), "utf8"),
        ),
      );
    expect(importers).toEqual([]);
  });
});
