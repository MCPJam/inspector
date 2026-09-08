import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../computers/convex-skills-client", async (importOriginal) => ({
  // Keep the real pure helpers (e.g. normalizeProvenance); only the two network
  // query fns are stubbed below.
  ...(await importOriginal<
    typeof import("../../computers/convex-skills-client")
  >()),
  convexListSkillsForRuntime: vi.fn(),
  convexListSkillsForRuntimeExecution: vi.fn(),
  convexListSkillFilesForRuntime: vi.fn(),
  convexListSkillFilesForRuntimeExecution: vi.fn(),
}));

import {
  fetchRuntimeSkills,
  fetchRuntimeSkillFiles,
  skillsFingerprint,
  toHarnessSkills,
  toPinnableSkill,
  frontmatterSafeSkills,
  prepareClaudeCodeSkills,
  prepareCodexSkills,
  prepareNoSkills,
  toYamlDoubleQuoted,
  type RuntimeSkill,
} from "../runtime-skills";
import {
  convexListSkillsForRuntime,
  convexListSkillsForRuntimeExecution,
  convexListSkillFilesForRuntime,
} from "../../computers/convex-skills-client";

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
      new Error("convex down"),
    );
    const res = await fetchRuntimeSkills("Bearer x", "proj_1");
    expect(res).toEqual({ ok: false });
    // critically, not { ok: true, skills: [] }
    expect(res.ok).toBe(false);
  });

  // Secure Guest Harness Enablement — the execution-scoped query is used when a
  // scope is present (guest / swarm grant), so a guest never hits the member
  // `projectId` query (which would reject them).
  it("uses the member projectId query when no executionScope is given", async () => {
    vi.mocked(convexListSkillsForRuntime).mockResolvedValue([
      skill({ skillId: "s1" }),
    ]);
    const res = await fetchRuntimeSkills("Bearer x", "proj_1");
    expect(convexListSkillsForRuntime).toHaveBeenCalledWith(
      "Bearer x",
      "proj_1",
    );
    expect(convexListSkillsForRuntimeExecution).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, skills: [skill({ skillId: "s1" })] });
  });

  it("uses the execution-scoped query when an executionScope is present", async () => {
    const scope = {
      kind: "swarm" as const,
      swarmId: "cb_1",
      accessVersion: 3,
      projectId: "proj_1",
      workspaceId: "ws_1",
    };
    vi.mocked(convexListSkillsForRuntimeExecution).mockResolvedValue([
      skill({ skillId: "s2" }),
    ]);
    const res = await fetchRuntimeSkills("Bearer x", "proj_1", scope);
    expect(convexListSkillsForRuntimeExecution).toHaveBeenCalledWith(
      "Bearer x",
      scope,
    );
    expect(convexListSkillsForRuntime).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, skills: [skill({ skillId: "s2" })] });
  });
});

describe("fetchRuntimeSkillFiles (tri-state)", () => {
  it("returns { ok: true, files } on success (empty array is a valid 'no files')", async () => {
    vi.mocked(convexListSkillFilesForRuntime).mockResolvedValue([]);
    const res = await fetchRuntimeSkillFiles("Bearer x", "proj_1");
    expect(res).toEqual({ ok: true, files: [] });
  });

  it("returns { ok: false } on failure — NEVER [] (so the caller skips prune)", async () => {
    vi.mocked(convexListSkillFilesForRuntime).mockRejectedValue(
      new Error("convex down"),
    );
    const res = await fetchRuntimeSkillFiles("Bearer x", "proj_1");
    // Critically distinct from { ok: true, files: [] } — an empty set on a
    // failure would make materialize prune every delivered skill's files.
    expect(res).toEqual({ ok: false });
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
      skillsFingerprint([skill({ skillId: "s1", aggregateHash: "b" })]),
    ).not.toBe(base); // edit
    expect(
      skillsFingerprint([...one, skill({ skillId: "s2", aggregateHash: "c" })]),
    ).not.toBe(base); // add
    expect(
      skillsFingerprint([skill({ skillId: "s1", name: "renamed" })]),
    ).not.toBe(base); // rename
    expect(skillsFingerprint([])).not.toBe(base); // delete
  });

  it("is UNCHANGED for a provenance-only difference (metadata, not box state)", () => {
    const base = skillsFingerprint([
      skill({ skillId: "s1", provenance: "authored" }),
    ]);
    const adopted = skillsFingerprint([
      skill({ skillId: "s1", provenance: "computer-adopted" }),
    ]);
    expect(adopted).toBe(base);
  });
});

