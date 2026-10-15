/**
 * App mappings (single and OpenAI's keyed `.app.json`), presentation from
 * OpenAI's `interface`, and the packaged onboarding skill.
 */

import { describe, expect, it } from "vitest";
import { parsePluginBundle } from "../../src/plugin-bundle/index.js";
import { bitsAndBoltsRemoteFiles } from "./compat-fixtures.js";
import {
  bundle,
  manifestJson,
  MCP_JSON_HTTP,
  minimalBundle,
  skillMd,
} from "./fixtures.js";

const compat = { profile: "openai-compatible" } as const;
const keyed = (apps: unknown) => JSON.stringify({ apps });

describe("keyed .app.json", () => {
  it("binds a registered app to the bundle server of the same name", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "mcp.json": MCP_JSON_HTTP,
        ".app.json": keyed({ "demo-server": { id: "plugin_asdk_app_demo" } }),
      })
    );
    expect(parsed.apps).toEqual([
      expect.objectContaining({
        componentKey: "app:.app.json#demo-server",
        appId: "plugin_asdk_app_demo",
        appKey: "demo-server",
        serverKey: "demo-server",
        binding: "registered",
        status: "bound",
      }),
    ]);
  });

  it("keeps a registered-app-only package importable, the app unresolved", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/setup/SKILL.md": skillMd("setup"),
        ".app.json": keyed({ crm: { id: "plugin_asdk_app_crm" } }),
      })
    );
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.apps).toEqual([
      expect.objectContaining({
        appId: "plugin_asdk_app_crm",
        binding: "registered",
        status: "unresolved",
      }),
    ]);
    expect(parsed.apps[0]).not.toHaveProperty("serverKey");
  });

  it("never treats a registered ID as the bundle's only server", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "mcp.json": MCP_JSON_HTTP,
        ".app.json": keyed({ other: { id: "plugin_asdk_app_other" } }),
      })
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual([
      "demo-server",
    ]);
    expect(parsed.apps).toEqual([
      expect.objectContaining({ status: "unresolved", binding: "registered" }),
    ]);
  });

  it("reads the empty scaffold as no apps", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({ ".app.json": keyed({}) })
    );
    expect(parsed.apps).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("ignores an entry without an id and screens secrets from the rest", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        ".app.json": keyed({
          broken: { name: "no id" },
          good: { id: "plugin_asdk_app_good", token: "sk-live-app-secret" },
        }),
      })
    );
    expect(parsed.apps.map((app) => app.appKey)).toEqual(["good"]);
    expect(parsed.apps[0].extensions).toEqual({});
    expect(JSON.stringify(parsed)).not.toContain("sk-live-app-secret");
    expect(parsed.warnings.map((w) => w.code).sort()).toEqual([
      "APP_MISSING_ID",
      "APP_SECRET_FIELD_OMITTED",
    ]);
  });
});

describe("app configuration failures stay with the app file", () => {
  it.each([
    ["invalid JSON", "{ nope"],
    ["a missing id", JSON.stringify({ server: "demo-server" })],
    ["a non-object apps map", keyed(["a"])],
    ["a non-object document", "[1]"],
  ])(
    "skips apps in a file with %s, keeping the bundle",
    async (_label, content) => {
      const parsed = await parsePluginBundle(
        minimalBundle({
          "skills/setup/SKILL.md": skillMd("setup"),
          "mcp.json": MCP_JSON_HTTP,
          "broken.app.json": content,
          "ok.app.json": JSON.stringify({ id: "com.example.ok" }),
        })
      );
      expect(parsed.skills).toHaveLength(1);
      expect(parsed.mcpServers).toHaveLength(1);
      expect(parsed.apps.map((app) => app.appId)).toEqual(["com.example.ok"]);
      expect(parsed.skipped).toEqual([
        expect.objectContaining({ kind: "app", key: "broken.app.json" }),
      ]);
      expect(parsed.warnings.every((w) => w.severity === "warning")).toBe(true);
    }
  );

  it("refuses a keyed file with more apps than a bundle may have servers, in one issue", async () => {
    const apps = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`app-${i}`, {}])
    );
    const parsed = await parsePluginBundle(
      minimalBundle({
        "big.app.json": keyed(apps),
        "ok.app.json": JSON.stringify({ id: "com.example.ok" }),
      })
    );
    expect(parsed.apps.map((app) => app.appId)).toEqual(["com.example.ok"]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "app", key: "big.app.json" }),
    ]);
    expect(parsed.warnings.length).toBeLessThan(5);
  });
});

