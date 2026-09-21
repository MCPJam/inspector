/**
 * The lazy and local arms of the effective skill surface.
 *
 * Both exist so ONE catalog can carry every origin. A captured environment set
 * holds its bytes inline — that is what makes a snapshot a snapshot — while a
 * live origin (the project's Convex skills, the local filesystem) must not pay
 * for a body the model never asks for. These cases pin that a lazy origin is
 * fetched exactly once, on demand, and that a local file is read from disk
 * rather than through a URL it will never have.
 */

import { describe, expect, it, vi } from "vitest";
import { getEffectiveSkillToolsAndPrompt } from "../effective-skill-tools.js";
import {
  buildLiveEffectiveCapabilities,
  type EffectiveCapabilitySet,
  type RuntimeLocalSkill,
  type RuntimeStandaloneSkill,
} from "../../../services/environments/effective-capabilities.js";

async function run(tool: unknown, input: unknown): Promise<string> {
  return (tool as { execute: (i: unknown) => Promise<string> }).execute(input);
}

function tools(set: EffectiveCapabilitySet) {
  return getEffectiveSkillToolsAndPrompt(set).tools as Record<string, unknown>;
}

function cloudSkill(
  overrides: Partial<RuntimeStandaloneSkill> = {}
): RuntimeStandaloneSkill {
  return {
    skillId: "sk_1",
    ref: "code-review",
    name: "code-review",
    description: "Review code.",
    content: async () => "# Project code-review",
    aggregateHash: "hash-cloud",
    channels: [],
    files: [],
    ...overrides,
  };
}

function localSkill(
  overrides: Partial<RuntimeLocalSkill> = {}
): RuntimeLocalSkill {
  return {
    skillId: "local:/home/u/.claude/skills/code-review",
    ref: "local/code-review",
    name: "code-review",
    description: "Review code, locally.",
    content: "# Local code-review",
    aggregateHash: "hash-local",
    directory: "~/.claude/skills/code-review",
    files: [],
    ...overrides,
  };
}

describe("a lazy body is fetched only when loaded", () => {
  it("builds the catalog without reading a single body", () => {
    const content = vi.fn(async () => "# Project code-review");
    const set = buildLiveEffectiveCapabilities({
      standaloneSkills: [cloudSkill({ content })],
    });

    const { systemPromptSection } = getEffectiveSkillToolsAndPrompt(set);

    // The listing needs a name and a description, both of which the catalog
    // query already returned. Paying a fetch per skill to build it is the cost
    // this shape exists to avoid.
    expect(systemPromptSection).toContain("code-review");
    expect(content).not.toHaveBeenCalled();
  });

  it("awaits the body for the skill actually asked for", async () => {
    const content = vi.fn(async () => "# Project code-review");
    const set = buildLiveEffectiveCapabilities({
      standaloneSkills: [cloudSkill({ content })],
    });

    const loaded = await run(tools(set).loadSkill, { name: "code-review" });

    expect(loaded).toContain("# Project code-review");
    expect(content).toHaveBeenCalledTimes(1);
  });

  it("reports a failed fetch as an error the model can read, not a thrown turn", async () => {
    const set = buildLiveEffectiveCapabilities({
      standaloneSkills: [
        cloudSkill({
          content: async () => {
            throw new Error("project skill was deleted");
          },
        }),
      ],
    });

    const loaded = await run(tools(set).loadSkill, { name: "code-review" });

    expect(loaded).toContain("Error loading");
    expect(loaded).toContain("project skill was deleted");
  });

  it("lists supporting files through the lazy loader", async () => {
    const listFiles = vi.fn(async () => [
      { path: "scripts/run.py", size: 12, url: null },
    ]);
    const set = buildLiveEffectiveCapabilities({
      standaloneSkills: [cloudSkill({ listFiles })],
    });

    const listed = await run(tools(set).listSkillFiles, {
      name: "code-review",
    });

    expect(listed).toContain("scripts/run.py");
    expect(listFiles).toHaveBeenCalledTimes(1);
  });

  it("fetches the listing once across list-then-read, empty included", async () => {
    // `listSkillFiles` then `readSkillFile` is the sequence the model actually
    // performs, and the second call needs the same list to find the file in.
    const listFiles = vi.fn(async () => [
      { path: "scripts/run.py", size: 12, url: null, read: async () => new Uint8Array([104, 105]) },
    ]);
    const set = buildLiveEffectiveCapabilities({
      standaloneSkills: [cloudSkill({ listFiles })],
    });
    const toolSet = tools(set);

    await run(toolSet.listSkillFiles, { name: "code-review" });
    const read = await run(toolSet.readSkillFile, {
      name: "code-review",
      path: "scripts/run.py",
    });

    expect(read).toContain("hi");
    expect(listFiles).toHaveBeenCalledTimes(1);

    // An empty listing is the case an "only cache non-empty" shortcut would
    // miss, and it is the common one.
    const emptyListFiles = vi.fn(async () => []);
    const emptySet = buildLiveEffectiveCapabilities({
      standaloneSkills: [cloudSkill({ listFiles: emptyListFiles })],
    });
    const emptyTools = tools(emptySet);
    await run(emptyTools.listSkillFiles, { name: "code-review" });
    await run(emptyTools.readSkillFile, {
      name: "code-review",
      path: "scripts/run.py",
    });
    expect(emptyListFiles).toHaveBeenCalledTimes(1);
  });

  it("retries a listing that failed, rather than caching the failure", async () => {
    // Caching the rejected promise would pin the skill file-less for the whole
    // turn on one transient error.
    const listFiles = vi
      .fn<() => Promise<Array<{ path: string; size: number; url: null }>>>()
      .mockRejectedValueOnce(new Error("catalog offline"))
      .mockResolvedValue([{ path: "scripts/run.py", size: 12, url: null }]);
    const set = buildLiveEffectiveCapabilities({
      standaloneSkills: [cloudSkill({ listFiles })],
    });
    const toolSet = tools(set);

    expect(await run(toolSet.listSkillFiles, { name: "code-review" })).toContain(
      "catalog offline"
    );
    expect(await run(toolSet.listSkillFiles, { name: "code-review" })).toContain(
      "scripts/run.py"
    );
    expect(listFiles).toHaveBeenCalledTimes(2);
  });
});

