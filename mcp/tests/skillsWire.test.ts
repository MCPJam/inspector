/**
 * `io.modelcontextprotocol/skills` (SEP-2640) over the real wire.
 *
 * The first wire-level test in this package: everything else here exercises
 * registration bookkeeping, not what a client actually receives.
 *
 * ## MCPJam's own host is the oracle
 *
 * The assertions do not re-implement the spec. They run `verifySkillMarkdown`
 * from `@mcpjam/sdk` — the same function the Inspector uses on a third-party
 * server — against the bytes this worker serves. So a digest, size, or
 * frontmatter bug fails CI here rather than shipping and being discovered by
 * our own debugger pointed at our own server.
 *
 * Every skill and every file is checked, not a sample. A per-file manifest that
 * is right for entry 0 and wrong for entry 9 is exactly the bug this catches,
 * and sampling would make the suite pass for the wrong reason.
 *
 * PIN: modelcontextprotocol/modelcontextprotocol @ a3e147ca27 (branch `sep/skills-extension`, `seps/2640-skills-extension.md`).
 */

import { describe, expect, it } from "vitest";
import {
  enumeratedResources,
  findListedResource,
  sha256HexOfText,
  verifyDigest,
  verifySize,
  verifySkillMarkdown,
} from "@mcpjam/sdk";
import { handleMcpRequest } from "../src/server.js";
import {
  SKILLS_LIST_CACHE_SCOPE,
  SKILLS_LIST_TTL_MS,
} from "../src/tools/skillsSurface.js";
import type { Env } from "../src/env.js";

const ENV = {
  PLATFORM_API_URL: "https://example.invalid/api/v1",
} as unknown as Env;

const MODERN_VERSION = "2026-07-28";

/**
 * Sends one JSON-RPC request and returns the parsed result.
 *
 * Two wire details cost an hour each if you meet them by surprise, so they are
 * handled once, here:
 *   - the LEGACY path demands an `Accept` naming BOTH `application/json` and
 *     `text/event-stream`, or answers 406 before dispatch;
 *   - the legacy response body is SSE (`event: message\ndata: {…}`), not bare
 *     JSON, so the payload has to be unwrapped.
 */
async function call(
  method: string,
  params: Record<string, unknown> = {},
  options: { era?: "legacy" | "modern"; name?: string } = {}
): Promise<{ status: number; result?: any; error?: any }> {
  const era = options.era ?? "legacy";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  };

  if (era === "modern") {
    headers["mcp-protocol-version"] = MODERN_VERSION;
    // Required by the modern envelope validator, which rejects with -32020
    // BEFORE dispatch when it is absent. Our own client derives it from the
    // body; a hand-rolled one must not forget it.
    headers["mcp-method"] = method;
    if (options.name) headers["mcp-name"] = options.name;
    body.params = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
  }

  const response = await handleMcpRequest(
    new Request("https://mcp.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    ENV
  );
  const text = await response.text();
  const json = text.startsWith("event:")
    ? JSON.parse(text.slice(text.indexOf("data: ") + 6).split("\n")[0]!)
    : JSON.parse(text);
  return { status: response.status, result: json.result, error: json.error };
}

async function listSkills(era: "legacy" | "modern" = "legacy") {
  const { result } = await call("skills/list", {}, { era });
  return result;
}

async function readResource(uri: string, era: "legacy" | "modern" = "legacy") {
  const { result, error } = await call(
    "resources/read",
    { uri },
    { era, name: uri }
  );
  return { result, error };
}

describe("capability declaration", () => {
  it("declares the extension with an OBJECT value on initialize", async () => {
    const { result } = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const declared = result.capabilities?.extensions?.[
      "io.modelcontextprotocol/skills"
    ];
    // A host reads the VALUE as the settings object, so `true` would not count
    // as a declaration at all.
    expect(declared).toEqual({});
    expect(typeof declared).toBe("object");
  });

  it("does not claim directoryRead, which it cannot answer", async () => {
    const { result } = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const declared =
      result.capabilities?.extensions?.["io.modelcontextprotocol/skills"];
    expect(declared.directoryRead).toBeUndefined();
  });

  it("keeps the tool and resource capabilities it registers", async () => {
    const { result } = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    // The declared `extensions` block is merged with, never substituted for,
    // what `registerTool` / `registerResource` add.
    expect(result.capabilities?.tools).toBeDefined();
    expect(result.capabilities?.resources).toBeDefined();
  });
});

