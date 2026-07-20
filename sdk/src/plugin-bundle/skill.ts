/**
 * Plugin skill (`skills/<dir>/SKILL.md`) parsing and validation.
 *
 * Mirrors the Agent Skills rules the inspector already enforces (kebab-case
 * name, required description <= 1024 chars) without Node dependencies: the
 * frontmatter and `agents/openai.yaml` metadata use a deliberately small
 * YAML subset (scalars, `- ` lists, `|`/`>` blocks). Lines the subset cannot
 * interpret are preserved raw and reported as warnings — never guessed at.
 * Scripts are never executed during import.
 */

import { computeAggregateHash } from "./hashes.js";
import { MAX_VALUE_DEPTH, type PluginIssueCollector } from "./validation.js";

export const SKILLS_DIR = "skills";
export const SKILL_FILE_NAME = "SKILL.md";
export const SKILL_OPENAI_METADATA_PATH = "agents/openai.yaml";

const SKILL_NAME_MAX_LENGTH = 64;
const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** Mirrors `isValidSkillName` from the inspector's shared skill types. */
export function isValidPluginSkillName(name: string): boolean {
  if (name.length < 1 || name.length > SKILL_NAME_MAX_LENGTH) return false;
  if (name.includes("--")) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
}

export interface PluginSkillFileInput {
  /** Canonical bundle path. */
  path: string;
  size: number;
  contentHash: string;
}

export interface ParsedPluginSkillFile {
  /** Canonical bundle path. */
  path: string;
  /** Path relative to the skill directory. */
  relativePath: string;
  size: number;
  contentHash: string;
}

export interface ParsedPluginSkillOpenAiMetadata {
  /** Canonical bundle path of `agents/openai.yaml`. */
  path: string;
  /** Parsed key/value data (YAML subset). */
  data: Record<string, unknown>;
}

export interface ParsedPluginSkill {
  /** `skill:<directory-name>` — stable component identity. */
  componentKey: string;
  /** `skills/<directory-name>` canonical bundle path. */
  directory: string;
  directoryName: string;
  skillFilePath: string;
  /** Declared frontmatter name. */
  name: string;
  description: string;
  /** Model-facing namespaced reference: `<plugin-name>/<skill-name>`. */
  modelRef: string;
  /** SKILL.md body with frontmatter stripped. */
  instructions: string;
  /** Parsed frontmatter, including preserved optional OpenAI metadata. */
  frontmatter: Record<string, unknown>;
  /** Raw frontmatter text for lossless round-tripping. */
  frontmatterRaw: string;
  allowImplicitInvocation?: boolean;
  /** MCP tool dependencies declared in frontmatter or agents/openai.yaml. */
  mcpToolDependencies: string[];
  openaiMetadata?: ParsedPluginSkillOpenAiMetadata;
  /** Every skill-directory file except SKILL.md itself. */
  supportingFiles: ParsedPluginSkillFile[];
  /** SHA-256 of the raw SKILL.md bytes. */
  contentHash: string;
  /** Aggregate hash over every skill-directory file (relative path + bytes). */
  aggregateHash: string;
}

export interface YamlLiteResult {
  data: Record<string, unknown>;
  /** Raw lines the YAML subset could not interpret. */
  unparsed: string[];
  /** Raw lines whose value exceeded `MAX_VALUE_DEPTH` (hostile nesting). */
  tooDeep: string[];
}

/** Internal signal: a flow-sequence value exceeded `MAX_VALUE_DEPTH`. */
class YamlValueTooDeepError extends Error {
  constructor() {
    super("yaml value nests too deeply");
    this.name = "YamlValueTooDeepError";
  }
}

function parseScalar(raw: string, depth = 0): unknown {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    // Depth cap so a hostile "[[[[...]]]]" value surfaces as a stable
    // VALUE_TOO_DEEP issue instead of a raw RangeError from the recursion.
    if (depth >= MAX_VALUE_DEPTH) {
      throw new YamlValueTooDeepError();
    }
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => parseScalar(item, depth + 1));
  }
  return trimmed;
}

/**
 * Deliberately small YAML subset: top-level `key: scalar`, `key:` + `- item`
 * lists, and `|` / `>` block scalars. Anything else (nested maps, anchors,
 * multi-documents) lands in `unparsed` so callers can warn without guessing.
 */
