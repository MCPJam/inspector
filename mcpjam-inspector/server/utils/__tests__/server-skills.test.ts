/**
 * Skills over MCP (SEP-2640) — the verified read path's POLICY layer.
 *
 * PIN: modelcontextprotocol/modelcontextprotocol @ a3e147ca27 (branch `sep/skills-extension`, `seps/2640-skills-extension.md`).
 *
 * `server-skills.ts` had no direct test: it was covered only transitively,
 * through the chat wrapper. These cover the decisions that are MCPJam's rather
 * than the SDK's — which server behaviours become which refusal, and where the
 * draft's per-skill limits are enforced.
 *
 * The distinctions under test are all ones a collapsed implementation would
 * pass anyway while telling the user the wrong thing.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MAX_SERVER_SKILL_READ_BYTES,
  getVerifiedServerSkill,
  isServerSkillRefusalError,
  listServerSkillCatalog,
  readVerifiedServerSkillFile,
  type ServerSkillRefusal,
} from "../server-skills.js";
import type { MCPClientManager } from "@mcpjam/sdk";

const SERVER_ID = "srv";
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

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

type Manifest = Array<{ uri: string; digest: string; size?: number }>;

/**
 * A manager double speaking only the three methods this module uses. The wire
 * answers are the input under test, so they are controlled directly rather
 * than mocked off a real client.
 */
async function makeManager(
  options: {
    resources?: Manifest | "dynamic" | undefined;
    /** Serve a SKILL.md longer than the manifest advertises. */
    padMarkdown?: boolean;
    /** Serve a supporting file longer than the manifest advertises. */
    padFile?: boolean;
  } = {}
) {
  const markdown = options.padMarkdown ? `${MARKDOWN}  ` : MARKDOWN;
  const fileText = options.padFile ? `${FILE_TEXT}  ` : FILE_TEXT;

  const defaultManifest: Manifest = [
    {
      uri: SKILL_URI,
      digest: `sha256:${await sha256(markdown)}`,
      size: bytesOf(MARKDOWN),
    },
    {
      uri: FILE_URI,
      digest: `sha256:${await sha256(fileText)}`,
      size: bytesOf(FILE_TEXT),
    },
  ];
  const resources =
    options.resources === undefined && !("resources" in options)
      ? defaultManifest
      : options.resources;

  const entry = {
    uri: SKILL_URI,
    frontmatter: { name: "refunds", description: "Handle refunds." },
    ...(resources === undefined ? {} : { resources }),
  };

  const manager = {
    getSkillsSupport: () => ({
      declared: true,
      advertised: true,
      directoryRead: false,
      active: true,
    }),
    listServerSkills: vi.fn(async () => ({ skills: [entry] })),
    getServerSkill: vi.fn(async (_serverId: string, uri: string) => {
      if (uri === SKILL_URI) return entry;
      const error = new Error("Invalid params") as Error & { code: number };
      error.code = -32602;
      throw error;
    }),
    readResource: vi.fn(async (_serverId: string, args: { uri: string }) => {
      const text =
        args.uri === SKILL_URI
          ? markdown
          : args.uri === FILE_URI
            ? fileText
            : undefined;
      if (text === undefined) throw new Error(`no such resource ${args.uri}`);
      return { contents: [{ uri: args.uri, text, mimeType: "text/markdown" }] };
    }),
  };
  return { manager: manager as unknown as MCPClientManager, entry };
}

