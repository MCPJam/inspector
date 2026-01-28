import matter from "gray-matter";
import fs from "fs/promises";
import path from "path";
import { logger } from "./logger";
import {
  isValidSkillName,
  type Skill,
  type SkillListItem,
  type SkillFrontmatter,
  type SkillFile,
} from "../../shared/skill-types";

// Re-export for backward compatibility
export { isValidSkillName };

/**
 * Common MIME type mappings by extension
 */
const MIME_TYPES: Record<string, string> = {
  // Text files
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",

  // Programming languages
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-cpp",
  ".h": "text/x-c",
  ".hpp": "text/x-cpp",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".fish": "text/x-shellscript",
  ".ps1": "text/x-powershell",
  ".sql": "text/x-sql",
  ".php": "text/x-php",
  ".swift": "text/x-swift",
  ".kt": "text/x-kotlin",
  ".scala": "text/x-scala",
  ".lua": "text/x-lua",
  ".r": "text/x-r",
  ".R": "text/x-r",

  // Config files
  ".toml": "application/toml",
  ".ini": "text/x-ini",
  ".conf": "text/plain",
  ".env": "text/plain",
  ".gitignore": "text/plain",
  ".editorconfig": "text/plain",

  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",

  // Binary/other
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
};

/**
 * Text MIME type prefixes
 */
const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/toml",
  "image/svg+xml",
];

/**
 * Get MIME type from file path
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Check if MIME type represents text content
 */
export function isTextMimeType(mimeType: string): boolean {
  return TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

/**
 * Validate that a path is within a base directory (path traversal protection)
 */
export function isPathWithinDirectory(
  baseDir: string,
  targetPath: string,
): boolean {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(baseDir, targetPath);
  return (
    resolvedTarget.startsWith(resolvedBase + path.sep) ||
    resolvedTarget === resolvedBase
  );
}

/**
 * Recursively list all files in a directory
 */
export async function listFilesRecursive(
  dirPath: string,
  relativeTo: string = dirPath,
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(relativeTo, fullPath);
      const ext = path.extname(entry.name).toLowerCase();

      if (entry.isDirectory()) {
        const children = await listFilesRecursive(fullPath, relativeTo);
        files.push({
          path: relativePath,
          name: entry.name,
          type: "directory",
          children,
        });
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          const mimeType = getMimeType(entry.name);
          files.push({
            path: relativePath,
            name: entry.name,
            type: "file",
            size: stat.size,
            mimeType,
            extension: ext || undefined,
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  } catch {
    // Return empty array if directory doesn't exist or can't be read
  }

  // Sort: directories first (alphabetically), then files (alphabetically), but SKILL.md always first
  return files.sort((a, b) => {
    // SKILL.md always first
    if (a.name === "SKILL.md") return -1;
    if (b.name === "SKILL.md") return 1;

    // Directories before files
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;

    // Alphabetical within same type
    return a.name.localeCompare(b.name);
  });
}

/**
 * Parses a SKILL.md file content and extracts frontmatter and body
 */
export function parseSkillFile(
  fileContent: string,
  skillPath: string,
): Skill | null {
  try {
    const parsed = matter(fileContent);

    const frontmatter = parsed.data as Partial<SkillFrontmatter>;

    // Validate required fields
    if (!frontmatter.name || typeof frontmatter.name !== "string") {
      logger.warn(`Skill at ${skillPath} missing required 'name' field`);
      return null;
    }

    if (
      !frontmatter.description ||
      typeof frontmatter.description !== "string"
    ) {
      logger.warn(`Skill at ${skillPath} missing required 'description' field`);
      return null;
    }

    // Validate description length per Agent Skills spec (max 1024 characters)
    if (frontmatter.description.length > 1024) {
      logger.warn(
        `Skill at ${skillPath} has description exceeding 1024 characters`,
      );
      return null;
    }

    // Validate name format
    if (!isValidSkillName(frontmatter.name)) {
      logger.warn(
        `Skill at ${skillPath} has invalid name format: ${frontmatter.name}`,
      );
      return null;
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      content: parsed.content.trim(),
      path: skillPath,
    };
  } catch (error) {
    logger.error(`Error parsing skill file at ${skillPath}:`, error);
    return null;
  }
}

/**
 * Converts a Skill to a SkillListItem (without content)
 */
export function skillToListItem(skill: Skill): SkillListItem {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
  };
}

/**
 * Generates SKILL.md content from skill data
 */
export function generateSkillFileContent(
  name: string,
  description: string,
  content: string,
): string {
  const frontmatter = `---
name: ${name}
description: ${description}
---`;

  return `${frontmatter}\n\n${content}`;
}
