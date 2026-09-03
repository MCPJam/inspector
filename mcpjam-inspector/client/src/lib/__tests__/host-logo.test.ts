import { describe, expect, it } from "vitest";
import { resolveHostLogoByName, UNKNOWN_HOST_LOGO } from "@/lib/host-logo";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";

// Hosts don't persist the catalog template they came from, so both single-select
// client pickers infer the logo from the display name. They used to do it two
// different ways — an exact style-name match (HostOverlayBar) and a regex hint
// table (HostCanvasSelector) — which made the same custom client render a
// different mark in each. This helper is the one resolver both now share.
describe("resolveHostLogoByName", () => {
  it("falls back to the generic MCP mark for a name it cannot place", () => {
    expect(resolveHostLogoByName("Acme Internal Bot")).toBe(UNKNOWN_HOST_LOGO);
    // The return type is a plain string, so the blank cases have to resolve to
    // the mark too rather than falling through to undefined. `trim()` is what
    // the exact-match pass guards on, hence the whitespace-only case.
    expect(resolveHostLogoByName("")).toBe(UNKNOWN_HOST_LOGO);
    expect(resolveHostLogoByName("   ")).toBe(UNKNOWN_HOST_LOGO);
  });

  it("still places a decorated name via the hint table", () => {
    // The exact-match resolver alone returns null here.
    expect(resolveHostLogoByName("Cursor (staging)")).toContain("cursor");
  });

  it("places a style id the hint table does not list", () => {
    // `codex` is a real style id but absent from the regex hints, so this only
    // resolves through the exact-name pass.
    expect(resolveHostLogoByName("Codex")).toContain("codex");
  });

  it("places a plain known name", () => {
    expect(resolveHostLogoByName("Claude")).toContain("claude");
  });

  it("routes Claude Desktop through its own id, not the bare /claude/ hint", () => {
    // The hint table is ordered, and `/claude/i` would swallow this name and
    // hand back the web app's mark — the same trap claude-code and cursor-cli
    // are ordered around. Asserted against `getHostLogoSrc("claude-desktop")`
    // rather than a filename so it keeps holding when Desktop's own asset
    // replaces the placeholder it currently shares with `claude`.
    expect(resolveHostLogoByName("Claude Desktop")).toBe(
      getHostLogoSrc("claude-desktop"),
    );
    expect(resolveHostLogoByName("claude-desktop")).toBe(
      getHostLogoSrc("claude-desktop"),
    );
    // Claude Code sits above it in the table and must be unaffected.
    expect(resolveHostLogoByName("Claude Code")).toBe(
      getHostLogoSrc("claude-code"),
    );
  });
});
