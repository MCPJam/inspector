import { describe, expect, it } from "vitest";
import { scanWidgetMeta, scanWidgetSource } from "../widget-scan";

describe("scanWidgetSource", () => {
  it("detects raw MCP Apps wire methods", () => {
    const needs = scanWidgetSource(
      `sendRequest("ui/message", { text }); sendRequest("tools/call", {});`,
    );
    expect(needs.has("message")).toBe(true);
    expect(needs.has("serverTools")).toBe(true);
  });

  it("detects the OpenAI Apps SDK surface", () => {
    const needs = scanWidgetSource(
      `window.openai.sendFollowUpMessage("hi"); window.openai.openExternal(url);`,
    );
    expect(needs.has("message")).toBe(true);
    expect(needs.has("openLinks")).toBe(true);
  });

  it("returns nothing for inert markup", () => {
    expect(scanWidgetSource(`<div>hello world</div>`).size).toBe(0);
  });
});

describe("scanWidgetMeta", () => {
  it("reads declared CSP frame domains and sandbox permissions", () => {
    const needs = scanWidgetMeta({
      ui: {
        csp: { frameDomains: ["https://youtube.com"] },
        permissions: { camera: {} },
      },
    });
    expect(needs.has("cspFrameDomains")).toBe(true);
    expect(needs.has("sandboxPermissions")).toBe(true);
  });

  it("ignores empty / absent metadata", () => {
    expect(scanWidgetMeta(undefined).size).toBe(0);
    expect(scanWidgetMeta({ ui: { csp: { frameDomains: [] }, permissions: {} } }).size).toBe(0);
  });
});
