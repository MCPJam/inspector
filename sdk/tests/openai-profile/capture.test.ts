import { describe, expect, it, vi } from "vitest";
import { captureOpenAIProfile } from "../../src/openai-profile/capture.js";
const profileTool = { name: "whoami", _meta: { "openai/profile": true } };
function manager(result: unknown, tools = [profileTool]) {
  return {
    listTools: vi.fn().mockResolvedValue({ tools }),
    executeTool: vi.fn().mockResolvedValue(result),
  };
}
describe("profile capture", () => {
  it("uses structured content and preserves short opaque IDs exactly", async () => {
    const m = manager({
      structuredContent: { id: " 1 " },
      content: [{ type: "text", text: '{"id":"wrong"}' }],
    });
    expect(await captureOpenAIProfile(m as any, "B")).toEqual({
      profile: { id: " 1 " },
      structuredContent: true,
    });
    expect(m.executeTool).toHaveBeenCalledTimes(1);
    expect(m.executeTool.mock.calls[0].slice(0, 3)).toEqual([
      "B",
      "whoami",
      {},
    ]);
  });
  it.each([{ id: " " }, { id: "one", extra: true }, { id: "one", name: null }])(
    "rejects malformed profiles %j",
    async (profile) => {
      expect(
        (
          await captureOpenAIProfile(
            manager({ structuredContent: profile }) as any,
            "B"
          )
        ).profile
      ).toBeUndefined();
    }
  );
  it("accepts text JSON fallback but never converts an error into an identity", async () => {
    expect(
      (
        await captureOpenAIProfile(
          manager({ content: [{ type: "text", text: '{"id":"a"}' }] }) as any,
          "B"
        )
      ).profile
    ).toEqual({ id: "a" });
    expect(
      (
        await captureOpenAIProfile(
          manager({ isError: true, structuredContent: { id: "a" } }) as any,
          "B"
        )
      ).profile
    ).toBeUndefined();
  });
  it.each([
    { tools: [] },
    { tools: [profileTool, profileTool] },
    { tools: [{ ...profileTool, _meta: { "openai/profile": false } }] },
  ])("does not call without a unique designated tool", async ({ tools }) => {
    const m = manager({}, tools);
    await captureOpenAIProfile(m as any, "B");
    expect(m.executeTool).not.toHaveBeenCalled();
  });
  it("bounds hung calls, aborts the request, and never retries", async () => {
    const m = manager({});
    m.executeTool.mockImplementation(() => new Promise(() => {}));
    expect(
      (await captureOpenAIProfile(m as any, "B", { timeoutMs: 10 })).profile
    ).toBeUndefined();
    expect(m.executeTool).toHaveBeenCalledTimes(1);
    expect(m.executeTool.mock.calls[0][3].signal.aborted).toBe(true);
  });
});
