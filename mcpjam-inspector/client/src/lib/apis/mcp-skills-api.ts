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
 *   - `local`: the inspector's own filesystem (`/api/mcp/skills/*`).
 *   - `cloud`: the project's durable skills in Convex (`/api/web/skills/*`).
 *     Used in hosted mode, and locally when the user toggles to Cloud.
 *
 * Cloud skills are SKILL.md-only in v1 (no supporting files). Cloud reads/writes
 * are keyed server-side by id; the client stays name-based and resolves the id
 * via the list when a mutation needs it (skill names are unique in a member's
 * visible scope, enforced by the backend).
 */
export type SkillsSource =
  | { kind: "local" }
  | { kind: "cloud"; projectId: string };

/** 'project' = shared; 'user' = personal. */
export type SkillSharing = "user" | "project";

function isCloud(
  source?: SkillsSource,
): source is { kind: "cloud"; projectId: string } {
  return source?.kind === "cloud";
}

interface CloudSkillWire {
  skillId: string;
  name: string;
  description: string;
  sharing: SkillSharing;
  isOwner: boolean;
  content?: string;
}

function cloudToListItem(s: CloudSkillWire): SkillListItem {
  return {
    name: s.name,
    description: s.description,
    path: s.sharing === "project" ? "Shared" : "Personal",
    skillId: s.skillId,
    sharing: s.sharing,
    isOwner: s.isOwner,
    origin: "cloud",
  };
}

function cloudToSkill(s: CloudSkillWire): Skill {
  return {
    name: s.name,
    description: s.description,
    content: s.content ?? "",
    path: s.sharing === "project" ? "Shared" : "Personal",
  };
}

/** Parse a SKILL.md into { description, body } for cloud create. */
function parseSkillMd(text: string): { description: string; body: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { description: "", body: text.trim() };
  const front = m[1];
  const body = (m[2] ?? "").trim();
  const desc = front.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  // Strip surrounding quotes if present.
  const description = desc.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
  return { description, body };
}

async function resolveCloudSkillId(
  projectId: string,
  name: string,
): Promise<string> {
  const body = await webPost<{ projectId: string }, { skills: CloudSkillWire[] }>(
    "/api/web/skills/list",
    { projectId },
  );
  const match = (body?.skills ?? []).find((s) => s.name === name);
  if (!match) throw new Error(`Skill '${name}' not found`);
  return match.skillId;
}

export interface ListSkillsResponse {
  skills: SkillListItem[];
}

export async function listSkills(
  source?: SkillsSource,
): Promise<SkillListItem[]> {
  if (isCloud(source)) {
    const body = await webPost<
      { projectId: string },
      { skills: CloudSkillWire[] }
    >("/api/web/skills/list", { projectId: source.projectId });
    return (body?.skills ?? []).map(cloudToListItem);
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
        throw new Error(body?.error || `List skills failed (${res.status})`);
      }
      return Array.isArray(body?.skills)
        ? (body.skills as SkillListItem[]).map((s) => ({
            ...s,
            origin: "local" as const,
          }))
        : [];
    },
  });
}

export async function getSkill(
  name: string,
  source?: SkillsSource,
): Promise<Skill> {
  if (isCloud(source)) {
    const body = await webPost<
      { projectId: string; name: string },
      { skill: CloudSkillWire }
    >("/api/web/skills/get-by-name", { projectId: source.projectId, name });
    return cloudToSkill(body.skill);
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
  if (!res.ok) throw new Error(body?.error || `Get skill failed (${res.status})`);
  return body.skill as Skill;
}

export async function uploadSkill(
  data: { name: string; description: string; content: string },
  source?: SkillsSource,
  sharing: SkillSharing = "user",
): Promise<Skill> {
  if (isCloud(source)) {
    const body = await webPost<
      {
        projectId: string;
        name: string;
        description: string;
        content: string;
        sharing: SkillSharing;
      },
      { skill: CloudSkillWire }
    >("/api/web/skills/create", {
      projectId: source.projectId,
      ...data,
      sharing,
    });
    return cloudToSkill(body.skill);
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
  if (!res.ok) throw new Error(body?.error || `Upload skill failed (${res.status})`);
  return body.skill as Skill;
}

export async function uploadSkillFolder(
  files: File[],
  skillName: string,
  source?: SkillsSource,
  sharing: SkillSharing = "user",
): Promise<Skill> {
  if (isCloud(source)) {
    // v1 cloud skills are SKILL.md-only: read the SKILL.md, create from it
    // (supporting files in the folder are ignored until v2).
    const skillMdFile = files.find(
      (f) =>
        f.name === "SKILL.md" ||
        ((f as any).webkitRelativePath || "").endsWith("/SKILL.md"),
    );
    if (!skillMdFile) throw new Error("No SKILL.md found in the folder");
    const { description, body } = parseSkillMd(await skillMdFile.text());
    return uploadSkill(
      { name: skillName, description, content: body },
      source,
      sharing,
    );
  }

  const formData = new FormData();
  formData.append("skillName", skillName);
  for (const file of files) {
    const relativePath = (file as any).webkitRelativePath || file.name;
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
    throw new Error(
      body?.error || body?.message || `Upload skill failed (${res.status})`,
    );
  }
  return body.skill as Skill;
}

export async function deleteSkill(
  name: string,
  source?: SkillsSource,
): Promise<void> {
  if (isCloud(source)) {
    const skillId = await resolveCloudSkillId(source.projectId, name);
    await webPost<
      { projectId: string; skillId: string },
      { success: boolean }
    >("/api/web/skills/delete", { projectId: source.projectId, skillId });
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
  if (!res.ok) throw new Error(body?.error || `Delete skill failed (${res.status})`);
}

/** Cloud only: promote a personal skill to project-shared (admin). */
export async function promoteSkill(
  name: string,
  projectId: string,
): Promise<void> {
  const skillId = await resolveCloudSkillId(projectId, name);
  await webPost<{ projectId: string; skillId: string }, { success: boolean }>(
    "/api/web/skills/promote",
    { projectId, skillId },
  );
}

export async function listSkillFiles(
  name: string,
  source?: SkillsSource,
): Promise<SkillFile[]> {
  if (isCloud(source)) {
    // v1 cloud skills have no supporting files.
    return [];
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
    throw new Error(body?.error || `List skill files failed (${res.status})`);
  }
  return Array.isArray(body?.files) ? (body.files as SkillFile[]) : [];
}

export async function readSkillFile(
  name: string,
  filePath: string,
  source?: SkillsSource,
): Promise<SkillFileContent> {
  if (isCloud(source)) {
    // v1: only SKILL.md exists; serve it from the skill content.
    if (filePath !== "SKILL.md") {
      throw new Error("Cloud skills have no supporting files yet");
    }
    const skill = await getSkill(name, source);
    return {
      path: "SKILL.md",
      name: "SKILL.md",
      mimeType: "text/markdown",
      size: new TextEncoder().encode(skill.content).length,
      isText: true,
      content: skill.content,
    };
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
  if (!res.ok) throw new Error(body?.error || `Read skill file failed (${res.status})`);
  return body.file as SkillFileContent;
}
