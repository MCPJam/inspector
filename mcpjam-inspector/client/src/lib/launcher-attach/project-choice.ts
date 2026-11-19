import { create } from "zustand";
import type { LauncherTabProject } from "@/shared/launcher-attach";

/**
 * The question a tab asks when open tabs show different projects: which
 * project should a dev command's server be saved to? One question is on
 * screen at a time; `LauncherProjectChoiceDialog` renders the head.
 */
export interface LauncherProjectChoicePrompt {
  attachId: string;
  serverName: string;
  projects: LauncherTabProject[];
  defaultProjectId: string;
}

interface PendingChoice extends LauncherProjectChoicePrompt {
  resolve: (projectId: string | null) => void;
}

interface LauncherProjectChoiceState {
  queue: PendingChoice[];
  /** Resolves with the chosen project id, or null when the developer cancels. */
  ask: (prompt: LauncherProjectChoicePrompt) => Promise<string | null>;
  settle: (projectId: string | null) => void;
  /** Drops a question whose dev command quit before it was answered. */
  withdraw: (attachId: string) => void;
}

export const useLauncherProjectChoiceStore = create<LauncherProjectChoiceState>(
  (set, get) => ({
    queue: [],
    ask: (prompt) =>
      new Promise<string | null>((resolve) => {
        set((state) => ({ queue: [...state.queue, { ...prompt, resolve }] }));
      }),
    settle: (projectId) => {
      const [head, ...rest] = get().queue;
      if (!head) return;
      set({ queue: rest });
      head.resolve(projectId);
    },
    withdraw: (attachId) => {
      const withdrawn = get().queue.filter((p) => p.attachId === attachId);
      if (withdrawn.length === 0) return;
      set((state) => ({
        queue: state.queue.filter((p) => p.attachId !== attachId),
      }));
      for (const prompt of withdrawn) prompt.resolve(null);
    },
  }),
);
