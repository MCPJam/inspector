/**
 * Manifest validation — root `plugin.json` per Agent Plugins 1.0: `$schema`
 * gate, name charset, closed-object unknown-field handling, the `com.mcpjam`
 * extension namespace, and the execution-ambiguous reject list.
 */

import { describe, expect, it } from "vitest";
import { parsePluginBundle } from "../../src/plugin-bundle/index.js";
import {
  PNG_BYTES,
  bundle,
  expectParseError,
  manifestJson,
  minimalBundle,
} from "./fixtures.js";

describe("plugin manifest validation", () => {
  it("parses a minimal manifest and hashes it", async () => {
    const parsed = await parsePluginBundle(minimalBundle());
    expect(parsed.manifest).toMatchObject({
      schemaVersion: "1.0.0",
      name: "demo-plugin",
      version: "1.2.3",
      description: "A demo plugin for parser tests.",
      extensions: {},
    });
    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.skipped).toEqual([]);
  });

  it("requires the manifest to exist at the bundle root", async () => {
    await expectParseError(
      bundle({ "README.md": "no manifest here" }),
      "MANIFEST_MISSING"
    );
  });

  it("treats a manifest under .codex-plugin/ as missing (Codex format is not supported)", async () => {
    await expectParseError(
      bundle({ ".codex-plugin/plugin.json": manifestJson() }),
      "MANIFEST_MISSING"
    );
  });

  it("ignores nested plugin.json files — only the root is the manifest", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "vendored/plugin.json": JSON.stringify({ name: "other-plugin" }),
      })
    );
    expect(parsed.manifest.name).toBe("demo-plugin");
  });

  it("requires $schema", async () => {
    await expectParseError(
      minimalBundle({}, { $schema: undefined }),
      "MANIFEST_UNSUPPORTED_SCHEMA"
    );
  });

  it("rejects an unsupported $schema without fetching it", async () => {
    await expectParseError(
      minimalBundle(
        {},
        { $schema: "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json" }
      ),
      "MANIFEST_UNSUPPORTED_SCHEMA"
    );
  });

  it("rejects malformed JSON", async () => {
    await expectParseError(
      bundle({ "plugin.json": "{ not json" }),
      "MANIFEST_INVALID_JSON"
    );
  });

  it("rejects invalid UTF-8 in the manifest", async () => {
    await expectParseError(
      bundle({ "plugin.json": new Uint8Array([0xff, 0xfe, 0x00, 0xc0]) }),
      "FILE_INVALID_UTF8"
    );
  });

  it.each(["com.example.plugin", "a", "deploy.tools-2", "demo-plugin"])(
    "accepts Agent Plugins name %j",
    async (name) => {
      const parsed = await parsePluginBundle(minimalBundle({}, { name }));
      expect(parsed.manifest.name).toBe(name);
    }
  );

  it.each([
    "Demo Plugin",
    "demo_plugin",
    "-demo",
    "demo-",
    ".demo",
    "demo.",
    "demo--plugin",
    "demo..plugin",
    "DEMO",
    "",
  ])("rejects invalid name %j", async (name) => {
    await expectParseError(
      minimalBundle({}, { name }),
      "MANIFEST_INVALID_NAME"
    );
  });

  it.each(["1.2", "v1.2.3", "latest", "2024.1", "2.0.0-beta.4+build.7"])(
    "accepts free-form version string %j",
    async (version) => {
      const parsed = await parsePluginBundle(minimalBundle({}, { version }));
      expect(parsed.manifest.version).toBe(version);
    }
  );

  it.each([42, "", { major: 1 }])(
    "rejects non-string version %j",
    async (version) => {
      await expectParseError(
        minimalBundle({}, { version }),
        "MANIFEST_INVALID_VERSION"
      );
    }
  );

  it("requires HTTPS for metadata URLs", async () => {
    await expectParseError(
      minimalBundle({}, { homepage: "http://example.com" }),
      "MANIFEST_INSECURE_URL"
    );
  });

  it("rejects unresolved [TODO: ...] placeholders anywhere in the manifest", async () => {
    await expectParseError(
      minimalBundle({}, { description: "[TODO: describe the plugin]" }),
      "MANIFEST_PLACEHOLDER"
    );
  });

  it("requires author to be an object", async () => {
    await expectParseError(
      minimalBundle({}, { author: "Demo Corp" }),
      "MANIFEST_INVALID_FIELD"
    );
  });

  it("normalizes the author object", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        {},
        { author: { name: "Demo Corp", url: "https://demo.example" } }
      )
    );
    expect(parsed.manifest.author).toEqual({
      name: "Demo Corp",
      url: "https://demo.example",
    });
  });

  it("reports and ignores unknown top-level fields (closed manifest)", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({}, { future_field: { nested: true }, display_name: "X" })
    );
    expect(parsed.manifest.extensions).toEqual({});
    expect(parsed.manifest.displayName).toBeUndefined();
    const codes = parsed.warnings.map((issue) => issue.code);
    expect(codes.filter((code) => code === "MANIFEST_UNKNOWN_FIELD")).toHaveLength(
      2
    );
  });

  it("reports and ignores a non-object extensions field (non-fatal per spec)", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({}, { extensions: "not-an-object" })
    );
    expect(parsed.manifest.extensions).toEqual({});
    expect(
      parsed.warnings.some((issue) => issue.code === "MANIFEST_INVALID_FIELD")
    ).toBe(true);
  });

  it("rejects execution-ambiguous unknown fields", async () => {
    await expectParseError(
      minimalBundle({}, { scripts: { install: "curl | sh" } }),
      "MANIFEST_AMBIGUOUS_FIELD"
    );
  });

  it("reads displayName, icon, and logo from the com.mcpjam namespace", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        { "assets/icon.png": PNG_BYTES },
        {
          extensions: {
            "com.mcpjam": {
              displayName: "Demo Plugin",
              icon: "./assets/icon.png",
            },
            "com.example.other": { anything: true },
          },
        }
      )
    );
    expect(parsed.manifest.displayName).toBe("Demo Plugin");
    expect(parsed.manifest.icon).toBe("assets/icon.png");
    expect(parsed.manifest.extensions["com.example.other"]).toEqual({
      anything: true,
    });
    expect(parsed.assets).toEqual([
      expect.objectContaining({
        path: "assets/icon.png",
        kind: "icon",
        contentType: "image/png",
      }),
    ]);
  });

  it("warns (never fails) when a com.mcpjam icon reference is missing or escapes", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        {},
        { extensions: { "com.mcpjam": { icon: "assets/missing.png" } } }
      )
    );
    expect(parsed.manifest.icon).toBeUndefined();
    expect(
      parsed.warnings.some((issue) => issue.code === "MANIFEST_MISSING_FILE")
    ).toBe(true);

    const escaping = await parsePluginBundle(
      minimalBundle(
        {},
        { extensions: { "com.mcpjam": { icon: "../outside.png" } } }
      )
    );
    expect(escaping.manifest.icon).toBeUndefined();
    expect(
      escaping.warnings.some((issue) => issue.code === "PATH_ESCAPES_ROOT")
    ).toBe(true);
  });

  it("rejects icons whose bytes do not match the extension", async () => {
    await expectParseError(
      minimalBundle(
        { "assets/icon.png": "definitely not a png" },
        { extensions: { "com.mcpjam": { icon: "assets/icon.png" } } }
      ),
      "ASSET_CONTENT_MISMATCH"
    );
  });
});

describe("manifest hardening", () => {
  it("fails deeply nested extension values with VALUE_TOO_DEEP, not a RangeError", async () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 200; i++) nested = { deeper: nested };
    await expectParseError(
      minimalBundle({}, { extensions: { "com.example.deep": nested } }),
      "VALUE_TOO_DEEP"
    );
  });

  it("drops secret-looking values from extension namespaces", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        {},
        {
          extensions: {
            "com.example.integration": {
              endpoint: "https://api.example.com",
              auth: "Bearer sk-live-manifest-leak",
              nested: { api_key: "sk_live_nested_leak" },
            },
          },
        }
      )
    );
    expect(parsed.manifest.extensions).toEqual({
      "com.example.integration": {
        endpoint: "https://api.example.com",
        nested: {},
      },
    });
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("sk-live-manifest-leak");
    expect(serialized).not.toContain("sk_live_nested_leak");
    expect(
      parsed.warnings.some(
        (issue) => issue.code === "MANIFEST_SECRET_FIELD_OMITTED"
      )
    ).toBe(true);
  });
});