export function parseYamlLite(text: string): YamlLiteResult {
  const data: Record<string, unknown> = {};
  const unparsed: string[] = [];
  const tooDeep: string[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const keyMatch = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!keyMatch) {
      unparsed.push(line);
      i++;
      continue;
    }
    const key = keyMatch[1];
    const rest = keyMatch[2];

    if (rest === "") {
      // List or (unsupported) nested block.
      const items: unknown[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (/^\s*$/.test(next) || /^\s*#/.test(next)) {
          j++;
          continue;
        }
        const listMatch = /^\s+-\s*(.*)$/.exec(next);
        if (listMatch) {
          try {
            items.push(parseScalar(listMatch[1]));
          } catch (error) {
            if (!(error instanceof YamlValueTooDeepError)) throw error;
            tooDeep.push(next);
          }
          j++;
          continue;
        }
        if (/^\s+\S/.test(next)) {
          unparsed.push(next);
          j++;
          continue;
        }
        break;
      }
      if (items.length > 0) data[key] = items;
      else data[key] = "";
      i = j;
      continue;
    }

    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      const blockLines: string[] = [];
      let indent: number | null = null;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (/^\s*$/.test(next)) {
          blockLines.push("");
          j++;
          continue;
        }
        const currentIndent = next.length - next.trimStart().length;
        if (currentIndent === 0) break;
        if (indent === null) indent = currentIndent;
        blockLines.push(next.slice(Math.min(indent, currentIndent)));
        j++;
      }
      while (
        blockLines.length > 0 &&
        blockLines[blockLines.length - 1] === ""
      ) {
        blockLines.pop();
      }
      data[key] = rest.startsWith("|")
        ? blockLines.join("\n")
        : blockLines.map((blockLine) => blockLine || "\n").join(" ");
      i = j;
      continue;
    }

    try {
      data[key] = parseScalar(rest);
    } catch (error) {
      if (!(error instanceof YamlValueTooDeepError)) throw error;
      tooDeep.push(line);
    }
    i++;
  }

  return { data, unparsed, tooDeep };
}

export interface SplitFrontmatterResult {
  frontmatter: string;
  body: string;
}

export function splitFrontmatter(text: string): SplitFrontmatterResult | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function readStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((item) => typeof item !== "string")) return null;
  return value as string[];
}

export interface ParsePluginSkillArgs {
  /** Normalized manifest name — used for the namespaced model ref. */
  pluginName: string;
  /** `skills/<directoryName>` canonical bundle path. */
  directory: string;
  directoryName: string;
  skillFilePath: string;
  /** Decoded SKILL.md text. */
  skillText: string;
  /** SHA-256 of the raw SKILL.md bytes. */
  skillContentHash: string;
  /** Every file in the skill directory (including SKILL.md), with hashes. */
  files: PluginSkillFileInput[];
  /** Decoded `agents/openai.yaml`, when the skill ships one. */
  openaiYaml?: { path: string; text: string };
  issues: PluginIssueCollector;
}

