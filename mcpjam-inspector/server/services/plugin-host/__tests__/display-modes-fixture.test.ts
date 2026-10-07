import { describe, expect, it } from "vitest";
import { createDisplayModesFixture } from "../testing/display-modes.js";

describe("independent display-mode fixture", () => {
  it("serves all missing metadata variants without discovery activation", async () => {
    const fixture = await createDisplayModesFixture();
    const call = async (method: string, params = {}) => {
      const response = await fetch(fixture.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).result;
    };
    try {
      const { tools } = await call("tools/list");
      expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
        "preferred",
        "omitted",
        "narrowed",
        "unsupported",
      ]);
      const { resources } = await call("resources/list");
      expect(resources).toHaveLength(4);
      const read = async (name: string) =>
        (await call("resources/read", { uri: `ui://display/${name}` }))
          .contents[0];
      expect((await read("preferred"))._meta["openai/ui"]).toEqual({
        preferredDisplayMode: "fullscreen",
      });
      expect((await read("omitted"))._meta).toBeUndefined();
      expect(
        (await read("narrowed"))._meta["openai/ui"].availableDisplayModes,
      ).toEqual(["inline", "fullscreen"]);
      expect((await read("unsupported")).text).toContain(
        'availableDisplayModes: ["fullscreen"]',
      );
      expect(fixture.activations.size).toBe(0);
      await call("tools/call", { name: "preferred", arguments: {} });
      await read("preferred");
      expect(fixture.activations.get("preferred")).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});
