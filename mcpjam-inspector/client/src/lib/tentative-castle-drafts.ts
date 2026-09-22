/**
 * Project-scoped tentative castle snaps from the Swarm target composer.
 *
 * Sibling of `environment-draft-seed.ts` (Connect one-shot handoff), with
 * deliberate differences:
 *
 * - `localStorage` (not sessionStorage): drafts survive tab navigation between
 *   Swarms and `/environments` and are personal/device-local.
 * - A **list** per project (not a single seed): the composer can park multiple
 *   partial snaps; Environments shows them as draft chips.
 * - Consuming a draft for create prefill does NOT delete it until the user
 *   successfully saves the environment (or explicitly discards).
 *
 * Project keys are always trimmed so Connect-style id padding can't split the
 * map.
 */

import type { ProjectEnvironmentSkillSelection } from "@/hooks/useProjectEnvironments";

const STORAGE_KEY = "mcp-tentative-castle-drafts";

export type TentativeCastle = {
  id: string;
  name?: string;
  /** Unordered / partial OK — Environments create uses the first host. */
  hostIds: string[];
  serverAttachmentId: string | null;
  skillSelection: ProjectEnvironmentSkillSelection | null;
  computerEnvironmentId: string | null;
  updatedAt: number;
};

function normalizeProjectKey(projectId: string): string {
  return projectId.trim();
}

function readAll(): Record<string, TentativeCastle[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, TentativeCastle[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      out[key] = value
        .map(normalizeCastle)
        .filter((c): c is TentativeCastle => c !== null);
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, TentativeCastle[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable ⇒ Save draft degrades silently.
  }
}

function normalizeCastle(raw: unknown): TentativeCastle | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return null;
  const hostIds = Array.isArray(row.hostIds)
    ? row.hostIds.filter((id): id is string => typeof id === "string" && !!id)
    : [];
  let skillSelection: ProjectEnvironmentSkillSelection | null = null;
  if (
    row.skillSelection &&
    typeof row.skillSelection === "object" &&
    (row.skillSelection as { mode?: unknown }).mode === "explicit" &&
    Array.isArray((row.skillSelection as { skillIds?: unknown }).skillIds)
  ) {
    const skillIds = (
      row.skillSelection as { skillIds: unknown[] }
    ).skillIds.filter((id): id is string => typeof id === "string" && !!id);
    skillSelection =
      skillIds.length > 0 ? { mode: "explicit", skillIds } : null;
  }
  return {
    id: row.id,
    ...(typeof row.name === "string" && row.name.trim()
      ? { name: row.name.trim() }
      : {}),
    hostIds,
    serverAttachmentId:
      typeof row.serverAttachmentId === "string"
        ? row.serverAttachmentId
        : null,
    skillSelection,
    computerEnvironmentId:
      typeof row.computerEnvironmentId === "string"
        ? row.computerEnvironmentId
        : null,
    updatedAt:
      typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt)
        ? row.updatedAt
        : Date.now(),
  };
}

function mintId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `draft_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function listTentativeCastles(projectId: string): TentativeCastle[] {
  const key = normalizeProjectKey(projectId);
  if (!key) return [];
  const list = readAll()[key] ?? [];
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveTentativeCastle(
  projectId: string,
  draft: Omit<TentativeCastle, "id" | "updatedAt"> & {
    id?: string;
    updatedAt?: number;
  }
): TentativeCastle | null {
  const key = normalizeProjectKey(projectId);
  if (!key) return null;
  const castle: TentativeCastle = {
    id: draft.id ?? mintId(),
    ...(draft.name?.trim() ? { name: draft.name.trim() } : {}),
    hostIds: [...draft.hostIds],
    serverAttachmentId: draft.serverAttachmentId ?? null,
    skillSelection: draft.skillSelection ?? null,
    computerEnvironmentId: draft.computerEnvironmentId ?? null,
    updatedAt: draft.updatedAt ?? Date.now(),
  };
  const all = readAll();
  const list = all[key] ?? [];
  const idx = list.findIndex((c) => c.id === castle.id);
  if (idx >= 0) list[idx] = castle;
  else list.unshift(castle);
  all[key] = list;
  writeAll(all);
  return castle;
}

export function getTentativeCastle(
  projectId: string,
  draftId: string
): TentativeCastle | null {
  return (
    listTentativeCastles(projectId).find((c) => c.id === draftId) ?? null
  );
}

/** Remove one draft after successful create (or explicit discard). */
export function clearTentativeCastle(
  projectId: string,
  draftId: string
): void {
  const key = normalizeProjectKey(projectId);
  if (!key) return;
  const all = readAll();
  const list = all[key];
  if (!list) return;
  all[key] = list.filter((c) => c.id !== draftId);
  if (all[key].length === 0) delete all[key];
  writeAll(all);
}

/** Prefill shape for ProjectEnvironmentEditor `initialDraft`. */
export function tentativeCastleToInitialDraft(castle: TentativeCastle): {
  name?: string;
  hostId: string | null;
  serverAttachmentId: string | null;
  skillSelection: ProjectEnvironmentSkillSelection | null;
  computerEnvironmentId: string | null;
} {
  return {
    ...(castle.name ? { name: castle.name } : {}),
    hostId: castle.hostIds[0] ?? null,
    serverAttachmentId: castle.serverAttachmentId,
    skillSelection: castle.skillSelection,
    computerEnvironmentId: castle.computerEnvironmentId,
  };
}
