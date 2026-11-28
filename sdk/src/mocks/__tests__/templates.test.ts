import { describe, expect, it } from "vitest";
import { matchTemplate, validateMockDefinition } from "../index.js";
import { useItemHarness } from "./item-harness.js";
import type { Era } from "./item-harness.js";

const h = useItemHarness();

describe.each<Era>(["legacy", "modern"])(
  "resource templates (%s era)",
  (era) => {
    it("answers any URI a template matches, filling its variables, beside the real server's resources", async () => {
      const { client } = await h.connect(
        {
          resourceTemplates: {
            "docs://{+path}": {
              name: "Docs",
              mimeType: "text/plain",
              text: "page {{input.path}}",
            },
            "users://{id}/profile": { text: "user {{input.id}}" },
          },
        },
        era
      );
      expect(
        (await client.listResourceTemplates()).resourceTemplates.map(
          (t) => t.uriTemplate
        )
      ).toEqual(["docs://{+path}", "users://{id}/profile"]);
      const read = async (uri: string) =>
        (await client.readResource({ uri })).contents[0];
      expect(await read("docs://guide/intro")).toMatchObject({
        text: "page guide/intro",
        mimeType: "text/plain",
      });
      expect(await read("users://a%20b/profile")).toMatchObject({
        text: "user a b",
      });
      expect(await read("test://greeting")).toMatchObject({ text: "hello" });
    });

    it("refuses to list templates when an edit points at one the real server no longer lists, naming it", async () => {
      const { handler } = await h.connect(
        { resourceTemplates: { "x://{id}": { hidden: true } } },
        era
      );
      const list = await h.rpc(handler, era, "resources/templates/list");
      expect(list.error?.data).toMatchObject({
        mockCode: "mock_edited_item_missing",
        kind: "resource template",
        items: ["x://{id}"],
      });
    });
  }
);

describe("matchTemplate", () => {
  it("reads simple and reserved variables, decoding the simple ones", () => {
    expect(
      matchTemplate("users://{id}/profile", "users://a%20b/profile")
    ).toEqual({
      id: "a b",
    });
    expect(
      matchTemplate("users://{id}/profile", "users://a/b/profile")
    ).toBeUndefined();
    expect(matchTemplate("file:///{+path}", "file:///a/b.txt")).toEqual({
      path: "a/b.txt",
    });
    expect(matchTemplate("a://{x}/{y}", "a://1/2")).toEqual({ x: "1", y: "2" });
    expect(matchTemplate("a://{x}", "b://1")).toBeUndefined();
  });
});

describe("validating templates", () => {
  const issues = (input: unknown) => {
    const result = validateMockDefinition(input);
    return result.ok ? [] : result.issues.map((i) => [i.code, i.path]);
  };

  it("accepts simple and reserved variables, and refuses operators and repeats it does not read", () => {
    expect(
      issues({ resourceTemplates: { "file:///{+path}": { text: "x" } } })
    ).toEqual([]);
    expect(
      issues({ resourceTemplates: { "file:///{?q}": { text: "x" } } })
    ).toEqual([["invalid_value", "resourceTemplates.file:///{?q}"]]);
    expect(
      issues({ resourceTemplates: { "file:///{a}/{a}": { text: "x" } } })
    ).toEqual([["invalid_value", "resourceTemplates.file:///{a}/{a}"]]);
  });

  it("refuses adding template content while removing the resources capability", () => {
    expect(
      issues({
        capabilities: { resources: null },
        resourceTemplates: { "a://{id}": { text: "x" } },
      })
    ).toEqual([["param_conflict", "capabilities.resources"]]);
  });
});
