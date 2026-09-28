/**
 * The serving helper that templates the sandbox proxy document.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  hosted: false,
  allowed: [] as string[],
}));

vi.mock("../../../../config.js", () => ({
  // The CORS fallback list. The proxy must not read it: its defaults are for
  // CORS on a developer machine, not origins a deployment serves.
  CORS_ORIGINS: ["http://localhost:5173", "https://staging.mcpjam.test"],
  MCPJAM_HOSTED_ORIGIN: "https://app.mcpjam.test",
  get WEB_ALLOWED_ORIGINS() {
    return mockConfig.allowed;
  },
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

describe("sandboxProxyHostOriginPatterns — local inspector", () => {
  beforeEach(() => {
    mockConfig.hosted = false;
    mockConfig.allowed = [];
  });

  it("includes the loopback patterns", () => {
    const patterns = sandboxProxyHostOriginPatterns();
    for (const pattern of SANDBOX_PROXY_LOCALHOST_PATTERNS) {
      expect(patterns).toContain(pattern);
    }
  });

  it("trusts nothing but loopback when no origin is configured", () => {
    expect(sandboxProxyHostOriginPatterns()).toEqual(
      SANDBOX_PROXY_LOCALHOST_PATTERNS,
    );
  });

  it("does not include the hosted app origin or the CORS defaults", () => {
    const patterns = sandboxProxyHostOriginPatterns();
    expect(patterns).not.toContain("https://app.mcpjam.test");
    expect(patterns).not.toContain("https://staging.mcpjam.test");
  });

  it("adds the https origins the operator configured", () => {
    mockConfig.allowed = ["https://inspector.example.test"];
    expect(sandboxProxyHostOriginPatterns()).toContain(
      "https://inspector.example.test",
    );
  });

  it("drops a configured plaintext origin off loopback", () => {
    mockConfig.allowed = ["http://insecure.example.test"];
    expect(sandboxProxyHostOriginPatterns()).not.toContain(
      "http://insecure.example.test",
    );
  });
});

describe("sandboxProxyHostOriginPatterns — hosted deploy", () => {
  beforeEach(() => {
    mockConfig.hosted = true;
    mockConfig.allowed = [];
  });
  afterEach(() => {
    mockConfig.hosted = false;
    mockConfig.allowed = [];
  });

  it("includes no loopback pattern", () => {
    const patterns = sandboxProxyHostOriginPatterns();
    for (const pattern of SANDBOX_PROXY_LOCALHOST_PATTERNS) {
      expect(patterns).not.toContain(pattern);
    }
  });

  it("trusts its own app origin", () => {
    expect(sandboxProxyHostOriginPatterns()).toEqual([
      "https://app.mcpjam.test",
    ]);
  });

  it("adds its configured https origins, once each", () => {
    mockConfig.allowed = [
      "https://app.mcpjam.test",
      "https://embed.example.test",
      "http://insecure.example.test",
    ];
    expect(sandboxProxyHostOriginPatterns()).toEqual([
      "https://app.mcpjam.test",
      "https://embed.example.test",
    ]);
  });

  it("does not include the CORS defaults", () => {
    expect(sandboxProxyHostOriginPatterns()).not.toContain(
      "https://staging.mcpjam.test",
    );
  });

  it("keeps a loopback origin only when it is configured exactly", () => {
    // `npm run dev:hosted` runs a hosted build on a developer machine and
    // lists its own origins; that is a configured origin, not a wildcard.
    mockConfig.allowed = ["http://localhost:5173"];
    const patterns = sandboxProxyHostOriginPatterns();
    expect(patterns).toContain("http://localhost:5173");
    expect(patterns).not.toContain("http://localhost:*");
  });

  it("sends a frame-ancestors with no loopback source", () => {
    const policy = buildSandboxProxyFrameAncestors();
    expect(policy).toBe("frame-ancestors 'self' https://app.mcpjam.test");
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
  beforeEach(() => {
    mockConfig.allowed = ["https://app.mcpjam.test"];
    resetSandboxProxyHtmlForTests();
  });
  afterEach(() => {
    mockConfig.allowed = [];
    mockConfig.hosted = false;
    resetSandboxProxyHtmlForTests();
  });

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

  it("templates a hosted list without loopback patterns", () => {
    mockConfig.hosted = true;
    mockConfig.allowed = [];
    const html = renderSandboxProxyHtml();
    const match = html.match(/const HOST_ORIGIN_PATTERNS = (\[[^\]]*\]);/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual(["https://app.mcpjam.test"]);
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
