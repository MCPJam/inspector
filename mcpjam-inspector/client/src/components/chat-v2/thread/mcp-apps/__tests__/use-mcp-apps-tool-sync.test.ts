import { describe, expect, it } from "vitest";
import { getToolInputSignature } from "../use-mcp-apps-tool-sync";

describe("getToolInputSignature", () => {
  it("returns identical signatures for equivalent payloads", () => {
    const a = { points: [1, 2, 3], config: { width: 100, height: 200 } };
    const b = { config: { height: 200, width: 100 }, points: [1, 2, 3] };

    expect(getToolInputSignature(a)).toBe(getToolInputSignature(b));
  });

  it("changes when nested object values change with same keys", () => {
    const first = { config: { width: 100, height: 200 } };
    const second = { config: { width: 500, height: 200 } };

    expect(getToolInputSignature(first)).not.toBe(
      getToolInputSignature(second),
    );
  });

  it("changes when same-length primitive arrays change", () => {
    const first = { points: [1, 2, 3] };
    const second = { points: [1, 9, 3] };

    expect(getToolInputSignature(first)).not.toBe(
      getToolInputSignature(second),
    );
  });
});
