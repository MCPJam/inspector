import { describe, expect, it } from "vitest";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import { resolveToolUiResourceUri } from "../src/widget-runtime/tool-ui-resource.js";

describe("resolveToolUiResourceUri", () => {
  it("resolves the nested ui.resourceUri", () => {
    expect(
      resolveToolUiResourceUri({ ui: { resourceUri: "ui://server/app.html" } }),
    ).toBe("ui://server/app.html");
  });

  it("resolves the deprecated flat ui/resourceUri", () => {
    expect(
      resolveToolUiResourceUri({ "ui/resourceUri": "ui://legacy/app.html" }),
    ).toBe("ui://legacy/app.html");
  });

  it("answers null when the tool declares no UI resource", () => {
    expect(resolveToolUiResourceUri(undefined)).toBeNull();
    expect(resolveToolUiResourceUri({})).toBeNull();
    expect(resolveToolUiResourceUri({ ui: {} })).toBeNull();
  });

  // INSPECTOR-CLIENT-227: a connected server advertised `ui.resourceUri: ""`.
  // The upstream helper throws on it, which unwound through render and blanked
  // `/servers`. Every malformed shape has to answer "no app UI" instead.
  it.each([
    ["the empty string", ""],
    ["a non-ui:// string", "https://example.com/app.html"],
    ["a number", 42],
    ["an object", { href: "ui://server/app.html" }],
    ["null", null],
  ])("answers null for %s rather than throwing", (_label, resourceUri) => {
    expect(resolveToolUiResourceUri({ ui: { resourceUri } })).toBeNull();
    expect(
      resolveToolUiResourceUri({ "ui/resourceUri": resourceUri }),
    ).toBeNull();
  });

  // Upstream reads the flat key only when the nested one is absent, so a
  // malformed nested value shadows a valid flat one rather than falling
  // through to it. Pinned because the resolution order is upstream's, not ours.
  it("answers null when a malformed nested value shadows a valid flat one", () => {
    expect(
      resolveToolUiResourceUri({
        ui: { resourceUri: "" },
        "ui/resourceUri": "ui://server/app.html",
      }),
    ).toBeNull();
  });

  // The guard matches upstream's throw by message prefix, because ext-apps
  // raises a plain Error with no subclass or code to key on. If an upgrade
  // rewords it, the narrowed catch would start propagating malformed-URI
  // throws again and `/servers` would crash exactly as it did in
  // INSPECTOR-CLIENT-227. Fail here at upgrade time instead of in production.
  it("pins the upstream malformed-URI error message the guard matches on", () => {
    expect(() =>
      getToolUiResourceUri({ _meta: { ui: { resourceUri: "" } } }),
    ).toThrow(/^Invalid UI resource URI:/);
  });

  // Only the malformed-URI throw is absorbed; a genuine fault must surface.
  it("propagates an error that is not the malformed-URI throw", () => {
    const exploding = {
      get ui(): never {
        throw new Error("boom");
      },
    } as unknown as Record<string, unknown>;

    expect(() => resolveToolUiResourceUri(exploding)).toThrow("boom");
  });
});
