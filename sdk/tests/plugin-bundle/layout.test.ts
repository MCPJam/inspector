/**
 * Manifest resolution under the `strict` and `openai-compatible` profiles:
 * which file is the manifest, how a Codex overlay applies, and what a legacy
 * manifest contributes.
 */

import { describe, expect, it } from "vitest";
import { parsePluginBundle } from "../../src/plugin-bundle/index.js";
import {
  computeAggregateHash,
  sha256HexBytes,
} from "../../src/plugin-bundle/hashes.js";
import {
  BITS_AND_BOLTS_CODEX_MANIFEST,
  bitsAndBoltsCodexFiles,
  claudePluginFiles,
  portableWithOverlayFiles,
} from "./compat-fixtures.js";
import {
  bundle,
  encode,
  expectParseError,
  manifestJson,
  minimalBundle,
} from "./fixtures.js";

const compat = { profile: "openai-compatible" } as const;
const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code);

describe("strict profile", () => {
  it("is the default and never reads a legacy manifest", async () => {
    await expectParseError(
      bundle(bitsAndBoltsCodexFiles()),
      "MANIFEST_MISSING"
    );
  });

  it("treats a Codex overlay beside the root manifest as an ordinary file", async () => {
    const parsed = await parsePluginBundle(bundle(portableWithOverlayFiles()));
    expect(parsed.interpretation).toEqual({
      profile: "strict",
      layout: "agent-plugins",
      manifestPath: "plugin.json",
    });
    expect(parsed.manifest.logo).toBeUndefined();
    expect(parsed.manifest.extensions).toEqual({});
    expect(parsed.warnings).toEqual([]);
  });
});

describe("openai-compatible profile: root manifest", () => {
  it("keeps a plain portable bundle exactly as strict reads it", async () => {
    const strict = await parsePluginBundle(minimalBundle());
    const parsed = await parsePluginBundle(minimalBundle(), compat);
    expect({ ...parsed, interpretation: undefined }).toEqual({
      ...strict,
      interpretation: undefined,
    });
    expect(parsed.interpretation).toEqual({
      profile: "openai-compatible",
      layout: "agent-plugins",
      manifestPath: "plugin.json",
    });
  });

  it("applies the Codex overlay's OpenAI data to the root manifest", async () => {
    const parsed = await parsePluginBundle(
      bundle(portableWithOverlayFiles()),
      compat
    );
    expect(parsed.interpretation.overlayPath).toBe(".codex-plugin/plugin.json");
    expect(parsed.manifest).toMatchObject({
      name: "bits-and-bolts",
      // Portable identity comes from the root, not the overlay.
      version: "1.2.3",
      logo: "assets/icon.svg",
      logoDark: "assets/icon-dark.svg",
      composerIcon: "assets/icon.svg",
    });
    expect(parsed.manifest.extensions["com.openai"]).toMatchObject({
      onboardingSkill: "./skills/onboarding/SKILL.md",
    });
    // The overlay names `.mcp.json`; a root package reads only `mcp.json`.
    expect(parsed.warnings).toEqual([
      expect.objectContaining({
        code: "MANIFEST_OVERLAY_IGNORED",
        message: expect.stringContaining('"mcpServers"'),
      }),
    ]);
  });

  it("lets an inline extensions['com.openai'] object replace the overlay entirely", async () => {
    const parsed = await parsePluginBundle(
      bundle(
        portableWithOverlayFiles({
          extensions: {
            "com.openai": {
              onboardingSkill: "./skills/onboarding/SKILL.md",
            },
          },
        })
      ),
      compat
    );
    expect(parsed.interpretation.overlayPath).toBeUndefined();
    // Nothing from the overlay is merged in: no icons, no interface.
    expect(parsed.manifest.logo).toBeUndefined();
    expect(parsed.manifest.extensions["com.openai"]).toEqual({
      onboardingSkill: "./skills/onboarding/SKILL.md",
    });
    expect(codes(parsed.warnings)).toContain("MANIFEST_OVERLAY_IGNORED");
  });

  it("never falls back to a legacy manifest when the root is invalid", async () => {
    const files = bitsAndBoltsCodexFiles();
    await expectParseError(
      bundle({ ...files, "plugin.json": "{ not json" }),
      "MANIFEST_INVALID_JSON",
      compat
    );
    await expectParseError(
      bundle({ ...files, "plugin.json": manifestJson({ name: "Bad Name" }) }),
      "MANIFEST_INVALID_NAME",
      compat
    );
  });

  it("reports, rather than reads, other legacy manifests beside a root", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        "plugin.json": manifestJson(),
        ".claude-plugin/plugin.json": JSON.stringify({ name: "other" }),
        ".mcp.json": JSON.stringify({ mcpServers: {} }),
      }),
      compat
    );
    expect(parsed.manifest.name).toBe("demo-plugin");
    expect(parsed.mcpServers).toEqual([]);
    // `.mcp.json` stays an ordinary file, exactly as strict reads it.
    expect(codes(parsed.warnings)).toEqual(["MANIFEST_OVERLAY_IGNORED"]);
  });

  it("ignores an unreadable overlay with a warning, keeping the root", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        "plugin.json": manifestJson(),
        ".codex-plugin/plugin.json": "{ nope",
      }),
      compat
    );
    expect(parsed.interpretation.overlayPath).toBeUndefined();
    expect(parsed.warnings).toEqual([
      expect.objectContaining({
        code: "MANIFEST_OVERLAY_IGNORED",
        severity: "warning",
      }),
    ]);
  });

  it("does not let an overlay relocate portable skills", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        ...portableWithOverlayFiles(),
        ".codex-plugin/plugin.json": JSON.stringify({
          ...BITS_AND_BOLTS_CODEX_MANIFEST,
          skills: "./other-skills/",
        }),
        "other-skills/hidden/SKILL.md":
          "---\nname: hidden\ndescription: Not a portable skill.\n---\n",
      }),
      compat
    );
    expect(parsed.skills.map((skill) => skill.name)).toEqual(["onboarding"]);
    expect(
      parsed.warnings.some(
        (w) =>
          w.code === "MANIFEST_OVERLAY_IGNORED" && w.message.includes("skills")
      )
    ).toBe(true);
  });
});

