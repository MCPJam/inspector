/**
 * `skills-dispatch.ts` — the mutual-declaration gate, and the guards that
 * validate what a server sends back.
 *
 * The gate is the whole security posture of the feature in one boolean, so
 * each half of the conjunction gets its own negative case.
 */

import { describe, expect, it } from "vitest";
import {
  MCP_SKILLS_EXTENSION_ID,
  clientDeclaresSkillsExtension,
  resolveSkillsSupport,
  serverDeclaresSkillsExtension,
  skillsDirectoryReadEnabled,
} from "../src/mcp-client-manager/skills-dispatch.js";
import {
  assertDirectoryReadResult,
  assertSkillEntry,
  assertSkillsListResult,
  assertSkillsGetResult,
  isInvalidSkillsPayloadError,
} from "../src/mcp-client-manager/skills-ext-guards.js";
import {
  getDefaultClientCapabilities,
  withSkillsExtensionCapability,
} from "../src/mcp-client-manager/capabilities.js";

const DECLARED = { extensions: { [MCP_SKILLS_EXTENSION_ID]: {} } };

describe("declaration reading", () => {
  it("accepts an empty settings object", () => {
    expect(serverDeclaresSkillsExtension(DECLARED as never)).toBe(true);
    expect(clientDeclaresSkillsExtension(DECLARED as never)).toBe(true);
  });

  it("accepts unknown settings — the SEP may grow them", () => {
    expect(
      serverDeclaresSkillsExtension({
        extensions: { [MCP_SKILLS_EXTENSION_ID]: { somethingNew: 1 } },
      } as never)
    ).toBe(true);
  });

  it("rejects a non-object settings value — key presence is not enough", () => {
    for (const value of [true, "yes", [], null, 1]) {
      expect(
        serverDeclaresSkillsExtension({
          extensions: { [MCP_SKILLS_EXTENSION_ID]: value },
        } as never)
      ).toBe(false);
    }
  });

  it("rejects a missing or malformed extensions container", () => {
    expect(serverDeclaresSkillsExtension(undefined)).toBe(false);
    expect(serverDeclaresSkillsExtension({} as never)).toBe(false);
    expect(serverDeclaresSkillsExtension({ extensions: [] } as never)).toBe(
      false
    );
  });
});

describe("skillsDirectoryReadEnabled", () => {
  it("requires a strict true", () => {
    expect(
      skillsDirectoryReadEnabled({
        extensions: { [MCP_SKILLS_EXTENSION_ID]: { directoryRead: true } },
      } as never)
    ).toBe(true);
    for (const value of ["true", 1, {}, undefined]) {
      expect(
        skillsDirectoryReadEnabled({
          extensions: { [MCP_SKILLS_EXTENSION_ID]: { directoryRead: value } },
        } as never)
      ).toBe(false);
    }
  });
});

describe("resolveSkillsSupport", () => {
  it("is active only when BOTH sides declared", () => {
    expect(resolveSkillsSupport(DECLARED as never, DECLARED as never)).toEqual({
      declared: true,
      advertised: true,
      directoryRead: false,
      active: true,
    });
  });

  it("is inactive when the client did not advertise — advertise = enforce", () => {
    const support = resolveSkillsSupport(undefined, DECLARED as never);
    expect(support.active).toBe(false);
    // The two halves stay distinguishable: "server has no skills" and "we
    // never declared" must not collapse into one indistinguishable state.
    expect(support).toMatchObject({ declared: true, advertised: false });
  });

  it("is inactive when the server did not declare", () => {
    const support = resolveSkillsSupport(DECLARED as never, undefined);
    expect(support).toMatchObject({
      declared: false,
      advertised: true,
      active: false,
    });
  });

  it("reports nothing when neither side declared", () => {
    // The early-return literal no other assertion reaches.
    expect(resolveSkillsSupport(undefined, undefined)).toEqual({
      declared: false,
      advertised: false,
      directoryRead: false,
      active: false,
    });
  });

  it("never reports directoryRead on an inactive connection", () => {
    const serverCaps = {
      extensions: { [MCP_SKILLS_EXTENSION_ID]: { directoryRead: true } },
    };
    expect(
      resolveSkillsSupport(undefined, serverCaps as never).directoryRead
    ).toBe(false);
    expect(
      resolveSkillsSupport(DECLARED as never, serverCaps as never).directoryRead
    ).toBe(true);
  });
});

