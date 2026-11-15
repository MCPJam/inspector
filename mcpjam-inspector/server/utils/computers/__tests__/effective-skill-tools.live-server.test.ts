/**
 * MCPJam's agent's skill tools over a live turn's connected servers' skills
 * (SEP-2640): the skill list in the prompt, verified loads by ref and by URI,
 * file reads held to the loaded manifest, and the approval declaration.
 *
 * PIN: modelcontextprotocol/ext-skills @ c1aa87e (`specification/stable/skills.mdx`).
 */
import { describe, expect, it } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  buildLiveEffectiveCapabilities,
  withLiveServerSkills,
  type EffectiveCapabilitySet,
} from "../../../services/environments/effective-capabilities";
import {
  BODY,
  FILE_TEXT,
  FILE_URI,
  MARKDOWN,
  makeServerSkillWire,
  sha256,
  SKILL_URI,
} from "../../../test/support/server-skill-wire";
import { applySkillToolApproval } from "../../chat-v2-orchestration";
import { getEffectiveSkillToolsAndPrompt } from "../effective-skill-tools";
import { listLiveServerSkills } from "../live-server-skills";
import { MAX_SERVER_SKILL_PROMPT_BYTES } from "../server-skill-reads";

const SERVERS = [{ serverId: "srv1", serverLabel: "Acme Billing" }];
const REF = "acme-billing/refunds";

interface SkillTool {
  execute: (input: unknown, options?: unknown) => Promise<unknown>;
  needsApproval?: unknown;
}

/** The turn's skill tools and prompt section, as `prepareChatV2` builds them. */
async function liveTurn(
  wire: MCPClientManager,
  options: {
    servers?: Array<{ serverId: string; serverLabel: string }>;
    own?: EffectiveCapabilitySet;
    modelContextTokens?: number;
  } = {},
) {
  const live = await listLiveServerSkills(wire, options.servers ?? SERVERS);
  if (!live) throw new Error("No selected server declares the extension.");
  const own = options.own ?? buildLiveEffectiveCapabilities({});
  const { tools, systemPromptSection } = getEffectiveSkillToolsAndPrompt(
    withLiveServerSkills(own, live),
    options.modelContextTokens !== undefined
      ? { modelContextTokens: options.modelContextTokens }
      : {},
  );
  const tool = (name: string) => Reflect.get(tools, name) as SkillTool;
  const call = async (name: string, input: unknown, messages: unknown[] = []) =>
    String(await tool(name).execute(input, { toolCallId: "c", messages }));
  return { tools, tool, call, prompt: systemPromptSection };
}

const DEPLOY = {
  skillId: "sk_deploy",
  ref: "deploy",
  name: "deploy",
  description: "Deploy the app.",
  content: "# Deploy",
  aggregateHash: "h",
  files: [
    {
      path: "scripts/go.sh",
      size: 6,
      url: null,
      read: async () => new TextEncoder().encode("echo\n"),
    },
  ],
  channels: [],
};

describe("the skill list in the prompt", () => {
  it("names every server skill with its server and description", async () => {
    const { prompt } = await liveTurn(await makeServerSkillWire());
    expect(prompt).toContain(`**${REF}**`);
    expect(prompt).toContain("Handle refunds.");
    // Attributed on every line: these descriptions are third-party text, and
    // one that reads like an instruction should still show where it came from.
    expect(prompt).toContain('MCP server "Acme Billing"');
    expect(prompt).toContain("loadSkill");
    expect(prompt).toContain("untrusted input");
    expect(prompt).toContain("listSkillFiles");
  });

  it("marks an unloadable skill rather than hiding it", async () => {
    const { prompt } = await liveTurn(
      await makeServerSkillWire({ noResources: true }),
    );
    // Visible and named, so the model does not keep trying to load it, and a
    // server author reading the same list can see MCPJam declined.
    expect(prompt).toContain(`**${REF}**`);
    expect(prompt).toContain("unverifiable");
  });

  it("gives the set's own skills first claim on the budget", async () => {
    // The budget is shared, and a project's own skills should not be pushed
    // out of the prompt by a connected third party's. A model this small has
    // room for one line.
    const { prompt } = await liveTurn(await makeServerSkillWire(), {
      own: buildLiveEffectiveCapabilities({ standaloneSkills: [DEPLOY] }),
      modelContextTokens: 1_000,
    });
    expect(prompt).toContain("**deploy**");
    expect(prompt).not.toContain(`**${REF}**`);
    expect(prompt).toContain("1 more skill could not be listed");
  });

  it("keeps the tools and drops the stanza when a declaring server listed nothing", async () => {
    // A skill URI can reach the model in a server's instructions, and only
    // `loadSkill` resolves one.
    const { tools, prompt } = await liveTurn(
      await makeServerSkillWire({ emptySkills: true }),
    );
    expect(prompt).toBe("");
    expect(Object.keys(tools)).toEqual([
      "loadSkill",
      "listSkillFiles",
      "readSkillFile",
    ]);
  });

  it("lists each server once for the prompt and every tool call after it", async () => {
    const wire = await makeServerSkillWire();
    const { call } = await liveTurn(wire);
    await call("loadSkill", { name: REF });
    await call("listSkillFiles", { name: REF });
    await call("readSkillFile", { name: REF, path: FILE_URI });
    expect(wire.calls.filter((c) => c === "skills/list")).toHaveLength(1);
  });
});

