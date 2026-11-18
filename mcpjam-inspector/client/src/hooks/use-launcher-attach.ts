import { useEffect, useRef } from "react";
import { toast } from "@/lib/toast";
import type { ServerWithName } from "@/state/app-types";
import type { ServerFormData } from "@/shared/types";
import type {
  LauncherAttachTask,
  LauncherDecision,
  LauncherPollResponse,
  LauncherReleaseTask,
  LauncherServer,
  LauncherTabProject,
} from "@/shared/launcher-attach";
import {
  claimLauncherAttach,
  closeLauncherTab,
  pollLauncherTasks,
  reportLauncherAttach,
  reportLauncherReleased,
  routeLauncherAttach,
} from "@/lib/launcher-attach/api";
import {
  chooseLauncherDestination,
  type SavedServerTarget,
} from "@/lib/launcher-attach/destination";
import { useLauncherProjectChoiceStore } from "@/lib/launcher-attach/project-choice";

export const LAUNCHER_POLL_INTERVAL_MS = 2_000;
const CONNECT_SETTLE_TIMEOUT_MS = 60_000;
const CONNECT_SETTLE_STEP_MS = 250;

type ConnectOutcome = { connected: true } | { connected: false; error: string };

export interface UseLauncherAttachOptions {
  /** False in hosted mode, where the local launcher routes do not exist. */
  enabled: boolean;
  signedIn: boolean;
  /** The project this tab shows, when it is a saved (signed-in) project. */
  project: LauncherTabProject | null;
  servers: Record<string, ServerWithName>;
  selectedServer: string;
  /** Saves the server to this tab's project and connects it. */
  saveAndConnect: (formData: ServerFormData) => Promise<void>;
  /** Connects a server already saved in this project. */
  connectSaved: (serverName: string) => Promise<{ status: string; error?: string }>;
  saveWithoutConnecting: (formData: ServerFormData) => Promise<boolean>;
  removeServer: (serverName: string) => Promise<void>;
  disconnectServer: (serverName: string) => Promise<void>;
  selectServer: (serverName: string) => void;
  requestSignIn: () => void;
}

/**
 * Takes the dev command attach requests the local MCPJam server hands this
 * tab: saves the server to this tab's project (or asks which project when
 * open tabs differ), connects and selects it, and undoes that when the dev
 * command quits. See `shared/launcher-attach.ts`.
 */
