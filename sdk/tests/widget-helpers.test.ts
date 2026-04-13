import {
  buildChatGptRuntimeHead,
  buildCspMetaContent,
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
