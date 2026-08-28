/**
 * `io.modelcontextprotocol/skills` (SEP-2640) driven against the raw HTTP
 * fixture in `support/skills-fixture.ts`, through the REAL `MCPClientManager`
 * — negotiation, capability declaration, `skills/list` drain, `skills/get`,
 * and `resources/read`-backed verification.
 *
 * PIN: modelcontextprotocol/modelcontextprotocol @ a3e147ca27 (branch `sep/skills-extension`, `seps/2640-skills-extension.md`).
 */

import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import type {
  ClientCapabilityOptions,
  McpProtocolVersion,
} from "../src/mcp-client-manager/index.js";
import { listAllServerSkills } from "../src/operations.js";
import {
  MCP_SKILLS_EXTENSION_ID,
  withSkillsExtensionCapability,
  getDefaultClientCapabilities,
  enumeratedResources,
  isListedResource,
  isMCPSkillsWireError,
  isSkillNotFoundError,
  verifySkillMarkdown,
  findListedResource,
  verifyDigest,
} from "../src/mcp-client-manager/index.js";
import {
  DEFAULT_FIXTURE_SKILLS,
  startSkillsFixture,
  type SkillsFixtureHandle,
  type SkillsFixtureOptions,
} from "./support/skills-fixture.js";

const SERVER_ID = "skills";

const opened: {
  managers: MCPClientManager[];
  fixtures: SkillsFixtureHandle[];
} = { managers: [], fixtures: [] };

afterEach(async () => {
  for (const manager of opened.managers.splice(0)) {
    await manager.disconnectAllServers().catch(() => {});
  }
  for (const fixture of opened.fixtures.splice(0)) {
    await fixture.close().catch(() => {});
  }
});

async function serve(
  options: SkillsFixtureOptions = {}
): Promise<SkillsFixtureHandle> {
  const fixture = await startSkillsFixture(options);
  opened.fixtures.push(fixture);
  return fixture;
}

/**
 * Connects with the extension advertised — i.e. as the MCPJam client, which
 * ships the SEP-2640 fulfiller. `declare: false` connects as any other host
 * persona, which is the suppression case.
 */
async function connect(
  url: string,
  options: { declare?: boolean; protocolVersion?: McpProtocolVersion } = {}
): Promise<MCPClientManager> {
  const manager = new MCPClientManager();
  opened.managers.push(manager);
  const base = getDefaultClientCapabilities() as Record<string, unknown>;
  await manager.connectToServer(SERVER_ID, {
    url,
    timeout: 10_000,
    ...(options.protocolVersion
      ? { mcpProtocolVersion: options.protocolVersion }
      : {}),
    clientCapabilities: (options.declare === false
      ? base
      : withSkillsExtensionCapability(base)) as ClientCapabilityOptions,
  });
  return manager;
}

describe("capability negotiation", () => {
  it("reports active only when both sides declare", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    expect(manager.getSkillsSupport(SERVER_ID)).toMatchObject({
      declared: true,
      advertised: true,
      active: true,
      directoryRead: false,
    });
  });

  it("surfaces the server's directoryRead opt-in", async () => {
    const fixture = await serve({ directoryRead: true });
    const manager = await connect(fixture.url);
    expect(manager.getSkillsSupport(SERVER_ID).directoryRead).toBe(true);
  });

  /**
   * Where the declaration rides depends on the era: the 2026 wire carries the
   * client capabilities in the `server/discover` `_meta` envelope, the legacy
   * one in `initialize`'s `params.capabilities`. Both are read here so the
   * assertion is about the DECLARATION, not about one era's framing.
   */
  function declaredExtensions(
    fixture: SkillsFixtureHandle
  ): Record<string, unknown> | undefined {
    for (const entry of fixture.received) {
      const fromInitialize = (
        entry.params?.capabilities as
          | { extensions?: Record<string, unknown> }
          | undefined
      )?.extensions;
      if (fromInitialize) return fromInitialize;
      const envelope = (
        entry.params?._meta as Record<string, unknown> | undefined
      )?.["io.modelcontextprotocol/clientCapabilities"] as
        | { extensions?: Record<string, unknown> }
        | undefined;
      if (envelope?.extensions) return envelope.extensions;
    }
    return undefined;
  }

  for (const version of ["2025-06-18", "2026-07-28"] as const) {
    it(`puts the declaration on the ${version} handshake`, async () => {
      const fixture = await serve({ supportedVersions: [version] });
      await connect(fixture.url, { protocolVersion: version });
      expect(declaredExtensions(fixture)?.[MCP_SKILLS_EXTENSION_ID]).toEqual(
        {}
      );
    });

    it(`omits the declaration on ${version} when the host does not opt in`, async () => {
      const fixture = await serve({ supportedVersions: [version] });
      await connect(fixture.url, { declare: false, protocolVersion: version });
      expect(
        declaredExtensions(fixture)?.[MCP_SKILLS_EXTENSION_ID]
      ).toBeUndefined();
    });
  }
});

