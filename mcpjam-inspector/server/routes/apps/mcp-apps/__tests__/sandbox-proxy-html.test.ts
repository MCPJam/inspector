/**
 * The serving helper that templates the sandbox proxy document.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../config.js", () => ({
  CORS_ORIGINS: [
    "http://localhost:5173",
    "https://app.mcpjam.test",
    "http://insecure.mcpjam.test",
  ],
  MCPJAM_HOSTED_ORIGIN: "https://app.mcpjam.test",
}));

const {
  SANDBOX_PROXY_LOCALHOST_PATTERNS,
  buildSandboxProxyFrameAncestors,
  renderSandboxProxyHtml,
  resetSandboxProxyHtmlForTests,
  sandboxProxyHostOriginPatterns,
} = await import("../sandbox-proxy-html.js");

describe("sandboxProxyHostOriginPatterns", () => {
  it("always includes the loopback patterns", () => {
    const patterns = sandboxProxyHostOriginPatterns();
    for (const pattern of SANDBOX_PROXY_LOCALHOST_PATTERNS) {
      expect(patterns).toContain(pattern);
    }
  });

  it("includes the hosted origin and https CORS origins", () => {
    expect(sandboxProxyHostOriginPatterns()).toContain(
      "https://app.mcpjam.test",
    );
  });

  it("drops non-https CORS entries", () => {
    // A plaintext origin in the list would let anything that can MITM the
    // network pose as the host to every widget.
    const patterns = sandboxProxyHostOriginPatterns();
    expect(patterns).not.toContain("http://insecure.mcpjam.test");
    // ...except the loopback patterns, which are the local app itself.
    expect(patterns).not.toContain("http://localhost:5173");
  });

  it("does not repeat an origin that is both hosted and a CORS entry", () => {
    const patterns = sandboxProxyHostOriginPatterns();
    expect(
      patterns.filter((p) => p === "https://app.mcpjam.test"),
    ).toHaveLength(1);
  });
});

describe("buildSandboxProxyFrameAncestors", () => {
  it("keeps 'self' for the documented same-origin fallback deploy", () => {
    // 'self' belongs in frame-ancestors but NOT in the message-sender list —
    // see sandbox-proxy-html.ts.
    expect(buildSandboxProxyFrameAncestors(["https://app.mcpjam.test"])).toBe(
      "frame-ancestors 'self' https://app.mcpjam.test",
    );
  });
});

describe("renderSandboxProxyHtml", () => {
  beforeEach(() => resetSandboxProxyHtmlForTests());

  it("replaces both placeholders", () => {
    const html = renderSandboxProxyHtml();
    // Only the ASSIGNMENTS are replaced. `buildRecorderScript` compares
    // RECORDER_SHIM against its own placeholder to detect "recording
    // unavailable", so those two occurrences must survive.
    expect(html).not.toContain(
      'const RECORDER_SHIM = "__MCPJAM_RECORDER_SHIM__";',
    );
    expect(html).not.toContain(
      'const HOST_ORIGIN_PATTERNS = "__MCPJAM_HOST_ORIGINS__";',
    );
    expect(html).toContain('const RECORDER_SHIM = "(function(){');
    expect(html).toContain('"https://app.mcpjam.test"');
  });

  it("memoizes", () => {
    expect(renderSandboxProxyHtml()).toBe(renderSandboxProxyHtml());
  });
});
