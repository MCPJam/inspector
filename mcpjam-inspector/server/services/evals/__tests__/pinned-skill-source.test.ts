/**
 * A run's harness copies carry each captured server skill's capture, as the
 * run's set holds it, so a harness's skill tools serve it as MCPJam's agent
 * does in the same run.
 */
import { describe, expect, it } from "vitest";
import { buildPinnedSkillSource } from "../pinned-skill-source";
import {
  authoredPin,
  EVAL_PLUGIN_VERSIONS,
  pluginPin,
  preparedRunSkills,
  serverPin,
} from "../../../test/support/skill-delivery";

describe("buildPinnedSkillSource", () => {
  it("stamps a server skill's copy with its capture, under the set's ref", async () => {
    const run = await preparedRunSkills();
    const [library, plugin, server] = run.pinnedHarnessSkills;
    expect(library?.server).toBeUndefined();
    expect(plugin?.server).toBeUndefined();
    expect(server?.server).toEqual({
      serverSkillId: "ss_docs_search",
      versionId: "ssv_docs_search_2",
      serverId: "srv_docs",
      serverLabel: "Docs",
      ref: "docs/search",
      skillUri: "skill://docs/search",
      versionNumber: 2,
      capturedAt: 1_700_000_000_000,
      contentSha256: "hash-search",
    });
    // The plan reads the same stamped copies.
    expect(run.pinnedSkillSource.harnessSkills).toBe(run.pinnedHarnessSkills);
  });

  it("takes the set's ref when it had to disambiguate one", async () => {
    // A plugin named like the server holds the server skill's ref: the set
    // keeps the plugin's and suffixes the server's.
    const run = await buildPinnedSkillSource({
      pins: [
        pluginPin({ modelRef: "docs/search", name: "search" }),
        serverPin(),
      ],
      pluginVersions: [
        { pluginId: "plg_docs", pluginVersionId: "plv_docs_1", name: "docs" },
      ],
      pluginServers: [],
      effectiveServerIds: ["srv_docs"],
    });
    const ref = run.pinnedSkillSource.set.serverSkills[0]?.ref;
    expect(ref).toMatch(/^docs\/search~/);
    expect(run.pinnedHarnessSkills[1]?.server?.ref).toBe(ref);
  });

  it("records each supporting file's captured size, which a read re-checks", async () => {
    const withFile = serverPin({
      aggregateHash: "agg-search",
      files: [
        {
          path: "notes.md",
          contentHash: "hash-notes",
          size: 5,
          url: `data:text/markdown;base64,${Buffer.from("notes").toString("base64")}`,
        },
      ],
    });
    const run = await preparedRunSkills([authoredPin(), withFile]);
    expect(run.pinnedHarnessSkills[1]?.server?.fileSizes).toEqual({
      "notes.md": 5,
    });
  });

  it("keeps the copies a swarm target passes in, stamping the server skill's on a copy of it", async () => {
    // As the swarm runner fetches them: SKILL.md only, under the served hash,
    // which a copy rebuilt from the pins would not carry.
    const pins = [pluginPin(), serverPin()];
    const copies = pins.map(({ name, description, content }) => ({
      name,
      description,
      content,
      contentHash: `served-${name}`,
    }));
    const run = await buildPinnedSkillSource({
      pins,
      harnessSkills: copies,
      pluginVersions: EVAL_PLUGIN_VERSIONS,
      pluginServers: [],
      effectiveServerIds: ["srv_docs"],
      reportsFailure: false,
    });
    expect(run.pinnedHarnessSkills.map((copy) => copy.contentHash)).toEqual([
      "served-summarize",
      "served-search",
    ]);
    expect(run.pinnedHarnessSkills[0]?.server).toBeUndefined();
    expect(run.pinnedHarnessSkills[1]?.server).toMatchObject({
      serverSkillId: "ss_docs_search",
      serverId: "srv_docs",
      ref: "docs/search",
    });
    // The caller's copy is not stamped in place: a cached fetch is shared.
    expect(copies[1]).not.toHaveProperty("server");
    expect(run.pinnedSkillSource.harnessSkills).toBe(run.pinnedHarnessSkills);
  });
});
