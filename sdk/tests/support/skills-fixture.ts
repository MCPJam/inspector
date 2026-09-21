/**
 * A raw `io.modelcontextprotocol/skills` (SEP-2640) fixture server, spoken
 * over Streamable HTTP on a real socket.
 *
 * PIN: modelcontextprotocol/modelcontextprotocol @ a3e147ca27 (branch `sep/skills-extension`, `seps/2640-skills-extension.md`).
 * Every wire shape below is copied from that commit — re-diff when re-syncing.
 *
 * Why hand-rolled JSON-RPC rather than `@modelcontextprotocol/server`:
 * upstream implements neither `skills/list`/`skills/get` nor
 * `resources/directory/read`, and the point of this fixture is to drive the
 * REAL client against wire bytes we control byte-for-byte — including bytes
 * that VIOLATE the spec, so client-side verification has something to fail
 * against. It is also the reference server for manual e2e: `startSkillsFixture`
 * is exported so it can be run standalone.
 *
 * ## Spec behavior served by default
 *   - the extension is declared in `initialize` / `server/discover`
 *     capabilities, with `{ directoryRead: true }` when enabled;
 *   - `skills/list` returns `{ uri, frontmatter, resources }` entries, paged;
 *   - `skills/get` answers by URI — INCLUDING for skills the listing omits
 *     (the `unlisted` flag), and `-32602` for a URI it does not serve;
 *   - `resources/read` serves the SKILL.md and every manifest file, and
 *     `-32002` for a URI outside the skill set;
 *   - digests are computed from the ACTUAL bytes, so a default fixture always
 *     verifies.
 *
 * ## Spec violations it can produce on demand
 * Everything under {@link SkillsMisbehavior} — each drives a specific host-side
 * refusal, and every one of them is a real failure mode a debugger's users will
 * meet in the wild.
 */

import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

/** The extension identifier (SEP-2640). */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

/** `INVALID_PARAMS` — the answer for a `skills/get` on an unknown URI. */
export const INVALID_PARAMS = -32602;
/** `RESOURCE_NOT_FOUND` — the answer for a `resources/read` we do not serve. */
export const RESOURCE_NOT_FOUND = -32002;

export const DEFAULT_PROTOCOL_VERSION = "2026-07-28";

/** SEP-2549 attributes the modern wire requires on `tools/list`. */
const LIST_RESULT_TTL_MS = 60_000;
const LIST_RESULT_CACHE_SCOPE = "private" as const;

export interface SkillFixtureFile {
  /** Path relative to the skill root, e.g. `scripts/fill.py`. */
  path: string;
  content: string;
  mimeType?: string;
}

export interface SkillFixtureSkill {
  /** Skill root path — the URI becomes `<scheme>://<root>/SKILL.md`. */
  root: string;
  name: string;
  description: string;
  /** SKILL.md body, without frontmatter. */
  body: string;
  /** Extra frontmatter lines rendered into the file AND advertised. */
  extraFrontmatter?: Record<string, string>;
  files?: SkillFixtureFile[];
  /**
   * Served by `skills/get` but ABSENT from `skills/list`. The SEP is explicit
   * that a listing may be partial, so this is conforming behavior — not
   * misbehavior — and the host must be able to load it by URI.
   */
  unlisted?: boolean;
  /** Omit `resources` from this skill's entry entirely. */
  omitResources?: boolean;
  /** Override the URI scheme (default `skill`). */
  scheme?: string;
}

export interface SkillsMisbehavior {
  /** Serve a SKILL.md whose bytes do not match the advertised digest. */
  digestMismatch?: string;
  /** Advertise a frontmatter `description` that differs from the file's. */
  frontmatterDrift?: string;
  /** Advertise a `name` that is not the URI's final path segment. */
  uriNameMismatch?: string;
  /** Answer `resources/read` for a URI absent from the skill's manifest. */
  serveUnlistedFile?: { skillRoot: string; path: string; content: string };
  /** Emit every listed skill TWICE, in the same page. */
  duplicateUris?: boolean;
  /** Advertise digests using an algorithm the host will not verify. */
  unsupportedDigestAlgorithm?: boolean;
  /** Stop declaring the extension in initialize capabilities. */
  hideExtension?: boolean;
  /** Answer `skills/list` with a cursor that never advances. */
  repeatCursor?: boolean;
  /** Return a malformed entry (missing `uri`) in the listing. */
  malformedEntry?: boolean;
  /**
   * Advertise a `size` that does not match the bytes served, for the named
   * skill root. Distinct from `digestMismatch`: the draft makes a length
   * mismatch its own verification failure, catchable before hashing.
   */
  sizeMismatch?: string;
  /** Advertise `"resources": "dynamic"` instead of an enumerated manifest. */
  dynamicResources?: boolean;
  /** Omit `size` from every manifest entry, as a pre-`size` server would. */
  omitSizes?: boolean;
}