async function refusalFrom(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (isServerSkillRefusalError(error)) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("dynamic manifests", () => {
  it("lists a dynamic skill as unloadable rather than dropping it", async () => {
    // A dynamic skill is REAL and a user should see it in the catalog. The
    // refusal belongs to loading, not to discovery.
    const { manager } = await makeManager({ resources: "dynamic" });
    const listing = await listServerSkillCatalog(manager, SERVER_ID);
    expect(listing.rejected).toEqual([]);
    expect(listing.skills).toHaveLength(1);
    expect(listing.skills[0]?.unloadable?.reason).toBe("dynamic_resources");
  });

  it("refuses to LOAD a dynamic skill, naming it as dynamic", async () => {
    const { manager } = await makeManager({ resources: "dynamic" });
    const refusal = await refusalFrom(() =>
      getVerifiedServerSkill(manager, { serverId: SERVER_ID, uri: SKILL_URI })
    );
    expect(refusal.kind).toBe("dynamic_resources");
    expect(refusal.skillUri).toBe(SKILL_URI);
  });

  it("keeps 'dynamic' and 'omitted' as different refusals", async () => {
    // One is a server using a form the draft defines; the other is a server
    // omitting a field the draft requires. Collapsing them would tell a
    // conforming server author their skill is malformed.
    const { manager } = await makeManager({ resources: undefined });
    const refusal = await refusalFrom(() =>
      getVerifiedServerSkill(manager, { serverId: SERVER_ID, uri: SKILL_URI })
    );
    expect(refusal.kind).toBe("no_resources");
  });

  it("authorizes no file reads for a dynamic skill", async () => {
    const { manager } = await makeManager({ resources: "dynamic" });
    const refusal = await refusalFrom(() =>
      readVerifiedServerSkillFile(manager, {
        serverId: SERVER_ID,
        entry: { uri: SKILL_URI, resources: "dynamic" },
        resourceUri: FILE_URI,
      })
    );
    expect(refusal.kind).toBe("unlisted_resource");
  });
});

describe("size verification", () => {
  it("refuses a SKILL.md whose byte length differs from its manifest", async () => {
    const { manager } = await makeManager({ padMarkdown: true });
    const refusal = await refusalFrom(() =>
      getVerifiedServerSkill(manager, { serverId: SERVER_ID, uri: SKILL_URI })
    );
    expect(refusal.kind).toBe("size_mismatch");
    expect(refusal.expected).toBe(String(bytesOf(MARKDOWN)));
    expect(refusal.actual).toBe(String(bytesOf(MARKDOWN) + 2));
  });

  it("refuses a supporting file whose byte length differs", async () => {
    const { manager, entry } = await makeManager({ padFile: true });
    const refusal = await refusalFrom(() =>
      readVerifiedServerSkillFile(manager, {
        serverId: SERVER_ID,
        entry,
        resourceUri: FILE_URI,
      })
    );
    expect(refusal.kind).toBe("size_mismatch");
    expect(refusal.resourceUri).toBe(FILE_URI);
  });

  it("loads normally when the server omitted size", async () => {
    const { manager, entry } = await makeManager({
      resources: [
        { uri: SKILL_URI, digest: `sha256:${await sha256(MARKDOWN)}` },
        { uri: FILE_URI, digest: `sha256:${await sha256(FILE_TEXT)}` },
      ],
    });
    const loaded = await getVerifiedServerSkill(manager, {
      serverId: SERVER_ID,
      uri: SKILL_URI,
    });
    expect(loaded.name).toBe("refunds");
    const file = await readVerifiedServerSkillFile(manager, {
      serverId: SERVER_ID,
      entry,
      resourceUri: FILE_URI,
    });
    expect(file.text).toBe(FILE_TEXT);
  });
});

describe("per-skill limits", () => {
  it("refuses a manifest over the entry limit, saying which limit", async () => {
    // 513 entries — one past what the draft requires hosts to support. The
    // refusal must not read as a containment or malformed-manifest bug.
    const oversized: Manifest = [
      {
        uri: SKILL_URI,
        digest: `sha256:${await sha256(MARKDOWN)}`,
        size: bytesOf(MARKDOWN),
      },
      ...Array.from({ length: 512 }, (_, i) => ({
        uri: `skill://acme/refunds/f${i}.md`,
        digest: `sha256:${"0".repeat(64)}`,
        size: 1,
      })),
    ];
    const { manager } = await makeManager({ resources: oversized });
    const refusal = await refusalFrom(() =>
      getVerifiedServerSkill(manager, { serverId: SERVER_ID, uri: SKILL_URI })
    );
    expect(refusal.kind).toBe("too_many_resources");
    expect(refusal.message).toContain("512");
  });

  it("refuses a manifest whose declared bytes exceed the budget", async () => {
    const { manager } = await makeManager({
      resources: [
        {
          uri: SKILL_URI,
          digest: `sha256:${await sha256(MARKDOWN)}`,
          size: MAX_SERVER_SKILL_READ_BYTES + 1,
        },
      ],
    });
    const refusal = await refusalFrom(() =>
      getVerifiedServerSkill(manager, { serverId: SERVER_ID, uri: SKILL_URI })
    );
    expect(refusal.kind).toBe("too_large");
  });

  it("no longer refuses a SKILL.md over the OLD 128 KiB cap", async () => {
    // The regression this pins: the old per-file caps (128 KiB for SKILL.md,
    // 2 MiB for a supporting file) sat BELOW what the draft says a host MUST
    // support, so a conforming skill was refused as our bug, not the
    // server's.
    const padding = "x".repeat(200 * 1024);
    const bigMarkdown = `---\nname: refunds\ndescription: Handle refunds.\n---\n${padding}`;
    const manager = {
      getSkillsSupport: () => ({
        declared: true,
        advertised: true,
        directoryRead: false,
        active: true,
      }),
      getServerSkill: vi.fn(async () => ({
        uri: SKILL_URI,
        frontmatter: { name: "refunds", description: "Handle refunds." },
        resources: [
          {
            uri: SKILL_URI,
            digest: `sha256:${await sha256(bigMarkdown)}`,
            size: bytesOf(bigMarkdown),
          },
        ],
      })),
      readResource: vi.fn(async () => ({
        contents: [
          { uri: SKILL_URI, text: bigMarkdown, mimeType: "text/markdown" },
        ],
      })),
    } as unknown as MCPClientManager;

    const loaded = await getVerifiedServerSkill(manager, {
      serverId: SERVER_ID,
      uri: SKILL_URI,
    });
    expect(loaded.content).toContain(padding);
  });
});

describe("refusal shape", () => {
  it("carries the specific violation, never a bare failure", async () => {
    const { manager } = await makeManager({ padMarkdown: true });
    const refusal: ServerSkillRefusal = await refusalFrom(() =>
      getVerifiedServerSkill(manager, { serverId: SERVER_ID, uri: SKILL_URI })
    );
    // A debugger's user needs WHICH file and WHICH numbers; `kind` alone is
    // not a diagnosis.
    expect(refusal.skillUri).toBe(SKILL_URI);
    expect(refusal.expected).toBeDefined();
    expect(refusal.actual).toBeDefined();
  });
});
