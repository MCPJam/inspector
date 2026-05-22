import { authFetch } from "@/lib/session-token";
import { runByMode } from "@/lib/apis/mode-client";
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
 * A shared (project-published) skill, sourced from Convex. Distinct from a
 * SkillListItem because it carries the publisher's identity for UI rendering
 * and the Convex row id needed for update/archive calls.
 */
export interface SharedProjectSkillSummary {
  skillId: string;
  projectId: string;
  creatorUserId: string;
  creatorName: string | null;
  creatorEmail: string | null;
  creatorImageUrl: string | null;
  name: string;
  description: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

/**
 * List all available skills from .mcpjam/skills/
 */
export async function listSkills(
  opts?: { projectId?: string },
): Promise<SkillListItem[]> {
  return runByMode({
    hosted: async () => [],
    local: async () => {
      const res = await authFetch("/api/mcp/skills/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: opts?.projectId }),
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
 * List project-shared (published) skills. Returns [] when not signed in or
 * when no projectId is available; the popover treats that as "show local
 * skills only".
 */
export async function listProjectSkills(
  projectId: string,
  convexAuthToken: string,
): Promise<SharedProjectSkillSummary[]> {
  if (!projectId || !convexAuthToken) return [];
  const res = await authFetch("/api/mcp/skills/list-project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, convexAuthToken }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const message =
      body?.error || `List project skills failed (${res.status})`;
    throw new Error(message);
  }

  return Array.isArray(body?.skills)
    ? (body.skills as SharedProjectSkillSummary[])
    : [];
}

/**
 * Trigger a server-side sync that pulls the project's shared skills from
 * Convex onto disk so the filesystem-backed loader can use them.
 */
export async function syncProjectSkills(
  projectId: string,
  convexAuthToken: string,
): Promise<{
  materialized: string[];
  pruned: number;
  cacheDir: string;
}> {
  const res = await authFetch("/api/mcp/skills/sync-project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, convexAuthToken }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `Sync project skills failed (${res.status})`);
  }
  return body;
}

/**
 * Publish a local skill (by name) to the current project. Server reads the
 * full bundle from the filesystem and writes it to Convex. Returns a
 * structured `nameCollision` code when an active skill in the same project
 * already uses the requested name.
 */
export async function publishSkillToProject(args: {
  projectId: string;
  convexAuthToken: string;
  name: string;
  publishAs?: string;
}): Promise<
  | { kind: "ok"; skill: SharedProjectSkillSummary }
  | { kind: "nameCollision"; message: string }
> {
  const res = await authFetch("/api/mcp/skills/publish-to-project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 && body?.code === "nameCollision") {
    return { kind: "nameCollision", message: body.error };
  }
  if (!res.ok) {
    throw new Error(body?.error || `Publish failed (${res.status})`);
  }
  return { kind: "ok", skill: body.skill as SharedProjectSkillSummary };
}

/**
 * Push the local copy of a previously-published skill back to Convex.
 */
export async function updatePublishedSkill(args: {
  skillId: string;
  convexAuthToken: string;
  sourceName: string;
}): Promise<SharedProjectSkillSummary> {
  const res = await authFetch("/api/mcp/skills/update-published", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `Update failed (${res.status})`);
  }
  return body.skill as SharedProjectSkillSummary;
}

/**
 * Archive (unshare) a published skill in Convex. Creator or admin/owner.
 */
export async function archivePublishedSkill(args: {
  skillId: string;
  convexAuthToken: string;
}): Promise<void> {
  const res = await authFetch("/api/mcp/skills/archive-published", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `Archive failed (${res.status})`);
  }
}

/**
 * Get full skill content by name
 */
export async function getSkill(
  name: string,
  opts?: { projectId?: string },
): Promise<Skill> {
  const res = await authFetch("/api/mcp/skills/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, projectId: opts?.projectId }),
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
export async function listSkillFiles(
  name: string,
  opts?: { projectId?: string },
): Promise<SkillFile[]> {
  const res = await authFetch("/api/mcp/skills/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, projectId: opts?.projectId }),
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
  opts?: { projectId?: string },
): Promise<SkillFileContent> {
  const res = await authFetch("/api/mcp/skills/read-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, filePath, projectId: opts?.projectId }),
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
