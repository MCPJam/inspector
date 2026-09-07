import { describe, expect, it } from "vitest";
import {
  compareCspPolicies,
  effectiveFromCspHeader,
  parseCspHeader,
  resolveDirective,
} from "../csp-header";

describe("compareCspPolicies", () => {
  it("ignores directive order, source order, duplicates, and whitespace", () => {
    expect(
      compareCspPolicies(
        "frame-src https://b.example https://a.example; default-src 'none'",
        " default-src 'none'; frame-src https://a.example https://b.example https://a.example ",
      ),
    ).toEqual({ status: "matching", differingDirectives: [] });
  });

  it("reports changed directives", () => {
    expect(
      compareCspPolicies(
        "default-src 'none'; frame-src https://a.example",
        "default-src 'none'; frame-src https://b.example",
      ),
    ).toEqual({ status: "different", differingDirectives: ["frame-src"] });
  });

  it("reports unavailable when either policy was not captured", () => {
    expect(compareCspPolicies(undefined, "default-src 'none'").status).toBe(
      "unavailable",
    );
  });
});

// The two policies the sandbox proxy can actually apply, verbatim. The
// widget-declared one is the output of `buildCSP` for a widget declaring only
// `frameDomains`; the permissive one is the literal in sandbox-proxy.html.
const WIDGET_DECLARED =
  "default-src 'none'; script-src 'unsafe-inline' data: blob:; " +
  "style-src 'unsafe-inline' data: blob:; img-src data: blob:; " +
  "font-src data: blob:; media-src data: blob:; connect-src 'none'; " +
  "frame-src https://js.stripe.com https://hooks.stripe.com; " +
  "object-src 'none'; base-uri 'none'";

const PERMISSIVE =
  "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: filesystem: about:; " +
  "script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  "style-src * 'unsafe-inline' data: blob:; " +
  "img-src * data: blob: https: http:; " +
  "media-src * data: blob: https: http:; " +
  "font-src * data: blob: https: http:; " +
  "connect-src * data: blob: https: http: ws: wss: about:; " +
  "frame-src * data: blob: https: http: about:; " +
  "object-src * data: blob:; base-uri *; form-action *";

describe("parseCspHeader", () => {
  it("parses a real widget-declared policy", () => {
    const map = parseCspHeader(WIDGET_DECLARED);
    expect(map["default-src"]).toEqual(["'none'"]);
    expect(map["frame-src"]).toEqual([
      "https://js.stripe.com",
      "https://hooks.stripe.com",
    ]);
    expect(map["connect-src"]).toEqual(["'none'"]);
    expect(map["base-uri"]).toEqual(["'none'"]);
  });

  it("lower-cases directive names but preserves source-expression case", () => {
    const map = parseCspHeader("Connect-SRC https://API.Example.com");
    expect(map["connect-src"]).toEqual(["https://API.Example.com"]);
  });

  it("honours the first occurrence of a repeated directive, as browsers do", () => {
    const map = parseCspHeader(
      "connect-src https://a.example; connect-src https://b.example",
    );
    expect(map["connect-src"]).toEqual(["https://a.example"]);
  });

  it("tolerates empty segments, extra whitespace and a trailing semicolon", () => {
    const map = parseCspHeader("  ;; connect-src   https://a.example  ;  ");
    expect(map).toEqual({ "connect-src": ["https://a.example"] });
  });

  it("records a directive with no sources as an empty allowlist", () => {
    expect(parseCspHeader("sandbox")).toEqual({ sandbox: [] });
  });

  it("does not confuse inherited Object properties with directives", () => {
    // `map["constructor"]` on a plain object would otherwise be truthy and make
    // the first-occurrence-wins guard drop a real directive.
    const map = parseCspHeader("constructor https://a.example");
    expect(map["constructor"]).toEqual(["https://a.example"]);
  });
});

describe("resolveDirective", () => {
  it("falls back to default-src when the directive is absent", () => {
    const map = parseCspHeader(
      "default-src 'self'; connect-src https://a.example",
    );
    expect(resolveDirective(map, "connect-src")).toEqual(["https://a.example"]);
    expect(resolveDirective(map, "img-src")).toEqual(["'self'"]);
  });

  it("returns undefined — not an empty list — when nothing governs", () => {
    expect(
      resolveDirective(parseCspHeader("script-src 'self'"), "img-src"),
    ).toBeUndefined();
  });

  it("prefers an explicitly empty directive over default-src", () => {
    const map = parseCspHeader("default-src *; img-src");
    expect(resolveDirective(map, "img-src")).toEqual([]);
  });
});

describe("effectiveFromCspHeader", () => {
  it("derives the four arrays from a widget-declared policy", () => {
    const e = effectiveFromCspHeader(parseCspHeader(WIDGET_DECLARED));
    expect(e.connectDomains).toEqual(["'none'"]);
    expect(e.frameDomains).toEqual([
      "https://js.stripe.com",
      "https://hooks.stripe.com",
    ]);
    expect(e.baseUriDomains).toEqual(["'none'"]);
    // Union of script/style/img/font/media-src, de-duplicated, order preserved.
    expect(e.resourceDomains).toEqual(["'unsafe-inline'", "data:", "blob:"]);
  });

  it("carries the permissive wildcard through, not the widget's request", () => {
    const e = effectiveFromCspHeader(parseCspHeader(PERMISSIVE));
    expect(e.connectDomains).toContain("*");
    expect(e.frameDomains).toContain("*");
    expect(e.resourceDomains).toContain("*");
    expect(e.baseUriDomains).toEqual(["*"]);
  });

  it("applies the default-src fallback when a directive is missing", () => {
    const e = effectiveFromCspHeader(
      parseCspHeader("default-src https://a.example"),
    );
    expect(e.connectDomains).toEqual(["https://a.example"]);
    expect(e.resourceDomains).toEqual(["https://a.example"]);
  });
});
