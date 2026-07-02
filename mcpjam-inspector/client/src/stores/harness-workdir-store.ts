import { create } from "zustand";

/**
 * Caches the latest harness working directory streamed from the server, keyed by
 * project + host. The Playground Shell reads it to open a terminal in the harness
 * workdir (`/home/user/claude-code-<id>`) instead of the box's home.
 *
 * "Latest per (project, host)" is the intended scope: the user inspects the run
 * they just did. Project+host keying avoids a stale cwd when switching between two
 * harness hosts in the same project.
 */
// The host id (previewedHostId — a globally-unique Convex doc id) is the primary
// key: the write side (chat stream) and read side (rail) both derive it from
// `usePreviewedHostId`, so it always matches. We key by it ALONE when present so
// the result is immune to the two sides resolving `projectId` from slightly
// different sources. projectId is only the fallback when there's no host id.
function workdirKey(projectId: string | null, hostId: string | null): string {
  return hostId ? `h:${hostId}` : `p:${projectId ?? ""}`;
}

interface HarnessWorkdirState {
  byKey: Record<string, string>;
  setWorkdir: (
    projectId: string | null,
    hostId: string | null,
    workdir: string,
  ) => void;
}

export const useHarnessWorkdirStore = create<HarnessWorkdirState>((set) => ({
  byKey: {},
  setWorkdir: (projectId, hostId, workdir) =>
    set((state) => {
      const key = workdirKey(projectId, hostId);
      if (state.byKey[key] === workdir) return state;
      return { byKey: { ...state.byKey, [key]: workdir } };
    }),
}));

/** Selector: the cached harness workdir for a (project, host), or undefined. */
export function useHarnessWorkdir(
  projectId: string | null,
  hostId: string | null,
): string | undefined {
  const key = workdirKey(projectId, hostId);
  return useHarnessWorkdirStore((s) => s.byKey[key]);
}
