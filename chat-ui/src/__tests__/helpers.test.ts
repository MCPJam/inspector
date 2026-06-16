import { describe, it, expect } from "vitest";

import { safeStringify } from "../internal/thread-helpers";
import { isSafeImageUrl } from "../internal/safe-external-url";
import {
  UIType,
  detectUIType,
  getUIResourceUri,
  isWidgetUiType,
} from "../internal/widget-detection";

describe("safeStringify", () => {
  it("always returns a string (even for undefined)", () => {
    expect(typeof safeStringify(undefined)).toBe("string");
    expect(safeStringify(undefined)).toBe("undefined");
    expect(safeStringify({ a: 1 })).toContain("\"a\": 1");
  });
});

describe("isSafeImageUrl", () => {
  it("allows inline data:image/* and absolute https:", () => {
    expect(isSafeImageUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeImageUrl("https://example.com/cat.png")).toBe(true);
  });

  it("rejects http, javascript:, non-image data:, and junk", () => {
    expect(isSafeImageUrl("http://example.com/cat.png")).toBe(false);
    expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageUrl("data:text/html,<script>")).toBe(false);
    expect(isSafeImageUrl("")).toBe(false);
    expect(isSafeImageUrl(undefined)).toBe(false);
  });
});

describe("detectUIType", () => {
  it("detects MCP Apps via flat (ui/resourceUri) and nested keys", () => {
    expect(detectUIType({ "ui/resourceUri": "ui://x" }, undefined)).toBe(
      UIType.MCP_APPS,
    );
    expect(detectUIType({ ui: { resourceUri: "ui://x" } }, undefined)).toBe(
      UIType.MCP_APPS,
    );
    expect(getUIResourceUri(UIType.MCP_APPS, { "ui/resourceUri": "ui://x" })).toBe(
      "ui://x",
    );
  });

  it("only treats a non-empty string openai/outputTemplate as a widget", () => {
    // Truthy non-string metadata must NOT classify as a widget.
    expect(detectUIType({ "openai/outputTemplate": true }, undefined)).toBeNull();
    expect(detectUIType({ "openai/outputTemplate": "" }, undefined)).toBeNull();
    const ok = detectUIType({ "openai/outputTemplate": "ui://tmpl" }, undefined);
    expect(ok).toBe(UIType.OPENAI_SDK);
    expect(isWidgetUiType(ok)).toBe(true);
  });

  it("returns null for plain tools", () => {
    expect(detectUIType({ foo: "bar" }, undefined)).toBeNull();
    expect(isWidgetUiType(null)).toBe(false);
  });
});
