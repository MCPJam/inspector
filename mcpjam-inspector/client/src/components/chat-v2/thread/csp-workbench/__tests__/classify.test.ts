import { describe, it, expect } from "vitest";
import type { CspViolation } from "@/stores/widget-debug-store";
import { classifyDiagnoses, directiveToField, summarize } from "../classify";
import type { ClassifierInput } from "../types";

function v(
  blockedUri: string,
  directive: string,
  ts = 1000,
  subtype?: CspViolation["subtype"]
): CspViolation {
  return {
    directive,
    effectiveDirective: directive,
    blockedUri,
    timestamp: ts,
    subtype,
  };
}

const EMPTY_EFFECTIVE: ClassifierInput["effective"] = {
  connectDomains: [],
  resourceDomains: [],
  frameDomains: [],
  baseUriDomains: [],
};

describe("directiveToField", () => {
  it("maps connect-src → connectDomains", () => {
    expect(directiveToField("connect-src")).toBe("connectDomains");
  });

  it("maps script/style/img/font/media/default-src → resourceDomains", () => {
    expect(directiveToField("script-src")).toBe("resourceDomains");
    expect(directiveToField("style-src")).toBe("resourceDomains");
    expect(directiveToField("img-src")).toBe("resourceDomains");
    expect(directiveToField("font-src")).toBe("resourceDomains");
    expect(directiveToField("media-src")).toBe("resourceDomains");
    expect(directiveToField("default-src")).toBe("resourceDomains");
  });

  it("collapses -elem / -attr variants", () => {
    expect(directiveToField("script-src-elem")).toBe("resourceDomains");
    expect(directiveToField("style-src-attr")).toBe("resourceDomains");
  });

  it("maps frame-src / child-src → frameDomains", () => {
    expect(directiveToField("frame-src")).toBe("frameDomains");
    expect(directiveToField("child-src")).toBe("frameDomains");
  });

  it("maps base-uri → baseUriDomains", () => {
    expect(directiveToField("base-uri")).toBe("baseUriDomains");
  });

  it("returns null for unsupported directives", () => {
    expect(directiveToField("worker-src")).toBeNull();
    expect(directiveToField("manifest-src")).toBeNull();
    expect(directiveToField("form-action")).toBeNull();
    expect(directiveToField("frame-ancestors")).toBeNull();
  });
});

