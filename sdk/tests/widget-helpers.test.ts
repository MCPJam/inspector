import {
  buildChatGptRuntimeHead,
  buildCspHeader,
  buildCspMetaContent,
  normalizeWidgetCspMeta,
} from "../src/widget-helpers.js";

describe("buildCspMetaContent", () => {
  it("strips directives not allowed in meta CSP tags", () => {
    const input =
      "default-src 'self'; frame-ancestors 'self'; report-uri /report; sandbox allow-scripts; connect-src https:";

    expect(buildCspMetaContent(input)).toBe(
      "default-src 'self'; connect-src https:",
    );
  });

  it("preserves valid directives", () => {
    const input =
      "default-src 'self'; script-src 'unsafe-inline'; img-src data: blob:";

    expect(buildCspMetaContent(input)).toBe(input);
  });
});

describe("buildCspHeader", () => {
  it("allows http and https resource loads in permissive mode", () => {
    const { headerString } = buildCspHeader("permissive");

    expect(headerString).toContain("img-src 'self' data: blob: https: http:");
    expect(headerString).toContain("media-src 'self' data: blob: https: http:");
    expect(headerString).toContain("connect-src 'self' https: http: wss: ws:");
    expect(headerString).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:",
    );
  });
});

describe("normalizeWidgetCspMeta", () => {
  it("normalizes standard MCP Apps ui.csp metadata for ChatGPT compatibility", () => {
    const normalized = normalizeWidgetCspMeta({
      ui: {
        csp: {
          connectDomains: ["https://api.example.com"],
          resourceDomains: ["https://img.example.com"],
          frameDomains: ["https://frame.example.com"],
        },
      },
    });

    expect(normalized).toEqual({
      connect_domains: ["https://api.example.com"],
      resource_domains: ["https://img.example.com"],
      frame_domains: ["https://frame.example.com"],
    });
    expect(buildCspHeader("widget-declared", normalized).headerString).toContain(
      "https://img.example.com",
    );
  });

  it("falls back to legacy openai/widgetCSP fields when standard csp is absent", () => {
    expect(
      normalizeWidgetCspMeta({
        "openai/widgetCSP": {
          connect_domains: ["https://legacy-api.example.com"],
          resource_domains: ["https://legacy-assets.example.com"],
          frame_domains: ["https://legacy-frame.example.com"],
        },
      }),
    ).toEqual({
      connect_domains: ["https://legacy-api.example.com"],
      resource_domains: ["https://legacy-assets.example.com"],
      frame_domains: ["https://legacy-frame.example.com"],
    });
  });

  it("uses standard ui.csp exclusively when stale legacy fields also exist", () => {
    expect(
      normalizeWidgetCspMeta({
        ui: {
          csp: {
            connectDomains: ["https://api.example.com"],
          },
        },
        "openai/widgetCSP": {
          resource_domains: ["https://legacy-assets.example.com"],
          frame_domains: ["https://legacy-frame.example.com"],
        },
      }),
    ).toEqual({
      connect_domains: ["https://api.example.com"],
    });
  });

  it("returns undefined when explicit empty standard arrays block legacy fallback", () => {
    expect(
      normalizeWidgetCspMeta({
        ui: {
          csp: {
            resourceDomains: [],
          },
        },
        "openai/widgetCSP": {
          resource_domains: ["https://legacy-assets.example.com"],
        },
      }),
    ).toBeUndefined();
  });
});

describe("buildChatGptRuntimeHead", () => {
  it("derives the base URL from the HTML content by default", () => {
    const result = buildChatGptRuntimeHead({
      htmlContent:
        '<html><head><base href="https://example.com/app/"></head></html>',
      runtimeConfig: { toolId: "tool-1" },
    });

    expect(result).toContain('<base href="https://example.com/app/">');
    expect(result).toContain("window.__widgetBaseUrl");
    expect(result).toContain('id="openai-runtime-config"');
  });

  it("allows callers to override the base href without the URL polyfill", () => {
    const result = buildChatGptRuntimeHead({
      htmlContent: "<html><head></head></html>",
      runtimeConfig: { toolId: "tool-1" },
      baseHref: "/",
    });

    expect(result).toContain('<base href="/">');
    expect(result).not.toContain("window.__widgetBaseUrl");
  });
});