describe("openai-compatible profile: legacy manifests", () => {
  it("reads the pinned Bits & Bolts Codex manifest without a $schema", async () => {
    const files = bitsAndBoltsCodexFiles();
    const parsed = await parsePluginBundle(bundle(files), compat);
    expect(parsed.interpretation).toEqual({
      profile: "openai-compatible",
      layout: "codex",
      manifestPath: ".codex-plugin/plugin.json",
    });
    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.manifest).toMatchObject({
      name: "bits-and-bolts",
      version: "0.1.11",
      author: { name: "OpenAI" },
      logo: "assets/icon.svg",
      logoDark: "assets/icon-dark.svg",
      composerIcon: "assets/icon.svg",
    });
    // The nested onboarding skill survives normalization.
    expect(parsed.manifest.extensions["com.openai"]).toMatchObject({
      onboardingSkill: "./skills/onboarding/SKILL.md",
    });
    expect(parsed.skills.map((skill) => skill.name)).toEqual([
      "bits-and-bolts",
      "onboarding",
    ]);
    expect(parsed.manifestHash).toBe(
      await sha256HexBytes(encode(String(files[".codex-plugin/plugin.json"])))
    );
  });

  it("hashes the same raw files a strict parser would, layout aside", async () => {
    const files = bitsAndBoltsCodexFiles();
    const parsed = await parsePluginBundle(bundle(files), compat);
    // A rootless strict parse throws, so compare against the file aggregate.
    const expected = await computeAggregateHash(
      await Promise.all(
        Object.entries(files).map(async ([path, content]) => ({
          path,
          contentHash: await sha256HexBytes(
            typeof content === "string" ? encode(content) : content
          ),
        }))
      )
    );
    expect(parsed.bundleHash).toBe(expected);
  });

  it("resolves Codex, then the Agent location, then Claude", async () => {
    const agent = JSON.stringify({ name: "from-agent" });
    const claude = JSON.stringify({ name: "from-claude" });
    const both = await parsePluginBundle(
      bundle({
        ".agent-plugin/plugin.json": agent,
        ".claude-plugin/plugin.json": claude,
      }),
      compat
    );
    expect(both.manifest.name).toBe("from-agent");
    expect(both.interpretation.layout).toBe("agent-legacy");
    expect(codes(both.warnings)).toEqual(["MANIFEST_OVERLAY_IGNORED"]);

    const claudeOnly = await parsePluginBundle(
      bundle({ ".claude-plugin/plugin.json": claude }),
      compat
    );
    expect(claudeOnly.interpretation.layout).toBe("claude");
  });

  it("validates a legacy manifest's portable fields by the root rules", async () => {
    await expectParseError(
      bundle({ ".codex-plugin/plugin.json": JSON.stringify({ name: "Bad" }) }),
      "MANIFEST_INVALID_NAME",
      compat
    );
    await expectParseError(
      bundle({ ".codex-plugin/plugin.json": "[1, 2]" }),
      "MANIFEST_INVALID_JSON",
      compat
    );
    // An Agent Plugins identifier still selects (here: rejects) its version.
    await expectParseError(
      bundle({
        ".codex-plugin/plugin.json": JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json",
          name: "demo",
        }),
      }),
      "MANIFEST_UNSUPPORTED_SCHEMA",
      compat
    );
  });

  it("reads an editor $schema on a legacy manifest as Agent Plugins 1.0.0", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        ".claude-plugin/plugin.json": JSON.stringify({
          $schema:
            "https://json.schemastore.org/claude-code-plugin-manifest.json",
          name: "demo",
        }),
      }),
      compat
    );
    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.warnings).toEqual([]);
  });

  it("reports Claude features it does not run instead of dropping them silently", async () => {
    const parsed = await parsePluginBundle(bundle(claudePluginFiles()), compat);
    expect(parsed.skills.map((skill) => skill.name)).toEqual(["query"]);
    const unsupported = parsed.warnings.filter(
      (w) => w.code === "UNSUPPORTED_COMPONENT"
    );
    expect(unsupported.map((w) => w.message)).toEqual([
      expect.stringContaining('"hooks"'),
      expect.stringContaining('"commands"'),
    ]);
    // A Claude plugin carries no OpenAI data, so OpenAI's icon rules do not apply.
    expect(codes(parsed.warnings)).not.toContain(
      "MANIFEST_DIRECTORY_ICON_MISSING"
    );
  });

  it("describes a skills location it will not read", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        ".codex-plugin/plugin.json": JSON.stringify({
          name: "demo",
          skills: "./custom/",
        }),
      }),
      compat
    );
    expect(parsed.warnings).toEqual([
      expect.objectContaining({
        code: "UNSUPPORTED_COMPONENT",
        message: expect.stringContaining('"./custom/"'),
      }),
    ]);
  });

  it("refuses two different onboarding skills instead of picking one", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        ".codex-plugin/plugin.json": JSON.stringify({
          name: "demo",
          onboardingSkill: "skills/a/SKILL.md",
          extensions: {
            "com.openai": { onboardingSkill: "./skills/b/SKILL.md" },
          },
        }),
      }),
      compat
    );
    expect(parsed.manifest.extensions["com.openai"]).toBeUndefined();
    expect(codes(parsed.warnings)).toContain("MANIFEST_INVALID_FIELD");
  });

  it("names every accepted location when no manifest is found", async () => {
    const error = await expectParseError(
      bundle({ "README.md": "# hi" }),
      "MANIFEST_MISSING",
      compat
    );
    expect(error.message).toContain(".codex-plugin/plugin.json");
    expect(error.message).toContain(".claude-plugin/plugin.json");
  });
});
