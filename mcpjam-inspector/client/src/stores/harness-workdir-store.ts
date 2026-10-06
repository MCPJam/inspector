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
  /** The latest PERSONAL-computer workdir per (project, host). */
  byKey: Record<string, string>;
  /**
   * Conversations whose latest turn ran on their own disposable computer. Only
   * `disposable` is ever stored: absent means the personal computer, so a
   * server that predates the field changes nothing.
   *
   * Keyed by CONVERSATION, not by (project, host): a compare column and the
   * main chat run the same host at once on different machines, and one
   * conversation's Cursor turn says nothing about where the next conversation
   * runs. Keyed by host, either would have told the rail the wrong machine.
   */
  disposableByConversation: Record<string, true>;
  setWorkdir: (
    projectId: string | null,
    hostId: string | null,
    workdir: string,
    machine?: HarnessMachine,
    chatSessionId?: string | null,
  ) => void;
}

export const useHarnessWorkdirStore = create<HarnessWorkdirState>((set) => ({
  byKey: {},
  disposableByConversation: {},
  setWorkdir: (projectId, hostId, workdir, machine, chatSessionId) =>
    set((state) => {
      const key = workdirKey(projectId, hostId);
      const disposable = machine === "disposable";
      // A disposable turn's workdir is a path on THAT machine. The cache below
      // is what the rail's (personal-computer) terminal opens at, so it keeps
      // the last personal path rather than one that does not exist there.
      const byKey =
        disposable || state.byKey[key] === workdir
          ? state.byKey
          : { ...state.byKey, [key]: workdir };
      let disposableByConversation = state.disposableByConversation;
      if (chatSessionId) {
        const flagged = Boolean(disposableByConversation[chatSessionId]);
        if (disposable && !flagged) {
          disposableByConversation = {
            ...disposableByConversation,
            [chatSessionId]: true,
          };
        } else if (!disposable && flagged) {
          const { [chatSessionId]: _dropped, ...rest } =
            disposableByConversation;
          disposableByConversation = rest;
        }
      }
      if (
        byKey === state.byKey &&
        disposableByConversation === state.disposableByConversation
      ) {
        return state;
      }
      return { byKey, disposableByConversation };
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
 * Did this conversation's latest turn run on its disposable computer rather
 * than the personal one? The Shell rail uses it (for the conversation on
 * screen) to say so, and to stop opening its personal-computer terminal at a
 * path that only exists on the other machine.
 */
export function useHarnessRanOnDisposable(
  chatSessionId: string | null,
): boolean {
  return useHarnessWorkdirStore((s) =>
    chatSessionId ? Boolean(s.disposableByConversation[chatSessionId]) : false,
  );
}
