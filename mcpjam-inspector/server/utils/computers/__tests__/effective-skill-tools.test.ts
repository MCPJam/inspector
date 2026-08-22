import { afterEach, describe, expect, it, vi } from "vitest";
import { getEffectiveSkillToolsAndPrompt } from "../effective-skill-tools";
import { skillMetadataBudgetChars } from "../skill-metadata-budget";
import type { EffectiveCapabilitySet } from "../../../services/environments/effective-capabilities";

const PLUGIN_A = {
  pluginId: "p_a",
  pluginVersionId: "pv_a",
  name: "alpha",
  bundleHash: "aaaa1111bbbb",
};
const PLUGIN_B = {
  pluginId: "p_b",
  pluginVersionId: "pv_b",
  name: "beta",
  bundleHash: "bbbb2222cccc",
};

function set(overrides: Partial<EffectiveCapabilitySet> = {}) {
  return {
    explicitServerIds: [],
    pluginServerIds: [],
    effectiveServerIds: [],
    servers: [],
    pluginSkills: [],
    standaloneSkills: [],
    serverSkills: [],
    pluginVersions: [],
    problems: [],
    ...overrides,
  } satisfies EffectiveCapabilitySet;
}

/** The AI SDK tool shape exposes `execute`; call it the way streamText would. */
async function run(tool: unknown, input: unknown): Promise<string> {
  const execute = (tool as { execute: (i: unknown) => Promise<string> })
    .execute;
  return execute(input);
}

const DUPLICATE_NAME_SET = set({
  pluginSkills: [
    {
      ref: "alpha/summarize",
      skillId: "sk_a",
      name: "summarize",
      description: "Alpha's summarizer",
      content: "ALPHA BODY",
      aggregateHash: "agg_a",
      files: [],
      plugin: PLUGIN_A,
    },
    {
      ref: "beta/summarize",
      skillId: "sk_b",
      name: "summarize",
      description: "Beta's summarizer",
      content: "BETA BODY",
      aggregateHash: "agg_b",
      files: [],
      plugin: PLUGIN_B,
    },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prompt catalog", () => {
  it("advertises refs and origins, not bare names", () => {
    const { tools, systemPromptSection } =
      getEffectiveSkillToolsAndPrompt(DUPLICATE_NAME_SET);
    expect(tools).not.toHaveProperty("listSkills");
    expect(systemPromptSection).toContain(
      "**alpha/summarize** (plugin alpha@aaaa1111)"
    );
    expect(systemPromptSection).toContain(
      "**beta/summarize** (plugin beta@bbbb2222)"
    );
  });

  it("labels a standalone skill as a project skill", () => {
    const { systemPromptSection } = getEffectiveSkillToolsAndPrompt(
      set({
        standaloneSkills: [
          {
            ref: "release-notes",
            skillId: "sk",
            name: "release-notes",
            description: "Write release notes",
            content: "body",
            aggregateHash: "agg",
            files: [],
            channels: ["environment"],
          },
        ],
      })
    );
    expect(systemPromptSection).toContain("**release-notes** (project)");
  });

  it("still calls an unattributed plugin skill a plugin skill, not a project one", () => {
    // Mislabelling it "project" would be a false claim about where the model's
    // instructions came from.
    const { systemPromptSection } = getEffectiveSkillToolsAndPrompt(
      set({
        pluginSkills: [
          {
            ref: "summarize",
            skillId: "sk_a",
            name: "summarize",
            description: "Summarize",
            content: "body",
            aggregateHash: "agg",
            files: [],
          },
        ],
      })
    );
    expect(systemPromptSection).toContain("**summarize** (plugin)");
  });

  it("emits no tools and no stanza when the capability set is empty", () => {
    const { tools, systemPromptSection } = getEffectiveSkillToolsAndPrompt(
      set()
    );
    expect(tools).toEqual({});
    expect(systemPromptSection).toBe("");
  });

  it("emits a listing that actually fits the budget, origin labels included", () => {
    // The accounting is only worth having if the STRING obeys it. Plugin
    // origins ("plugin alpha@aaaa1111") are ~25 chars each, so an uncharged
    // origin overshoots by an amount that grows with the plugin-skill count.
    const many = Array.from({ length: 30 }, (_, index) => ({
      ref: `alpha/skill-${index}`,
      skillId: `sk_${index}`,
      name: `skill-${index}`,
      description: "d".repeat(120),
      content: "body",
      aggregateHash: "agg",
      files: [],
      plugin: PLUGIN_A,
    }));
    const modelContextTokens = 25_000; // 2% × 4 chars/token = 2,000 chars.
    const budgetChars = skillMetadataBudgetChars(modelContextTokens);
    const { systemPromptSection } = getEffectiveSkillToolsAndPrompt(
      set({ pluginSkills: many }),
      { modelContextTokens }
    );

    // Measure the catalog lines only — header, trigger, and overflow notice
    // sit outside the budget.
    const body = systemPromptSection
      .split("\n")
      .filter((line) => line.startsWith("- **"))
      .join("\n");
    expect(body.length).toBeLessThanOrEqual(budgetChars);
    // And the origin really is in the measured text, or the assertion is empty.
    expect(body).toContain("(plugin alpha@aaaa1111)");
  });

  it("states that skills were dropped when the metadata budget omits them", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      ref: `skill-${index}`,
      skillId: `sk_${index}`,
      name: `skill-${index}`,
      description: "d".repeat(400),
      content: "body",
      aggregateHash: "agg",
      files: [],
      channels: ["environment" as const],
    }));
    const { systemPromptSection } = getEffectiveSkillToolsAndPrompt(
      set({ standaloneSkills: many }),
      // A tiny context makes the 2% budget bite deterministically.
      { modelContextTokens: 1_000 }
    );
    expect(systemPromptSection).toMatch(
      /could not be listed within this model's skill-metadata budget/
    );
  });
});