describe("skills/list", () => {
  it("returns the catalog with SEP-2549 cache attributes", async () => {
    const result = await listSkills();
    expect(result.skills.length).toBeGreaterThan(0);
    expect(result.ttlMs).toBe(SKILLS_LIST_TTL_MS);
    expect(SKILLS_LIST_CACHE_SCOPE).toBe("public");
    expect(result.cacheScope).toBe("public");
  });

  it("gives every entry a complete manifest with digest AND size", async () => {
    const result = await listSkills();
    for (const skill of result.skills) {
      const manifest = enumeratedResources(skill);
      expect(manifest, `${skill.uri} must enumerate its files`).toBeDefined();
      expect(manifest!.length).toBeGreaterThan(0);
      for (const entry of manifest!) {
        expect(entry.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(Number.isInteger(entry.size)).toBe(true);
      }
      // The manifest MUST cover the SKILL.md itself, or a host refuses the
      // whole skill as `unlisted_resource`.
      expect(findListedResource(skill, skill.uri)).toBeDefined();
    }
  });

  it("names each skill for the final path segment of its URI", async () => {
    const result = await listSkills();
    for (const skill of result.skills) {
      const segment = skill.uri.split("/").at(-2);
      expect(skill.frontmatter.name).toBe(segment);
    }
  });

  it("rejects a cursor it never issued", async () => {
    // Ignoring it would leave a paginating client looping on page one with no
    // indication anything was wrong.
    const { error } = await call("skills/list", { cursor: "nope" });
    expect(error?.code).toBe(-32602);
  });
});

describe("skills/get", () => {
  it("answers with an entry identical to the listing's", async () => {
    const listed = await listSkills();
    for (const skill of listed.skills) {
      const { result } = await call("skills/get", { uri: skill.uri });
      // The draft says the two are "identical in shape and meaning". Any drift
      // means a host that refreshes one skill sees a different manifest than
      // the catalog showed, and silently invalidates its content-bound
      // approval.
      expect(result.skill).toEqual(skill);
    }
  });

  it("answers -32602 for a URI it does not serve", async () => {
    const { error } = await call("skills/get", {
      uri: "skill://mcpjam/no-such-skill/SKILL.md",
    });
    expect(error?.code).toBe(-32602);
  });
});

describe("integrity — our own host as the oracle", () => {
  it("serves every manifest file at the exact size and digest advertised", async () => {
    const listed = await listSkills();
    let checked = 0;
    for (const skill of listed.skills) {
      for (const entry of enumeratedResources(skill)!) {
        const { result } = await readResource(entry.uri);
        const text: string = result.contents[0].text;
        const bytes = new TextEncoder().encode(text);

        const sizing = verifySize(bytes.byteLength, entry);
        expect(sizing.ok, `${entry.uri} size`).toBe(true);
        // Not merely "not refused" — the check must actually have run, which
        // is the difference between a size guarantee and a missing field.
        expect(sizing.ok && sizing.checked).toBe(true);

        const digest = await verifyDigest(bytes, entry.digest);
        expect(digest.ok, `${entry.uri} digest`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("passes full host verification for every SKILL.md", async () => {
    const listed = await listSkills();
    for (const skill of listed.skills) {
      const { result } = await readResource(skill.uri);
      const markdown: string = result.contents[0].text;
      // Digest, size, URI/name identity, and field-by-field frontmatter drift,
      // in one call — the same one the Inspector makes.
      const verified = await verifySkillMarkdown({
        entry: skill,
        markdown,
      });
      expect(verified.frontmatter.name).toBe(skill.frontmatter.name);
      expect(verified.frontmatter.description.length).toBeGreaterThan(0);
      expect(verified.body.length).toBeGreaterThan(0);
      expect(await sha256HexOfText(markdown)).toBe(
        findListedResource(skill, skill.uri)!.digest.split(":")[1]
      );
    }
  });

  it("returns the mimeType on the CONTENT, not only the registration", async () => {
    // A reader takes the type from `contents[0]`, not from `resources/list` —
    // MCPJam's own loader names it in the refusal for a non-text read. So
    // declaring one at registration and omitting it here told two different
    // stories about the same file.
    const listed = await listSkills();
    for (const skill of listed.skills) {
      for (const entry of enumeratedResources(skill)!) {
        const { result } = await readResource(entry.uri);
        expect(result.contents[0].mimeType, entry.uri).toBeDefined();
        if (entry.uri.endsWith(".md")) {
          expect(result.contents[0].mimeType).toBe("text/markdown");
        }
        if (entry.uri.endsWith(".yaml")) {
          // Not `text/plain`: these are eval suites a reader may want to parse.
          expect(result.contents[0].mimeType).toBe("application/yaml");
        }
      }
    }
  });

  it("refuses to read a skill URI outside the manifest", async () => {
    const { error, result } = await readResource(
      "skill://mcpjam/create-mcp-eval/references/does-not-exist.md"
    );
    expect(result).toBeUndefined();
    // Both codecs rewrite ResourceNotFound (-32002) to -32602, so this worker
    // cannot emit -32002 even if it wanted to. Recorded here so the difference
    // from `skills-fixture.ts` is a documented fact, not a surprise.
    expect(error?.code).toBe(-32602);
  });
});

describe("era blindness", () => {
  it("serves skills/list on the modern wire too", async () => {
    const result = await listSkills("modern");
    expect(result.skills.length).toBeGreaterThan(0);
    // The SDK stamps these onto every modern result. `resultType` is in the
    // current draft's own examples, so it is expected rather than a deviation.
    expect(result.resultType).toBe("complete");
  });

  it("serves identical skill entries on both eras", async () => {
    const legacy = await listSkills("legacy");
    const modern = await listSkills("modern");
    expect(modern.skills).toEqual(legacy.skills);
  });

  it("verifies a modern-era read against the same manifest", async () => {
    const listed = await listSkills("modern");
    const skill = listed.skills[0];
    const { result } = await readResource(skill.uri, "modern");
    const verified = await verifySkillMarkdown({
      entry: skill,
      markdown: result.contents[0].text,
    });
    expect(verified.frontmatter.name).toBe(skill.frontmatter.name);
  });
});
