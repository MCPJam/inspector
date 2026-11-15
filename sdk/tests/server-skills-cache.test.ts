/**
 * The verified read cache (SEP-2640): a cached file whose digest matches the
 * current entry is served without fetching it again, bounded by entries and
 * bytes, and dropped for a server the user removes.
 *
 * PIN: modelcontextprotocol/ext-skills @ c1aa87e (`specification/stable/skills.mdx`).
 */

import { describe, expect, it, vi } from "vitest";
import {
  cachedVerifiedText,
  forgetVerifiedServerSkillReads,
  rememberVerifiedText,
} from "../src/server-skills-cache.js";
import { readVerifiedServerSkillFile } from "../src/server-skills.js";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import type { MCPClientManager as Manager } from "../src/mcp-client-manager/index.js";

const SERVER_ID = "srv";
const SKILL_URI = "skill://acme/refunds/SKILL.md";
const FILE_URI = "skill://acme/refunds/scripts/run.py";
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

/** A manager double that answers `resources/read` for the one file. */
async function makeManager(fileText = FILE_TEXT) {
  const digest = `sha256:${await sha256(fileText)}`;
  const entry = {
    uri: SKILL_URI,
    resources: [{ uri: FILE_URI, digest, size: bytesOf(fileText) }],
  };
  const manager = {
    readResource: vi.fn(async (_serverId: string, args: { uri: string }) => ({
      contents: [{ uri: args.uri, text: fileText, mimeType: "text/plain" }],
    })),
  };
  return { manager: manager as unknown as Manager, entry, digest };
}

describe("the verified read cache", () => {
  it("serves a repeat read from the cache without a second resources/read", async () => {
    const { manager, entry } = await makeManager();
    const first = await readVerifiedServerSkillFile(manager, {
      serverId: SERVER_ID,
      entry,
      resourceUri: FILE_URI,
    });
    const second = await readVerifiedServerSkillFile(manager, {
      serverId: SERVER_ID,
      entry,
      resourceUri: FILE_URI,
    });
    expect(second).toEqual(first);
    expect(
      (manager as unknown as { readResource: ReturnType<typeof vi.fn> })
        .readResource
    ).toHaveBeenCalledTimes(1);
  });

  it("misses when the entry's digest changed, and reads again", async () => {
    const { manager, entry } = await makeManager();
    await readVerifiedServerSkillFile(manager, {
      serverId: SERVER_ID,
      entry,
      resourceUri: FILE_URI,
    });
    // The server now advertises different bytes for the same URI. The cached
    // text verified against the OLD digest and must not stand in for the new.
    const changed = {
      uri: SKILL_URI,
      resources: [
        {
          uri: FILE_URI,
          digest: `sha256:${await sha256("print('changed')\n")}`,
          size: bytesOf(FILE_TEXT),
        },
      ],
    };
    await expect(
      readVerifiedServerSkillFile(manager, {
        serverId: SERVER_ID,
        entry: changed,
        resourceUri: FILE_URI,
      })
    ).rejects.toMatchObject({ refusal: { kind: "digest_mismatch" } });
    expect(
      (manager as unknown as { readResource: ReturnType<typeof vi.fn> })
        .readResource
    ).toHaveBeenCalledTimes(2);
  });

  it("is keyed per manager and per server", () => {
    const a = {};
    const b = {};
    rememberVerifiedText(a, "s1", FILE_URI, "sha256:x", "one");
    expect(cachedVerifiedText(a, "s1", FILE_URI, "sha256:x")).toBe("one");
    expect(cachedVerifiedText(b, "s1", FILE_URI, "sha256:x")).toBeUndefined();
    expect(cachedVerifiedText(a, "s2", FILE_URI, "sha256:x")).toBeUndefined();
    expect(cachedVerifiedText(a, "s1", FILE_URI, undefined)).toBeUndefined();
  });

  it("evicts the oldest entries past the byte budget", () => {
    // 32 MiB of budget; five 8 MiB files overflow it by one.
    const manager = {};
    const text = "x".repeat(8 * 1024 * 1024);
    for (let i = 0; i < 5; i += 1) {
      rememberVerifiedText(manager, "s", `file://${i}`, "sha256:d", text);
    }
    expect(cachedVerifiedText(manager, "s", "file://0", "sha256:d")).toBeUndefined();
    for (let i = 1; i < 5; i += 1) {
      expect(cachedVerifiedText(manager, "s", `file://${i}`, "sha256:d")).toBe(
        text
      );
    }
  });

  it("evicts the oldest entries past the entry cap, keeping one in use", () => {
    const manager = {};
    for (let i = 0; i < 256; i += 1) {
      rememberVerifiedText(manager, "s", `file://${i}`, "sha256:d", "t");
    }
    // A hit refreshes insertion order, so the file in use outlives one that
    // is not.
    expect(cachedVerifiedText(manager, "s", "file://0", "sha256:d")).toBe("t");
    rememberVerifiedText(manager, "s", "file://256", "sha256:d", "t");
    expect(cachedVerifiedText(manager, "s", "file://0", "sha256:d")).toBe("t");
    expect(cachedVerifiedText(manager, "s", "file://1", "sha256:d")).toBeUndefined();
  });

  it("refuses to cache a single text over the whole budget", () => {
    const manager = {};
    rememberVerifiedText(
      manager,
      "s",
      FILE_URI,
      "sha256:d",
      "x".repeat(32 * 1024 * 1024 + 1)
    );
    expect(cachedVerifiedText(manager, "s", FILE_URI, "sha256:d")).toBeUndefined();
  });

  it("drops one server's reads and keeps the others'", () => {
    const manager = {};
    rememberVerifiedText(manager, "s1", FILE_URI, "sha256:d", "one");
    rememberVerifiedText(manager, "s2", FILE_URI, "sha256:d", "two");
    forgetVerifiedServerSkillReads(manager, "s1");
    expect(cachedVerifiedText(manager, "s1", FILE_URI, "sha256:d")).toBeUndefined();
    expect(cachedVerifiedText(manager, "s2", FILE_URI, "sha256:d")).toBe("two");
  });

  it("is dropped for a server the manager removes", async () => {
    // The spec: a host removes a server's cached skill content when the
    // user removes that server. `removeServer` is that moment.
    const manager = new MCPClientManager({}, { lazyConnect: true });
    rememberVerifiedText(manager, SERVER_ID, FILE_URI, "sha256:d", "one");
    await manager.removeServer(SERVER_ID);
    expect(
      cachedVerifiedText(manager, SERVER_ID, FILE_URI, "sha256:d")
    ).toBeUndefined();
  });
});