/** Parse and validate one skill directory. Returns `null` on fatal issues. */
export async function parsePluginSkill(
  args: ParsePluginSkillArgs
): Promise<ParsedPluginSkill | null> {
  const {
    pluginName,
    directory,
    directoryName,
    skillFilePath,
    skillText,
    skillContentHash,
    files,
    openaiYaml,
    issues,
  } = args;
  const componentKey = `skill:${directoryName}`;
  const context = { path: skillFilePath, componentKey };

  const split = splitFrontmatter(skillText);
  if (split === null) {
    issues.error(
      "SKILL_FRONTMATTER_MISSING",
      `skill "${directoryName}" is missing YAML frontmatter in SKILL.md`,
      context
    );
    return null;
  }

  const {
    data: frontmatter,
    unparsed,
    tooDeep,
  } = parseYamlLite(split.frontmatter);
  for (const line of unparsed) {
    issues.warn(
      "SKILL_FRONTMATTER_UNPARSED",
      `skill "${directoryName}": frontmatter line not interpreted: ${line.trim()}`,
      context
    );
  }
  for (const line of tooDeep) {
    issues.error(
      "VALUE_TOO_DEEP",
      `skill "${directoryName}": frontmatter value nests deeper than ${MAX_VALUE_DEPTH} levels: ${line
        .trim()
        .slice(0, 80)}`,
      context
    );
  }

  const name = frontmatter.name;
  if (typeof name !== "string" || name.length === 0) {
    issues.error(
      "SKILL_MISSING_NAME",
      `skill "${directoryName}" is missing the required "name" field`,
      context
    );
    return null;
  }
  if (!isValidPluginSkillName(name)) {
    issues.error(
      "SKILL_INVALID_NAME",
      `skill name "${name}" must be kebab-case ([a-z0-9-], 1-${SKILL_NAME_MAX_LENGTH} chars, no "--")`,
      context
    );
    return null;
  }
  if (name !== directoryName) {
    issues.warn(
      "SKILL_NAME_MISMATCH",
      `skill name "${name}" does not match its directory "${directoryName}"`,
      context
    );
  }

  const description = frontmatter.description;
  if (typeof description !== "string" || description.length === 0) {
    issues.error(
      "SKILL_MISSING_DESCRIPTION",
      `skill "${directoryName}" is missing the required "description" field`,
      context
    );
    return null;
  }
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    issues.error(
      "SKILL_DESCRIPTION_TOO_LONG",
      `skill "${directoryName}" description exceeds ${SKILL_DESCRIPTION_MAX_LENGTH} characters`,
      context
    );
    return null;
  }

  // Optional OpenAI metadata: frontmatter first, agents/openai.yaml wins.
  let openaiMetadata: ParsedPluginSkillOpenAiMetadata | undefined;
  if (openaiYaml !== undefined) {
    const parsed = parseYamlLite(openaiYaml.text);
    for (const line of parsed.unparsed) {
      issues.warn(
        "SKILL_INVALID_METADATA",
        `skill "${directoryName}": openai.yaml line not interpreted: ${line.trim()}`,
        { path: openaiYaml.path, componentKey }
      );
    }
    for (const line of parsed.tooDeep) {
      issues.error(
        "VALUE_TOO_DEEP",
        `skill "${directoryName}": openai.yaml value nests deeper than ${MAX_VALUE_DEPTH} levels: ${line
          .trim()
          .slice(0, 80)}`,
        { path: openaiYaml.path, componentKey }
      );
    }
    openaiMetadata = { path: openaiYaml.path, data: parsed.data };
  }

  let allowImplicitInvocation: boolean | undefined;
  for (const source of [frontmatter, openaiMetadata?.data]) {
    const value = source?.allow_implicit_invocation;
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      issues.warn(
        "SKILL_INVALID_METADATA",
        `skill "${directoryName}": "allow_implicit_invocation" must be a boolean`,
        context
      );
      continue;
    }
    allowImplicitInvocation = value;
  }

  const mcpToolDependencies: string[] = [];
  for (const source of [frontmatter, openaiMetadata?.data]) {
    const value = source?.mcp_tools;
    if (value === undefined) continue;
    const tools = readStringList(value);
    if (tools === null) {
      issues.warn(
        "SKILL_INVALID_METADATA",
        `skill "${directoryName}": "mcp_tools" must be a list of strings`,
        context
      );
      continue;
    }
    for (const tool of tools) {
      if (!mcpToolDependencies.includes(tool)) mcpToolDependencies.push(tool);
    }
  }

  const supportingFiles: ParsedPluginSkillFile[] = files
    .filter((file) => file.path !== skillFilePath)
    .map((file) => ({
      path: file.path,
      relativePath: file.path.slice(directory.length + 1),
      size: file.size,
      contentHash: file.contentHash,
    }));

  const aggregateHash = await computeAggregateHash(
    files.map((file) => ({
      path: file.path.slice(directory.length + 1),
      contentHash: file.contentHash,
    }))
  );

  return {
    componentKey,
    directory,
    directoryName,
    skillFilePath,
    name,
    description,
    modelRef: `${pluginName}/${name}`,
    instructions: split.body.trim(),
    frontmatter,
    frontmatterRaw: split.frontmatter,
    ...(allowImplicitInvocation !== undefined
      ? { allowImplicitInvocation }
      : {}),
    mcpToolDependencies,
    ...(openaiMetadata !== undefined ? { openaiMetadata } : {}),
    supportingFiles,
    contentHash: skillContentHash,
    aggregateHash,
  };
}
