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
  targetsMatch,
  type SavedServerTarget,
} from "@/lib/launcher-attach/destination";
import { useLauncherProjectChoiceStore } from "@/lib/launcher-attach/project-choice";

export const LAUNCHER_POLL_INTERVAL_MS = 2_000;
/**
 * `handleConnect` resolves once the connect has run, including any stdio
 * approval or OAuth wait, so this only covers the render that shows its result.
 */
const CONNECT_SETTLE_TIMEOUT_MS = 5_000;
const CONNECT_SETTLE_STEP_MS = 100;

type ConnectOutcome = { connected: true } | { connected: false; error: string };

export interface UseLauncherAttachOptions {
  /** False in hosted mode, where the local launcher routes do not exist. */
  enabled: boolean;
  /** Whether the developer is signed in, whatever this tab has loaded yet. */
  signedIn: boolean;
  /**
   * The project this tab shows, once it AND its saved servers have loaded.
   * Until then it is null: deciding earlier would not see a same-name server
   * the project already has, and could overwrite it.
   */
  project: LauncherTabProject | null;
  servers: Record<string, ServerWithName>;
  selectedServer: string;
  /**
   * Saves the server to this tab's project and connects it. `onSaved` runs as
   * soon as the entry is in the project, before the connect starts.
   */
  saveAndConnect: (formData: ServerFormData, onSaved: () => void) => Promise<void>;
  /** Connects a server already saved in this project. */
  connectSaved: (serverName: string) => Promise<{ status: string; error?: string }>;
  saveWithoutConnecting: (formData: ServerFormData) => Promise<boolean>;
  removeServer: (serverName: string) => Promise<void>;
  disconnectServer: (serverName: string) => Promise<void>;
  selectServer: (serverName: string) => void;
  requestSignIn: () => void;
  /** How often this tab asks MCPJam for requests. For tests. */
  pollIntervalMs?: number;
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
    /** Requests the local server withdrew: the dev command quit or restarted. */
    const cancelled = new Set<string>();
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
      const { requestSignIn, signedIn } = optionsRef.current;
      for (const attachId of response.cancelledAttachIds) {
        cancelled.add(attachId);
        toast.dismiss(chooseToastId(attachId));
        useLauncherProjectChoiceStore.getState().withdraw(attachId);
      }
      // Sign-in toasts follow what is waiting now: gone when the request is
      // taken, the dev command quits, or this tab signs in. Only a tab that
      // is not signed in asks; a signed-in tab still loading its project is
      // not "waiting for sign-in".
      const waiting = new Set(response.waitingForSignIn.map((w) => w.attachId));
      for (const attachId of [...signInToasts]) {
        if (signedIn || !waiting.has(attachId)) {
          toast.dismiss(signInToastId(attachId));
          signInToasts.delete(attachId);
        }
      }
      if (!signedIn) {
        for (const request of response.waitingForSignIn) {
          if (signInToasts.has(request.attachId)) continue;
          signInToasts.add(request.attachId);
          toast.info(`Sign in to add ${request.serverName}`, {
            id: signInToastId(request.attachId),
            description:
              "Your dev command is waiting. Nothing is saved until you sign in.",
            duration: Infinity,
            action: { label: "Sign in", onClick: () => requestSignIn() },
          });
        }
      }
      for (const task of response.tasks) {
        // A request delivered after its cancellation is a new one, such as a
        // dev command that quit and started again under the same id.
        if (task.kind === "attach") cancelled.delete(task.attachId);
        run(`${task.kind}:${task.attachId}`, () =>
          task.kind === "attach" ? handleAttach(task) : handleRelease(task),
        );
      }
    };

    const handleAttach = async (task: LauncherAttachTask) => {
      if (!optionsRef.current.project) return;
      if (!(await claimLauncherAttach(task.attachId, tabId))) return;
      await decideAndConnect(task);
    };

    /** Always decides for the project this tab shows now, not when it was claimed. */
    const decideAndConnect = async (task: LauncherAttachTask): Promise<void> => {
      const { project } = optionsRef.current;
      if (!project || cancelled.has(task.attachId)) return;
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
          toast.error(message);
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
          // The dev command quit while the question was open: not a Cancel.
          if (cancelled.has(task.attachId)) return;
          if (choice === null) {
            // Still claimed by this tab; the dev command keeps waiting, so the
            // way back stays on screen for as long as it does.
            toast(`${name} was not added`, {
              id: chooseToastId(task.attachId),
              duration: Infinity,
              description: "Your dev command is still running.",
              action: {
                label: "Choose project",
                onClick: () => {
                  toast.dismiss(chooseToastId(task.attachId));
                  run(`attach:${task.attachId}`, () => decideAndConnect(task));
                },
              },
            });
            return;
          }
          const current = optionsRef.current.project;
          if (!current) return;
          if (choice !== current.id) {
            await routeLauncherAttach(task.attachId, tabId, choice);
            return;
          }
          await connect(task, current, true, false);
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
      // The tab was switched to another project since the decision: it would
      // save into the new one while naming the old. Decide again.
      if (opts.project?.id !== project.id) return decideAndConnect(task);
      if (cancelled.has(task.attachId)) return;
      if (opts.selectedServer && opts.selectedServer !== name) {
        previousSelection.set(task.attachId, opts.selectedServer);
      }
      const decision: LauncherDecision = {
        projectId: project.id,
        projectName: project.name,
        serverName: name,
        createdByAttach,
      };
      let savedHere = false;
      let outcome: ConnectOutcome;
      if (alreadySaved) {
        const result = await opts.connectSaved(name);
        outcome =
          result.status === "connected"
            ? { connected: true }
            : { connected: false, error: result.error ?? `${name} did not connect.` };
      } else {
        let savedReport: Promise<boolean> = Promise.resolve(true);
        await opts.saveAndConnect(launcherServerToFormData(task.server), () => {
          savedHere = true;
          // Reported before connecting: connecting can take a minute or wait
          // on stdio approval or an OAuth redirect, and a quit, reload or
          // reset in that window must still find the entry this attach made.
          savedReport = reportLauncherAttach(task.attachId, {
            tabId,
            outcome: "saved",
            decision,
          });
        });
        await savedReport;
        outcome = await settleConnect(name);
      }
      optionsRef.current.selectServer(name);
      toast.dismiss(chooseToastId(task.attachId));
      if (outcome.connected) {
        toast.success(`${name} connected`, {
          description: createdByAttach
            ? `Added to ${project.name} by your dev command. Stopping the dev command removes it.`
            : `Your dev command connected the ${name} saved in ${project.name}. Stopping the dev command disconnects it.`,
        });
      }
      const saved = savedHere || name in optionsRef.current.servers;
      const accepted = await reportLauncherAttach(
        task.attachId,
        outcome.connected
          ? { tabId, outcome: "connected", decision }
          : {
              tabId,
              outcome: "failed",
              message: outcome.error,
              ...(saved ? { decision } : {}),
            },
      );
      // MCPJam no longer knows this request, so nothing will ever release the
      // entry. It was promised gone when the dev command stops: remove it now.
      if (!accepted && createdByAttach && saved) {
        await removeCreated(task, decision);
      }
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
      // Not a stall on the project's rows: the connect has already run.
      return {
        connected: false,
        error: `${name} did not connect. The Connect screen shows its status.`,
      };
    };

    /** Removes what this attach created and offers to keep it. */
    const removeCreated = async (
      task: { attachId: string; server: LauncherServer },
      decision: LauncherDecision,
    ) => {
      const opts = optionsRef.current;
      const name = decision.serverName;
      const previous = previousSelection.get(task.attachId);
      previousSelection.delete(task.attachId);
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
    };

    const handleRelease = async (task: LauncherReleaseTask) => {
      const opts = optionsRef.current;
      const { decision } = task;
      // Not acknowledged: MCPJam keeps the undo until a tab shows the project.
      if (opts.project?.id !== decision.projectId) return;
      const name = decision.serverName;
      const saved = opts.servers[name];
      // The developer removed or edited it while the dev command ran. Leave it
      // alone: removing would delete their choice, and "Keep server" would
      // put the dev command's original config back over their edits.
      const unchanged =
        saved !== undefined && targetsMatch(savedTarget(saved), task.server);
      if (!unchanged) {
        previousSelection.delete(task.attachId);
        await reportLauncherReleased(task.attachId, tabId);
        return;
      }
      if (decision.createdByAttach) {
        await removeCreated(task, decision);
      } else {
        previousSelection.delete(task.attachId);
        await opts.disconnectServer(name);
        toast(`${name} disconnected`, {
          description: "Your dev command stopped. The saved server is unchanged.",
        });
      }
      await reportLauncherReleased(task.attachId, tabId);
    };

    const tick = async () => {
      const { project } = optionsRef.current;
      try {
        // A tab is eligible only once its project and that project's saved
        // servers are loaded; until then it must not be handed a request.
        const response = await pollLauncherTasks(tabId, {
          focusedAt,
          signedIn: project !== null,
          project,
        });
        if (response && !stopped) handle(response);
      } catch (error) {
        // The local server may be restarting; the next poll retries.
        console.debug("[launcher-attach] Poll failed", error);
      }
      if (!stopped) {
        timer = setTimeout(
          tick,
          optionsRef.current.pollIntervalMs ?? LAUNCHER_POLL_INTERVAL_MS,
        );
      }
    };
    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", markFocused);
      document.removeEventListener("visibilitychange", markFocused);
      window.removeEventListener("pagehide", onPageHide);
      for (const attachId of signInToasts) toast.dismiss(signInToastId(attachId));
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

function savedTarget(server: ServerWithName): SavedServerTarget {
  const config = server.config as {
    url?: string | URL;
    command?: string;
    args?: string[];
  };
  return {
    ...(config.url !== undefined ? { url: String(config.url) } : {}),
    ...(config.command !== undefined ? { command: config.command } : {}),
    ...(config.args !== undefined ? { args: config.args } : {}),
  };
}

function savedTargets(
  servers: Record<string, ServerWithName>,
): Record<string, SavedServerTarget> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, savedTarget(server)]),
  );
}

function chooseToastId(attachId: string) {
  return `launcher-choose-${attachId}`;
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
