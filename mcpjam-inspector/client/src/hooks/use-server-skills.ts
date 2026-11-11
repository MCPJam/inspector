/**
 * Captured MCP-server skills (SEP-2640), read from the backend's capture
 * store. These are the copies an environment pins and a run freezes, not the
 * live listing a connected server sends (`lib/apis/server-skills-api.ts`).
 */
import { useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { shouldQueryProjectId } from "@/hooks/useProjects";

/** One captured server skill, at its latest capture. */
export type ProjectServerSkill = {
  id: string;
  serverId: string;
  /** The server's name as a slug, shown as the skill's origin. */
  serverSlug: string;
  /** `serverSlug/name`, unique within the project. */
  ref: string;
  name: string;
  description: string;
  /** The latest capture, which "Latest" resolves to when a run starts. */
  versionId: string;
  versionNumber: number;
  /** Present when no environment can select it (`no_resources`, `files_over_cap`). */
  unpinnable?: { reason: string };
};

/** One captured version of a server skill. */
export type ServerSkillVersion = {
  id: string;
  versionNumber: number;
  capturedAt: number;
};

const listProjectServerSkills = makeFunctionReference<
  "query",
  { projectId: string },
  ProjectServerSkill[]
>("serverSkills:listProjectServerSkills");

const listServerSkillVersions = makeFunctionReference<
  "query",
  { serverSkillId: string },
  ServerSkillVersion[]
>("serverSkills:listServerSkillVersions");

/** Newest-seen first; `undefined` while loading or before sign-in settles. */
export function useProjectServerSkills(
  projectId: string,
): ProjectServerSkill[] | undefined {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const normalized = projectId.trim();
  return useQuery(
    listProjectServerSkills,
    isAuthenticated && isUserReady && shouldQueryProjectId(normalized)
      ? { projectId: normalized }
      : "skip",
  );
}

/**
 * Newest first. Read only once `enabled`, so a version menu nobody opened
 * reads nothing.
 */
export function useServerSkillVersions(
  serverSkillId: string,
  enabled: boolean,
): ServerSkillVersion[] | undefined {
  return useQuery(
    listServerSkillVersions,
    enabled ? { serverSkillId } : "skip",
  );
}
