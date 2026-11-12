/**
 * A connected server that serves skills (SEP-2640), for the tests of the
 * agent's server-skill tools and the listing a live turn makes.
 *
 * PIN: modelcontextprotocol/ext-skills @ c1aa87e (`specification/stable/skills.mdx`).
 *
 * Hand-rolled rather than a mock of `MCPClientManager`: the point is to
 * control the WIRE answers, including malformed ones.
 */
import { vi } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";

export const SKILL_URI = "skill://acme/refunds/SKILL.md";
export const FILE_URI = "skill://acme/refunds/scripts/run.py";
export const BODY = "# Refunds\n\nRefund politely.\n";
export const MARKDOWN = `---\nname: refunds\ndescription: Handle refunds.\n---\n${BODY}`;
export const FILE_TEXT = "print('refund')\n";

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface ServerSkillWireOptions {
  active?: boolean;
  /** Serve the SKILL.md with bytes that don't match the advertised digest. */
  tamper?: boolean;
  /** Omit `resources` from the entry entirely. */
  noResources?: boolean;
  /** Pad the body: `true` for 200 KiB, or a byte count. */
  hugeBody?: boolean | number;
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
  /** Server ids whose `skills/list` never answers. */
  stalledServers?: string[];
  /** Server ids whose `skills/list` fails. */
  failingServers?: string[];
  unlistedSkills?: Record<
    string,
    { name: string; markdown: string; tamper?: boolean }
  >;
}

export type ServerSkillWire = MCPClientManager & {
  /** Every wire call, in order: `skills/list`, `skills/get:<uri>`, `resources/read:<uri>`. */
  calls: string[];
  listServerSkills: ReturnType<typeof vi.fn>;
};

/** A manager double that speaks exactly the wire methods server skills use. */
export async function makeServerSkillWire(
  options: ServerSkillWireOptions = {},
): Promise<ServerSkillWire> {
  const bodyMarkdown = options.hugeBody
    ? `${MARKDOWN}${"x".repeat(
        typeof options.hugeBody === "number" ? options.hugeBody : 200 * 1024,
      )}`
    : MARKDOWN;
  const markdownDigest = `sha256:${await sha256(
    options.tamper ? `${bodyMarkdown}tampered` : bodyMarkdown,
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
  const getServerSkill = vi.fn(async (_serverId: string, uri: string) => {
    calls.push(`skills/get:${uri}`);
    if (uri === SKILL_URI) return entry;
    if (options.substituteUriFor === uri) {
      // A DIFFERENT URI than the one asked for, otherwise well-formed.
      return entry;
    }
    const unlisted = options.unlistedSkills?.[uri];
    if (unlisted) {
      return {
        uri,
        frontmatter: { name: unlisted.name, description: "An unlisted skill." },
        resources: [
          {
            uri,
            digest: `sha256:${await sha256(
              unlisted.tamper
                ? `${unlisted.markdown}tampered`
                : unlisted.markdown,
            )}`,
          },
        ],
      };
    }
    throw Object.assign(new Error("Invalid params"), { code: -32602 });
  });
  const manager = {
    calls,
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
    listServerSkills: vi.fn(async (serverId: string) => {
      calls.push("skills/list");
      if (options.stalledServers?.includes(serverId)) {
        return new Promise<never>(() => {});
      }
      if (options.failingServers?.includes(serverId)) {
        throw new Error("transport closed");
      }
      if (options.emptySkills) return { skills: [] };
      return {
        skills: options.extraSkills ? [entry, ...options.extraSkills] : [entry],
      };
    }),
    getServerSkill,
    // The verified load path asks for the `skills/get` ENVELOPE; the double
    // answers it from the same entry `getServerSkill` returns.
    getServerSkillResult: vi.fn(async (serverId: string, uri: string) => ({
      skill: await getServerSkill(serverId, uri),
    })),
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
  return manager as never;
}