export function useLauncherAttach(options: UseLauncherAttachOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { enabled } = options;

  useEffect(() => {
    if (!enabled) return;
    const tabId = newTabId();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let focusedAt = document.hasFocus() ? Date.now() : 0;
    const inFlight = new Set<string>();
    const signInToasts = new Set<string>();
    /** Selection before each attach, restored when its server is removed. */
    const previousSelection = new Map<string, string>();
    let queue = Promise.resolve();

    const markFocused = () => {
      if (document.visibilityState === "visible") focusedAt = Date.now();
    };
    window.addEventListener("focus", markFocused);
    document.addEventListener("visibilitychange", markFocused);
    const onPageHide = () => closeLauncherTab(tabId);
    window.addEventListener("pagehide", onPageHide);

    const run = (key: string, work: () => Promise<void>) => {
      if (inFlight.has(key)) return;
      inFlight.add(key);
      queue = queue
        .then(work)
        .catch((error: unknown) => {
          console.warn("[launcher-attach] Task failed", error);
        })
        .finally(() => inFlight.delete(key));
    };

    const handle = (response: LauncherPollResponse) => {
      const { requestSignIn } = optionsRef.current;
      for (const attachId of response.cancelledAttachIds) {
        useLauncherProjectChoiceStore.getState().withdraw(attachId);
      }
      for (const waiting of response.waitingForSignIn) {
        if (signInToasts.has(waiting.attachId)) continue;
        signInToasts.add(waiting.attachId);
        toast.info(`Sign in to add ${waiting.serverName}`, {
          id: signInToastId(waiting.attachId),
          description:
            "Your dev command is waiting. Nothing is saved until you sign in.",
          duration: Infinity,
          action: { label: "Sign in", onClick: () => requestSignIn() },
        });
      }
      if (optionsRef.current.signedIn) {
        for (const attachId of signInToasts) toast.dismiss(signInToastId(attachId));
        signInToasts.clear();
      }
      for (const task of response.tasks) {
        run(`${task.kind}:${task.attachId}`, () =>
          task.kind === "attach"
            ? handleAttach(task)
            : handleRelease(task),
        );
      }
    };

    const handleAttach = async (task: LauncherAttachTask) => {
      const { project } = optionsRef.current;
      if (!project) return;
      if (!(await claimLauncherAttach(task.attachId, tabId))) return;
      await decideAndConnect(task, project);
    };

    const decideAndConnect = async (
      task: LauncherAttachTask,
      project: LauncherTabProject,
    ): Promise<void> => {
      const name = task.server.name;
      const destination = chooseLauncherDestination(
        task,
        project,
        savedTargets(optionsRef.current.servers),
      );
      switch (destination.kind) {
        case "elsewhere":
          await routeLauncherAttach(task.attachId, tabId, destination.projectId);
          return;
        case "conflict": {
          const what = task.server.url ? "URL" : "command";
          const message = `${name} is already saved in ${project.name} with a different ${what}. Rename one of them, then restart your dev command.`;
          toast.error(`Could not add ${name}`, { description: message });
          await reportLauncherAttach(task.attachId, {
            tabId,
            outcome: "failed",
            message,
          });
          return;
        }
        case "ask": {
          const choice = await useLauncherProjectChoiceStore.getState().ask({
            attachId: task.attachId,
            serverName: name,
            projects: destination.projects,
            defaultProjectId: project.id,
          });
          if (choice === null) {
            // Still claimed by this tab; the dev command keeps waiting.
            toast(`${name} was not added`, {
              description: "Your dev command is still running.",
              action: {
                label: "Choose project",
                onClick: () =>
                  run(`attach:${task.attachId}`, () =>
                    decideAndConnect(task, project),
                  ),
              },
            });
            return;
          }
          if (choice !== project.id) {
            await routeLauncherAttach(task.attachId, tabId, choice);
            return;
          }
          await connect(task, project, true, false);
          return;
        }
        case "reuse":
          await connect(task, project, destination.createdByAttach, true);
          return;
        case "existing":
          await connect(task, project, false, true);
          return;
        case "save":
          await connect(task, project, true, false);
          return;
      }
    };

    const connect = async (
      task: LauncherAttachTask,
      project: LauncherTabProject,
      createdByAttach: boolean,
      alreadySaved: boolean,
    ) => {
      const opts = optionsRef.current;
      const name = task.server.name;
      if (opts.selectedServer && opts.selectedServer !== name) {
        previousSelection.set(task.attachId, opts.selectedServer);
      }
      let outcome: ConnectOutcome;
      if (alreadySaved) {
        const result = await opts.connectSaved(name);
        outcome =
          result.status === "connected"
            ? { connected: true }
            : { connected: false, error: result.error ?? `${name} did not connect.` };
      } else {
        await opts.saveAndConnect(launcherServerToFormData(task.server));
        outcome = await settleConnect(name);
      }
      optionsRef.current.selectServer(name);
      const decision: LauncherDecision = {
        projectId: project.id,
        projectName: project.name,
        serverName: name,
        createdByAttach,
      };
      if (outcome.connected) {
        toast.success(`${name} connected`, {
          description: createdByAttach
            ? `Added to ${project.name} by your dev command. Stopping the dev command removes it.`
            : `Your dev command connected the ${name} saved in ${project.name}. Stopping the dev command disconnects it.`,
        });
        await reportLauncherAttach(task.attachId, {
          tabId,
          outcome: "connected",
          decision,
        });
        return;
      }
      // The connect flow already showed why it failed.
      const saved = name in optionsRef.current.servers;
      await reportLauncherAttach(task.attachId, {
        tabId,
        outcome: "failed",
        message: outcome.error,
        ...(saved ? { decision } : {}),
      });
    };

    const settleConnect = async (name: string): Promise<ConnectOutcome> => {
      const deadline = Date.now() + CONNECT_SETTLE_TIMEOUT_MS;
      while (Date.now() < deadline && !stopped) {
        const server = optionsRef.current.servers[name];
        if (server?.connectionStatus === "connected") return { connected: true };
        if (server && server.connectionStatus !== "connecting" && server.lastError) {
          return { connected: false, error: server.lastError };
        }
        await delay(CONNECT_SETTLE_STEP_MS);
      }
      return { connected: false, error: `${name} did not finish connecting.` };
    };

    const handleRelease = async (task: LauncherReleaseTask) => {
      const opts = optionsRef.current;
      const { decision } = task;
      if (opts.project?.id !== decision.projectId) return;
      const name = decision.serverName;
      const previous = previousSelection.get(task.attachId);
      previousSelection.delete(task.attachId);
      if (decision.createdByAttach) {
        const wasSelected = opts.selectedServer === name;
        await opts.removeServer(name);
        if (wasSelected && previous && previous in optionsRef.current.servers) {
          optionsRef.current.selectServer(previous);
        }
        const formData = launcherServerToFormData(task.server);
        toast(`${name} removed from ${decision.projectName}`, {
          description: "Your dev command stopped.",
          action: {
            label: "Keep server",
            onClick: () => {
              void optionsRef.current.saveWithoutConnecting(formData);
            },
          },
        });
      } else {
        await opts.disconnectServer(name);
        toast(`${name} disconnected`, {
          description: "Your dev command stopped. The saved server is unchanged.",
        });
      }
      await reportLauncherReleased(task.attachId, tabId);
    };

    const tick = async () => {
      const { signedIn, project } = optionsRef.current;
      try {
        const response = await pollLauncherTasks(tabId, {
          focusedAt,
          signedIn: signedIn && project !== null,
          project: signedIn ? project : null,
        });
        if (response && !stopped) handle(response);
      } catch (error) {
        // The local server may be restarting; the next poll retries.
        console.debug("[launcher-attach] Poll failed", error);
      }
      if (!stopped) timer = setTimeout(tick, LAUNCHER_POLL_INTERVAL_MS);
    };
    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", markFocused);
      document.removeEventListener("visibilitychange", markFocused);
      window.removeEventListener("pagehide", onPageHide);
      closeLauncherTab(tabId);
    };
  }, [enabled]);
}

