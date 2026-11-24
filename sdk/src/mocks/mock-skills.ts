import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import {
  MCP_SKILLS_EXTENSION_ID,
  sha256HexOfBytes,
  splitSkillMarkdown,
} from "../mcp-client-manager/index.js";
import type { SkillEntry } from "../mcp-client-manager/index.js";
import type { MockDefinition, MockResource } from "./definition-types.js";

/**
 * Skills (`io.modelcontextprotocol/skills`, SEP-2640): a skill is the
 * `skill://<name>/SKILL.md` resource the definition states, plus the other
 * `skill://<name>/...` resources beside it. The mock lists each with a
 * manifest of those files and the SHA-256 and size of what it will serve, so a
 * host that verifies digests accepts it. The real server's skills pass through
 * with the same treatment: a file the definition hides leaves the manifest,
 * and a file it replaces gets the new digest and size. A real skill whose
 * SKILL.md the definition replaces is replaced whole by the definition's.
 */

export const SKILLS_SETTINGS_TTL_MS = 0;
export const SKILLS_CACHE_SCOPE = "private";

const SKILL_PREFIX = "skill://";
const isSkillFile = (uri: string) => uri.startsWith(SKILL_PREFIX);
const isSkillMarkdown = (uri: string) =>
  isSkillFile(uri) && uri.toLowerCase().endsWith("/skill.md");

const ownsContent = (entry: MockResource) =>
  entry.hidden !== true &&
  (entry.text !== undefined || entry.blob !== undefined);

function bytesOf(entry: MockResource): Uint8Array {
  return entry.blob !== undefined
    ? new Uint8Array(Buffer.from(entry.blob, "base64"))
    : new TextEncoder().encode(entry.text ?? "");
}

/** Whether the definition has anything to say about skills, so the mock must answer `skills/*` itself. */
export function definitionTouchesSkills(definition: MockDefinition): boolean {
  return Object.keys(definition.resources ?? {}).some(isSkillFile);
}

/** Whether the definition serves a skill file of its own, so the mock declares the extension. */
export function definitionServesSkills(definition: MockDefinition): boolean {
  return Object.entries(definition.resources ?? {}).some(
    ([uri, entry]) => isSkillFile(uri) && ownsContent(entry)
  );
}

async function manifestEntry(uri: string, entry: MockResource) {
  const bytes = bytesOf(entry);
  return {
    uri,
    digest: `sha256:${await sha256HexOfBytes(bytes)}`,
    size: bytes.byteLength,
  };
}

async function ownSkills(definition: MockDefinition): Promise<SkillEntry[]> {
  const files = Object.entries(definition.resources ?? {}).filter(
    ([uri, entry]) => isSkillFile(uri) && ownsContent(entry)
  );
  const skills: SkillEntry[] = [];
  for (const [uri, entry] of files) {
    if (!isSkillMarkdown(uri)) continue;
    const directory = uri.slice(0, uri.length - "SKILL.md".length);
    const manifest = await Promise.all(
      files
        .filter(([other]) => other.startsWith(directory))
        .map(([other, file]) => manifestEntry(other, file))
    );
    skills.push({
      uri,
      frontmatter: splitSkillMarkdown(entry.text ?? "").frontmatter ?? {},
      resources: manifest,
    });
  }
  return skills;
}

/** One real skill with the definition's edits applied; `undefined` when the definition hides or replaces it. */
export async function adjustMockSkill(
  definition: MockDefinition,
  skill: SkillEntry
): Promise<SkillEntry | undefined> {
  const resources = definition.resources ?? {};
  const own = resources[skill.uri];
  // Hidden, or replaced whole by the definition's own SKILL.md.
  if (own && (own.hidden === true || ownsContent(own))) return undefined;
  if (!Array.isArray(skill.resources)) return skill;
  const manifest = [];
  for (const file of skill.resources) {
    const edit = resources[file.uri];
    if (edit?.hidden === true) continue;
    manifest.push(
      edit && ownsContent(edit) ? await manifestEntry(file.uri, edit) : file
    );
  }
  return { ...skill, resources: manifest };
}

/** The skills a client lists: the real server's, adjusted, then the definition's own. */
export async function listMockSkills(
  definition: MockDefinition,
  realSkills: SkillEntry[]
): Promise<SkillEntry[]> {
  const adjusted = await Promise.all(
    realSkills.map((s) => adjustMockSkill(definition, s))
  );
  const own = await ownSkills(definition);
  const ownUris = new Set(own.map((s) => s.uri));
  return [
    ...adjusted.filter(
      (s): s is SkillEntry => s !== undefined && !ownUris.has(s.uri)
    ),
    ...own,
  ];
}

export function skillNotFoundError(uri: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Skill ${uri} not found`,
    { mockCode: "mock_skill_not_found", uri }
  );
}

/** What the extension is declared as when the definition serves skills and the real server did not declare it. */
export function skillsCapability(): Record<string, object> {
  return { [MCP_SKILLS_EXTENSION_ID]: {} };
}
