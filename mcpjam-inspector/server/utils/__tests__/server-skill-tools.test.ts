/**
 * Skills over MCP (SEP-2640) — the live chat wrapper.
 *
 * PIN: modelcontextprotocol/docs @ d7490ec.
 *
 * The wrapper's contract has three load-bearing properties, and each gets a
 * test that would fail loudly if it regressed:
 *   1. it is INVISIBLE when no server declares the extension (byte-identical
 *      base), so every pre-existing turn is unchanged;
 *   2. a bare name NEVER resolves to a server skill (no shadowing channel);
 *   3. a server-origin load is ALWAYS approval-gated, even with the host's
 *      approval policy off.
 */

import { describe, expect, it, vi } from "vitest";
import {
  manifestApprovalHash,
  resolveProviderSlugs,
  serverSkillBanner,
  slugifyServerLabel,
  withServerSkills,
} from "../server-skill-tools.js";

const SKILL_URI = "skill://acme/refunds/SKILL.md";
const FILE_URI = "skill://acme/refunds/scripts/run.py";
const BODY = "# Refunds\n\nRefund politely.\n";
const MARKDOWN = `---\nname: refunds\ndescription: Handle refunds.\n---\n${BODY}`;
const FILE_TEXT = "print('refund')\n";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A manager double that speaks exactly the three methods the wrapper uses.
 * Deliberately hand-rolled rather than a mock of `MCPClientManager`: the point
 * is to control the WIRE answers, including malformed ones.
 */
async function makeManager(
  options: {
    active?: boolean;
    /** Serve the SKILL.md with bytes that don't match the advertised digest. */
    tamper?: boolean;
    /** Omit `resources` from the entry entirely. */
    noResources?: boolean;
    /** Also answer reads for this unlisted URI. */
    serveUnlisted?: string;
    unlistedSkills?: Record<string, { name: string; markdown: string }>;
  } = {}
) {
  const markdownDigest = `sha256:${await sha256(
    options.tamper ? `${MARKDOWN}tampered` : MARKDOWN
  )}`;
  const fileDigest = `sha256:${await sha256(FILE_TEXT)}`;
  const entry = {
    uri: SKILL_URI,
    frontmatter: { name: "refunds", description: "Handle refunds." },
    ...(options.noResources
      ? {}
      : {
          resources: [
            { uri: SKILL_URI, digest: markdownDigest },
            { uri: FILE_URI, digest: fileDigest },
          ],
        }),
  };

  const calls: string[] = [];
  const manager = {
    calls,
    getSkillsSupport: () => ({
      declared: options.active !== false,
      advertised: options.active !== false,
      directoryRead: false,
      active: options.active !== false,
    }),
    listServerSkills: vi.fn(async () => {
      calls.push("skills/list");
      return { skills: [entry] };
    }),
    getServerSkill: vi.fn(async (_serverId: string, uri: string) => {
      calls.push(`skills/get:${uri}`);
      if (uri === SKILL_URI) return entry;
      const unlisted = options.unlistedSkills?.[uri];
      if (unlisted) {
        return {
          uri,
          frontmatter: {
            name: unlisted.name,
            description: "An unlisted skill.",
          },
          resources: [
            { uri, digest: `sha256:${await sha256(unlisted.markdown)}` },
          ],
        };
      }
      throw Object.assign(new Error("Invalid params"), { code: -32602 });
    }),
    readResource: vi.fn(async (_serverId: string, params: { uri: string }) => {
      calls.push(`resources/read:${params.uri}`);
      if (params.uri === SKILL_URI) {
        return { contents: [{ uri: params.uri, text: MARKDOWN }] };
      }
      if (params.uri === FILE_URI) {
        return { contents: [{ uri: params.uri, text: FILE_TEXT }] };
      }
      if (params.uri === options.serveUnlisted) {
        return { contents: [{ uri: params.uri, text: "TOKEN=hunter2\n" }] };
      }
      const unlisted = options.unlistedSkills?.[params.uri];
      if (unlisted) {
        return { contents: [{ uri: params.uri, text: unlisted.markdown }] };
      }
      throw new Error(`Resource not found: ${params.uri}`);
    }),
  };
  return manager as unknown as Parameters<
    typeof withServerSkills
  >[1]["manager"] & {
    calls: string[];
  };
}

function baseTools() {
  return {
    listSkills: {
      description: "base list",
      execute: vi.fn(
        async () => "Available skills:\n\n- **local-skill**: A local one."
      ),
    },
    loadSkill: {
      execute: vi.fn(async (input: { name?: string }) => `BASE:${input.name}`),
    },
    listSkillFiles: { execute: vi.fn(async () => "BASE FILES") },
    readSkillFile: { execute: vi.fn(async () => "BASE FILE") },
  };
}

