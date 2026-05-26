import { describe, it, expect } from "vitest";
import type { CspViolation } from "@/stores/widget-debug-store";
import {
  classifyDiagnoses,
  directiveToField,
  summarize,
} from "../classify";
import type { ClassifierInput } from "../types";

function v(
  blockedUri: string,
  directive: string,
  ts = 1000,
): CspViolation {
  return {
    directive,
    effectiveDirective: directive,
    blockedUri,
    timestamp: ts,
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
      violations: [
        v("https://x.broad-cdn.example/foo.js", "script-src"),
      ],
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