describe("loadSkill", () => {
  it("follows the host's switch rather than forcing its own prompt", async () => {
    // SEP-2640 does not require approval to read a skill's text; it requires
    // origin tagging (the banner). Its consent obligations cover code
    // execution, `allowed-tools`, nested activation and cross-origin reads,
    // none of which a plain load performs.
    const { tools } = await liveTurn(await makeServerSkillWire());
    const ask = (set: Record<string, unknown>, input: unknown) => {
      const declared = (set.loadSkill as SkillTool).needsApproval;
      return typeof declared === "function" ? declared(input) : declared;
    };
    expect(ask(tools, { name: REF })).toBe(false);
    expect(ask(tools, { uri: SKILL_URI })).toBe(false);
    // A host that requires tool approval still gets one for a server's load.
    const switchedOn = applySkillToolApproval(tools, {
      pinned: false,
      requireToolApproval: true,
    });
    expect(ask(switchedOn, { name: REF })).toBe(true);
  });

  it("loads a verified server skill behind the untrusted-content banner", async () => {
    const { call } = await liveTurn(await makeServerSkillWire());
    const text = await call("loadSkill", { name: REF });
    expect(text).toContain(`# Skill: ${REF}`);
    // The wording separates consistency from trust: a hostile server digests
    // its hostile content correctly.
    expect(text).toContain("matched the server-advertised digest");
    expect(text).toContain("not trustworthiness");
    expect(text).toContain("untrusted input");
    expect(text).toMatch(/digest set [0-9a-f]{12}/);
    expect(text).toContain("Refund politely.");
  });

  it("never resolves a BARE NAME to a server skill", async () => {
    // Bare names belong to the set's own skills; a server that could claim
    // one would have a shadowing channel.
    const alone = await liveTurn(await makeServerSkillWire());
    expect(await alone.call("loadSkill", { name: "refunds" })).toBe(
      'Error: Skill "refunds" not found.',
    );
    const beside = await liveTurn(await makeServerSkillWire(), {
      own: buildLiveEffectiveCapabilities({
        standaloneSkills: [
          {
            ...DEPLOY,
            skillId: "sk_r",
            ref: "refunds",
            name: "refunds",
            content: "# Our refunds",
          },
        ],
      }),
    });
    expect(await beside.call("loadSkill", { name: "refunds" })).toContain(
      "# Our refunds",
    );
  });

  it("resolves an UNLISTED skill by URI via skills/get", async () => {
    const hiddenUri = "skill://acme/hidden/SKILL.md";
    const wire = await makeServerSkillWire({
      unlistedSkills: {
        [hiddenUri]: {
          name: "hidden",
          markdown: `---\nname: hidden\ndescription: An unlisted skill.\n---\n# Hidden\n`,
        },
      },
    });
    const { call } = await liveTurn(wire);
    const text = await call("loadSkill", { uri: hiddenUri });
    expect(text).toContain("# Hidden");
    expect(text).toContain('> Origin: MCP server "Acme Billing"');
    expect(wire.calls).toContain(`skills/get:${hiddenUri}`);
  });

  it("accepts a skill URI carrying a query or fragment", async () => {
    // `skillNameFromUri` strips both before segmenting, so such a URI passes
    // the identity check, and the skill directory must be derived the same way.
    const uri = "skill://acme/versioned/SKILL.md?v=2";
    const wire = await makeServerSkillWire({
      unlistedSkills: {
        [uri]: {
          name: "versioned",
          markdown: `---\nname: versioned\ndescription: An unlisted skill.\n---\nVersioned body.\n`,
        },
      },
    });
    const text = await (await liveTurn(wire)).call("loadSkill", { uri });
    expect(text).not.toContain("invalid file manifest");
    expect(text).toContain("Versioned body.");
  });

  it("verifies the DIRECT skills/get path too, not just the listed one", async () => {
    const hiddenUri = "skill://acme/hidden/SKILL.md";
    const wire = await makeServerSkillWire({
      unlistedSkills: {
        [hiddenUri]: {
          name: "hidden",
          markdown: `---\nname: hidden\ndescription: An unlisted skill.\n---\n# Hidden\n`,
          // Advertise the digest of DIFFERENT bytes than the ones served.
          tamper: true,
        },
      },
    });
    const text = await (
      await liveTurn(wire)
    ).call("loadSkill", {
      uri: hiddenUri,
    });
    expect(text).toContain("digest_mismatch");
    expect(text).not.toContain("# Hidden");
  });

  it("refuses a skill whose URI the server substituted", async () => {
    // The server chooses `entry.uri` on `skills/get`. Answering a request for
    // one URI with a different skill keeps the integrity chain internally
    // consistent while replacing the identity the user asked for.
    const askedFor = "skill://acme/asked-for/SKILL.md";
    const wire = await makeServerSkillWire({ substituteUriFor: askedFor });
    const text = await (
      await liveTurn(wire)
    ).call("loadSkill", {
      uri: askedFor,
    });
    expect(text).toContain("identity_mismatch");
  });

  it("refuses a URI it cannot attribute to a single server", async () => {
    const { call } = await liveTurn(await makeServerSkillWire(), {
      servers: [
        { serverId: "srv1", serverLabel: "Acme" },
        { serverId: "srv2", serverLabel: "Globex" },
      ],
    });
    const text = await call("loadSkill", {
      uri: "skill://somewhere/else/SKILL.md",
    });
    // Refuses and says how to disambiguate, rather than guessing a server.
    expect(text).toContain(
      "could not be resolved to a single connected server",
    );
  });

  it("refuses without a hint, and resolves with one, a URI two servers both serve", async () => {
    // The double lists the same entry for every server, so both claim it.
    const { call } = await liveTurn(await makeServerSkillWire(), {
      servers: [
        { serverId: "srv1", serverLabel: "Acme Billing" },
        { serverId: "srv2", serverLabel: "Acme Support" },
      ],
    });
    expect(await call("loadSkill", { uri: SKILL_URI })).toContain(
      "Pass `server`",
    );
    const hinted = await call("loadSkill", {
      uri: SKILL_URI,
      server: "acme-support",
    });
    expect(hinted).toContain('> Origin: MCP server "Acme Support"');
    expect(hinted).toContain(BODY);
  });

  it("refuses a skill with no manifest instead of loading it unverified", async () => {
    const { call } = await liveTurn(
      await makeServerSkillWire({ noResources: true }),
    );
    const text = await call("loadSkill", { name: REF });
    expect(text).toContain("no_resources");
    expect(text).not.toContain("Refund politely.");
  });

  it("refuses tampered bytes with the expected and actual digests", async () => {
    const { call } = await liveTurn(
      await makeServerSkillWire({ tamper: true }),
    );
    const text = await call("loadSkill", { name: REF });
    expect(text).toContain("digest_mismatch");
    expect(text).toMatch(/expected: sha256:[0-9a-f]{64}/);
    expect(text).toMatch(/actual: sha256:[0-9a-f]{64}/);
    expect(text).not.toContain("Refund politely.");
  });

  it("loads a verified skill of 200 KiB, within the spec's per-skill budget", async () => {
    // A host MUST support a skill up to 16 MiB, and support means loading it.
    const { call } = await liveTurn(
      await makeServerSkillWire({ hugeBody: true }),
    );
    const text = await call("loadSkill", { name: REF });
    expect(text).not.toContain("too_large_for_prompt");
    expect(text).toContain("xxxxxxxxxx");
  });

  it("refuses to place a verified skill over the prompt cap in one tool result", async () => {
    // Verification accepts a skill up to the spec's 16 MiB; one tool result
    // does not. Nothing else in the chat pipeline bounds a tool's output.
    const { call } = await liveTurn(
      await makeServerSkillWire({ hugeBody: MAX_SERVER_SKILL_PROMPT_BYTES }),
    );
    const text = await call("loadSkill", { name: REF });
    expect(text).toContain("Error (too_large_for_prompt)");
    expect(text).not.toContain("xxxxxxxxxx");
  });
});

