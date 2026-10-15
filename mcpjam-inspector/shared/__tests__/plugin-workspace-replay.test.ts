import { describe, expect, it } from "vitest";
import {
  capturedPluginImageDataUrl,
  pluginWorkspaceReplayDocument,
} from "../plugin-workspace-replay";
const recording = {
  version: 1,
  runtime: "codex",
  sequence: 0,
  droppedEvents: 0,
  instances: [],
  events: [],
};
describe("screenshot-only workspace replay", () => {
  it("shows existing captures without inventing a recording version", () => {
    const html = pluginWorkspaceReplayDocument(
      undefined,
      btoa("\x89PNG\r\n\x1a\n"),
    );
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toMatch(/<h1|<ol|<script|runtime/);
  });
  it("allows only bounded base64 raster data", () => {
    for (const value of [
      btoa('<svg onload="alert(1)"/>'),
      btoa("<html>"),
      "https://example.invalid/image.png",
      "A".repeat(2 * 1024 * 1024),
    ]) {
      expect(() => capturedPluginImageDataUrl(value)).toThrow(
        "PLUGIN_REPLAY_IMAGE_INVALID",
      );
    }
    expect(capturedPluginImageDataUrl(btoa("\x89PNG\r\n\x1a\n"))).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(capturedPluginImageDataUrl(btoa("\xff\xd8\xff"))).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });
  it("emits only host markup and pixels, with no events or app HTML", () => {
    const result = pluginWorkspaceReplayDocument(
      recording,
      btoa("\x89PNG\r\n\x1a\n"),
    );
    expect(result).toContain("connect-src 'none'");
    expect(result).toContain("default-src 'none'");
    expect(result).not.toMatch(/<script|<h1|<ol|instanceId|runtime|codex/);
  });
  it("rejects unknown versions and app-authored fields rather than rendering them", () => {
    expect(() =>
      pluginWorkspaceReplayDocument({ ...recording, version: 3 }),
    ).toThrow();
    expect(() =>
      pluginWorkspaceReplayDocument({
        ...recording,
        title: '<img src="https://example.invalid">',
      }),
    ).toThrow();
  });
});
