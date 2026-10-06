import { create } from "zustand";
import type { HarnessMachine } from "@/shared/harness-session";

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
  /**
   * Which machine the latest turn for a (project, host) ran on. Only
   * `disposable` is ever stored: absent means the personal computer, so a
   * server that predates the field changes nothing.
   */
  disposableByKey: Record<string, true>;
  setWorkdir: (
    projectId: string | null,
    hostId: string | null,
    workdir: string,
    machine?: HarnessMachine,
  ) => void;
}

export const useHarnessWorkdirStore = create<HarnessWorkdirState>((set) => ({
  byKey: {},
  disposableByKey: {},
  setWorkdir: (projectId, hostId, workdir, machine) =>
    set((state) => {
      const key = workdirKey(projectId, hostId);
      const disposable = machine === "disposable";
      const sameMachine = Boolean(state.disposableByKey[key]) === disposable;
      if (state.byKey[key] === workdir && sameMachine) return state;
      const { [key]: _dropped, ...rest } = state.disposableByKey;
      return {
        byKey: { ...state.byKey, [key]: workdir },
        disposableByKey: disposable
          ? { ...state.disposableByKey, [key]: true }
          : rest,
      };
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

/**
 * Did the latest turn for this (project, host) run on the conversation's
 * disposable computer rather than the personal one? The Shell rail uses it to
 * say so, and to stop opening its (personal-computer) terminal at a path that
 * only exists on the other machine.
 */
export function useHarnessRanOnDisposable(
  projectId: string | null,
  hostId: string | null,
): boolean {
  const key = workdirKey(projectId, hostId);
  return useHarnessWorkdirStore((s) => Boolean(s.disposableByKey[key]));
}