const SERVERS = [{ serverId: "srv1", serverLabel: "Acme Billing" }];

describe("slug + ref minting", () => {
  it("slugifies a server LABEL, never a server-supplied name", () => {
    expect(slugifyServerLabel("Acme Billing (prod)")).toBe("acme-billing-prod");
    expect(slugifyServerLabel("!!!")).toBe("server");
  });

  it("uniquifies slugs across providers so refs cannot collide", () => {
    const providers = resolveProviderSlugs([
      { serverId: "a", serverLabel: "Acme" },
      { serverId: "b", serverLabel: "acme" },
      { serverId: "c", serverLabel: "ACME!" },
    ]);
    expect(providers.map((p) => p.serverSlug)).toEqual([
      "acme",
      "acme-2",
      "acme-3",
    ]);
  });
});

describe("manifestApprovalHash", () => {
  it("is stable under reordering but changes with any manifest edit", async () => {
    const a = [
      { uri: "b", digest: "sha256:2" },
      { uri: "a", digest: "sha256:1" },
    ];
    const reordered = [...a].reverse();
    expect(await manifestApprovalHash(a)).toBe(
      await manifestApprovalHash(reordered)
    );
    // A changed digest is a DIFFERENT approval — that is the SEP's
    // "bind approval to the digest set" rule.
    expect(
      await manifestApprovalHash([
        { uri: "a", digest: "sha256:1" },
        { uri: "b", digest: "sha256:CHANGED" },
      ])
    ).not.toBe(await manifestApprovalHash(a));
    // So is an added file.
    expect(
      await manifestApprovalHash([...a, { uri: "c", digest: "sha256:3" }])
    ).not.toBe(await manifestApprovalHash(a));
  });
});

describe("withServerSkills — attachment", () => {
  it("returns the base object UNCHANGED when no server declares the extension", async () => {
    const base = baseTools();
    const manager = await makeManager({ active: false });
    const wrapped = withServerSkills(base, { manager, servers: SERVERS });
    // Identity, not deep equality: the orchestration decides whether to add the
    // system-prompt sentence by comparing references.
    expect(wrapped).toBe(base);
    expect(manager.calls).toEqual([]);
  });

  it("returns the base object unchanged when there are no servers at all", async () => {
    const base = baseTools();
    const manager = await makeManager();
    expect(withServerSkills(base, { manager, servers: [] })).toBe(base);
  });

  it("sends ZERO skills/* frames until something asks about skills", async () => {
    const base = baseTools();
    const manager = await makeManager();
    withServerSkills(base, { manager, servers: SERVERS });
    // Discovery is lazy: constructing the wrapper must not touch the wire.
    expect(manager.calls).toEqual([]);
  });
});

describe("withServerSkills — listSkills", () => {
  it("appends an origin-framed section to the base listing", async () => {
    const base = baseTools();
    const manager = await makeManager();
    const wrapped = withServerSkills(base, { manager, servers: SERVERS });
    const text = String(
      await (wrapped.listSkills as { execute: Function }).execute({}, {})
    );
    expect(text).toContain("local-skill");
    expect(text).toContain("acme-billing/refunds");
    expect(text).toContain('MCP server "Acme Billing"');
    // The description is framed as server-provided, so a description that
    // imitates a system instruction reads as third-party text.
    expect(text).toContain("untrusted descriptions");
  });

  it("drains each provider only once per turn", async () => {
    const base = baseTools();
    const manager = await makeManager();
    const wrapped = withServerSkills(base, { manager, servers: SERVERS });
    const listSkills = wrapped.listSkills as { execute: Function };
    await listSkills.execute({}, {});
    await listSkills.execute({}, {});
    expect(manager.calls.filter((c) => c === "skills/list")).toHaveLength(1);
  });
});