export function launcherServerToFormData(server: LauncherServer): ServerFormData {
  const isHttp = server.url !== undefined;
  return {
    name: server.name,
    type: isHttp ? "http" : "stdio",
    ...(isHttp
      ? { url: server.url }
      : { command: server.command, args: server.args ?? [] }),
    env: server.env ?? {},
    ...(server.headers ? { headers: server.headers } : {}),
    secretPatch: {
      ...(server.env && Object.keys(server.env).length > 0
        ? { env: server.env }
        : {}),
      ...(server.headers && Object.keys(server.headers).length > 0
        ? { headers: server.headers }
        : {}),
    },
    useOAuth: server.useOAuth ?? false,
  };
}

function savedTargets(
  servers: Record<string, ServerWithName>,
): Record<string, SavedServerTarget> {
  const targets: Record<string, SavedServerTarget> = {};
  for (const [name, server] of Object.entries(servers)) {
    const config = server.config as {
      url?: string | URL;
      command?: string;
      args?: string[];
    };
    targets[name] = {
      ...(config.url !== undefined ? { url: String(config.url) } : {}),
      ...(config.command !== undefined ? { command: config.command } : {}),
      ...(config.args !== undefined ? { args: config.args } : {}),
    };
  }
  return targets;
}

function signInToastId(attachId: string) {
  return `launcher-sign-in-${attachId}`;
}

function newTabId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
