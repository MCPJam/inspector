import { describe, expect, it, vi } from "vitest";

import {
  VARIANT_ERROR_CODES,
  VARIANT_LIMITS,
  VariantError,
  buildVariantDraft,
  computeContentHash,
  computeEditsHash,
  computeSurfaceHash,
  computeToolHash,
  pinVariantSurface,
  type VariantEditInput,
  type VariantErrorCode,
  type VariantTool,
  type VariantToolsPage,
} from "../../src/variants/index.js";

const TOOLS: VariantTool[] = [
  {
    name: "show_servers",
    description: "Show servers.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" } },
    },
    annotations: { readOnlyHint: true },
  },
  { name: "list_project_servers", inputSchema: { type: "object" } },
];

function edit(
  target: string,
  value: unknown = `New ${target}.`
): VariantEditInput {
  return { feature: "tools.description", target, op: "set", value };
}

async function expectRefusal(
  input: Partial<Parameters<typeof buildVariantDraft>[0]>,
  code: VariantErrorCode,
  message: string
) {
  const refusal = await buildVariantDraft({
    baseServerId: "base",
    tools: TOOLS,
    edits: [],
    ...input,
  }).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(refusal).toBeInstanceOf(VariantError);
  expect(refusal).toMatchObject({ name: "VariantError", code, message });
}

describe("buildVariantDraft", () => {
  it("returns clean edits in order, every hash and a diff", async () => {
    const edits = [
      {
        ...edit("list_project_servers", "Lists one project's servers."),
        note: "dropped",
      },
      edit("show_servers", "Shows servers across projects."),
    ];

    const draft = await buildVariantDraft({
      baseServerId: "base",
      tools: TOOLS,
      edits,
    });

    expect(draft.edits).toEqual([
      {
        feature: "tools.description",
        target: "list_project_servers",
        op: "set",
        value: "Lists one project's servers.",
      },
      {
        feature: "tools.description",
        target: "show_servers",
        op: "set",
        value: "Shows servers across projects.",
      },
    ]);
    expect(draft.editsHash).toBe(await computeEditsHash(draft.edits));
    expect(draft.baseSurfaceHash).toBe(await computeSurfaceHash(TOOLS));
    expect(draft.toolHashes).toEqual([
      { tool: "list_project_servers", hash: await computeToolHash(TOOLS[1]) },
      { tool: "show_servers", hash: await computeToolHash(TOOLS[0]) },
    ]);
    expect(draft.contentHash).toBe(
      await computeContentHash({
        baseServerId: "base",
        baseSurfaceHash: draft.baseSurfaceHash,
        editsHash: draft.editsHash,
      })
    );
    expect(draft.diff).toEqual([
      {
        tool: "list_project_servers",
        field: "description",
        before: null,
        after: "Lists one project's servers.",
      },
      {
        tool: "show_servers",
        field: "description",
        before: "Show servers.",
        after: "Shows servers across projects.",
      },
    ]);
  });

  it("gives the same base, surface and edits the same content hash, and another base a different one", async () => {
    const edits = [edit("show_servers")];
    const first = await buildVariantDraft({
      baseServerId: "base",
      tools: TOOLS,
      edits,
    });
    const again = await buildVariantDraft({
      baseServerId: "base",
      tools: structuredClone(TOOLS),
      edits,
    });
    const elsewhere = await buildVariantDraft({
      baseServerId: "other",
      tools: TOOLS,
      edits,
    });

    expect(again.contentHash).toBe(first.contentHash);
    expect(elsewhere.contentHash).not.toBe(first.contentHash);
  });

  it("accepts a description of exactly 10,000 characters after trimming", async () => {
    const value = `  ${"d".repeat(VARIANT_LIMITS.maxValueChars)}\n`;
    const draft = await buildVariantDraft({
      baseServerId: "base",
      tools: TOOLS,
      edits: [edit("show_servers", value)],
    });
    expect(draft.edits[0].value).toBe(value);
  });

  it("exports every code in the contract", () => {
    expect(VARIANT_ERROR_CODES).toEqual([
      "VARIANT_FEATURE_NOT_VARIABLE",
      "VARIANT_INVALID_VALUE",
      "VARIANT_DUPLICATE_EDIT",
      "VARIANT_UNKNOWN_TARGET",
      "VARIANT_TOO_LARGE",
      "VARIANT_UNSUPPORTED_SERVER",
      "VARIANT_IMMUTABLE",
      "VARIANT_BASE_DRIFTED",
    ]);
  });

  it("refuses a feature other than tools.description", async () => {
    await expectRefusal(
      { edits: [{ ...edit("show_servers"), feature: "tools.title" }] },
      "VARIANT_FEATURE_NOT_VARIABLE",
      "A variant can't change tools.title yet. It can change: tools.description."
    );
  });

  it.each([
    ["an op other than set", { op: "remove" }],
    ["an empty value", { value: "" }],
    ["a value that is only whitespace", { value: " \n\t " }],
    [
      "a value over 10,000 characters after trimming",
      { value: "d".repeat(10_001) },
    ],
    ["a value that isn't text", { value: 42 }],
  ])("refuses %s", async (_case, change) => {
    await expectRefusal(
      { edits: [{ ...edit("show_servers"), ...change }] },
      "VARIANT_INVALID_VALUE",
      "The new description for show_servers must be 1 to 10,000 characters of text."
    );
  });

  it("refuses two edits to the same tool's description", async () => {
    await expectRefusal(
      { edits: [edit("show_servers", "One."), edit("show_servers", "Two.")] },
      "VARIANT_DUPLICATE_EDIT",
      "Two edits change the description of show_servers. Keep one."
    );
  });

  it("refuses a tool the base doesn't have, naming the server when given", async () => {
    await expectRefusal(
      { edits: [edit("show_server")], serverName: "mcpjam-docs" },
      "VARIANT_UNKNOWN_TARGET",
      "mcpjam-docs has no tool named show_server. Check the name with list_server_tools."
    );
    await expectRefusal(
      { edits: [edit("show_server")] },
      "VARIANT_UNKNOWN_TARGET",
      "The base server has no tool named show_server. Check the name with list_server_tools."
    );
  });

  it("refuses more than 200 edits", async () => {
    const tools = Array.from({ length: 201 }, (_, index) => ({
      name: `tool_${index}`,
    }));
    await expectRefusal(
      { tools, edits: tools.map((tool) => edit(tool.name)) },
      "VARIANT_TOO_LARGE",
      "A variant can hold at most 200 edits and 256 KB of edits. Remove some edits."
    );
  });

  it("refuses edits over 256 KB as canonical JSON", async () => {
    const tools = Array.from({ length: 27 }, (_, index) => ({
      name: `tool_${index}`,
    }));
    await expectRefusal(
      {
        tools,
        edits: tools.map((tool) => edit(tool.name, "d".repeat(10_000))),
      },
      "VARIANT_TOO_LARGE",
      "A variant can hold at most 200 edits and 256 KB of edits. Remove some edits."
    );
  });

  it("accepts edits just under 256 KB", async () => {
    const tools = Array.from({ length: 26 }, (_, index) => ({
      name: `tool_${index}`,
    }));
    const draft = await buildVariantDraft({
      baseServerId: "base",
      tools,
      edits: tools.map((tool) => edit(tool.name, "d".repeat(10_000))),
    });
    expect(draft.edits).toHaveLength(26);
  });

  it("refuses a variant with no edits", async () => {
    await expect(
      buildVariantDraft({ baseServerId: "base", tools: TOOLS, edits: [] })
    ).rejects.toThrow(new TypeError("A variant needs at least one edit."));
  });
});