describe("withServerSkills — loadSkill", () => {
  it("ALWAYS requires approval, even with the host policy off", async () => {
    const manager = await makeManager();
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
      requireToolApproval: false,
    });
    expect(
      (wrapped.loadSkill as { needsApproval?: boolean }).needsApproval
    ).toBe(true);
    expect(
      (wrapped.readSkillFile as { needsApproval?: boolean }).needsApproval
    ).toBe(true);
  });

  it("loads a verified server skill behind the untrusted-content banner", async () => {
    const manager = await makeManager();
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    });
    const text = String(
      await (wrapped.loadSkill as { execute: Function }).execute(
        { name: "acme-billing/refunds" },
        {}
      )
    );
    expect(text).toContain("# Skill: acme-billing/refunds");
    // The wording separates consistency from trust — a hostile server digests
    // its hostile content correctly.
    expect(text).toContain("matched the server-advertised digest");
    expect(text).toContain("not trustworthiness");
    expect(text).toContain("untrusted input");
    expect(text).toContain("Refund politely.");
  });

  it("delegates a BARE NAME to the base source — no shadowing channel", async () => {
    const base = baseTools();
    const manager = await makeManager();
    const wrapped = withServerSkills(base, { manager, servers: SERVERS });
    const result = await (wrapped.loadSkill as { execute: Function }).execute(
      { name: "refunds" },
      {}
    );
    expect(result).toBe("BASE:refunds");
    expect(base.loadSkill.execute).toHaveBeenCalled();
  });

  it("resolves an UNLISTED skill by URI via skills/get", async () => {
    const hiddenUri = "skill://acme/hidden/SKILL.md";
    const hiddenMarkdown = `---\nname: hidden\ndescription: An unlisted skill.\n---\n# Hidden\n`;
    const manager = await makeManager({
      unlistedSkills: {
        [hiddenUri]: { name: "hidden", markdown: hiddenMarkdown },
      },
    });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    });
    const text = String(
      await (wrapped.loadSkill as { execute: Function }).execute(
        { uri: hiddenUri },
        {}
      )
    );
    expect(text).toContain("# Hidden");
    expect(manager.calls).toContain(`skills/get:${hiddenUri}`);
  });

  it("refuses a URI it cannot attribute to a single server", async () => {
    const manager = await makeManager();
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: [
        { serverId: "srv1", serverLabel: "Acme" },
        { serverId: "srv2", serverLabel: "Globex" },
      ],
    });
    const text = String(
      await (wrapped.loadSkill as { execute: Function }).execute(
        { uri: "skill://somewhere/else/SKILL.md" },
        {}
      )
    );
    // Refuses and says how to disambiguate, rather than guessing a server.
    expect(text).toContain(
      "could not be resolved to a single connected server"
    );
  });

  it("refuses a skill with no manifest instead of loading it unverified", async () => {
    const manager = await makeManager({ noResources: true });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    });
    const text = String(
      await (wrapped.loadSkill as { execute: Function }).execute(
        { name: "acme-billing/refunds" },
        {}
      )
    );
    expect(text).toContain("no_resources");
    expect(text).not.toContain("Refund politely.");
  });

  it("refuses tampered bytes with the expected and actual digests", async () => {
    const manager = await makeManager({ tamper: true });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    });
    const text = String(
      await (wrapped.loadSkill as { execute: Function }).execute(
        { name: "acme-billing/refunds" },
        {}
      )
    );
    expect(text).toContain("digest_mismatch");
    expect(text).toMatch(/expected: sha256:[0-9a-f]{64}/);
    expect(text).toMatch(/actual: sha256:[0-9a-f]{64}/);
    expect(text).not.toContain("Refund politely.");
  });
});

describe("withServerSkills — file reads", () => {
  it("lists the manifest and reads a listed file", async () => {
    const manager = await makeManager();
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    });
    const listed = String(
      await (wrapped.listSkillFiles as { execute: Function }).execute(
        { name: "acme-billing/refunds" },
        {}
      )
    );
    expect(listed).toContain(FILE_URI);

    const read = String(
      await (wrapped.readSkillFile as { execute: Function }).execute(
        { name: "acme-billing/refunds", path: FILE_URI },
        {}
      )
    );
    expect(read).toContain("print('refund')");
  });

  it("refuses an UNLISTED file even when the server would serve it", async () => {
    const unlisted = "skill://acme/refunds/secrets.env";
    const manager = await makeManager({ serveUnlisted: unlisted });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    });
    const text = String(
      await (wrapped.readSkillFile as { execute: Function }).execute(
        { name: "acme-billing/refunds", path: unlisted },
        {}
      )
    );
    expect(text).toContain("unlisted_resource");
    expect(text).not.toContain("hunter2");
    // The refusal happens BEFORE the fetch — the manifest is the allowlist,
    // so a server answering is not permission.
    expect(manager.calls).not.toContain(`resources/read:${unlisted}`);
  });

  it("delegates file tools for a base-source skill", async () => {
    const base = baseTools();
    const manager = await makeManager();
    const wrapped = withServerSkills(base, { manager, servers: SERVERS });
    expect(
      await (wrapped.listSkillFiles as { execute: Function }).execute(
        { name: "local-skill" },
        {}
      )
    ).toBe("BASE FILES");
    expect(
      await (wrapped.readSkillFile as { execute: Function }).execute(
        { name: "local-skill", path: "x.py" },
        {}
      )
    ).toBe("BASE FILE");
  });
});

describe("serverSkillBanner", () => {
  it("names the captured version when serving a pinned capture", () => {
    const banner = serverSkillBanner({
      ref: "acme/refunds",
      serverLabel: "Acme",
      skillUri: SKILL_URI,
      captured: { versionNumber: 3, capturedAt: Date.UTC(2026, 7, 3) },
    });
    expect(banner).toContain("captured v3 on 2026-08-03");
  });
});
