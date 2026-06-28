import { authFetch } from "@/lib/session-token";
import { runByMode } from "@/lib/apis/mode-client";
import { webPost } from "@/lib/apis/web/base";
import type {
  Skill,
  SkillListItem,
  SkillFile,
  SkillFileContent,
} from "../../../../shared/skill-types";

/**
 * Where skills are read from / written to:
 *   - `local`: the inspector's own filesystem (`/api/mcp/skills/*`). The
 *     default and the only option for local builds without a computer.
 *   - `cloud`: the project's Computer (E2B sandbox) via `/api/web/skills/*`.
 *     Used in hosted mode, and locally when the user toggles to Cloud.
 *
 * Passing `source` is optional and backward-compatible: omitting it preserves
 * the original local behavior (and the hosted `listSkills() → []` contract).
 */
export type SkillsSource =
  | { kind: "local" }
  | { kind: "cloud"; projectId: string };

function isCloud(
  source?: SkillsSource,
): source is { kind: "cloud"; projectId: string } {
  return source?.kind === "cloud";
}

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
 * List all available skills.
 */
export async function listSkills(
  source?: SkillsSource,
): Promise<SkillListItem[]> {
  if (isCloud(source)) {
    const body = await webPost<{ projectId: string }, ListSkillsResponse>(
      "/api/web/skills/list",
      { projectId: source.projectId },
    );
    return Array.isArray(body?.skills) ? body.skills : [];
  }

  return runByMode({
    hosted: async () => [],
    local: async () => {
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

      return Array.isArray(body?.skills)
        ? (body.skills as SkillListItem[])
        : [];
    },
  });
}

/**
 * Get full skill content by name
 */
export async function getSkill(
  name: string,
  source?: SkillsSource,
): Promise<Skill> {
  if (isCloud(source)) {
    const body = await webPost<
      { projectId: string; name: string },
      GetSkillResponse
    >("/api/web/skills/get", { projectId: source.projectId, name });
    return body.skill;
  }

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
export async function uploadSkill(
  data: {
    name: string;
    description: string;
    content: string;
  },
  source?: SkillsSource,
): Promise<Skill> {
  if (isCloud(source)) {
    const body = await webPost<
      { projectId: string; name: string; description: string; content: string },
      UploadSkillResponse
    >("/api/web/skills/upload", { projectId: source.projectId, ...data });
    return body.skill;
  }

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
  source?: SkillsSource,
): Promise<Skill> {
  const formData = new FormData();
  formData.append("skillName", skillName);
  if (isCloud(source)) {
    formData.append("projectId", source.projectId);
  }

  for (const file of files) {
    // Use webkitRelativePath if available, otherwise just the filename
    const relativePath = (file as any).webkitRelativePath || file.name;
    // Strip the root folder name from the path to get relative path within skill
    const parts = relativePath.split("/");
    const pathWithinSkill =
      parts.length > 1 ? parts.slice(1).join("/") : parts[0];

    formData.append("files", file, pathWithinSkill);
  }

  const endpoint = isCloud(source)
    ? "/api/web/skills/upload-folder"
    : "/api/mcp/skills/upload-folder";
  const res = await authFetch(endpoint, {
    method: "POST",
    body: formData,
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message =
      body?.error || body?.message || `Upload skill failed (${res.status})`;
    throw new Error(message);
  }

  return body.skill as Skill;
}

/**
 * Delete a skill by name
 */
export async function deleteSkill(
  name: string,
  source?: SkillsSource,
): Promise<void> {
  if (isCloud(source)) {
    await webPost<{ projectId: string; name: string }, { success: boolean }>(
      "/api/web/skills/delete",
      { projectId: source.projectId, name },
    );
    return;
  }

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
export async function listSkillFiles(
  name: string,
  source?: SkillsSource,
): Promise<SkillFile[]> {
  if (isCloud(source)) {
    const body = await webPost<
      { projectId: string; name: string },
      { files: SkillFile[] }
    >("/api/web/skills/files", { projectId: source.projectId, name });
    return Array.isArray(body?.files) ? body.files : [];
  }

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
  source?: SkillsSource,
): Promise<SkillFileContent> {
  if (isCloud(source)) {
    const body = await webPost<
      { projectId: string; name: string; filePath: string },
      { file: SkillFileContent }
    >("/api/web/skills/read-file", {
      projectId: source.projectId,
      name,
      filePath,
    });
    return body.file;
  }

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
