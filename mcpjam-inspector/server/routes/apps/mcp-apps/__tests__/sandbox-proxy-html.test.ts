/**
 * The serving helper that templates the sandbox proxy document.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConfig = vi.hoisted(() => ({ hosted: false }));

vi.mock("../../../../config.js", () => ({
  CORS_ORIGINS: [
    "http://localhost:5173",
    "https://app.mcpjam.test",
    "http://insecure.mcpjam.test",
  ],
  MCPJAM_HOSTED_ORIGIN: "https://app.mcpjam.test",
  get HOSTED_MODE() {
    return mockConfig.hosted;
  },
}));

const {
  SANDBOX_PROXY_LOCAL_FRAME_SOURCES,
  SANDBOX_PROXY_LOCALHOST_PATTERNS,
  buildSandboxProxyFrameAncestors,
  renderSandboxProxyHtml,
  resetSandboxProxyHtmlForTests,
  sandboxProxyHostOriginPatterns,
  withoutLocalFrameSources,
} = await import("../sandbox-proxy-html.js");

/** The `content` of the document's own `<meta>` CSP, split into directives. */
function metaCspDirectives(html: string): Map<string, string[]> {
  const match = html.match(
    /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/,
  );
  expect(match).not.toBeNull();
  const directives = new Map<string, string[]>();
  for (const directive of match![1].split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

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

describe("sandbox proxy document CSP (MJ-014)", () => {
  beforeEach(() => resetSandboxProxyHtmlForTests());
  afterEach(() => {
    mockConfig.hosted = false;
    resetSandboxProxyHtmlForTests();
  });

  it("disallows plugin content in every build", () => {
    for (const hosted of [false, true]) {
      mockConfig.hosted = hosted;
      resetSandboxProxyHtmlForTests();
      const directives = metaCspDirectives(renderSandboxProxyHtml());
      expect(directives.get("object-src")).toEqual(["'none'"]);
    }
  });

  it("keeps the loopback frame sources in a local build", () => {
    mockConfig.hosted = false;
    const frameSrc = metaCspDirectives(renderSandboxProxyHtml()).get(
      "frame-src",
    );
    for (const source of SANDBOX_PROXY_LOCAL_FRAME_SOURCES) {
      expect(frameSrc).toContain(source);
    }
  });

  it("serves a hosted build without the loopback frame sources", () => {
    mockConfig.hosted = true;
    const directives = metaCspDirectives(renderSandboxProxyHtml());
    expect(directives.get("frame-src")).toEqual(["*", "blob:", "data:"]);
    // Every other directive is the same policy a local build serves.
    mockConfig.hosted = false;
    resetSandboxProxyHtmlForTests();
    const local = metaCspDirectives(renderSandboxProxyHtml());
    for (const [name, sources] of local) {
      if (name === "frame-src") continue;
      expect(directives.get(name)).toEqual(sources);
    }
  });

  it("only rewrites the document's own policy", () => {
    const html = [
      '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; frame-src * http://localhost:* https://127.0.0.1:*;" />',
      '<script>const inner = "frame-src http://localhost:*";</script>',
    ].join("\n");
    const out = withoutLocalFrameSources(html);
    expect(out).toContain("content=\"default-src 'self'; frame-src *;\"");
    expect(out).toContain('const inner = "frame-src http://localhost:*";');
  });
});
