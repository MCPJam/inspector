import { describe, it, expect } from "vitest";
import { scrubAppToolResultForModel } from "../app-tools-sanitizer";

describe("scrubAppToolResultForModel (SEP-1865)", () => {
  it("keeps content and drops structuredContent + _meta", () => {
    const raw = {
      content: [{ type: "text" as const, text: "hello" }],
      structuredContent: { secret: 1 },
      _meta: { sensitive: true },
    };
    const out = scrubAppToolResultForModel(raw);
    expect(out).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("preserves isError = true", () => {
    const raw = {
      content: [{ type: "text" as const, text: "oops" }],
      isError: true,
      _meta: { trace: "x" },
    };
    const out = scrubAppToolResultForModel(raw);
    expect(out.isError).toBe(true);
    expect(out).not.toHaveProperty("_meta");
  });

  it("omits isError when falsy (smaller payload)", () => {
    const raw = {
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
    };
    const out = scrubAppToolResultForModel(raw);
    expect(out).not.toHaveProperty("isError");
  });
});