describe("withSkillsExtensionCapability", () => {
  it("is NOT part of the SDK defaults (SEP-2133 opt-in)", () => {
    const defaults = getDefaultClientCapabilities() as Record<string, unknown>;
    const extensions = defaults.extensions as Record<string, unknown>;
    expect(extensions).not.toHaveProperty(MCP_SKILLS_EXTENSION_ID);
  });

  it("merges without dropping unrelated extensions", () => {
    const merged = withSkillsExtensionCapability(
      getDefaultClientCapabilities() as Record<string, unknown>
    );
    const extensions = merged.extensions as Record<string, unknown>;
    expect(extensions["io.modelcontextprotocol/ui"]).toBeDefined();
    expect(extensions[MCP_SKILLS_EXTENSION_ID]).toEqual({});
  });

  it("preserves settings a caller already pinned", () => {
    const merged = withSkillsExtensionCapability({
      extensions: { [MCP_SKILLS_EXTENSION_ID]: { pinned: true } },
    });
    expect(
      (merged.extensions as Record<string, unknown>)[MCP_SKILLS_EXTENSION_ID]
    ).toEqual({ pinned: true });
  });

  it("works from undefined", () => {
    expect(withSkillsExtensionCapability(undefined).extensions).toEqual({
      [MCP_SKILLS_EXTENSION_ID]: {},
    });
  });
});

describe("wire guards", () => {
  it("preserves SEP-2549 ttlMs/cacheScope through the listing guard", () => {
    const result = assertSkillsListResult({
      skills: [],
      ttlMs: 60_000,
      cacheScope: "private",
    });
    expect(result).toMatchObject({ ttlMs: 60_000, cacheScope: "private" });
  });

  it("passes unknown keys through — a debugger shows what was sent", () => {
    const result = assertSkillsListResult({
      skills: [{ uri: "skill://a/b/SKILL.md", frontmatter: {}, futureKey: 1 }],
      futureTopLevel: true,
    }) as unknown as Record<string, unknown>;
    expect(result.futureTopLevel).toBe(true);
    expect(result.skills as unknown[]).toHaveLength(1);
    expect((result.skills as Record<string, unknown>[])[0]!.futureKey).toBe(1);
  });

  it("rejects a malformed entry and names the failing path", () => {
    const error = (() => {
      try {
        assertSkillsListResult({ skills: [{ frontmatter: {} }] });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(isInvalidSkillsPayloadError(error)).toBe(true);
    expect((error as { method?: string }).method).toBe("skills/list");
    expect((error as { issues: string[] }).issues.join(" ")).toContain("uri");
  });

  it("rejects a resource ref missing its digest", () => {
    expect(() =>
      assertSkillEntry({
        uri: "skill://a/b/SKILL.md",
        frontmatter: {},
        resources: [{ uri: "skill://a/b/x" }],
      })
    ).toThrow(/digest/);
  });

  it("accepts an entry with no resources — the refusal is a policy layer up", () => {
    expect(
      assertSkillEntry({ uri: "skill://a/b/SKILL.md", frontmatter: {} })
    ).toMatchObject({ uri: "skill://a/b/SKILL.md" });
  });

  it("unwraps the skills/get ENVELOPE and refuses a bare entry", () => {
    // SEP-2640 returns `{ skill }`. Validating the result as a bare entry
    // looks for `uri` at the top level, where no conforming server puts it —
    // so the old shape failed against every real server and passed only
    // against a fixture repeating the same mistake.
    const entry = { uri: "skill://a/b/SKILL.md", frontmatter: { name: "b" } };
    expect(assertSkillsGetResult({ skill: entry })).toMatchObject({
      uri: "skill://a/b/SKILL.md",
    });
    const bare = (() => {
      try {
        assertSkillsGetResult(entry);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(isInvalidSkillsPayloadError(bare)).toBe(true);
  });

  it("validates directory read results", () => {
    expect(
      assertDirectoryReadResult({
        resources: [
          { uri: "skill://a/b/scripts", mimeType: "inode/directory" },
        ],
      }).resources
    ).toHaveLength(1);
    const error = (() => {
      try {
        assertDirectoryReadResult({ resources: [{}] });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    // Pinned by method AND path: a bare `.toThrow()` would be satisfied by a
    // defect that threw before validation ran.
    expect(isInvalidSkillsPayloadError(error)).toBe(true);
    expect((error as { method?: string }).method).toBe(
      "resources/directory/read"
    );
    expect((error as { issues: string[] }).issues.join(" ")).toContain("uri");
  });

  it("rejects an entry with NO frontmatter key at all", () => {
    // Without an explicit required-key guard this parses on the current zod,
    // and the identity re-check then compares nothing while reporting success.
    expect(() => assertSkillEntry({ uri: "skill://a/b/SKILL.md" })).toThrow(
      /frontmatter/
    );
  });

  it("rejects a negative or fractional ttlMs", () => {
    expect(() => assertSkillsListResult({ skills: [], ttlMs: -1 })).toThrow();
    expect(() => assertSkillsListResult({ skills: [], ttlMs: 1.5 })).toThrow();
  });
});