describe("pinVariantSurface", () => {
  it("reads every page in order and hashes the whole surface", async () => {
    const pages: Record<string, VariantToolsPage> = {
      first: { tools: [TOOLS[0]], nextCursor: "page-2" },
      "page-2": { tools: [], nextCursor: "page-3" },
      "page-3": { tools: [TOOLS[1], { name: "third", extra: { kept: true } }] },
    };
    const listPage = vi.fn(async (cursor?: string) => pages[cursor ?? "first"]);

    const pinned = await pinVariantSurface({ listPage });

    expect(listPage.mock.calls).toEqual([[undefined], ["page-2"], ["page-3"]]);
    expect(pinned.tools).toEqual([
      TOOLS[0],
      TOOLS[1],
      { name: "third", extra: { kept: true } },
    ]);
    expect(pinned.baseSurfaceHash).toBe(await computeSurfaceHash(pinned.tools));
  });

  it("reads a listing of exactly 100 pages", async () => {
    const listPage = vi.fn(async (cursor?: string) => {
      const page = cursor === undefined ? 1 : Number(cursor);
      return page < 100
        ? { tools: [{ name: `tool_${page}` }], nextCursor: String(page + 1) }
        : { tools: [{ name: `tool_${page}` }] };
    });

    const pinned = await pinVariantSurface({ listPage });

    expect(listPage).toHaveBeenCalledTimes(100);
    expect(pinned.tools).toHaveLength(100);
  });

  it("refuses a listing that is still going after 100 pages", async () => {
    const listPage = vi.fn(async (cursor?: string) => ({
      tools: [],
      nextCursor: `${cursor ?? ""}+`,
    }));

    await expect(pinVariantSurface({ listPage })).rejects.toThrow(
      "The base server lists its tools across more than 100 pages, so a variant can't pin them. Make variants of servers whose tool list ends within 100 pages."
    );
    expect(listPage).toHaveBeenCalledTimes(100);
  });
});