describe("toPinnableSkill", () => {
  it("maps aggregateHash → contentHash and normalizes provenance", () => {
    expect(
      toPinnableSkill(
        skill({
          skillId: "s1",
          name: "pdf",
          description: "Process PDFs",
          content: "body",
          aggregateHash: "agg",
          provenance: "computer-adopted",
        }),
      ),
    ).toEqual({
      name: "pdf",
      description: "Process PDFs",
      content: "body",
      contentHash: "agg",
      provenance: "computer-adopted",
    });
  });

  it("defaults an absent/unknown provenance to 'authored'", () => {
    expect(toPinnableSkill(skill({ skillId: "s1" })).provenance).toBe(
      "authored",
    );
    expect(
      toPinnableSkill(
        skill({ skillId: "s1", provenance: "future-value" as never }),
      ).provenance,
    ).toBe("authored");
  });
});

describe("description handling (adapter-agnostic vs frontmatter shim)", () => {
  it("toHarnessSkills leaves descriptions SEMANTIC (unmodified)", () => {
    const out = toHarnessSkills([
      skill({ skillId: "s1", description: 'Process: PDFs "safely"' }),
    ]);
    expect(out[0].description).toBe('Process: PDFs "safely"');
  });

  it("frontmatterSafeSkills pre-encodes a YAML double-quoted scalar", () => {
    const out = frontmatterSafeSkills([
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

describe("prepareSkills (per-adapter delivery shaping)", () => {
  it("Claude Code delivers every skill, descriptions YAML-encoded", () => {
    const skills = [
      skill({ skillId: "s1", name: "alpha", description: 'a "b"' }),
      skill({ skillId: "s2", name: "beta" }),
    ];
    const prepared = prepareClaudeCodeSkills(skills);
    expect(prepared.delivered).toEqual(skills);
    expect(prepared.skipped).toEqual([]);
    expect(prepared.payload.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(prepared.payload[0].description).toBe('"a \\"b\\""');
  });

  it("Codex delivers valid names with the same YAML encoding", () => {
    const skills = [
      skill({ skillId: "s1", name: "pdf-tools", description: 'a "b"' }),
    ];
    const prepared = prepareCodexSkills(skills);
    expect(prepared.delivered).toEqual(skills);
    expect(prepared.skipped).toEqual([]);
    expect(prepared.payload).toEqual([
      {
        name: "pdf-tools",
        description: '"a \\"b\\""',
        content: skills[0].content,
      },
    ]);
  });

  it("Codex FILTERS a name it could not write instead of failing the turn", () => {
    // The Codex adapter validates names inside `doStart` and THROWS on a
    // reject — one bad name would take the whole turn down, so it must never
    // reach the adapter. The good skill still ships.
    const good = skill({ skillId: "s1", name: "pdf-tools" });
    const prepared = prepareCodexSkills([
      good,
      skill({ skillId: "s2", name: ".." }),
      skill({ skillId: "s3", name: "Bad Name!" }),
    ]);
    expect(prepared.delivered).toEqual([good]);
    expect(prepared.payload.map((p) => p.name)).toEqual(["pdf-tools"]);
    expect(prepared.skipped).toEqual([
      { name: "..", reason: "invalid-skill-name" },
      { name: "Bad Name!", reason: "invalid-skill-name" },
    ]);
  });
});

describe("prepareNoSkills", () => {
  // The Cursor adapter ships `supportsSkills: false`, so `runHarnessTurn` never
  // calls this. It is tested anyway because the guard is the only thing keeping
  // it unreachable — if that guard ever moves, this must still be honest rather
  // than silently claiming a delivery the runtime does not perform.
  it("delivers nothing and reports every skill as skipped", () => {
    const result = prepareNoSkills([
      skill({ skillId: "sk-alpha", name: "alpha" }),
      skill({ skillId: "sk-beta", name: "beta" }),
    ]);
    expect(result.payload).toEqual([]);
    expect(result.delivered).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "alpha", reason: "harness-does-not-deliver-skills" },
      { name: "beta", reason: "harness-does-not-deliver-skills" },
    ]);
  });

  it("is empty in all three fields for an empty input", () => {
    // The "nothing to deliver" case must not read as "something was skipped".
    expect(prepareNoSkills([])).toEqual({
      payload: [],
      delivered: [],
      skipped: [],
    });
  });
});
