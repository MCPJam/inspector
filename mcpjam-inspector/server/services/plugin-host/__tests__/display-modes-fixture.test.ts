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
        "ui_prefers_fullscreen",
        "ui_fullscreen_only",
        "ui_no_preference",
        "ui_no_modes",
        "ui_error",
        "ui_invalid_preference",
        "plain",
      ]);
      const { resources } = await call("resources/list");
      expect(resources).toHaveLength(10);
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

  it("serves Claude's _meta.ui variants on the content item only", async () => {
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
    const read = async (name: string) =>
      (await call("resources/read", { uri: `ui://display/${name}` }))
        .contents[0];
    try {
      expect((await read("ui_prefers_fullscreen"))._meta).toEqual({
        ui: { preferredDisplayMode: "fullscreen" },
      });
      expect((await read("ui_invalid_preference"))._meta).toEqual({
        ui: { preferredDisplayMode: "sidebar" },
      });
      for (const name of ["ui_fullscreen_only", "ui_no_preference"])
        expect((await read(name))._meta).toBeUndefined();
      expect((await read("ui_fullscreen_only")).text).toContain(
        'availableDisplayModes: ["fullscreen"]',
      );
      expect((await read("ui_no_modes")).text).toContain(
        "availableDisplayModes: []",
      );
      const { resources } = await call("resources/list");
      const listed = resources.find(
        (resource: { uri: string }) =>
          resource.uri === "ui://display/ui_prefers_fullscreen",
      );
      expect(listed._meta).toBeUndefined();
      const { tools } = await call("tools/list");
      const tool = (name: string) =>
        tools.find((entry: { name: string }) => entry.name === name);
      expect(tool("ui_prefers_fullscreen")._meta["openai/ui"]).toBeUndefined();
      expect(tool("plain")._meta).toBeUndefined();
      expect(
        await call("tools/call", { name: "ui_error", arguments: {} }),
      ).toMatchObject({ isError: true });
      expect(
        await call("tools/call", { name: "plain", arguments: {} }),
      ).not.toHaveProperty("isError");
    } finally {
      await fixture.close();
    }
  });
});