describe("a local skill is read from disk", () => {
  it("reads a supporting file through its own reader, with no URL", async () => {
    const set = buildLiveEffectiveCapabilities({
      localSkills: [
        localSkill({
          listFiles: async () => [
            {
              path: "notes.md",
              size: 6,
              url: null,
              read: async () => new TextEncoder().encode("hello\n"),
            },
          ],
        }),
      ],
    });

    const read = await run(tools(set).readSkillFile, {
      name: "local/code-review",
      path: "notes.md",
    });

    expect(read).toContain("hello");
  });

  it("still refuses a file with neither a reader nor a URL", async () => {
    const set = buildLiveEffectiveCapabilities({
      localSkills: [
        localSkill({
          files: [{ path: "notes.md", size: 6, url: null }],
        }),
      ],
    });

    const read = await run(tools(set).readSkillFile, {
      name: "local/code-review",
      path: "notes.md",
    });

    expect(read).toContain("no download URL");
  });

  it("names the directory it came from in the catalog", () => {
    const set = buildLiveEffectiveCapabilities({
      localSkills: [localSkill()],
    });

    const { systemPromptSection } = getEffectiveSkillToolsAndPrompt(set);

    // "Which code-review is this?" is the question a merged catalog raises.
    expect(systemPromptSection).toContain("~/.claude/skills/code-review");
  });
});

describe("local and project skills of the same name", () => {
  // The case that made a source TOGGLE feel necessary. It is an ambiguity, not
  // a conflict: both are real, both are addressable, and the only wrong answer
  // is silently picking one.
  const set = buildLiveEffectiveCapabilities({
    standaloneSkills: [cloudSkill()],
    localSkills: [localSkill()],
  });

  it("keeps both, each addressable by its own ref", async () => {
    expect(await run(tools(set).loadSkill, { name: "local/code-review" })).toContain(
      "# Local code-review"
    );
    expect(await run(tools(set).loadSkill, { name: "code-review" })).toContain(
      "# Project code-review"
    );
    expect(set.problems).toEqual([]);
  });

  it("lists both origins in one catalog", () => {
    const { systemPromptSection } = getEffectiveSkillToolsAndPrompt(set);
    expect(systemPromptSection).toContain("**code-review**");
    expect(systemPromptSection).toContain("**local/code-review**");
    expect(systemPromptSection).toContain("(project)");
  });
});
