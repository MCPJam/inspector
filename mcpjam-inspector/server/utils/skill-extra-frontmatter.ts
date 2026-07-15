/**
 * The ONE extractor for preserved Agent-Skills-spec extra frontmatter
 * (`license` / `compatibility` / `allowed-tools` / `metadata`), shared by the
 * sandbox-adoption scan (`harness/adopt-sandbox-skills.ts`) and the web
 * folder-upload create route (`routes/web/skills.ts`). Both paths must derive
 * the identical shape from a raw SKILL.md — the backend re-validates and
 * size-caps whatever is forwarded.
 */
import matter from "gray-matter";
import { parseSkillFile } from "./skill-parser.js";
import type { SkillExtraFrontmatterInput } from "./computers/convex-skills-client.js";

/** Extract the preserved optional spec frontmatter (best-effort, lenient). */
export function extractExtraFrontmatter(
  data: Record<string, unknown>
): SkillExtraFrontmatterInput | undefined {
  const out: SkillExtraFrontmatterInput = {};
  if (typeof data.license === "string") out.license = data.license;
  if (typeof data.compatibility === "string") {
    out.compatibility = data.compatibility;
  }
  // `allowed-tools` may be a comma-separated string (Claude Code) or a YAML list.
  const allowed = data["allowed-tools"] ?? data.allowedTools;
  if (typeof allowed === "string") {
    const list = allowed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) out.allowedTools = list;
  } else if (Array.isArray(allowed)) {
    const list = allowed.filter((t): t is string => typeof t === "string");
    if (list.length > 0) out.allowedTools = list;
  }
  if (
    data.metadata &&
    typeof data.metadata === "object" &&
    !Array.isArray(data.metadata)
  ) {
    const md: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      data.metadata as Record<string, unknown>
    )) {
      md[k] = typeof v === "string" ? v : String(v);
    }
    if (Object.keys(md).length > 0) out.metadata = md;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A raw SKILL.md parsed for a cloud create: core fields + preserved extras. */
export interface ParsedSkillMdWithExtras {
  name: string;
  description: string;
  content: string;
  extraFrontmatter?: SkillExtraFrontmatterInput;
}

/**
 * Parse a raw SKILL.md into the authoritative create payload: core fields via
 * `parseSkillFile` (name/description validation + body trim) plus the preserved
 * extra frontmatter. Returns `null` when the SKILL.md is unusable (missing or
 * invalid name/description, unparseable frontmatter) — same rejection rules as
 * the local-FS skill reader.
 */
export function parseSkillMdWithExtras(
  raw: string,
  sourceLabel: string
): ParsedSkillMdWithExtras | null {
  const skill = parseSkillFile(raw, sourceLabel);
  if (!skill) return null;
  let data: Record<string, unknown>;
  try {
    data = matter(raw).data as Record<string, unknown>;
  } catch {
    return null;
  }
  const extraFrontmatter = extractExtraFrontmatter(data);
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    ...(extraFrontmatter ? { extraFrontmatter } : {}),
  };
}