describe("loadSkill", () => {
  it("delivers captured MCP-server skills under their pinned ref and requires approval", async () => {
    const { tools, systemPromptSection } = getEffectiveSkillToolsAndPrompt(
      set({
        serverSkills: [
          {
            ref: "acme/refunds",
            skillId: "server_skill_1",
            name: "refunds",
            description: "Handle refunds",
            content: "CAPTURED SERVER BODY",
            aggregateHash: "version_hash_1",
            files: [],
            serverId: "server_1",
            serverLabel: "Acme Billing",
            skillUri: "skill://acme/refunds/SKILL.md",
            versionId: "version_1",
            versionNumber: 3,
            capturedAt: 1,
          },
        ],
      })
    );
    expect(systemPromptSection).toContain(
      "**acme/refunds** (MCP server Acme Billing@v3)"
    );
    expect(await run(tools.loadSkill, { name: "acme/refunds" })).toContain(
      "CAPTURED SERVER BODY"
    );
    const needsApproval = (
      tools.loadSkill as {
        needsApproval: (input: { name: string }) => boolean;
      }
    ).needsApproval;
    expect(needsApproval({ name: "acme/refunds" })).toBe(true);
  });

  it("loads the correct content for each of two plugins declaring one name", async () => {
    const { tools } = getEffectiveSkillToolsAndPrompt(DUPLICATE_NAME_SET);
    expect(await run(tools.loadSkill, { name: "alpha/summarize" })).toContain(
      "ALPHA BODY"
    );
    expect(await run(tools.loadSkill, { name: "beta/summarize" })).toContain(
      "BETA BODY"
    );
  });

  it("refuses an ambiguous bare name and names both refs", async () => {
    const { tools } = getEffectiveSkillToolsAndPrompt(DUPLICATE_NAME_SET);
    const result = await run(tools.loadSkill, { name: "summarize" });
    expect(result).toContain("ambiguous");
    expect(result).toContain('"alpha/summarize"');
    expect(result).toContain('"beta/summarize"');
    // Crucially: it did NOT silently pick one.
    expect(result).not.toContain("ALPHA BODY");
  });

  it("accepts a bare name when it is unambiguous", async () => {
    const { tools } = getEffectiveSkillToolsAndPrompt(
      set({ pluginSkills: [DUPLICATE_NAME_SET.pluginSkills[0]] })
    );
    expect(await run(tools.loadSkill, { name: "summarize" })).toContain(
      "ALPHA BODY"
    );
  });

  it("rejects a malformed reference", async () => {
    const { tools } = getEffectiveSkillToolsAndPrompt(DUPLICATE_NAME_SET);
    expect(await run(tools.loadSkill, { name: "../etc/passwd" })).toContain(
      "Invalid skill reference"
    );
  });

  it("reports an unknown reference", async () => {
    const { tools } = getEffectiveSkillToolsAndPrompt(DUPLICATE_NAME_SET);
    expect(await run(tools.loadSkill, { name: "gamma/thing" })).toContain(
      "not found"
    );
  });
});

describe("supporting files", () => {
  const fileSet = set({
    pluginSkills: [
      {
        ref: "alpha/report",
        skillId: "sk_a",
        name: "report",
        description: "Reporting",
        content: "body",
        aggregateHash: "agg",
        files: [
          { path: "scripts/fill.py", size: 11, url: "https://blob/fill" },
          { path: "assets/logo.png", size: 9, url: "https://blob/logo" },
          { path: "no-url.txt", size: 4, url: null },
        ],
        plugin: PLUGIN_A,
      },
    ],
  });

  it("lists a skill's files through its ref", async () => {
    const { tools } = getEffectiveSkillToolsAndPrompt(fileSet);
    const listed = await run(tools.listSkillFiles, { name: "alpha/report" });
    expect(listed).toContain("scripts/fill.py (11 bytes)");
  });

  it("reads a text file from the signed URL the environment already minted", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(new TextEncoder().encode("print(1)"), { status: 200 })
      );
    const { tools } = getEffectiveSkillToolsAndPrompt(fileSet);
    const result = await run(tools.readSkillFile, {
      name: "alpha/report",
      path: "scripts/fill.py",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://blob/fill");
    expect(result).toContain("print(1)");
  });

  it("refuses a path that is not a file of that skill — refs bound file reads", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { tools } = getEffectiveSkillToolsAndPrompt(fileSet);
    const result = await run(tools.readSkillFile, {
      name: "alpha/report",
      path: "../other/secret.txt",
    });
    expect(result).toContain("is not a supporting file");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a binary file rather than returning garbage text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2]), { status: 200 })
    );
    const { tools } = getEffectiveSkillToolsAndPrompt(fileSet);
    expect(
      await run(tools.readSkillFile, {
        name: "alpha/report",
        path: "assets/logo.png",
      })
    ).toContain("is binary");
  });

  it("says so when no download URL was issued", async () => {
    const { tools } = getEffectiveSkillToolsAndPrompt(fileSet);
    expect(
      await run(tools.readSkillFile, {
        name: "alpha/report",
        path: "no-url.txt",
      })
    ).toContain("no download URL");
  });

  it("advertises the file tools only when the set has a file-bearing skill", () => {
    expect(
      getEffectiveSkillToolsAndPrompt(fileSet).systemPromptSection
    ).toContain("listSkillFiles");
    expect(
      getEffectiveSkillToolsAndPrompt(DUPLICATE_NAME_SET).systemPromptSection
    ).not.toContain("listSkillFiles");
  });
});
