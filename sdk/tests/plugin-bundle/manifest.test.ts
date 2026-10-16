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

  it.each([
    "com.example.plugin",
    "a",
    "deploy.tools-2",
    "demo-plugin",
    // The canonical schema pattern excludes only same-character doubles
    // ("--", ".."); mixed adjacent separators are spec-VALID names and
    // must not be rejected.
    "foo.-bar",
    "foo-.bar",
  ])("accepts Agent Plugins name %j", async (name) => {
    const parsed = await parsePluginBundle(minimalBundle({}, { name }));
    expect(parsed.manifest.name).toBe(name);
  });

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

  it("does not store a non-HTTPS or malformed metadata URL, and does not reject the plugin for it", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        {},
        {
          homepage: "http://example.com",
          repository: "not a url",
          author: { name: "A", url: "ftp://example.com" },
        }
      )
    );
    expect(parsed.manifest.homepage).toBeUndefined();
    expect(parsed.manifest.repository).toBeUndefined();
    expect(parsed.manifest.author).toEqual({ name: "A" });
    expect(parsed.warnings.map((issue) => issue.code).sort()).toEqual([
      "MANIFEST_INSECURE_URL",
      "MANIFEST_INSECURE_URL",
      "MANIFEST_INVALID_FIELD",
    ]);
  });

  it("does not store or repeat a metadata URL that carries a user name or password", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        {},
        {
          homepage: "https://u:p4ss@example.com",
          repository: "https://ghs_abc123@github.com/o/r",
          author: { name: "A", url: "https://:p4ss@example.com/a" },
        }
      )
    );
    expect(parsed.manifest.homepage).toBeUndefined();
    expect(parsed.manifest.repository).toBeUndefined();
    expect(parsed.manifest.author).toEqual({ name: "A" });
    expect(parsed.warnings.map((issue) => issue.code)).toEqual([
      "MANIFEST_SECRET_FIELD_OMITTED",
      "MANIFEST_SECRET_FIELD_OMITTED",
      "MANIFEST_SECRET_FIELD_OMITTED",
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/p4ss|ghs_abc123/);
  });

  it.each([
    ["a backslash", "https://example.com\\@evil.example/"],
    ["a tab", "https://exa\tmple.com"],
    ["a leading space", " https://example.com"],
    ["a line break", "https://example.com/\n"],
    ["one slash after the scheme", "https:/example.com"],
    ["no slashes after the scheme", "https:example.com"],
    ["empty user info", "https://@example.com"],
  ])(
    "does not store or repeat a metadata URL with %s, which URL parsing rewrites",
    async (_, homepage) => {
      const parsed = await parsePluginBundle(minimalBundle({}, { homepage }));
      expect(parsed.manifest.homepage).toBeUndefined();
      expect(parsed.warnings.map((issue) => issue.code)).toEqual([
        "MANIFEST_INVALID_FIELD",
      ]);
      expect(JSON.stringify(parsed.warnings)).not.toContain("example");
    }
  );

  it.each([
    ["its query", "https://example.com/?api_key=p4ss"],
    ["its path", "https://example.com/sk-live-p4ss01/r"],
    [
      "its fragment, as a parameter",
      "https://example.com/docs#access_token=p4ss01",
    ],
    [
      "its fragment",
      "https://example.com/#p4ss0123456789abcdef0123456789abcdef01234",
    ],
  ])(
    "does not store or repeat a metadata URL with a key in %s",
    async (_, homepage) => {
      const parsed = await parsePluginBundle(minimalBundle({}, { homepage }));
      expect(parsed.manifest.homepage).toBeUndefined();
      expect(parsed.warnings.map((issue) => issue.code)).toEqual([
        "MANIFEST_SECRET_FIELD_OMITTED",
      ]);
      expect(JSON.stringify(parsed)).not.toContain("p4ss");
    }
  );

  it("keeps a metadata URL whose long path and fragment are word slugs", async () => {
    const homepage =
      "https://example.com/docs/getting-started-with-the-mcpjam-inspector-plugin#how-to-install-and-configure-the-plugin-locally";
    const parsed = await parsePluginBundle(minimalBundle({}, { homepage }));
    expect(parsed.manifest.homepage).toBe(homepage);
    expect(parsed.warnings).toEqual([]);
  });

  it("stores a metadata URL with a fragment as written", async () => {
    const homepage = "https://example.com/docs#install";
    const parsed = await parsePluginBundle(minimalBundle({}, { homepage }));
    expect(parsed.manifest.homepage).toBe(homepage);
  });

  it("rejects a metadata URL that is not a string (a schema violation)", async () => {
    await expectParseError(
      minimalBundle({}, { homepage: 42 }),
      "MANIFEST_INVALID_FIELD"
    );
  });

  it("rejects unresolved [TODO: ...] placeholders in fields it keeps", async () => {
    await expectParseError(
      minimalBundle({}, { description: "[TODO: describe the plugin]" }),
      "MANIFEST_PLACEHOLDER"
    );
  });

  it("does not reject a [TODO: ...] inside an unknown, ignored field", async () => {
    // Ignored means ignored: unknown-field content must never be fatal.
    const parsed = await parsePluginBundle(
      minimalBundle({}, { future_field: "[TODO: fill this in]" })
    );
    expect(parsed.manifest.name).toBe("demo-plugin");
    expect(
      parsed.warnings.some((issue) => issue.code === "MANIFEST_UNKNOWN_FIELD")
    ).toBe(true);
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
        { "assets/icon.png": PNG_BYTES, "assets/logo.png": PNG_BYTES },
        {
          extensions: {
            "com.mcpjam": {
              display_name: "Demo Plugin",
              icon: "./assets/icon.png",
              logo: "assets/logo.png",
            },
            "com.example.other": { anything: true },
          },
        }
      )
    );
    expect(parsed.manifest.displayName).toBe("Demo Plugin");
    expect(parsed.manifest.icon).toBe("assets/icon.png");
    expect(parsed.manifest.logo).toBe("assets/logo.png");
    expect(parsed.manifest.extensions["com.example.other"]).toEqual({
      anything: true,
    });
    expect(parsed.assets).toEqual([
      expect.objectContaining({ path: "assets/icon.png", kind: "icon" }),
      expect.objectContaining({ path: "assets/logo.png", kind: "logo" }),
    ]);
  });

  it("keeps long asset paths readable despite the secret-value screen", async () => {
    // 40+ chars of [A-Za-z0-9-] trips the shared opaque-token heuristic; the
    // com.mcpjam presentation fields are read from the RAW namespace with
    // their own validation, so a long path still resolves.
    const longPath =
      "assets/brand-name-banner-icon-desktop-retina-display-final.png";
    const parsed = await parsePluginBundle(
      minimalBundle(
        { [longPath]: PNG_BYTES },
        { extensions: { "com.mcpjam": { icon: longPath } } }
      )
    );
    expect(parsed.manifest.icon).toBe(longPath);
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
