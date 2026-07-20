/**
 * Manifest validation — `.codex-plugin/plugin.json` field rules, unknown-field
 * preservation, and the execution-ambiguous reject list.
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

const MANIFEST = ".codex-plugin/plugin.json";

describe("plugin manifest validation", () => {
  it("parses a minimal manifest and hashes it", async () => {
    const parsed = await parsePluginBundle(minimalBundle());
    expect(parsed.manifest).toMatchObject({
      name: "demo-plugin",
      version: "1.2.3",
      description: "A demo plugin for parser tests.",
      extensions: {},
    });
    expect(parsed.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.warnings).toEqual([]);
  });

  it("requires the manifest to exist", async () => {
    await expectParseError(
      bundle({ "README.md": "no manifest here" }),
      "MANIFEST_MISSING"
    );
  });

  it("requires the manifest to exist exactly once", async () => {
    await expectParseError(
      bundle({
        [MANIFEST]: manifestJson(),
        [`vendored/${MANIFEST}`]: manifestJson({ name: "other-plugin" }),
      }),
      "MANIFEST_DUPLICATE"
    );
  });

  it("rejects malformed JSON", async () => {
    await expectParseError(
      bundle({ [MANIFEST]: "{ not json" }),
      "MANIFEST_INVALID_JSON"
    );
  });

  it("rejects invalid UTF-8 in the manifest", async () => {
    await expectParseError(
      bundle({ [MANIFEST]: new Uint8Array([0xff, 0xfe, 0x00, 0xc0]) }),
      "FILE_INVALID_UTF8"
    );
  });

  it.each(["Demo Plugin", "demo_plugin", "-demo", "demo-", "DEMO", ""])(
    "rejects non-kebab-case name %j",
    async (name) => {
      await expectParseError(
        minimalBundle({}, { name }),
        "MANIFEST_INVALID_NAME"
      );
    }
  );

  it("accepts semver with prerelease and build metadata", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({}, { version: "2.0.0-beta.4+build.7" })
    );
    expect(parsed.manifest.version).toBe("2.0.0-beta.4+build.7");
  });

  it.each(["1.2", "v1.2.3", "1.2.3.4", "latest"])(
    "rejects invalid semver %j",
    async (version) => {
      await expectParseError(
        minimalBundle({}, { version }),
        "MANIFEST_INVALID_VERSION"
      );
    }
  );

  it("requires HTTPS for install-metadata URLs", async () => {
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

  it("requires referenced icon files to exist in the bundle", async () => {
    await expectParseError(
      minimalBundle({}, { icon: "assets/missing.png" }),
      "MANIFEST_MISSING_FILE"
    );
  });

  it("rejects icon references escaping the bundle root", async () => {
    await expectParseError(
      minimalBundle({}, { icon: "../outside.png" }),
      "PATH_ESCAPES_ROOT"
    );
  });

  it("resolves ./-prefixed icon references", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        { "assets/icon.png": PNG_BYTES },
        { icon: "./assets/icon.png" }
      )
    );
    expect(parsed.manifest.icon).toBe("assets/icon.png");
    expect(parsed.assets).toEqual([
      expect.objectContaining({
        path: "assets/icon.png",
        kind: "icon",
        contentType: "image/png",
      }),
    ]);
  });

  it("preserves unknown optional fields in extensions with a warning", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({}, { future_field: { nested: true } })
    );
    expect(parsed.manifest.extensions).toEqual({
      future_field: { nested: true },
    });
    expect(parsed.warnings).toEqual([
      expect.objectContaining({
        code: "MANIFEST_UNKNOWN_FIELD",
        severity: "warning",
      }),
    ]);
  });

  it("rejects execution-ambiguous unknown fields", async () => {
    await expectParseError(
      minimalBundle({}, { scripts: { install: "curl | sh" } }),
      "MANIFEST_AMBIGUOUS_FIELD"
    );
  });

  it("normalizes display_name and author", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        {},
        {
          display_name: "Demo Plugin",
          author: { name: "Demo Corp", url: "https://demo.example" },
        }
      )
    );
    expect(parsed.manifest.displayName).toBe("Demo Plugin");
    expect(parsed.manifest.author).toEqual({
      name: "Demo Corp",
      url: "https://demo.example",
    });
  });

  it("records unsupported manifest component fields without executing them", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({}, { hooks: { on_start: "hooks/start.sh" } })
    );
    expect(parsed.unsupported).toEqual([
      expect.objectContaining({ kind: "hooks", key: "hooks" }),
    ]);
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_COMPONENT" }),
    ]);
    expect(parsed.manifest.extensions).toEqual({});
  });

  it("rejects icons whose bytes do not match the extension", async () => {
    await expectParseError(
      minimalBundle(
        { "assets/icon.png": "definitely not a png" },
        { icon: "assets/icon.png" }
      ),
      "ASSET_CONTENT_MISMATCH"
    );
  });
});