describe("suppression — advertise = enforce", () => {
  it("sends ZERO skills/* frames when the client did not declare", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url, { declare: false });

    expect(manager.getSkillsSupport(SERVER_ID).active).toBe(false);
    const error = await manager
      .listServerSkills(SERVER_ID)
      .catch((e: unknown) => e);
    expect(isMCPSkillsWireError(error)).toBe(true);
    // The refusal happens BEFORE the wire — that is the product claim.
    expect(fixture.methods()).not.toContain("skills/list");
  });

  it("refuses when the server does not declare, without probing", async () => {
    const fixture = await serve({ misbehavior: { hideExtension: true } });
    const manager = await connect(fixture.url);
    await expect(
      manager.getServerSkill(SERVER_ID, "skill://x")
    ).rejects.toThrow(/did not declare/);
    expect(fixture.methods()).not.toContain("skills/get");
  });

  it("refuses resources/directory/read when the server did not opt in", async () => {
    const fixture = await serve({ directoryRead: false });
    const manager = await connect(fixture.url);
    await expect(
      manager.readServerResourceDirectory(SERVER_ID, { uri: "skill://a" })
    ).rejects.toThrow(/resources\/directory\/read/);
    expect(fixture.methods()).not.toContain("resources/directory/read");
  });
});

describe("skills/list", () => {
  it("returns entries with verbatim frontmatter and a resource manifest", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const page = await manager.listServerSkills(SERVER_ID);
    expect(page.skills).toHaveLength(DEFAULT_FIXTURE_SKILLS.length);
    const greeting = page.skills.find((s) => s.uri.includes("greeting"))!;
    expect(greeting.frontmatter).toMatchObject({ name: "greeting" });
    expect(greeting.resources?.[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("preserves SEP-2549 ttlMs/cacheScope through the drain", async () => {
    const fixture = await serve({
      listTtlMs: 30_000,
      listCacheScope: "session",
    });
    const manager = await connect(fixture.url);
    const result = await listAllServerSkills(manager, { serverId: SERVER_ID });
    expect(result).toMatchObject({ ttlMs: 30_000, cacheScope: "session" });
  });

  it("drains across pages", async () => {
    const fixture = await serve({ pageSize: 1 });
    const manager = await connect(fixture.url);
    const result = await listAllServerSkills(manager, { serverId: SERVER_ID });
    expect(result.skills).toHaveLength(DEFAULT_FIXTURE_SKILLS.length);
    expect(result.duplicateUris).toEqual([]);
  });

  it("reports duplicate URIs rather than letting last-in win", async () => {
    const fixture = await serve({ misbehavior: { duplicateUris: true } });
    const manager = await connect(fixture.url);
    const result = await listAllServerSkills(manager, { serverId: SERVER_ID });
    // BOTH copies survive so a caller can show what was sent; the capture
    // path rejects both rather than resolving a self-contradictory listing.
    expect(result.skills).toHaveLength(DEFAULT_FIXTURE_SKILLS.length * 2);
    expect(result.duplicateUris.sort()).toHaveLength(
      DEFAULT_FIXTURE_SKILLS.length
    );
  });

  it("refuses a listing with a malformed entry", async () => {
    const fixture = await serve({ misbehavior: { malformedEntry: true } });
    const manager = await connect(fixture.url);
    await expect(manager.listServerSkills(SERVER_ID)).rejects.toThrow(
      /io\.modelcontextprotocol\/skills payload/
    );
  });

  // A repeated cursor is FOLLOWED, not treated as an ending: MCP 2026-07-28
  // `server/utilities/pagination` forbids reading anything off a cursor's
  // value beyond whether one was provided, and comparing two cursors for
  // equality is exactly that — a server may legally reissue one constant token
  // for every page. The page cap is the bound, and it stops the walk loudly
  // rather than handing back a partial listing as if it were whole.
  it("bounds a server that reissues one cursor forever with the page cap, not a cycle check", async () => {
    const fixture = await serve({
      pageSize: 1,
      misbehavior: { repeatCursor: true },
    });
    const manager = await connect(fixture.url);
    await expect(
      listAllServerSkills(manager, { serverId: SERVER_ID })
    ).rejects.toThrow(/Exceeded \d+ pages while draining skills\/list/);
  });
});

describe("skills/get", () => {
  it("serves a skill the listing never mentioned", async () => {
    const fixture = await serve({
      skills: [
        ...DEFAULT_FIXTURE_SKILLS,
        {
          root: "fixture/hidden",
          name: "hidden",
          description: "Only reachable by URI.",
          body: "# Hidden\n",
          unlisted: true,
        },
      ],
    });
    const manager = await connect(fixture.url);
    const listed = await listAllServerSkills(manager, { serverId: SERVER_ID });
    expect(listed.skills.map((s) => s.uri)).not.toContain(
      fixture.uriFor("fixture/hidden")
    );
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/hidden")
    );
    expect(entry.frontmatter).toMatchObject({ name: "hidden" });
  });

  it("answers -32602 for a URI it does not serve", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const error = await manager
      .getServerSkill(SERVER_ID, "skill://fixture/nope/SKILL.md")
      .catch((e: unknown) => e);
    // This answer — not an absent listing entry — is what proves absence.
    expect(isSkillNotFoundError(error)).toBe(true);
  });
});

describe("integrity over the real wire", () => {
  async function fetchMarkdown(
    manager: MCPClientManager,
    uri: string
  ): Promise<string> {
    const read = (await manager.readResource(SERVER_ID, { uri })) as {
      contents: Array<{ text?: string }>;
    };
    return read.contents[0]?.text ?? "";
  }

  it("verifies a conforming skill end to end", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/greeting")
    );
    const markdown = await fetchMarkdown(manager, entry.uri);
    const verified = await verifySkillMarkdown({ entry, markdown });
    expect(verified.frontmatter.name).toBe("greeting");
    expect(verified.body).toContain("Say hello warmly");
  });

  it("refuses a skill whose bytes do not match its digest", async () => {
    const fixture = await serve({
      misbehavior: { digestMismatch: "fixture/greeting" },
    });
    const manager = await connect(fixture.url);
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/greeting")
    );
    const markdown = await fetchMarkdown(manager, entry.uri);
    await expect(
      verifySkillMarkdown({ entry, markdown })
    ).rejects.toMatchObject({ kind: "digest_mismatch" });
  });

  it("refuses a skill whose advertised size does not match the bytes served", async () => {
    // The digest is correct here; only the length is wrong. This is the case
    // the draft calls out as a verification failure in its own right.
    const fixture = await serve({
      misbehavior: { sizeMismatch: "fixture/greeting" },
    });
    const manager = await connect(fixture.url);
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/greeting")
    );
    const markdown = await fetchMarkdown(manager, entry.uri);
    await expect(
      verifySkillMarkdown({ entry, markdown })
    ).rejects.toMatchObject({ kind: "size_mismatch" });
  });

  it("still verifies a server that predates the size field", async () => {
    // `size` is REQUIRED by the draft, but the SEP is unratified and servers
    // built against the earlier text omit it. Refusing them would make MCPJam
    // incompatible with every implementation that exists today; the digest
    // still carries the integrity guarantee.
    const fixture = await serve({ misbehavior: { omitSizes: true } });
    const manager = await connect(fixture.url);
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/greeting")
    );
    expect(
      Array.isArray(entry.resources) ? entry.resources[0]?.size : "not-an-array"
    ).toBeUndefined();
    const markdown = await fetchMarkdown(manager, entry.uri);
    const verified = await verifySkillMarkdown({ entry, markdown });
    expect(verified.frontmatter.name).toBe("greeting");
  });

  it("PARSES a dynamic manifest instead of failing the whole listing", async () => {
    // The regression this pins: `resources` used to be typed as an array
    // only, so a conforming server answering `"dynamic"` produced an
    // InvalidSkillsPayloadError — a wire error, for a form the draft defines.
    // MCPJam still refuses to LOAD such a skill, but that refusal belongs to
    // policy and must be able to name the skill it is refusing.
    const fixture = await serve({ misbehavior: { dynamicResources: true } });
    const manager = await connect(fixture.url);
    const listed = await manager.listServerSkills(SERVER_ID);
    expect(listed.skills.length).toBeGreaterThan(0);
    for (const skill of listed.skills) {
      expect(skill.resources).toBe("dynamic");
    }
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/greeting")
    );
    expect(entry.resources).toBe("dynamic");
  });

  it("authorizes NO reads for a dynamic skill", async () => {
    const fixture = await serve({ misbehavior: { dynamicResources: true } });
    const manager = await connect(fixture.url);
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/greeting")
    );
    // "dynamic" must never be read as "every URI is allowed".
    expect(isListedResource(entry, entry.uri)).toBe(false);
    expect(enumeratedResources(entry)).toBeUndefined();
  });

  it("refuses a skill whose file frontmatter drifted from the listing", async () => {
    const fixture = await serve({
      misbehavior: { frontmatterDrift: "fixture/greeting" },
    });
    const manager = await connect(fixture.url);
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/greeting")
    );
    const markdown = await fetchMarkdown(manager, entry.uri);
    expect(markdown).toContain("(drifted)");

    // The fixture digests the file it actually serves, so the digest PASSES
    // here and the drift check is the only thing that can fail. Pinning
    // `kind` and `field` is what proves the frontmatter comparison ran —
    // asserting on `skillUri` alone would be satisfied by any failure.
    await expect(
      verifySkillMarkdown({ entry, markdown })
    ).rejects.toMatchObject({
      kind: "frontmatter_drift",
      field: "description",
    });
  });

  it("refuses a name that is not the URI's final path segment", async () => {
    const fixture = await serve({
      misbehavior: { uriNameMismatch: "fixture/greeting" },
    });
    const manager = await connect(fixture.url);
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/greeting")
    );
    const markdown = await fetchMarkdown(manager, entry.uri);
    await expect(
      verifySkillMarkdown({ entry, markdown })
    ).rejects.toMatchObject({ kind: "identity_mismatch" });
  });

  it("treats a served-but-unlisted file as a failure, not a fetch", async () => {
    const fixture = await serve({
      misbehavior: {
        serveUnlistedFile: {
          skillRoot: "fixture/reporting",
          path: "secrets.env",
          content: "TOKEN=hunter2\n",
        },
      },
    });
    const manager = await connect(fixture.url);
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/reporting")
    );
    const unlistedUri = "skill://fixture/reporting/secrets.env";
    // The server WILL serve it...
    expect(await fetchMarkdown(manager, unlistedUri)).toContain("hunter2");
    // ...and the HOST-side gate is what refuses. `isListedResource` is the
    // gate every read path consults before fetching, so asserting on it is
    // asserting on the rule, not merely on the fixture's manifest.
    expect(findListedResource(entry, unlistedUri)).toBeUndefined();
    expect(isListedResource(entry, unlistedUri)).toBe(false);
    // A listed file, by contrast, passes the same gate.
    expect(
      isListedResource(entry, "skill://fixture/reporting/scripts/build.py")
    ).toBe(true);
  });

  it("refuses an unsupported digest algorithm", async () => {
    const fixture = await serve({
      misbehavior: { unsupportedDigestAlgorithm: true },
    });
    const manager = await connect(fixture.url);
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/greeting")
    );
    const markdown = await fetchMarkdown(manager, entry.uri);
    await expect(
      verifySkillMarkdown({ entry, markdown })
    ).rejects.toMatchObject({ kind: "unsupported_digest" });
  });

  it("verifies supporting files against their manifest digests", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const entry = await manager.getServerSkill(
      SERVER_ID,
      fixture.uriFor("fixture/reporting")
    );
    const fileUri = "skill://fixture/reporting/scripts/build.py";
    const ref = findListedResource(entry, fileUri);
    expect(ref).toBeDefined();
    const text = await fetchMarkdown(manager, fileUri);
    await expect(
      verifyDigest(new TextEncoder().encode(text), ref!.digest)
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("era blindness", () => {
  // `skills/*` is in NO protocol-version codec, so — unlike the tasks
  // extension — it needs no era-gate shadow and works on a pre-2026 wire.
  for (const version of ["2025-06-18", "2026-07-28"] as const) {
    it(`speaks skills/list on ${version}`, async () => {
      const fixture = await serve({ supportedVersions: [version] });
      const manager = await connect(fixture.url, { protocolVersion: version });
      const page = await manager.listServerSkills(SERVER_ID);
      expect(page.skills.length).toBeGreaterThan(0);
    });
  }
});

describe("resources/directory/read", () => {
  it("lists a skill's directory when the server opted in", async () => {
    const fixture = await serve({ directoryRead: true });
    const manager = await connect(fixture.url);
    const result = await manager.readServerResourceDirectory(SERVER_ID, {
      uri: "skill://fixture/reporting",
    });
    expect(result.resources.map((e) => e.name)).toContain("scripts/build.py");
  });
});
