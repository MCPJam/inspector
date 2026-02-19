import { describe, it, expect } from "vitest";
import { buildCspMetaContent } from "../widget-helpers.js";

describe("buildCspMetaContent", () => {
  it("strips frame-ancestors directive", () => {
    const input =
      "default-src 'self'; script-src 'unsafe-inline'; frame-ancestors 'self' http://localhost:*";
    const result = buildCspMetaContent(input);
    expect(result).not.toContain("frame-ancestors");
    expect(result).toContain("default-src 'self'");
    expect(result).toContain("script-src 'unsafe-inline'");
  });

  it("strips report-uri directive", () => {
    const input =
      "default-src 'self'; report-uri /csp-report; script-src 'unsafe-inline'";
    const result = buildCspMetaContent(input);
    expect(result).not.toContain("report-uri");
    expect(result).toContain("default-src 'self'");
  });

  it("strips sandbox directive", () => {
    const input = "default-src 'self'; sandbox allow-scripts; img-src data:";
    const result = buildCspMetaContent(input);
    expect(result).not.toContain("sandbox");
    expect(result).toContain("img-src data:");
  });

  it("strips all invalid meta directives at once", () => {
    const input =
      "default-src 'self'; frame-ancestors 'self'; report-uri /report; sandbox allow-scripts; connect-src https:";
    const result = buildCspMetaContent(input);
    expect(result).toBe("default-src 'self'; connect-src https:");
  });

  it("preserves all valid directives", () => {
    const input =
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src https://api.example.com; img-src data: blob:";
    const result = buildCspMetaContent(input);
    expect(result).toBe(input);
  });

  it("handles empty string", () => {
    expect(buildCspMetaContent("")).toBe("");
  });

  it("handles string with only invalid directives", () => {
    const input = "frame-ancestors 'self'; report-uri /report";
    expect(buildCspMetaContent(input)).toBe("");
  });

  it("trims whitespace from directives", () => {
    const input =
      "  default-src 'self' ;  frame-ancestors 'self'  ;  img-src data:  ";
    const result = buildCspMetaContent(input);
    expect(result).toBe("default-src 'self'; img-src data:");
  });

  it("handles a realistic full CSP header string", () => {
    const input = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'self' data: blob: http://localhost:* http://127.0.0.1:*",
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "style-src 'self' 'unsafe-inline' 'self' data: blob: http://localhost:*",
      "img-src 'self' data: blob: http://localhost:*",
      "connect-src 'self' https://api.example.com http://localhost:*",
      "frame-src 'none'",
      "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*",
    ].join("; ");

    const result = buildCspMetaContent(input);
    expect(result).not.toContain("frame-ancestors");
    expect(result).toContain("default-src 'self'");
    expect(result).toContain("connect-src");
    expect(result).toContain("https://api.example.com");
    expect(result).toContain("frame-src 'none'");
  });
});
