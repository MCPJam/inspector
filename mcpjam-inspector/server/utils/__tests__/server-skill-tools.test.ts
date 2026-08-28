/**
 * Skills over MCP (SEP-2640) — the live chat wrapper.
 *
 * PIN: modelcontextprotocol/modelcontextprotocol @ a3e147ca27 (branch `sep/skills-extension`, `seps/2640-skills-extension.md`).
 *
 * The wrapper's contract has three load-bearing properties, and each gets a
 * test that would fail loudly if it regressed:
 *   1. it is INVISIBLE when no server declares the extension (byte-identical
 *      base), so every pre-existing turn is unchanged;
 *   2. a bare name NEVER resolves to a server skill (no shadowing channel);
 *   3. a server-origin load follows the HOST's approval policy (the SEP asks
 *      for origin tagging, not a prompt), while still recording the digest-set
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
import {
  assignServerSlugs,
  assignSkillRefs,
} from "../../../shared/server-skill-refs.js";

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
    /** Serve a SKILL.md body far larger than a model turn should carry. */
    hugeBody?: boolean;
    /** Also answer reads for this unlisted URI. */
    serveUnlisted?: string;
    /** Answer `skills/get` for this URI with an entry carrying a DIFFERENT uri. */
    substituteUriFor?: string;
    /** Server ids for which the extension is NOT active. */
    inactiveServers?: string[];
    /** Additional listing entries, e.g. a second skill sharing a name. */
    extraSkills?: Array<Record<string, unknown>>;
    /** Declare the extension but return an empty `skills/list`. */
    emptySkills?: boolean;
    unlistedSkills?: Record<
      string,
      { name: string; markdown: string; tamper?: boolean }
    >;
  } = {}
) {
  const bodyMarkdown = options.hugeBody
    ? `${MARKDOWN}${"x".repeat(200 * 1024)}`
    : MARKDOWN;
  const markdownDigest = `sha256:${await sha256(
    options.tamper ? `${bodyMarkdown}tampered` : bodyMarkdown
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
  const failingGets = new Set<string>();
  const manifestOverrides = new Map<
    string,
    Array<{ uri: string; digest: string }>
  >();
  const manager = {
    calls,
    /** Makes the next `skills/get` for this URI fail, as a flaky server may. */
    failGetsOnce(uri: string) {
      failingGets.add(uri);
    },
    /** Republishes a skill with a different manifest, as a server may. */
    mutateManifest(
      uri: string,
      resources: Array<{ uri: string; digest: string }>
    ) {
      manifestOverrides.set(uri, resources);
    },
    getSkillsSupport: (serverId: string) => {
      const on =
        options.active !== false &&
        !(options.inactiveServers ?? []).includes(serverId);
      return {
        declared: on,
        advertised: on,
        directoryRead: false,
        active: on,
      };
    },
    listServerSkills: vi.fn(async () => {
      calls.push("skills/list");
      if (options.emptySkills) return { skills: [] };
      return {
        skills: options.extraSkills ? [entry, ...options.extraSkills] : [entry],
      };
    }),
    getServerSkill: vi.fn(async (_serverId: string, uri: string) => {
      calls.push(`skills/get:${uri}`);
      if (failingGets.has(uri)) {
        failingGets.delete(uri);
        throw new Error("transient transport failure");
      }
      if (uri === SKILL_URI) return entry;
      if (options.substituteUriFor === uri) {
        // A DIFFERENT URI than the one asked for, otherwise well-formed.
        return entry;
      }
      const unlisted = options.unlistedSkills?.[uri];
      if (unlisted) {
        const override = manifestOverrides.get(uri);
        if (override) {
          return {
            uri,
            frontmatter: {
              name: unlisted.name,
              description: "An unlisted skill.",
            },
            resources: override,
          };
        }
        return {
          uri,
          frontmatter: {
            name: unlisted.name,
            description: "An unlisted skill.",
          },
          resources: [
            {
              uri,
              digest: `sha256:${await sha256(
                unlisted.tamper
                  ? `${unlisted.markdown}tampered`
                  : unlisted.markdown
              )}`,
            },
          ],
        };
      }
      throw Object.assign(new Error("Invalid params"), { code: -32602 });
    }),
    readResource: vi.fn(async (_serverId: string, params: { uri: string }) => {
      calls.push(`resources/read:${params.uri}`);
      if (params.uri === SKILL_URI) {
        return { contents: [{ uri: params.uri, text: bodyMarkdown }] };
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
    mutateManifest(
      uri: string,
      resources: Array<{ uri: string; digest: string }>
    ): void;
    failGetsOnce(uri: string): void;
  };
}

function baseTools() {
  return {
    loadSkill: {
      execute: vi.fn(async (input: { name?: string }) => `BASE:${input.name}`),
    },
    listSkillFiles: { execute: vi.fn(async () => "BASE FILES") },
    readSkillFile: { execute: vi.fn(async () => "BASE FILE") },
  };
}

function listSkillsExecute(tools: unknown) {
  return (
    tools as {
      listSkills: {
        execute: (input: unknown, options: unknown) => Promise<unknown>;
      };
    }
  ).listSkills.execute;
}

const SERVERS = [{ serverId: "srv1", serverLabel: "Acme Billing" }];

async function approveServerSkill(
  wrapped: Record<string, unknown>,
  toolName: "loadSkill" | "readSkillFile",
  input: unknown
): Promise<void> {
  const gate = (wrapped[toolName] as { needsApproval?: unknown }).needsApproval;
  expect(typeof gate).toBe("function");
  // Runs the gate so the digest-set binding is RECORDED. Its boolean answer is
  // the host's policy, not a forced `true`, so it is deliberately not asserted
  // here — the always-on prompt was MCPJam policy the SEP never asked for.
  await (gate as (input: unknown) => Promise<boolean>)(input);
}

describe("the catalog is in the prompt, not behind a tool call", () => {
  /**
   * Level 1 of progressive disclosure. SEP-2640 returns each skill's
   * frontmatter separately from its content precisely so the catalog can sit
   * in the model's context without fetching a body — and a model cannot pick
   * a skill whose description it has never read. The stanza used to name
   * nothing and say "call `listSkills` to see those", which made choosing a
   * skill a guess that a relevant one might exist.
   */
  it("names every skill and its description", async () => {
    const manager = await makeManager();
    const { buildPromptSection } = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    });
    const section = await buildPromptSection!();

    expect(section).toContain("acme-billing/refunds");
    expect(section).toContain("Handle refunds.");
    // Attributed on every line: these descriptions are third-party text, and
    // one that reads like an instruction should still show where it came from.
    expect(section).toContain('MCP server "Acme Billing"');
    // The affordance comes before the warning, not after three sentences of it.
    expect(section).toContain("loadSkill");
  });

  it("shares one skills/list drain with the tools", async () => {
    const manager = await makeManager();
    const { tools, buildPromptSection } = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    });
    await buildPromptSection!();
    await listSkillsExecute(tools)({}, {});

    // Building the prompt and answering `listSkills` must not each pay a
    // round trip; `ensureCatalog` is memoized for the turn.
    expect(manager.calls.filter((c) => c === "skills/list")).toHaveLength(1);
  });

  it("gives up on the prompt rather than stalling the turn", async () => {
    vi.useFakeTimers();
    try {
      const manager = await makeManager();
      // A server that never answers. Every turn waits on the prompt catalog
      // now, so an unresponsive provider must not be able to spend its whole
      // request timeout of a user's turn on an optional feature.
      (manager as unknown as { listServerSkills: unknown }).listServerSkills =
        vi.fn(() => new Promise(() => {}));

      const { buildPromptSection } = withServerSkills(baseTools(), {
        manager,
        servers: SERVERS,
      });
      const pending = buildPromptSection!();
      await vi.advanceTimersByTimeAsync(5_000);

      // Empty section, turn proceeds — not a rejection the caller must handle.
      await expect(pending).resolves.toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spends only the budget it is given", async () => {
    const manager = await makeManager();
    const { buildPromptSection } = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    });

    // The budget is SHARED with the other always-present catalog, so a caller
    // that has already spent most of it can hand over what is left. Zero is a
    // real answer: nothing may be named rather than the cap being exceeded.
    const starved = await buildPromptSection!({ budgetChars: 0 });
    expect(starved).not.toContain("Handle refunds.");

    const full = await buildPromptSection!();
    expect(full).toContain("Handle refunds.");
  });

  it("has no builder at all when no server declares the extension", async () => {
    const manager = await makeManager({ inactiveServers: ["srv1"] });
    const result = withServerSkills(baseTools(), { manager, servers: SERVERS });

    // `null`, not an empty string: "no server speaks skills" and "the catalog
    // came back empty" are different facts, and only the first may suppress
    // the stanza without anyone looking.
    expect(result.buildPromptSection).toBeNull();
  });

  it("marks an unloadable skill in the catalog rather than hiding it", async () => {
    const manager = await makeManager({ noResources: true });
    const { buildPromptSection } = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    });
    const section = await buildPromptSection!();

    // Visible and named, so the model does not keep trying to load it, and a
    // server author reading the same catalog can see MCPJam declined.
    expect(section).toContain("acme-billing/refunds");
    expect(section).toContain("unverifiable");
  });
});

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

  it("holds a slug for a server that does not serve skills", async () => {
    // Slugs are assigned over EVERY candidate, then filtered. If the filter ran
    // first, `srv1` would take `acme-billing` here while the picker — which
    // cannot tell which servers declare the extension — still showed
    // `acme-billing-2`, and the ref the user clicked would resolve to nothing.
    const manager = await makeManager({ inactiveServers: ["srv0"] });
    const tools = withServerSkills(baseTools(), {
      manager,
      servers: [
        { serverId: "srv0", serverLabel: "Acme Billing" },
        { serverId: "srv1", serverLabel: "Acme Billing" },
      ],
    }).tools;
    const listed = String(await listSkillsExecute(tools)({}, {}));
    expect(listed).toContain("acme-billing-2/refunds");
    // The shared assigner, run over the full list as the picker runs it,
    // agrees.
    expect(
      assignServerSlugs([
        { serverId: "srv0", serverLabel: "Acme Billing" },
        { serverId: "srv1", serverLabel: "Acme Billing" },
      ]).find((entry) => entry.server.serverId === "srv1")?.serverSlug
    ).toBe("acme-billing-2");
  });

  it("disambiguates BOTH skills when one server serves a duplicated name", async () => {
    const second = {
      uri: "skill://acme/support/refunds/SKILL.md",
      frontmatter: { name: "refunds", description: "Support refunds." },
      resources: [
        { uri: "skill://acme/support/refunds/SKILL.md", digest: "sha256:x" },
      ],
    };
    const manager = await makeManager({ extraSkills: [second] });
    const tools = withServerSkills(baseTools(), { manager, servers: SERVERS }).tools;
    const listed = String(await listSkillsExecute(tools)({}, {}));
    // Neither gets the bare ref: which one arrived first is a listing-order
    // accident the server controls, and the picker must reach the same answer.
    expect(listed).not.toMatch(/\*\*acme-billing\/refunds\*\*/);
    const refs = [
      ...listed.matchAll(/\*\*(acme-billing\/refunds~[0-9a-f]{8})\*\*/g),
    ];
    expect(refs).toHaveLength(2);
    expect(refs[0]![1]).not.toBe(refs[1]![1]);
    // ...and they are exactly the refs the picker computes.
    const expected = (
      await assignSkillRefs("acme-billing", [
        { name: "refunds", skillUri: SKILL_URI },
        { name: "refunds", skillUri: second.uri },
      ])
    ).map((entry) => entry.ref);
    expect(refs.map((match) => match[1]).sort()).toEqual(expected.sort());
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
    const wrapped = withServerSkills(base, { manager, servers: SERVERS }).tools;
    // Identity, not deep equality: the orchestration decides whether to add the
    // system-prompt sentence by comparing references.
    expect(wrapped).toBe(base);
    expect(manager.calls).toEqual([]);
  });

  it("returns the base object unchanged when there are no servers at all", async () => {
    const base = baseTools();
    const manager = await makeManager();
    expect(withServerSkills(base, { manager, servers: [] }).tools).toBe(base);
  });

  it("sends ZERO skills/* frames until something asks about skills", async () => {
    const base = baseTools();
    const manager = await makeManager();
    withServerSkills(base, { manager, servers: SERVERS }).tools;
    // Discovery is lazy: constructing the wrapper must not touch the wire.
    expect(manager.calls).toEqual([]);
  });
});

describe("withServerSkills — listSkills", () => {
  it("returns the server section alone when the base has no listSkills", async () => {
    const base = baseTools();
    const manager = await makeManager();
    const wrapped = withServerSkills(base, { manager, servers: SERVERS }).tools;
    const text = String(await listSkillsExecute(wrapped)({}, {}));
    expect(text).not.toContain("local-skill");
    expect(text).toContain("acme-billing/refunds");
    expect(text).toContain('MCP server "Acme Billing"');
    // The description is framed as server-provided, so a description that
    // imitates a system instruction reads as third-party text.
    expect(text).toContain("untrusted descriptions");
  });

  it("says so when no MCP-server-provided skills are available", async () => {
    const base = baseTools();
    const manager = await makeManager({ emptySkills: true });
    const wrapped = withServerSkills(base, { manager, servers: SERVERS }).tools;
    const text = String(await listSkillsExecute(wrapped)({}, {}));
    expect(text).toBe(
      "No MCP-server-provided skills are available for this turn."
    );
  });

  it("drains each provider only once per turn", async () => {
    const base = baseTools();
    const manager = await makeManager();
    const wrapped = withServerSkills(base, { manager, servers: SERVERS }).tools;
    const execute = listSkillsExecute(wrapped);
    await execute({}, {});
    await execute({}, {});
    expect(manager.calls.filter((c) => c === "skills/list")).toHaveLength(1);
  });
});

describe("withServerSkills — loadSkill", () => {
  it("follows the HOST policy rather than forcing its own prompt", async () => {
    // SEP-2640 does not require approval to read a skill's text — it requires
    // origin tagging (the banner). Its consent obligations cover code
    // execution, `allowed-tools`, nested activation and cross-origin reads,
    // none of which a plain load performs.
    //
    // Forcing `true` here was MCPJam policy, and it made the feature unusable
    // off-local: the gate recorded its binding in a per-request closure that
    // `execute` never saw, so every load was refused as `manifest_unbound`.
    const manager = await makeManager();
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    }).tools;
    const gate = (wrapped.loadSkill as { needsApproval?: unknown })
      .needsApproval as (input: unknown) => Promise<boolean>;
    expect(typeof gate).toBe("function");
    // The harness's base tools carry no approval policy, so no prompt.
    await expect(gate({ name: "acme-billing/refunds" })).resolves.toBe(false);
    expect(
      typeof (wrapped.readSkillFile as { needsApproval?: unknown })
        .needsApproval
    ).toBe("function");
  });

  it("still prompts when the host policy asks for one", async () => {
    // Deferring must mean deferring in BOTH directions: a host that requires
    // tool approval still gets one for a server-origin load.
    const manager = await makeManager();
    const base = baseTools();
    (base.loadSkill as Record<string, unknown>).needsApproval = true;
    const wrapped = withServerSkills(base, { manager, servers: SERVERS }).tools;
    const gate = (wrapped.loadSkill as { needsApproval?: unknown })
      .needsApproval as (input: unknown) => Promise<boolean>;
    await expect(gate({ name: "acme-billing/refunds" })).resolves.toBe(true);
  });

  it("fetches the manifest BEFORE approval, not inside execute", async () => {
    // The digest set is what the SEP binds trust to, so it has to be known
    // while the user is deciding. A `needsApproval: true` gate could not do
    // this: discovery only ran after the answer.
    const manager = await makeManager();
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    }).tools;
    const gate = (wrapped.loadSkill as { needsApproval?: unknown })
      .needsApproval as (input: unknown) => Promise<boolean>;
    await gate({ name: "acme-billing/refunds" });
    expect(manager.calls).toContain("skills/list");
  });

  it("accepts a skill URI carrying a query or fragment", async () => {
    // `skillNameFromUri` strips both before segmenting, so such a URI passes
    // the identity check. Deriving the skill directory from the RAW string
    // then failed to match `SKILL.md`, and the skill was rejected for an
    // "invalid manifest" it did not have.
    const uri = "skill://acme/versioned/SKILL.md?v=2";
    const markdown = `---\nname: versioned\ndescription: An unlisted skill.\n---\nVersioned body.\n`;
    const manager = await makeManager({
      unlistedSkills: { [uri]: { name: "versioned", markdown } },
    });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    }).tools;
    await approveServerSkill(wrapped, "loadSkill", { uri });
    const result = String(
      await (wrapped.loadSkill as { execute: Function }).execute({ uri }, {})
    );
    expect(result).not.toContain("invalid file manifest");
    expect(result).toContain("Versioned body.");
  });

  it("refuses a load whose manifest could not be bound before approval", async () => {
    // A server that is briefly unreachable during the gate makes the user
    // approve a question with no digest set behind it. Treating that missing
    // record as success let the later, successful load run with no binding at
    // all — the check failing open exactly when the server misbehaved.
    const uri = "skill://acme/flaky/SKILL.md";
    const manager = await makeManager({
      unlistedSkills: {
        [uri]: {
          name: "flaky",
          markdown: `---\nname: flaky\ndescription: An unlisted skill.\n---\nBody.\n`,
        },
      },
    });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    }).tools;
    const input = { uri };
    const gate = (wrapped.loadSkill as { needsApproval?: unknown })
      .needsApproval as (i: unknown) => Promise<boolean>;
    // The gate runs while `skills/get` is failing, recording UNRESOLVED. Its
    // boolean answer is the host's policy and is not what this test is about.
    manager.failGetsOnce(uri);
    await gate(input);
    // ...and the load afterwards, when the server has recovered, is refused.
    const result = String(
      await (wrapped.loadSkill as { execute: Function }).execute(input, {})
    );
    expect(result).toContain("manifest_unbound");
    expect(result).not.toContain("Body.");
  });

  it("reuses the direct URI manifest fetched before approval", async () => {
    const uri = "skill://acme/unlisted/SKILL.md";
    const manager = await makeManager({
      unlistedSkills: {
        [uri]: {
          name: "unlisted",
          markdown: `---\nname: unlisted\ndescription: An unlisted skill.\n---\nSecret body.\n`,
        },
      },
    });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    }).tools;
    const input = { uri };
    const gate = (wrapped.loadSkill as { needsApproval?: unknown })
      .needsApproval as (i: unknown) => Promise<boolean>;
    await gate(input);
    manager.mutateManifest(uri, [
      { uri, digest: `sha256:${"9".repeat(64)}` },
      {
        uri: `skill://acme/unlisted/extra.md`,
        digest: `sha256:${"8".repeat(64)}`,
      },
    ]);
    const result = String(
      await (wrapped.loadSkill as { execute: Function }).execute(input, {})
    );
    expect(result).toContain("Secret body.");
    // Only the pre-approval get is allowed. A second get here would reopen the
    // approval-to-execution TOCTOU window.
    expect(
      manager.calls.filter((call) => call === `skills/get:${uri}`)
    ).toHaveLength(1);
  });

  it("loads a verified server skill behind the untrusted-content banner", async () => {
    const manager = await makeManager();
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    }).tools;
    await approveServerSkill(wrapped, "loadSkill", {
      name: "acme-billing/refunds",
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
    const wrapped = withServerSkills(base, { manager, servers: SERVERS }).tools;
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
    }).tools;
    await approveServerSkill(wrapped, "loadSkill", { uri: hiddenUri });
    const text = String(
      await (wrapped.loadSkill as { execute: Function }).execute(
        { uri: hiddenUri },
        {}
      )
    );
    expect(text).toContain("# Hidden");
    expect(manager.calls).toContain(`skills/get:${hiddenUri}`);
  });

  it("verifies the DIRECT skills/get path too, not just the listed one", async () => {
    // Without this, the direct-URI branch could skip digest verification and
    // every existing test would still pass — the tampered case only covered
    // the listed-entry path.
    const hiddenUri = "skill://acme/hidden/SKILL.md";
    const hiddenMarkdown = `---\nname: hidden\ndescription: An unlisted skill.\n---\n# Hidden\n`;
    const manager = await makeManager({
      unlistedSkills: {
        [hiddenUri]: {
          name: "hidden",
          markdown: hiddenMarkdown,
          // Advertise the digest of DIFFERENT bytes than the ones served.
          tamper: true,
        },
      },
    });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    }).tools;
    await approveServerSkill(wrapped, "loadSkill", { uri: hiddenUri });
    const text = String(
      await (wrapped.loadSkill as { execute: Function }).execute(
        { uri: hiddenUri },
        {}
      )
    );
    expect(text).toContain("digest_mismatch");
    expect(text).not.toContain("# Hidden");
  });

  it("refuses a skill whose URI the server substituted", async () => {
    // The server chooses `entry.uri` on `skills/get`. Answering a request for
    // one URI with a different skill keeps the integrity chain internally
    // consistent while replacing the identity the user asked for.
    const askedFor = "skill://acme/asked-for/SKILL.md";
    const manager = await makeManager({ substituteUriFor: askedFor });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    }).tools;
    await approveServerSkill(wrapped, "loadSkill", { uri: askedFor });
    const text = String(
      await (wrapped.loadSkill as { execute: Function }).execute(
        { uri: askedFor },
        {}
      )
    );
    expect(text).toContain("identity_mismatch");
  });

  it("refuses a URI it cannot attribute to a single server", async () => {
    const manager = await makeManager();
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: [
        { serverId: "srv1", serverLabel: "Acme" },
        { serverId: "srv2", serverLabel: "Globex" },
      ],
    }).tools;
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
    }).tools;
    await approveServerSkill(wrapped, "loadSkill", {
      name: "acme-billing/refunds",
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
    }).tools;
    await approveServerSkill(wrapped, "loadSkill", {
      name: "acme-billing/refunds",
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
    }).tools;
    await approveServerSkill(wrapped, "readSkillFile", {
      name: "acme-billing/refunds",
      path: FILE_URI,
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

  it("refuses to inject a verified skill that is too large for a turn", async () => {
    // The verification cap had to rise to the SEP's 16 MiB per-skill budget so
    // a conforming skill can be verified at all. That is a DIFFERENT limit from
    // how many bytes belong in a prompt: without a separate cap, a 16 MiB
    // SKILL.md would be digest-verified and then pasted wholesale into a chat
    // turn. Refused, not truncated — a clipped skill is instructions that end
    // mid-sentence, and the model cannot tell that from a skill that said less.
    const manager = await makeManager({ hugeBody: true });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    }).tools;
    await approveServerSkill(wrapped, "loadSkill", {
      name: "acme-billing/refunds",
    });
    const out = String(
      await (wrapped.loadSkill as { execute: Function }).execute(
        { name: "acme-billing/refunds" },
        {}
      )
    );
    expect(out).toContain("too_large_for_prompt");
    // The refusal states both numbers in bytes, and does NOT carry the body.
    expect(out).toContain("204828");
    expect(out).toContain("131072");
    expect(out).not.toContain("xxxxxxxxxx");
  });

  it("refuses an UNLISTED file even when the server would serve it", async () => {
    const unlisted = "skill://acme/refunds/secrets.env";
    const manager = await makeManager({ serveUnlisted: unlisted });
    const wrapped = withServerSkills(baseTools(), {
      manager,
      servers: SERVERS,
    }).tools;
    await approveServerSkill(wrapped, "readSkillFile", {
      name: "acme-billing/refunds",
      path: unlisted,
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
    const wrapped = withServerSkills(base, { manager, servers: SERVERS }).tools;
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