describe("supporting files", () => {
  it("lists the manifest and reads a listed file", async () => {
    const { call } = await liveTurn(await makeServerSkillWire());
    expect(await call("listSkillFiles", { name: REF })).toContain(FILE_URI);
    expect(
      await call("readSkillFile", { name: REF, path: FILE_URI }),
    ).toContain("print('refund')");
  });

  it("resolves a relative reference against the skill root, as a path would", async () => {
    const { call } = await liveTurn(await makeServerSkillWire());
    for (const path of [
      "./scripts/run.py",
      "scripts/../scripts/run.py",
      "scripts//run.py",
    ]) {
      expect(await call("readSkillFile", { name: REF, path }), path).toContain(
        "print('refund')",
      );
    }
    // A reference that climbs above the root is not resolved; it is refused
    // as unlisted, which is the fail-closed answer.
    expect(
      await call("readSkillFile", { name: REF, path: "../../etc/passwd" }),
    ).toContain("unlisted_resource");
  });

  it("tags a supporting file with its origin", async () => {
    const { call } = await liveTurn(await makeServerSkillWire());
    expect(
      await call("readSkillFile", { name: REF, path: FILE_URI }),
    ).toContain('> Origin: MCP server "Acme Billing"');
  });

  it("refuses an UNLISTED file even when the server would serve it", async () => {
    const unlisted = "skill://acme/refunds/secrets.env";
    const wire = await makeServerSkillWire({ serveUnlisted: unlisted });
    const text = await (
      await liveTurn(wire)
    ).call("readSkillFile", {
      name: REF,
      path: unlisted,
    });
    expect(text).toContain("unlisted_resource");
    expect(text).not.toContain("hunter2");
    // The refusal happens BEFORE the fetch: the manifest is the allowlist, so
    // a server answering is not permission.
    expect(wire.calls).not.toContain(`resources/read:${unlisted}`);
  });

  it("answers for the set's own skills exactly as before", async () => {
    const { call } = await liveTurn(await makeServerSkillWire(), {
      own: buildLiveEffectiveCapabilities({ standaloneSkills: [DEPLOY] }),
    });
    expect(await call("listSkillFiles", { name: "deploy" })).toContain(
      "scripts/go.sh",
    );
    expect(
      await call("readSkillFile", { name: "deploy", path: "scripts/go.sh" }),
    ).toContain("echo");
  });

  it("refuses a read when the server changed the manifest since the load", async () => {
    const { call } = await liveTurn(await makeServerSkillWire());
    const loaded = await call("loadSkill", { name: REF });
    const history = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "loadSkill",
            output: { type: "text", value: loaded },
          },
        ],
      },
    ];
    // Same manifest: the current entry is the held entry, so the read runs.
    expect(
      await call("readSkillFile", { name: REF, path: FILE_URI }, history),
    ).toContain("print('refund')");

    // A later request lists a changed manifest: the banner in context names
    // the entry the skill was loaded under, and that is the one that holds.
    const changed = await makeServerSkillWire();
    changed.listServerSkills.mockImplementation(async () => ({
      skills: [
        {
          uri: SKILL_URI,
          frontmatter: { name: "refunds", description: "Handle refunds." },
          resources: [
            { uri: SKILL_URI, digest: `sha256:${await sha256(MARKDOWN)}` },
            { uri: FILE_URI, digest: `sha256:${await sha256(FILE_TEXT)}` },
            {
              uri: "skill://acme/refunds/scripts/new.py",
              digest: `sha256:${"0".repeat(64)}`,
            },
          ],
        },
      ],
    }));
    const later = await liveTurn(changed);
    expect(
      await later.call("readSkillFile", { name: REF, path: FILE_URI }, history),
    ).toContain("manifest_changed");
    expect(changed.calls).not.toContain(`resources/read:${FILE_URI}`);
    expect(
      await later.call("listSkillFiles", { name: REF }, history),
    ).toContain("manifest_changed");
  });
});
