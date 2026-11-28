import type {
  LauncherAttachTask,
  LauncherServer,
  LauncherTabProject,
} from "@/shared/launcher-attach";

/** What a saved server in this tab's project points at. */
export interface SavedServerTarget {
  url?: string;
  command?: string;
  args?: string[];
}

/**
 * Where an attach request's server goes, decided by the tab that took it.
 *
 * - `reuse`: a restart of the same dev command; reconnect the entry it made.
 * - `existing`: this project already has the same server saved; connect it.
 * - `save`: save it to this tab's project.
 * - `ask`: open tabs show different projects; ask which one first.
 * - `conflict`: a different server already has this name in this project.
 * - `elsewhere`: it belongs to another project; this tab should not act.
 */
export type LauncherDestination =
  | { kind: "reuse"; createdByAttach: boolean }
  | { kind: "existing" }
  | { kind: "save" }
  | { kind: "ask"; projects: LauncherTabProject[] }
  | { kind: "conflict" }
  | { kind: "elsewhere"; projectId: string };

export function chooseLauncherDestination(
  task: LauncherAttachTask,
  project: LauncherTabProject,
  savedServers: Record<string, SavedServerTarget>,
): LauncherDestination {
  const saved = savedServers[task.server.name];
  const sameTarget = saved !== undefined && targetsMatch(saved, task.server);

  if (task.decision?.projectId === project.id && sameTarget) {
    return { kind: "reuse", createdByAttach: task.decision.createdByAttach };
  }
  if (task.targetProjectId && task.targetProjectId !== project.id) {
    return { kind: "elsewhere", projectId: task.targetProjectId };
  }
  if (saved !== undefined) {
    return sameTarget ? { kind: "existing" } : { kind: "conflict" };
  }
  if (task.targetProjectId === project.id) return { kind: "save" };

  const projects = withProject(task.openProjects, project);
  return projects.length > 1 ? { kind: "ask", projects } : { kind: "save" };
}

/** Same URL, or the same command and arguments. */
export function targetsMatch(
  saved: SavedServerTarget,
  server: LauncherServer,
): boolean {
  if (server.url !== undefined) {
    return saved.url !== undefined && sameUrl(saved.url, server.url);
  }
  return (
    saved.command === server.command &&
    JSON.stringify(saved.args ?? []) === JSON.stringify(server.args ?? [])
  );
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    // An unparseable saved URL can only match itself verbatim.
    return a === b;
  }
}

function withProject(
  projects: LauncherTabProject[],
  project: LauncherTabProject,
): LauncherTabProject[] {
  return projects.some((p) => p.id === project.id)
    ? projects
    : [project, ...projects];
}