describe("classifyDiagnoses", () => {
  it("classifies a violation against an undeclared origin as csp", () => {
    const out = classifyDiagnoses({
      effective: { ...EMPTY_EFFECTIVE },
      widgetDeclared: { connectDomains: [] },
      violations: [v("https://api.example.com/x", "connect-src")],
    });
    expect(out).toHaveLength(1);
    expect(out[0].class).toBe("csp");
    expect(out[0].patch).toEqual({
      field: "connectDomains",
      add: ["https://api.example.com"],
    });
    expect(out[0].primarySource).toBe("securitypolicyviolation");
  });

  it("classifies declared-but-stripped origin as host-stripped", () => {
    const out = classifyDiagnoses({
      effective: { ...EMPTY_EFFECTIVE },
      widgetDeclared: {
        resourceDomains: ["https://cdn.tiptap.dev"],
      },
      violations: [v("https://cdn.tiptap.dev/tiptap.min.js", "script-src")],
    });
    expect(out[0].class).toBe("host-stripped");
    expect(out[0].patch).toEqual({
      field: "resourceDomains",
      add: ["https://cdn.tiptap.dev"],
    });
    expect(out[0].primarySource).toBe("host-effective-csp");
    expect(out[0].risks).toContain("broad CDN");
  });

  it("classifies effective-allowed-but-blocked origin as runtime-mismatch", () => {
    const out = classifyDiagnoses({
      effective: {
        ...EMPTY_EFFECTIVE,
        connectDomains: ["https://api.linear.app"],
      },
      widgetDeclared: { connectDomains: ["https://api.linear.app"] },
      violations: [v("https://api.linear.app/events", "connect-src")],
    });
    expect(out[0].class).toBe("runtime-mismatch");
    expect(out[0].patch).toBeNull();
    expect(out[0].primarySource).toBe("inferred");
  });

  it("classifies all false CSP subtypes as host-stripped without a patch", () => {
    const cases: Array<{
      subtype: NonNullable<CspViolation["subtype"]>;
      directive: string;
    }> = [
      { subtype: "fetch", directive: "connect-src" },
      { subtype: "xhr", directive: "connect-src" },
      { subtype: "websocket", directive: "connect-src" },
      { subtype: "script", directive: "script-src" },
      { subtype: "stylesheet", directive: "style-src" },
      { subtype: "image", directive: "img-src" },
      { subtype: "font", directive: "font-src" },
      { subtype: "media", directive: "media-src" },
    ];

    for (const { subtype, directive } of cases) {
      const connectSubtype = ["fetch", "xhr", "websocket"].includes(subtype);
      const origin = "https://declared.example.com";
      const out = classifyDiagnoses({
        effective: {
          ...EMPTY_EFFECTIVE,
          ...(connectSubtype
            ? { connectDomains: [origin] }
            : { resourceDomains: [origin] }),
        },
        widgetDeclared: connectSubtype
          ? { connectDomains: [origin] }
          : { resourceDomains: [origin] },
        subtypePolicy: connectSubtype
          ? { cspConnectDomains: { [subtype]: false } }
          : { cspResourceDomains: { [subtype]: false } },
        violations: [v(`${origin}/asset`, directive, 1000, subtype)],
      });
      expect(out[0]).toMatchObject({
        class: "host-stripped",
        subtype,
        patch: null,
      });
    }
  });

  // The two subtype families are blocked by different machinery, so they
  // cannot share one explanation. `buildCSP` keeps declared origins in
  // `connect-src` (a guard refuses the call), but drops them from a blocked
  // resource directive outright.
  it("says the guard blocked a connect subtype whose origin survived the CSP", () => {
    const origin = "https://api.example.com";
    const out = classifyDiagnoses({
      effective: { ...EMPTY_EFFECTIVE, connectDomains: [origin] },
      widgetDeclared: { connectDomains: [origin] },
      subtypePolicy: { cspConnectDomains: { fetch: false } },
      violations: [v(`${origin}/data`, "connect-src", 1000, "fetch")],
    });

    expect(out[0].why).toContain("host does not support fetch requests");
    expect(out[0].evidence[0].note).toContain(
      "the origin stays in the effective CSP"
    );
  });

  it("still says stripped for a resource subtype, whose origin is gone", () => {
    const origin = "https://cdn.example.com";
    const out = classifyDiagnoses({
      // A blocked resource subtype loses its declared origins from that
      // directive, so the effective list no longer carries them.
      effective: EMPTY_EFFECTIVE,
      widgetDeclared: { resourceDomains: [origin] },
      subtypePolicy: { cspResourceDomains: { script: false } },
      violations: [v(`${origin}/app.js`, "script-src", 1000, "script")],
    });

    expect(out[0].why).toContain("host stripped this entry from effective CSP");
    expect(out[0].evidence[0].note).toContain("absent from effective script");
    expect(out[0].evidence[0].note).not.toContain("stays in the effective CSP");
  });

  it("calls connect-src stripped once every connect subtype is off", () => {
    const origin = "https://api.example.com";
    const out = classifyDiagnoses({
      // All three off collapses the directive to 'none', so this really is
      // a stripping, not a guard refusal.
      effective: EMPTY_EFFECTIVE,
      widgetDeclared: { connectDomains: [origin] },
      subtypePolicy: {
        cspConnectDomains: { fetch: false, xhr: false, websocket: false },
      },
      violations: [v(`${origin}/data`, "connect-src", 1000, "fetch")],
    });

    expect(out[0].why).toContain("host stripped this entry from effective CSP");
    expect(out[0].evidence[0].note).toContain("absent from effective fetch");
  });

  it("leaves unknown Goose websocket behavior unchanged", () => {
    const origin = "wss://declared.example.com";
    const out = classifyDiagnoses({
      effective: { ...EMPTY_EFFECTIVE, connectDomains: [origin] },
      widgetDeclared: { connectDomains: [origin] },
      subtypePolicy: { cspConnectDomains: { fetch: false, xhr: false } },
      violations: [v(origin, "connect-src", 1000, "websocket")],
    });
    expect(out[0].class).toBe("runtime-mismatch");
  });

  it("flags nested iframe risk on frame-src csp diagnoses", () => {
    const out = classifyDiagnoses({
      effective: { ...EMPTY_EFFECTIVE },
      widgetDeclared: null,
      violations: [v("https://www.youtube.com/embed/x", "frame-src")],
    });
    expect(out[0].class).toBe("csp");
    expect(out[0].patch?.field).toBe("frameDomains");
    expect(out[0].risks).toContain("nested iframe");
  });

  it("flags wildcard risk when the declared entry was a wildcard", () => {
    const out = classifyDiagnoses({
      effective: { ...EMPTY_EFFECTIVE },
      widgetDeclared: { resourceDomains: ["https://*.broad-cdn.example"] },
      violations: [v("https://x.broad-cdn.example/foo.js", "script-src")],
    });
    expect(out[0].class).toBe("host-stripped");
    expect(out[0].risks).toContain("wildcard");
  });

  it("supports OpenAI Apps snake_case widgetDeclared", () => {
    const out = classifyDiagnoses({
      effective: { ...EMPTY_EFFECTIVE },
      widgetDeclared: { connect_domains: ["https://api.example.com"] },
      violations: [v("https://api.example.com/x", "connect-src")],
    });
    expect(out[0].class).toBe("host-stripped");
  });

  it("returns a diagnosis with no patch for unsupported directives", () => {
    const out = classifyDiagnoses({
      effective: { ...EMPTY_EFFECTIVE },
      widgetDeclared: null,
      violations: [v("https://example.com/worker.js", "worker-src")],
    });
    expect(out[0].class).toBe("csp");
    expect(out[0].patch).toBeNull();
  });

  it("returns a diagnosis with no patch for keyword-token blockedUri", () => {
    const out = classifyDiagnoses({
      effective: { ...EMPTY_EFFECTIVE },
      widgetDeclared: null,
      violations: [v("inline", "script-src")],
    });
    expect(out[0].class).toBe("csp");
    expect(out[0].patch).toBeNull();
  });

  it("matches wildcard host declarations correctly", () => {
    const out = classifyDiagnoses({
      effective: {
        ...EMPTY_EFFECTIVE,
        resourceDomains: ["https://*.oaistatic.com"],
      },
      widgetDeclared: { resourceDomains: ["https://*.oaistatic.com"] },
      violations: [v("https://cdn.oaistatic.com/x.js", "script-src")],
    });
    expect(out[0].class).toBe("runtime-mismatch");
  });
});

describe("summarize", () => {
  it("partitions cards by class, then counts fixes/declarations", () => {
    const ds = classifyDiagnoses({
      effective: {
        ...EMPTY_EFFECTIVE,
        connectDomains: ["https://api.linear.app"],
      },
      widgetDeclared: {
        resourceDomains: ["https://cdn.tiptap.dev"],
        connectDomains: ["https://api.linear.app"],
      },
      violations: [
        v("https://api.notion.com/x", "connect-src"),
        v("https://fonts.gstatic.com/x", "font-src"),
        v("https://www.youtube.com/embed/x", "frame-src"),
        v("https://cdn.tiptap.dev/x.js", "script-src"),
        v("https://api.linear.app/events", "connect-src"),
      ],
    });
    const s = summarize(ds);
    expect(s.total).toBe(5);
    expect(s.csp).toBe(3);
    expect(s.hostStripped).toBe(1);
    expect(s.runtimeMismatch).toBe(1);
    expect(s.fixes).toBe(3);
    expect(s.declarations).toBe(1);
  });
});
