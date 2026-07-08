import { authFetch } from "@/lib/session-token";
import { runByMode } from "@/lib/apis/mode-client";
import { webPost } from "@/lib/apis/web/base";
import type {
  Skill,
  SkillListItem,
  SkillProvenance,
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
  source?: SkillsSource
): source is { kind: "cloud"; projectId: string } {
  return source?.kind === "cloud";
}

interface CloudSkillWire {
  skillId: string;
  name: string;
  description: string;
  sharing: SkillSharing;
  isOwner: boolean;
  /** Wire-tolerant; absent/unknown ⇒ 'authored'. */
  provenance?: string;
  content?: string;
}

/** Normalize a wire provenance (unknown ⇒ 'authored'), mirroring the backend. */
function normalizeProvenance(value: string | undefined): SkillProvenance {
  return value === "computer-adopted" ? "computer-adopted" : "authored";
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
    provenance: normalizeProvenance(s.provenance),
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
  const description = desc
    .replace(/^"(.*)"$/s, "$1")
    .replace(/^'(.*)'$/s, "$1");
  return { description, body };
}

/** The path of an uploaded file WITHIN its skill dir (strip the top folder). */
function skillRelativePath(file: File): string {
  const relativePath = (file as any).webkitRelativePath || file.name;
  const parts = relativePath.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : parts[0];
}

/** Hex sha256 of raw bytes (per-file content hash; folded into aggregateHash). */
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function resolveCloudSkillId(
  projectId: string,
  name: string
): Promise<string> {
  const body = await webPost<
    { projectId: string },
    { skills: CloudSkillWire[] }
  >("/api/web/skills/list", { projectId });
  const match = (body?.skills ?? []).find((s) => s.name === name);
  if (!match) throw new Error(`Skill '${name}' not found`);
  return match.skillId;
}

export interface ListSkillsResponse {
  skills: SkillListItem[];
}

export async function listSkills(
  source?: SkillsSource
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
  source?: SkillsSource
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
  if (!res.ok)
    throw new Error(body?.error || `Get skill failed (${res.status})`);
  return body.skill as Skill;
}

