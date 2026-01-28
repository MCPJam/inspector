import { authFetch } from "@/lib/session-token";
import type {
  Skill,
  SkillListItem,
  SkillFile,
  SkillFileContent,
} from "../../../../shared/skill-types";

export interface ListSkillsResponse {
  skills: SkillListItem[];
}

export interface GetSkillResponse {
  skill: Skill;
}

export interface UploadSkillResponse {
  success: boolean;
  skill: Skill;
}

/**
 * List all available skills from .mcpjam/skills/
 */
export async function listSkills(): Promise<SkillListItem[]> {
  const res = await authFetch("/api/mcp/skills/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message = body?.error || `List skills failed (${res.status})`;
    throw new Error(message);
  }

  return Array.isArray(body?.skills) ? (body.skills as SkillListItem[]) : [];
}

/**
 * Get full skill content by name
 */
export async function getSkill(name: string): Promise<Skill> {
  const res = await authFetch("/api/mcp/skills/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message = body?.error || `Get skill failed (${res.status})`;
    throw new Error(message);
  }

  return body.skill as Skill;
}

/**
 * Upload/create a new skill (legacy - JSON body)
 */
export async function uploadSkill(data: {
  name: string;
  description: string;
  content: string;
}): Promise<Skill> {
  const res = await authFetch("/api/mcp/skills/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message = body?.error || `Upload skill failed (${res.status})`;
    throw new Error(message);
  }

  return body.skill as Skill;
}

/**
 * Upload a skill folder with multiple files
 */
export async function uploadSkillFolder(
  files: File[],
  skillName: string,
): Promise<Skill> {
  const formData = new FormData();
  formData.append("skillName", skillName);

  for (const file of files) {
    // Use webkitRelativePath if available, otherwise just the filename
    const relativePath = (file as any).webkitRelativePath || file.name;
    // Strip the root folder name from the path to get relative path within skill
    const parts = relativePath.split("/");
    const pathWithinSkill =
      parts.length > 1 ? parts.slice(1).join("/") : parts[0];

    formData.append("files", file, pathWithinSkill);
  }

  const res = await authFetch("/api/mcp/skills/upload-folder", {
    method: "POST",
    body: formData,
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message = body?.error || `Upload skill failed (${res.status})`;
    throw new Error(message);
  }

  return body.skill as Skill;
}

/**
 * Delete a skill by name
 */
export async function deleteSkill(name: string): Promise<void> {
  const res = await authFetch("/api/mcp/skills/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message = body?.error || `Delete skill failed (${res.status})`;
    throw new Error(message);
  }
}

/**
 * List all files in a skill directory
 */
export async function listSkillFiles(name: string): Promise<SkillFile[]> {
  const res = await authFetch("/api/mcp/skills/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message = body?.error || `List skill files failed (${res.status})`;
    throw new Error(message);
  }

  return Array.isArray(body?.files) ? (body.files as SkillFile[]) : [];
}

/**
 * Read a specific file from a skill directory
 */
export async function readSkillFile(
  name: string,
  filePath: string,
): Promise<SkillFileContent> {
  const res = await authFetch("/api/mcp/skills/read-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, filePath }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message = body?.error || `Read skill file failed (${res.status})`;
    throw new Error(message);
  }

  return body.file as SkillFileContent;
}
