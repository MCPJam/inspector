import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listMockSkills } from "../index.js";
import type { MockDefinition } from "../index.js";
import { useItemHarness } from "./item-harness.js";
import type { Era } from "./item-harness.js";

const h = useItemHarness();

const SKILL_MD =
  "---\nname: triage\ndescription: Sort incoming issues.\n---\nRead checklist.md, then label.";
const CHECKLIST = "1. Reproduce\n2. Label";
const sha256 = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const skillDefinition: MockDefinition = {
  resources: {
    "skill://triage/SKILL.md": { mimeType: "text/markdown", text: SKILL_MD },
    "skill://triage/checklist.md": {
      mimeType: "text/markdown",
      text: CHECKLIST,
    },
  },
};

describe.each<Era>(["legacy", "modern"])("skills (%s era)", (era) => {
  it("serves a skill beside a real server's resources, with a manifest a host can verify", async () => {
    const { client, handler } = await h.connect(skillDefinition, era);
    if (era === "legacy") {
      // `extensions` is a 2026-07-28 field, so an older revision has no skills methods; the files are still resources.
      expect(client.getServerCapabilities()?.extensions).toBeUndefined();
      expect((await h.rpc(handler, era, "skills/list")).error?.code).toBe(
        -32601
      );
      const read = await client.readResource({
        uri: "skill://triage/checklist.md",
      });
      expect(read.contents[0]).toMatchObject({ text: CHECKLIST });
      return;
    }
    expect(client.getServerCapabilities()?.extensions).toHaveProperty(
      "io.modelcontextprotocol/skills"
    );
    const listed = await h.rpc(handler, era, "skills/list");
    expect(listed.result?.skills).toHaveLength(1);
    const skill = listed.result?.skills[0];
    expect(skill).toMatchObject({
      uri: "skill://triage/SKILL.md",
      frontmatter: { name: "triage", description: "Sort incoming issues." },
    });
    // What the manifest promises is what resources/read returns.
    expect(skill.resources).toEqual([
      {
        uri: "skill://triage/SKILL.md",
        digest: sha256(SKILL_MD),
        size: Buffer.byteLength(SKILL_MD),
      },
      {
        uri: "skill://triage/checklist.md",
        digest: sha256(CHECKLIST),
        size: Buffer.byteLength(CHECKLIST),
      },
    ]);
    const read = await client.readResource({
      uri: "skill://triage/checklist.md",
    });
    expect(read.contents[0]).toMatchObject({ text: CHECKLIST });
    const got = await h.rpc(handler, era, "skills/get", {
      uri: "skill://triage/SKILL.md",
    });
    expect(got.result?.skill.uri).toBe("skill://triage/SKILL.md");
    const missing = await h.rpc(handler, era, "skills/get", {
      uri: "skill://nope/SKILL.md",
    });
    expect(missing.error?.code).toBe(-32602);
  });

  it("a mock from nothing lists its skill and reads its files", async () => {
    const { client, handler } = await h.connect(skillDefinition, era, true);
    if (era === "legacy") {
      expect((await h.rpc(handler, era, "skills/list")).error?.code).toBe(
        -32601
      );
    } else
      expect(
        (await h.rpc(handler, era, "skills/list")).result?.skills
      ).toHaveLength(1);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([
      "skill://triage/SKILL.md",
      "skill://triage/checklist.md",
    ]);
    expect(
      (await client.readResource({ uri: "skill://triage/SKILL.md" }))
        .contents[0]
    ).toMatchObject({ text: SKILL_MD });
  });

  it("does not declare the extension, or answer skills, for a definition with no skill files", async () => {
    const { client, handler } = await h.connect(
      { resources: { "test://notes": { text: "x" } } },
      era
    );
    expect(client.getServerCapabilities()?.extensions).toBeUndefined();
    // Not the mock's to answer: it goes to the real server, which has no such method.
    expect(
      (await h.rpc(handler, era, "skills/list")).result?.skills
    ).toBeUndefined();
  });
});

describe("listMockSkills over the real server's skills", () => {
  const realSkill = {
    uri: "skill://real/SKILL.md",
    frontmatter: { name: "real", description: "A real skill." },
    resources: [
      { uri: "skill://real/SKILL.md", digest: "sha256:aa", size: 1 },
      { uri: "skill://real/notes.md", digest: "sha256:bb", size: 2 },
      { uri: "skill://real/extra.md", digest: "sha256:cc", size: 3 },
    ],
  };
  const other = {
    uri: "skill://other/SKILL.md",
    frontmatter: { name: "other", description: "d" },
    resources: [],
  };

  it("recomputes the digest of a replaced file and drops a hidden one from the manifest", async () => {
    const skills = await listMockSkills(
      {
        resources: {
          "skill://real/notes.md": { text: "new notes" },
          "skill://real/extra.md": { hidden: true },
        },
      },
      [realSkill, other]
    );
    expect(skills.map((s) => s.uri)).toEqual([
      "skill://real/SKILL.md",
      "skill://other/SKILL.md",
    ]);
    expect(skills[0]?.resources).toEqual([
      { uri: "skill://real/SKILL.md", digest: "sha256:aa", size: 1 },
      { uri: "skill://real/notes.md", digest: sha256("new notes"), size: 9 },
    ]);
  });

  it("drops a skill whose SKILL.md is hidden, and replaces one whose SKILL.md the definition states", async () => {
    const hidden = await listMockSkills(
      { resources: { "skill://real/SKILL.md": { hidden: true } } },
      [realSkill, other]
    );
    expect(hidden.map((s) => s.uri)).toEqual(["skill://other/SKILL.md"]);
    const md = "---\nname: real\ndescription: Mine.\n---\nbody";
    const replaced = await listMockSkills(
      { resources: { "skill://real/SKILL.md": { text: md } } },
      [realSkill, other]
    );
    expect(replaced.map((s) => s.uri)).toEqual([
      "skill://other/SKILL.md",
      "skill://real/SKILL.md",
    ]);
    expect(replaced[1]?.frontmatter).toEqual({
      name: "real",
      description: "Mine.",
    });
    expect(replaced[1]?.resources).toEqual([
      {
        uri: "skill://real/SKILL.md",
        digest: sha256(md),
        size: Buffer.byteLength(md),
      },
    ]);
  });
});