export async function uploadSkill(
  data: {
    name: string;
    description: string;
    content: string;
    /**
     * The RAW SKILL.md text, when the caller has it. Cloud create parses it
     * SERVER-SIDE so preserved frontmatter (`allowed-tools` / `license` / …)
     * survives the upload — the local `parseSkillMd` here only extracts
     * description/body. Ignored by the local-FS path.
     */
    skillMd?: string;
  },
  source?: SkillsSource,
  sharing: SkillSharing = "user"
): Promise<Skill> {
  const { skillMd, ...fields } = data;
  if (isCloud(source)) {
    const body = await webPost<
      {
        projectId: string;
        name: string;
        description: string;
        content: string;
        sharing: SkillSharing;
        skillMd?: string;
      },
      { skill: CloudSkillWire }
    >("/api/web/skills/create", {
      projectId: source.projectId,
      ...fields,
      sharing,
      ...(skillMd !== undefined ? { skillMd } : {}),
    });
    return cloudToSkill(body.skill);
  }

  const res = await authFetch("/api/mcp/skills/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok)
    throw new Error(body?.error || `Upload skill failed (${res.status})`);
  return body.skill as Skill;
}

export async function uploadSkillFolder(
  files: File[],
  skillName: string,
  source?: SkillsSource,
  sharing: SkillSharing = "user"
): Promise<Skill> {
  if (isCloud(source)) {
    const skillMdFile = files.find(
      (f) =>
        f.name === "SKILL.md" ||
        ((f as any).webkitRelativePath || "").endsWith("/SKILL.md")
    );
    if (!skillMdFile) throw new Error("No SKILL.md found in the folder");
    // 1. Create the skill from SKILL.md. A 409 here is a genuine name
    // conflict: the supporting-file phase below ROLLS BACK the created skill
    // on any failure, so a partial upload never persists and there is no
    // half-uploaded state to resume.
    // Send the RAW SKILL.md too: the server parses it authoritatively so
    // preserved frontmatter (allowed-tools / license / …) survives; the local
    // parse below only feeds the legacy description/content fields.
    const rawSkillMd = await skillMdFile.text();
    const { description, body } = parseSkillMd(rawSkillMd);
    const supporting = files.filter((f) => f !== skillMdFile);
    const skill = await uploadSkill(
      { name: skillName, description, content: body, skillMd: rawSkillMd },
      source,
      sharing
    );

    // 2. Upload supporting files DIRECTLY to Convex (bypasses inspector body
    // limits), then batch-register them. ATOMIC from the user's perspective:
    // any failure best-effort deletes the just-created skill and throws, so a
    // retry starts clean instead of half-saved.
    if (supporting.length === 0) return skill;

    const failedPaths: string[] = [];
    let skillId: string | null = null;
    try {
      skillId = await resolveCloudSkillId(source.projectId, skillName);
    } catch {
      // Can't even address the created skill's file APIs — treat every
      // supporting file as failed so the rollback below runs.
      failedPaths.push(...supporting.map(skillRelativePath));
    }
    if (skillId) {
      const attachInputs: {
        path: string;
        storageId: string;
        contentHash: string;
      }[] = [];
      for (const f of supporting) {
        const path = skillRelativePath(f);
        try {
          const { uploadUrl } = await webPost<
            { projectId: string; skillId: string },
            { uploadUrl: string }
          >("/api/web/skills/files/upload-url", {
            projectId: source.projectId,
            skillId,
          });
          const buf = await f.arrayBuffer();
          const putRes = await fetch(uploadUrl, {
            method: "POST",
            headers: {
              "Content-Type": f.type || "application/octet-stream",
            },
            body: buf,
          });
          if (!putRes.ok) throw new Error(`upload failed (${putRes.status})`);
          const { storageId } = (await putRes.json()) as { storageId: string };
          attachInputs.push({
            path,
            storageId,
            contentHash: await sha256Hex(buf),
          });
        } catch {
          failedPaths.push(path);
        }
      }
      if (attachInputs.length > 0) {
        try {
          await webPost<
            {
              projectId: string;
              skillId: string;
              files: typeof attachInputs;
            },
            { files: unknown }
          >("/api/web/skills/files/attach", {
            projectId: source.projectId,
            skillId,
            files: attachInputs,
          });
        } catch {
          failedPaths.push(...attachInputs.map((a) => a.path));
        }
      }
    }
    if (failedPaths.length > 0) {
      // Roll back the created skill so nothing partial persists. Best-effort:
      // if the rollback itself fails, surface BOTH facts so the user knows a
      // half-created skill is left behind.
      let rollbackFailed = false;
      try {
        await deleteSkill(skillName, source);
      } catch {
        rollbackFailed = true;
      }
      const failing = failedPaths.join(", ");
      if (rollbackFailed) {
        throw new Error(
          `Upload failed — ${failedPaths.length} supporting file(s) failed ` +
            `(${failing}), and removing the partially created skill also ` +
            `failed. Delete skill '${skillName}' manually, then fix the ` +
            `failing files and retry.`
        );
      }
      throw new Error(
        `Upload failed — nothing was saved. Fix the failing files ` +
          `(${failing}) and retry.`
      );
    }
    return skill;
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
      body?.error || body?.message || `Upload skill failed (${res.status})`
    );
  }
  return body.skill as Skill;
}

/**
 * Update a cloud skill's editable fields by id. Cloud-only in v1 (local FS skill
 * editing is out of scope). The first UI caller of the previously-unused update
 * chain; the server 403s if the caller may not manage this skill.
 * `name` is deliberately NOT updatable — skill names are immutable in v1 (the
 * backend rejects renames; on-box dirs and pins key off the name).
 */
