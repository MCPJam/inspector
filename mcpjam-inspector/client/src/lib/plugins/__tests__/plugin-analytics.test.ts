/**
 * Plugin telemetry must never carry bundle paths, server URLs, env/header
 * names or values, skill content, or the plugin's own authored name. These
 * tests pin that: the builder's OUTPUT is checked as a whole, so a future
 * field that leaks user content fails here rather than in production.
 */
import { describe, expect, it } from "vitest";
import {
  pluginBundleHashPrefix,
  pluginPreviewAnalyticsProps,
  sanitizePluginCode,
} from "../plugin-analytics";
import type { PluginImportPreview } from "../plugin-api-types";

const preview: PluginImportPreview = {
  identity: {
    name: "acme-secret-plugin",
    displayName: "ACME Secret Plugin",
    version: "1.2.3",
    description: "Internal ACME tooling",
  },
  bundleHash: "abcdef0123456789abcdef0123456789",
  manifestHash: "0123456789abcdef",
  counts: {
    skills: 2,
    servers: 3,
    apps: 1,
    assets: 4,
    unsupported: 5,
    warnings: 6,
  },
  skills: [
    {
      modelRef: "acme-secret-plugin/triage",
      name: "triage",
      description: "Triage things",
      supportingFileCount: 2,
      mcpToolDependencyCount: 1,
      hasOpenaiMetadata: false,
    },
  ],
  servers: [
    { key: "local-cli", transport: "stdio" },
    { key: "api", transport: "http" },
    { key: "api2", transport: "http" },
  ],
  apps: [{ appId: "app_1", binding: "server", status: "declared" }],
  assets: [{ kind: "icon", contentType: "image/png", size: 100 }],
  setupRequirements: [
    { serverKey: "api", kind: "header", name: "X-Acme-Token", required: true },
  ],
  unsupported: [
    { kind: "hook", key: "postinstall", reason: "not executed", pathCount: 1 },
  ],
  warnings: [
    { code: "MANIFEST_UNKNOWN_FIELD", severity: "warning", message: "unknown" },
  ],
};

describe("pluginPreviewAnalyticsProps", () => {
  it("emits the component census and nothing authored by the bundle", () => {
    const props = pluginPreviewAnalyticsProps(preview);
    expect(props).toEqual({
      bundle_hash_prefix: "abcdef012345",
      skill_count: 2,
      server_count: 3,
      app_count: 1,
      asset_count: 4,
      unsupported_count: 5,
      warning_count: 6,
      setup_requirement_count: 1,
      stdio_server_count: 1,
      http_server_count: 2,
    });
  });

  it("leaks no name, description, path, or requirement name", () => {
    const serialized = JSON.stringify(pluginPreviewAnalyticsProps(preview));
    for (const forbidden of [
      "acme-secret-plugin",
      "ACME Secret Plugin",
      "Internal ACME tooling",
      "X-Acme-Token",
      "triage",
      "local-cli",
      "postinstall",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("sanitizePluginCode", () => {
  it("passes stable machine codes through", () => {
    expect(sanitizePluginCode("ARCHIVE_TOO_LARGE_COMPRESSED")).toBe(
      "ARCHIVE_TOO_LARGE_COMPRESSED",
    );
  });

  it("replaces anything that could carry a message or path", () => {
    expect(sanitizePluginCode("failed reading /Users/me/plugin.zip")).toBe(
      "UNKNOWN",
    );
    expect(sanitizePluginCode("https://internal.example.com")).toBe("UNKNOWN");
    expect(sanitizePluginCode(undefined)).toBe("UNKNOWN");
    expect(sanitizePluginCode("A".repeat(65))).toBe("UNKNOWN");
  });
});

describe("pluginBundleHashPrefix", () => {
  it("returns a bounded hex prefix", () => {
    expect(pluginBundleHashPrefix("ABCDEF0123456789")).toBe("abcdef012345");
  });

  it("refuses anything that is not a hex digest", () => {
    expect(pluginBundleHashPrefix("../../etc/passwd")).toBeUndefined();
    expect(pluginBundleHashPrefix(undefined)).toBeUndefined();
  });
});
