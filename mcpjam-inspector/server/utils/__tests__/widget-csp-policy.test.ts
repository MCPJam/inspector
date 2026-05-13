import { describe, it, expect } from "vitest";
import { resolveWidgetCspPolicy } from "../widget-csp-policy.js";

describe("resolveWidgetCspPolicy", () => {
  it("preserves legacy buildCspHeader output when mcpProfile is undefined", () => {
    const result = resolveWidgetCspPolicy({
      cspMode: "permissive",
      widgetCsp: null,
      sandboxCspPolicy: undefined,
      hostedMode: false,
    });
    // Permissive mode emits the broad allowlist.
    expect(result.connectDomains).toContain("https:");
    expect(result.headerString).toContain("connect-src");
    expect(result.headerString).toContain("frame-ancestors");
  });

  it("preserves widget-declared output when mcpProfile is undefined", () => {
    const result = resolveWidgetCspPolicy({
      cspMode: "widget-declared",
      widgetCsp: {
        connect_domains: ["https://api.example.com"],
        resource_domains: ["https://cdn.example.com"],
        frame_domains: [],
      },
      sandboxCspPolicy: undefined,
      hostedMode: false,
    });
    expect(result.connectDomains).toContain("https://api.example.com");
    expect(result.resourceDomains).toContain("https://cdn.example.com");
  });

  it("removes a widget-declared domain via deny.connectDomains", () => {
    const result = resolveWidgetCspPolicy({
      cspMode: "widget-declared",
      widgetCsp: {
        connect_domains: ["https://api.example.com", "https://evil.com"],
      },
      sandboxCspPolicy: {
        mode: "declared",
        deny: { connectDomains: ["https://evil.com"] },
      },
      hostedMode: false,
    });
    expect(result.connectDomains).toContain("https://api.example.com");
    expect(result.connectDomains).not.toContain("https://evil.com");
  });

  it("intersects with restrictTo without adding undeclared domains", () => {
    const result = resolveWidgetCspPolicy({
      cspMode: "widget-declared",
      widgetCsp: {
        connect_domains: ["https://a.example.com", "https://b.example.com"],
      },
      sandboxCspPolicy: {
        mode: "declared",
        // restrictTo lists a domain the widget never declared — must NOT
        // appear in the resolved set (intersection, never union).
        restrictTo: {
          connectDomains: ["https://a.example.com", "https://undeclared.com"],
        },
      },
      hostedMode: false,
    });
    expect(result.connectDomains).toContain("https://a.example.com");
    expect(result.connectDomains).not.toContain("https://b.example.com");
    expect(result.connectDomains).not.toContain("https://undeclared.com");
  });

  it("strips localhost and private-network origins in hosted mode", () => {
    const result = resolveWidgetCspPolicy({
      cspMode: "widget-declared",
      widgetCsp: {
        connect_domains: [
          "https://api.example.com",
          "http://localhost:3000",
          "http://10.0.0.5",
        ],
      },
      // Trigger the policy path with `mode: "declared"` (no restrictTo/deny).
      sandboxCspPolicy: { mode: "declared" },
      hostedMode: true,
    });
    expect(result.connectDomains).toContain("https://api.example.com");
    expect(result.connectDomains).not.toContain("http://localhost:3000");
    expect(result.connectDomains).not.toContain("http://10.0.0.5");
  });

  it("strips MCPJam own-origin in hosted mode regardless of widget declaration", () => {
    const result = resolveWidgetCspPolicy({
      cspMode: "widget-declared",
      widgetCsp: {
        connect_domains: [
          "https://api.example.com",
          "https://app.mcpjam.com",
          "https://mcpjam.com",
        ],
      },
      sandboxCspPolicy: { mode: "declared" },
      hostedMode: true,
    });
    expect(result.connectDomains).not.toContain("https://app.mcpjam.com");
    expect(result.connectDomains).not.toContain("https://mcpjam.com");
    expect(result.connectDomains).toContain("https://api.example.com");
  });

  it("saved mcpProfile overrides the legacy cspMode behavior", () => {
    // Legacy `permissive` would have produced `https:` etc. With a host
    // policy applied the resolved domain set should be the widget-declared
    // intersection, not the legacy permissive set.
    const result = resolveWidgetCspPolicy({
      cspMode: "permissive",
      widgetCsp: {
        connect_domains: ["https://api.example.com"],
      },
      sandboxCspPolicy: { mode: "declared" },
      hostedMode: false,
    });
    expect(result.connectDomains).not.toContain("https:");
    expect(result.connectDomains).toContain("https://api.example.com");
  });
});