export interface SkillsFixtureOptions {
  skills?: SkillFixtureSkill[];
  /** Entries per `skills/list` page. Default: all in one page. */
  pageSize?: number;
  /** Declare `{ directoryRead: true }`. Default false. */
  directoryRead?: boolean;
  /** Advertised protocol versions. Default `["2026-07-28"]`. */
  supportedVersions?: string[];
  /** SEP-2549 attributes emitted on `skills/list`. */
  listTtlMs?: number;
  listCacheScope?: string;
  misbehavior?: SkillsMisbehavior;
}

export interface SkillsFixtureHandle {
  url: string;
  /** Every request the fixture received, in order. */
  received: Array<{ method: string; params?: Record<string, unknown> }>;
  /** Methods received, deduped — the suppression assertions read this. */
  methods: () => string[];
  misbehave: (patch: SkillsMisbehavior) => void;
  /** Replace a skill's body, so a re-capture mints a new version. */
  editSkill: (root: string, body: string) => void;
  uriFor: (root: string) => string;
  close: () => Promise<void>;
}

class JsonRpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** A default two-skill set: one plain, one with supporting files. */
export const DEFAULT_FIXTURE_SKILLS: SkillFixtureSkill[] = [
  {
    root: "fixture/greeting",
    name: "greeting",
    description: "Greets a user in a house style.",
    body: "# Greeting\n\nSay hello warmly, then ask how you can help.\n",
  },
  {
    root: "fixture/reporting",
    name: "reporting",
    description: "Builds a weekly report from raw metrics.",
    body: "# Reporting\n\nUse `scripts/build.py` to assemble the report.\n",
    files: [
      {
        path: "scripts/build.py",
        content: "print('report')\n",
        mimeType: "text/x-python",
      },
      {
        path: "reference/schema.md",
        content: "# Schema\n\nOne row per metric.\n",
        mimeType: "text/markdown",
      },
    ],
  },
];