export async function updateSkill(
  skillId: string,
  data: { description?: string; content?: string },
  source?: SkillsSource
): Promise<Skill> {
  if (!isCloud(source)) {
    throw new Error("Editing is only supported for cloud skills.");
  }
  const body = await webPost<
    {
      projectId: string;
      skillId: string;
      description?: string;
      content?: string;
    },
    { skill: CloudSkillWire }
  >("/api/web/skills/update", {
    projectId: source.projectId,
    skillId,
    ...data,
  });
  return cloudToSkill(body.skill);
}

export async function deleteSkill(
  name: string,
  source?: SkillsSource
): Promise<void> {
  if (isCloud(source)) {
    const skillId = await resolveCloudSkillId(source.projectId, name);
    await webPost<{ projectId: string; skillId: string }, { success: boolean }>(
      "/api/web/skills/delete",
      { projectId: source.projectId, skillId }
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
  if (!res.ok)
    throw new Error(body?.error || `Delete skill failed (${res.status})`);
}

/** Cloud only: promote a personal skill to project-shared (admin). */
export async function promoteSkill(
  name: string,
  projectId: string
): Promise<void> {
  const skillId = await resolveCloudSkillId(projectId, name);
  await webPost<{ projectId: string; skillId: string }, { success: boolean }>(
    "/api/web/skills/promote",
    { projectId, skillId }
  );
}

/** Metadata for one cloud supporting file (mirrors the backend view). */
interface CloudSkillFileWire {
  path: string;
  size: number;
  contentHash: string;
  updatedAt: number;
}

/**
 * Build a nested {@link SkillFile} tree from flat cloud file paths, with a
 * synthetic SKILL.md node first (mirroring the local FS tree, which includes the
 * SKILL.md the cloud stores as the skill body). Directories are inferred.
 */
export function buildSkillFileTree(files: CloudSkillFileWire[]): SkillFile[] {
  const root: SkillFile[] = [
    {
      path: "SKILL.md",
      name: "SKILL.md",
      type: "file",
      mimeType: "text/markdown",
    },
  ];
  const dirIndex = new Map<string, SkillFile>(); // dir path → node

  const ensureDir = (dirPath: string): SkillFile[] => {
    if (dirPath === "") return root;
    const existing = dirIndex.get(dirPath);
    if (existing) return existing.children!;
    const parts = dirPath.split("/");
    const name = parts[parts.length - 1];
    const parentChildren = ensureDir(parts.slice(0, -1).join("/"));
    const node: SkillFile = {
      path: dirPath,
      name,
      type: "directory",
      children: [],
    };
    dirIndex.set(dirPath, node);
    parentChildren.push(node);
    return node.children!;
  };

  for (const f of files) {
    const parts = f.path.split("/");
    const name = parts[parts.length - 1];
    const parentChildren = ensureDir(parts.slice(0, -1).join("/"));
    const ext = name.includes(".") ? `.${name.split(".").pop()}` : undefined;
    parentChildren.push({
      path: f.path,
      name,
      type: "file",
      size: f.size,
      ...(ext ? { extension: ext } : {}),
    });
  }
  return root;
}

export async function listSkillFiles(
  name: string,
  source?: SkillsSource
): Promise<SkillFile[]> {
  if (isCloud(source)) {
    const skillId = await resolveCloudSkillId(source.projectId, name);
    const body = await webPost<
      { projectId: string; skillId: string },
      { files: CloudSkillFileWire[] }
    >("/api/web/skills/files/list", { projectId: source.projectId, skillId });
    return buildSkillFileTree(body?.files ?? []);
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
  source?: SkillsSource
): Promise<SkillFileContent> {
  if (isCloud(source)) {
    // SKILL.md is the skill body (not a stored file); everything else is a
    // supporting file served server-side from its `_storage` blob.
    if (filePath === "SKILL.md") {
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
    const skillId = await resolveCloudSkillId(source.projectId, name);
    const body = await webPost<
      { projectId: string; skillId: string; path: string },
      { file: SkillFileContent }
    >("/api/web/skills/files/read", {
      projectId: source.projectId,
      skillId,
      path: filePath,
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
  if (!res.ok)
    throw new Error(body?.error || `Read skill file failed (${res.status})`);
  return body.file as SkillFileContent;
}
