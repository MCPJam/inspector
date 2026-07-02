import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../computers/convex-skills-client", () => ({
  convexListSkillsForRuntime: vi.fn(),
}));

import {
  fetchRuntimeSkills,
  skillsFingerprint,
  toHarnessSkills,
  claudeCodeSafeSkills,
  toYamlDoubleQuoted,
  type RuntimeSkill,
} from "../runtime-skills";
import { convexListSkillsForRuntime } from "../../computers/convex-skills-client";

function skill(p: Partial<RuntimeSkill> & { skillId: string }): RuntimeSkill {
  return {
    name: "pdf",
    description: "Process PDFs",
    content: "body",
    aggregateHash: "h1",
    ...p,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("fetchRuntimeSkills (tri-state)", () => {
  it("returns { ok: true, skills } on success", async () => {
    vi.mocked(convexListSkillsForRuntime).mockResolvedValue([
      skill({ skillId: "s1" }),
    ]);
    const res = await fetchRuntimeSkills("Bearer x", "proj_1");
    expect(res).toEqual({ ok: true, skills: [skill({ skillId: "s1" })] });
  });

  it("returns { ok: false } on failure — NEVER [] (so callers don't wipe/churn)", async () => {
    vi.mocked(convexListSkillsForRuntime).mockRejectedValue(
      new Error("convex down")
    );
    const res = await fetchRuntimeSkills("Bearer x", "proj_1");
    expect(res).toEqual({ ok: false });
    // critically, not { ok: true, skills: [] }
    expect(res.ok).toBe(false);
  });
});

describe("skillsFingerprint", () => {
  it("is order-independent and stable", () => {
    const a = skillsFingerprint([
      skill({ skillId: "s1", aggregateHash: "a" }),
      skill({ skillId: "s2", aggregateHash: "b" }),
    ]);
    const b = skillsFingerprint([
      skill({ skillId: "s2", aggregateHash: "b" }),
      skill({ skillId: "s1", aggregateHash: "a" }),
    ]);
    expect(a).toBe(b);
  });

  it("returns '' for an empty list (empty == omitted, so no session churn)", () => {
    expect(skillsFingerprint([])).toBe("");
  });

  it("changes on edit (aggregateHash), add, rename, and delete", () => {
    const one = [skill({ skillId: "s1", aggregateHash: "a", name: "pdf" })];
    const base = skillsFingerprint(one);
    expect(
      skillsFingerprint([skill({ skillId: "s1", aggregateHash: "b" })])
    ).not.toBe(base); // edit
    expect(
      skillsFingerprint([...one, skill({ skillId: "s2", aggregateHash: "c" })])
    ).not.toBe(base); // add
    expect(
      skillsFingerprint([skill({ skillId: "s1", name: "renamed" })])
    ).not.toBe(base); // rename
    expect(skillsFingerprint([])).not.toBe(base); // delete
  });
});

describe("description handling (adapter-agnostic vs Claude shim)", () => {
  it("toHarnessSkills leaves descriptions SEMANTIC (unmodified)", () => {
    const out = toHarnessSkills([
      skill({ skillId: "s1", description: 'Process: PDFs "safely"' }),
    ]);
    expect(out[0].description).toBe('Process: PDFs "safely"');
  });

  it("claudeCodeSafeSkills pre-encodes a YAML double-quoted scalar", () => {
    const out = claudeCodeSafeSkills([
      skill({ skillId: "s1", description: 'Process: PDFs "safely"' }),
    ]);
    // `description: ${value}` must be valid frontmatter — quoted + escaped.
    expect(out[0].description).toBe('"Process: PDFs \\"safely\\""');
  });

  it("toYamlDoubleQuoted neutralizes newlines/quotes/backslashes", () => {
    expect(toYamlDoubleQuoted("a\nb")).toBe('"a\\nb"');
    expect(toYamlDoubleQuoted('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(toYamlDoubleQuoted("c:\\path")).toBe('"c:\\\\path"');
  });
});
