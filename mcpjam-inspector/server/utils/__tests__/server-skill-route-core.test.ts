/**
 * The route-shaped translation for server-served skills.
 *
 * `server-skills.ts` signals a violation by THROWING; an HTTP surface has to
 * answer with it instead, because "here is the check that failed" is the answer
 * the caller asked for. These cases pin that translation, which is now shared
 * by `/api/web/server-skills` and its `/api/v1` mirror — the two routes cannot
 * disagree about whether a refusal is a 200 or a 500 unless someone edits this
 * module.
 */

import { describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  getServerSkillCore,
  listServerSkillsCore,
  readServerSkillFileCore,
} from "../server-skill-route-core.js";

const SERVER_ID = "srv";
const SKILL_URI = "skill://acme/refunds/SKILL.md";
const FILE_URI = "skill://acme/refunds/scripts/run.py";
const MARKDOWN = `---\nname: refunds\ndescription: Handle refunds.\n---\n# Refunds\n`;
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
const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;

async function makeManager(
  options: { active?: boolean; tamperFileDigest?: boolean } = {}
) {
  const entry = {
    uri: SKILL_URI,
    frontmatter: { name: "refunds", description: "Handle refunds." },
    resources: [
      {
        uri: SKILL_URI,
        digest: `sha256:${await sha256(MARKDOWN)}`,
        size: bytesOf(MARKDOWN),
      },
      {
        uri: FILE_URI,
        digest: `sha256:${await sha256(
          options.tamperFileDigest ? "something else" : FILE_TEXT
        )}`,
        size: bytesOf(FILE_TEXT),
      },
    ],
  };
  /**
   * Models the real manager's connection lifecycle, which is the whole point
   * on a hosted request: `getSkillsSupport` reads what a LIVE connection
   * negotiated, so before anything connects it answers `active: false` for
   * every server — regardless of what the server actually declares. A core
   * that reads it synchronously therefore reports "inactive" on every hosted
   * call. Only `ensureSkillsSupport` awaits the connection first.
   */
  let connected = false;
  const support = () => ({
    declared: connected && options.active !== false,
    advertised: connected && options.active !== false,
    directoryRead: false,
    active: connected && options.active !== false,
  });
  return {
    connectCount: 0,
    getSkillsSupport: () => support(),
    ensureSkillsSupport: vi.fn(async function (this: any) {
      connected = true;
      this.connectCount += 1;
      return support();
    }),
    listServerSkills: vi.fn(async () => ({ skills: [entry] })),
    getServerSkill: vi.fn(async () => entry),
    readResource: vi.fn(async (_id: string, read: { uri: string }) => ({
      contents: [
        {
          uri: read.uri,
          text: read.uri === SKILL_URI ? MARKDOWN : FILE_TEXT,
          mimeType: "text/markdown",
        },
      ],
    })),
  } as unknown as MCPClientManager;
}

describe("support is read from a connection, not before one", () => {
  // The regression: a hosted manager is EPHEMERAL, so nothing has connected
  // when the handler starts. Reading `getSkillsSupport` synchronously answered
  // "inactive" on every hosted request and returned an empty listing, while
  // the route's teardown aborted the negotiation still in flight — a 200 with
  // no skills and an `AbortError`, against a reachable server.
  it("connects before answering, so a declared extension is seen", async () => {
    const manager = (await makeManager()) as any;
    // The synchronous read is false right now, and stays false unless the core
    // awaits the connection.
    expect(manager.getSkillsSupport().active).toBe(false);

    const result = await listServerSkillsCore(manager, { serverId: SERVER_ID });

    expect(manager.ensureSkillsSupport).toHaveBeenCalledWith(SERVER_ID);
    expect(result.support.active).toBe(true);
    expect(result.skills).toHaveLength(1);
  });

  it("does the same on get and read-file", async () => {
    const getManager = (await makeManager()) as any;
    const got = await getServerSkillCore(getManager, {
      serverId: SERVER_ID,
      uri: SKILL_URI,
    });
    expect(getManager.ensureSkillsSupport).toHaveBeenCalledWith(SERVER_ID);
    expect(got.skill).toBeDefined();

    const readManager = (await makeManager()) as any;
    const read = await readServerSkillFileCore(readManager, {
      serverId: SERVER_ID,
      skillUri: SKILL_URI,
      resourceUri: FILE_URI,
    });
    expect(readManager.ensureSkillsSupport).toHaveBeenCalledWith(SERVER_ID);
    expect(read.file).toBeDefined();
  });
});

describe("an inactive extension is a state, not a failure", () => {
  // The client renders a response with no refusal as a generic `fetch_failed`,
  // so answering with nothing here would report a network problem for a
  // connection that simply never negotiated skills.
  it("lists nothing, and still says which server it answered for", async () => {
    const manager = await makeManager({ active: false });
    const result = await listServerSkillsCore(manager, { serverId: SERVER_ID });
    expect(result.support.active).toBe(false);
    expect(result.skills).toEqual([]);
    expect(result.serverId).toBe(SERVER_ID);
  });

  it("names the capability on get and on read-file, rather than throwing", async () => {
    const manager = await makeManager({ active: false });
    const got = await getServerSkillCore(manager, {
      serverId: SERVER_ID,
      uri: SKILL_URI,
    });
    const read = await readServerSkillFileCore(manager, {
      serverId: SERVER_ID,
      skillUri: SKILL_URI,
      resourceUri: FILE_URI,
    });
    expect(got.refusal?.kind).toBe("extension_inactive");
    expect(read.refusal?.kind).toBe("extension_inactive");
  });
});

describe("a refusal is a result", () => {
  it("returns the verified skill on the happy path", async () => {
    const manager = await makeManager();
    const result = await getServerSkillCore(manager, {
      serverId: SERVER_ID,
      uri: SKILL_URI,
    });
    expect(result.skill?.name).toBe("refunds");
    expect(result.refusal).toBeUndefined();
  });

  it("answers a failed file check with the refusal, not an exception", async () => {
    const manager = await makeManager({ tamperFileDigest: true });
    const result = await readServerSkillFileCore(manager, {
      serverId: SERVER_ID,
      skillUri: SKILL_URI,
      resourceUri: FILE_URI,
    });
    expect(result.file).toBeUndefined();
    expect(result.refusal?.kind).toBe("digest_mismatch");
    // The specific violation survives the translation — a refusal that lost its
    // `resourceUri` would tell a server author to go looking.
    expect(result.refusal?.resourceUri).toBe(FILE_URI);
  });

  it("re-fetches the manifest rather than trusting the caller's read request", async () => {
    // The manifest IS the read allowlist. A URI the skill never listed must be
    // refused before any fetch, even though this server would happily serve it.
    const manager = await makeManager();
    const result = await readServerSkillFileCore(manager, {
      serverId: SERVER_ID,
      skillUri: SKILL_URI,
      resourceUri: "skill://acme/refunds/secrets.env",
    });
    expect(result.refusal?.kind).toBe("unlisted_resource");
    expect(manager.readResource).not.toHaveBeenCalledWith(
      SERVER_ID,
      expect.objectContaining({ uri: "skill://acme/refunds/secrets.env" })
    );
  });
});
