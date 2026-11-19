import { describe, expect, it, vi } from "vitest";
import { currentAppToolVisibility } from "../browser-harness/current-tool";

describe("current App tool declaration", () => {
  it.each([
    { metadata: undefined, expected: ["model", "app"] },
    { metadata: { ui: { visibility: ["app"] } }, expected: ["app"] },
    { metadata: { ui: { visibility: ["model", "model"] } }, expected: ["model"] },
  ])("uses the listed declaration: $metadata", async ({ metadata, expected }) => {
    const listTools = vi.fn().mockResolvedValue({
      tools: [{ name: "refresh", inputSchema: { type: "object" }, _meta: metadata }],
    });
    expect(await currentAppToolVisibility({ listTools }, "saved", "refresh"))
      .toEqual(expected);
  });

  it("reads every request and follows opaque cursors", async () => {
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [], nextCursor: "" })
      .mockResolvedValueOnce({ tools: [], nextCursor: "" })
      .mockResolvedValueOnce({ tools: [{ name: "refresh", inputSchema: { type: "object" } }] })
      .mockResolvedValueOnce({ tools: [{ name: "refresh", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["model"] } } }] });
    expect(await currentAppToolVisibility({ listTools }, "saved", "refresh"))
      .toEqual(["model", "app"]);
    expect(listTools).toHaveBeenNthCalledWith(3, "saved", { cursor: "" }, { cacheMode: "bypass" });
    expect(await currentAppToolVisibility({ listTools }, "saved", "refresh"))
      .toEqual(["model"]);
    expect(listTools).toHaveBeenCalledTimes(4);
  });

  it("refuses an unlisted tool after a bounded lookup", async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [], nextCursor: "same" });
    await expect(currentAppToolVisibility({ listTools }, "saved", "refresh"))
      .rejects.toThrow("no longer available");
    expect(listTools).toHaveBeenCalledTimes(50);
  });

  it("does not turn a failed listing into default permission", async () => {
    const listTools = vi.fn().mockRejectedValue(new Error("disconnected"));
    await expect(currentAppToolVisibility({ listTools }, "saved", "refresh"))
      .rejects.toThrow("disconnected");
  });
});