describe("presentation", () => {
  it("reads the display name from OpenAI's interface, with com.mcpjam overriding", async () => {
    const fromTopLevel = await parsePluginBundle(
      minimalBundle({}, { interface: { displayName: "From Interface" } })
    );
    expect(fromTopLevel.manifest.displayName).toBe("From Interface");

    const precedence = await parsePluginBundle(
      minimalBundle(
        {},
        {
          interface: { displayName: "Top" },
          extensions: {
            "com.openai": { interface: { displayName: "OpenAI" } },
            "com.mcpjam": { displayName: "MCPJam" },
          },
        }
      )
    );
    expect(precedence.manifest.displayName).toBe("MCPJam");
  });

  it("ignores a placeholder display name in the interface block", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({}, { interface: { displayName: "[TODO: Plugin Name]" } })
    );
    expect(parsed.manifest.displayName).toBeUndefined();
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({
        code: "MANIFEST_INVALID_FIELD",
        message: expect.stringContaining("interface.displayName"),
      })
    );
  });

  it("reads the Bits & Bolts Remote package end to end", async () => {
    const parsed = await parsePluginBundle(
      bundle(bitsAndBoltsRemoteFiles()),
      compat
    );
    expect(parsed.manifest).toMatchObject({
      name: "bits-and-bolts",
      displayName: "Bits & Bolts",
      version: "1.0.23",
      logo: "assets/icon.svg",
      logoDark: "assets/icon-dark.svg",
      composerIcon: "assets/icon.svg",
      onboarding: {
        skillPath: "skills/onboarding/SKILL.md",
        componentKey: "skill:onboarding",
      },
    });
    expect(parsed.mcpServers[0].config).toMatchObject({
      transport: "http",
      auth: { type: "oauth" },
    });
    expect(parsed.apps).toEqual([
      expect.objectContaining({ serverKey: "bits-and-bolts", status: "bound" }),
    ]);
    expect(parsed.skipped).toEqual([]);
  });
});

describe("onboarding skill", () => {
  const withOnboarding = (onboardingSkill: unknown, skills = ["setup"]) =>
    bundle({
      "plugin.json": manifestJson({
        extensions: { "com.openai": { onboardingSkill } },
      }),
      ...Object.fromEntries(
        skills.map((name) => [`skills/${name}/SKILL.md`, skillMd(name)])
      ),
      "README.md": "# readme",
    });

  it("keeps an onboarding skill that names a loaded skill", async () => {
    const parsed = await parsePluginBundle(
      withOnboarding("./skills/setup/SKILL.md")
    );
    expect(parsed.manifest.onboarding).toEqual({
      skillPath: "skills/setup/SKILL.md",
      componentKey: "skill:setup",
    });
    expect(parsed.manifest.extensions["com.openai"]).toEqual({
      onboardingSkill: "./skills/setup/SKILL.md",
    });
  });

  it("keeps a long valid path the secret screen would have dropped", async () => {
    const name = "first-run-onboarding-setup-walkthrough-for-new-users";
    const path = `./skills/${name}/SKILL.md`;
    const parsed = await parsePluginBundle(withOnboarding(path, [name]));
    expect(parsed.manifest.onboarding?.componentKey).toBe(`skill:${name}`);
    expect(parsed.manifest.extensions["com.openai"]).toEqual({
      onboardingSkill: path,
    });
    // Nor is it reported as a dropped secret on its way back.
    expect(parsed.warnings.map((w) => w.code)).not.toContain(
      "MANIFEST_SECRET_FIELD_OMITTED"
    );
  });

  it.each([
    ["an escaping path", "../skills/setup/SKILL.md"],
    ["a file that is not a skill", "./README.md"],
    ["a skill that does not exist", "./skills/missing/SKILL.md"],
    ["a non-string value", 42],
    ["a secret-looking value", "sk-live-0123456789abcdef0123456789abcdef"],
  ])("drops an onboarding skill naming %s", async (_label, onboardingSkill) => {
    const parsed = await parsePluginBundle(withOnboarding(onboardingSkill));
    expect(parsed.manifest.onboarding).toBeUndefined();
    expect(parsed.manifest.extensions["com.openai"]).toEqual({});
    expect(parsed.warnings.map((w) => w.code)).toContain(
      "MANIFEST_MISSING_FILE"
    );
    expect(JSON.stringify(parsed.warnings)).not.toContain("sk-live");
  });

  it("drops an onboarding skill whose SKILL.md was skipped", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        "plugin.json": manifestJson({
          extensions: {
            "com.openai": { onboardingSkill: "./skills/setup/SKILL.md" },
          },
        }),
        "skills/setup/SKILL.md": "no frontmatter",
      })
    );
    expect(parsed.manifest.onboarding).toBeUndefined();
  });

  it("reads a legacy Codex package's top-level onboarding skill", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        ".codex-plugin/plugin.json": JSON.stringify({
          name: "demo",
          onboardingSkill: "skills/setup/SKILL.md",
        }),
        "skills/setup/SKILL.md": skillMd("setup"),
      }),
      compat
    );
    expect(parsed.manifest.onboarding?.skillPath).toBe("skills/setup/SKILL.md");
  });
});