export async function startSkillsFixture(
  options: SkillsFixtureOptions = {}
): Promise<SkillsFixtureHandle> {
  const supportedVersions = options.supportedVersions ?? [
    DEFAULT_PROTOCOL_VERSION,
  ];
  const misbehavior: SkillsMisbehavior = { ...options.misbehavior };
  const skills = (options.skills ?? DEFAULT_FIXTURE_SKILLS).map((skill) => ({
    ...skill,
  }));
  const received: Array<{
    method: string;
    params?: Record<string, unknown>;
  }> = [];

  const serverInfo = { name: "skills-fixture", version: "1.0.0" };

  const uriFor = (skill: SkillFixtureSkill) =>
    `${skill.scheme ?? "skill"}://${skill.root}/SKILL.md`;
  const fileUriFor = (skill: SkillFixtureSkill, path: string) =>
    `${skill.scheme ?? "skill"}://${skill.root}/${path}`;

  function skillByRoot(root: string): SkillFixtureSkill | undefined {
    return skills.find((skill) => skill.root === root);
  }

  /** Renders the SKILL.md exactly as `resources/read` will serve it. */
  function renderMarkdown(skill: SkillFixtureSkill): string {
    const description =
      misbehavior.frontmatterDrift === skill.root
        ? `${skill.description} (drifted)`
        : skill.description;
    const lines = [
      "---",
      `name: ${skill.name}`,
      `description: ${description}`,
      ...Object.entries(skill.extraFrontmatter ?? {}).map(
        ([key, value]) => `${key}: ${value}`
      ),
      "---",
      "",
    ];
    return `${lines.join("\n")}${skill.body}`;
  }

  /** The frontmatter the LISTING advertises (pre-drift, by construction). */
  function advertisedFrontmatter(
    skill: SkillFixtureSkill
  ): Record<string, unknown> {
    return {
      name:
        misbehavior.uriNameMismatch === skill.root
          ? `${skill.name}-renamed`
          : skill.name,
      description: skill.description,
      ...(skill.extraFrontmatter ?? {}),
    };
  }

  function digestOf(text: string): string {
    if (misbehavior.unsupportedDigestAlgorithm) {
      return `md5:${createHash("md5").update(text, "utf8").digest("hex")}`;
    }
    return sha256(text);
  }

  /**
   * The advertised `size` for some bytes, or `undefined` under `omitSizes`.
   *
   * A size-mismatch fixture advertises a length that is off by one rather than
   * wildly wrong: an off-by-one is what a truncated read actually looks like,
   * and it proves the host compares the number instead of sniffing for an
   * obviously bogus one.
   */
  function sizeOf(text: string, skill: SkillFixtureSkill): number | undefined {
    if (misbehavior.omitSizes) return undefined;
    const actual = Buffer.byteLength(text, "utf8");
    return misbehavior.sizeMismatch === skill.root ? actual + 1 : actual;
  }

  function resourcesOf(
    skill: SkillFixtureSkill
  ):
    | Array<{ uri: string; digest: string; size?: number }>
    | "dynamic"
    | undefined {
    if (misbehavior.dynamicResources) return "dynamic";
    if (skill.omitResources) return undefined;
    const markdown = renderMarkdown(skill);
    // A digest-mismatch fixture advertises the digest of DIFFERENT bytes; the
    // file served is unchanged, so the host's verification is what catches it.
    const advertisedMarkdown =
      misbehavior.digestMismatch === skill.root
        ? `${markdown}\n<!-- tampered -->`
        : markdown;
    const withSize = (
      uri: string,
      content: string
    ): { uri: string; digest: string; size?: number } => {
      const size = sizeOf(content, skill);
      return {
        uri,
        digest: digestOf(content),
        ...(size === undefined ? {} : { size }),
      };
    };
    // The two tampering modes stay INDEPENDENT: the digest is taken from the
    // possibly-tampered copy, the size from the bytes actually served. Sizing
    // the tampered copy instead would make `digestMismatch` trip the size
    // check first, and that test would then pass for the wrong reason.
    const skillMdSize = sizeOf(markdown, skill);
    return [
      {
        uri: uriFor(skill),
        digest: digestOf(advertisedMarkdown),
        ...(skillMdSize === undefined ? {} : { size: skillMdSize }),
      },
      ...(skill.files ?? []).map((file) =>
        withSize(fileUriFor(skill, file.path), file.content)
      ),
    ];
  }

  function entryOf(skill: SkillFixtureSkill): Record<string, unknown> {
    const resources = resourcesOf(skill);
    return {
      uri: uriFor(skill),
      frontmatter: advertisedFrontmatter(skill),
      ...(resources ? { resources } : {}),
    };
  }

  function capabilities(): Record<string, unknown> {
    return {
      tools: {},
      resources: {},
      ...(misbehavior.hideExtension
        ? {}
        : {
            extensions: {
              [SKILLS_EXTENSION_ID]: options.directoryRead
                ? { directoryRead: true }
                : {},
            },
          }),
    };
  }

  function handleSkillsList(
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const listed = skills.filter((skill) => !skill.unlisted);
    const entries = listed.map(entryOf);
    if (misbehavior.duplicateUris) {
      entries.push(...listed.map(entryOf));
    }
    if (misbehavior.malformedEntry) {
      entries.push({ frontmatter: { name: "nameless" } });
    }
    const pageSize = options.pageSize ?? entries.length;
    const cursor = typeof params?.cursor === "string" ? params.cursor : "0";
    const offset = misbehavior.repeatCursor ? 0 : Number.parseInt(cursor, 10);
    const start = Number.isFinite(offset) ? offset : 0;
    const page = entries.slice(start, start + Math.max(pageSize, 1));
    const nextStart = start + page.length;
    const hasMore = misbehavior.repeatCursor || nextStart < entries.length;
    return {
      resultType: "complete",
      skills: page,
      ...(hasMore ? { nextCursor: String(nextStart) } : {}),
      ...(options.listTtlMs !== undefined ? { ttlMs: options.listTtlMs } : {}),
      ...(options.listCacheScope !== undefined
        ? { cacheScope: options.listCacheScope }
        : {}),
    };
  }

  function handleSkillsGet(
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const uri = params?.uri;
    const skill = skills.find((candidate) => uriFor(candidate) === uri);
    if (!skill) {
      // SEP-2640: a URI the server does not serve is `-32602`. THIS answer —
      // not an absent listing entry — is what proves non-existence.
      throw new JsonRpcFailure(
        INVALID_PARAMS,
        `Unknown skill URI: ${String(uri)}`
      );
    }
    // The SEP's envelope: `{ skill }`. Spreading the entry at the top level
    // would let a client that forgot to unwrap pass — the fixture would then
    // be validating the client's bug instead of the protocol.
    return { resultType: "complete", skill: entryOf(skill) };
  }

  function handleResourcesRead(
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const uri = String(params?.uri ?? "");

    // SEP-2549 made `ttlMs` + `cacheScope` REQUIRED on every cacheable result
    // in the 2026 codec, `resources/read` included; omitting them makes the
    // client's decoder reject the response before any skills logic is reached.
    const cacheable = {
      ttlMs: LIST_RESULT_TTL_MS,
      cacheScope: LIST_RESULT_CACHE_SCOPE,
    };

    const unlisted = misbehavior.serveUnlistedFile;
    if (unlisted) {
      const skill = skillByRoot(unlisted.skillRoot);
      if (skill && uri === fileUriFor(skill, unlisted.path)) {
        return {
          resultType: "complete",
          ...cacheable,
          contents: [{ uri, mimeType: "text/plain", text: unlisted.content }],
        };
      }
    }

    for (const skill of skills) {
      if (uri === uriFor(skill)) {
        return {
          resultType: "complete",
          ...cacheable,
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: renderMarkdown(skill),
            },
          ],
        };
      }
      for (const file of skill.files ?? []) {
        if (uri === fileUriFor(skill, file.path)) {
          return {
            resultType: "complete",
            ...cacheable,
            contents: [
              {
                uri,
                mimeType: file.mimeType ?? "text/plain",
                text: file.content,
              },
            ],
          };
        }
      }
    }
    throw new JsonRpcFailure(RESOURCE_NOT_FOUND, `Resource not found: ${uri}`);
  }

  function handle(
    method: string,
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    switch (method) {
      case "server/discover":
      case "initialize":
        return {
          resultType: "complete",
          protocolVersion: supportedVersions[0],
          supportedVersions,
          capabilities: capabilities(),
          serverInfo,
        };

      case "tools/list":
        return {
          resultType: "complete",
          ttlMs: LIST_RESULT_TTL_MS,
          cacheScope: LIST_RESULT_CACHE_SCOPE,
          tools: [],
        };

      case "resources/list":
        return {
          resultType: "complete",
          ttlMs: LIST_RESULT_TTL_MS,
          cacheScope: LIST_RESULT_CACHE_SCOPE,
          resources: skills.map((skill) => ({
            uri: uriFor(skill),
            name: skill.name,
            mimeType: "text/markdown",
          })),
        };

      case "skills/list":
        return handleSkillsList(params);

      case "skills/get":
        return handleSkillsGet(params);

      case "resources/read":
        return handleResourcesRead(params);

      case "resources/directory/read": {
        if (!options.directoryRead) {
          throw new JsonRpcFailure(
            INVALID_PARAMS,
            "resources/directory/read is not enabled"
          );
        }
        const uri = String(params?.uri ?? "");
        const skill = skills.find((candidate) =>
          uri.startsWith(`${candidate.scheme ?? "skill"}://${candidate.root}`)
        );
        return {
          resultType: "complete",
          resources: (skill?.files ?? []).map((file) => ({
            uri: fileUriFor(skill!, file.path),
            name: file.path,
            mimeType: file.mimeType ?? "text/plain",
            size: Buffer.byteLength(file.content, "utf8"),
          })),
        };
      }

      default:
        return { resultType: "complete" };
    }
  }

  const httpServer = http.createServer((req, res) => {
    // Chunks are collected and decoded ONCE. Concatenating them as strings
    // decodes each independently, so a multi-byte character straddling a chunk
    // boundary would become replacement characters and fail `JSON.parse` — an
    // intermittent failure that looks like a transport fault.
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let message: {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof message.method === "string") {
        received.push({
          method: message.method,
          ...(message.params ? { params: message.params } : {}),
        });
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = {
          jsonrpc: "2.0",
          id: message.id,
          result: handle(message.method as string, message.params),
        };
      } catch (error) {
        const failure =
          error instanceof JsonRpcFailure
            ? error
            : new JsonRpcFailure(-32603, String(error));
        payload = {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: failure.code, message: failure.message },
        };
      }

      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-protocol-version": supportedVersions[0],
      });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const address = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    received,
    methods: () => [...new Set(received.map((entry) => entry.method))],
    misbehave: (patch) => Object.assign(misbehavior, patch),
    editSkill: (root, nextBody) => {
      const skill = skillByRoot(root);
      if (skill) skill.body = nextBody;
    },
    uriFor: (root) => {
      const skill = skillByRoot(root);
      if (!skill) throw new Error(`No fixture skill at root "${root}"`);
      return uriFor(skill);
    },
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
