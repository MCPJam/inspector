import { create } from "zustand";
import { toast } from "sonner";
import { authFetch } from "@/lib/session-token";
import {
  STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
  type StdioCommandApprovalTerms,
} from "@/shared/stdio-command-approval";

/**
 * Per-device approval of a STDIO server's command.
 *
 * The local server refuses to spawn a command this device has not approved
 * and answers with the terms it would run. `obtainStdioCommandApproval` shows
 * them, records the user's approval against the fingerprint they saw, and
 * reports whether the connect can be retried. Prompts queue so one dialog is
 * on screen at a time; `StdioCommandApprovalDialog` renders the head.
 */
export interface StdioCommandApprovalPrompt {
  projectId: string;
  serverName: string;
  terms: StdioCommandApprovalTerms;
}

interface PendingPrompt extends StdioCommandApprovalPrompt {
  /** Keys the dialog, so the next prompt mounts fresh instead of in place. */
  id: number;
  answer: Promise<boolean>;
  resolve: (allowed: boolean) => void;
}

interface StdioCommandApprovalState {
  queue: PendingPrompt[];
  request: (prompt: StdioCommandApprovalPrompt) => Promise<boolean>;
  /** Answers the prompt at the head of the queue. */
  settle: (allowed: boolean) => void;
}

let promptSequence = 0;

export const useStdioCommandApprovalStore = create<StdioCommandApprovalState>(
  (set, get) => ({
    queue: [],
    request: (prompt) => {
      // Concurrent connects or chat columns refused for the same command share
      // one dialog rather than asking the same question again.
      const pending = get().queue.find(
        (queued) =>
          queued.terms.serverId === prompt.terms.serverId &&
          queued.terms.fingerprint === prompt.terms.fingerprint,
      );
      if (pending) return pending.answer;
      let resolve!: (allowed: boolean) => void;
      const answer = new Promise<boolean>((done) => {
        resolve = done;
      });
      set((state) => ({
        queue: [
          ...state.queue,
          { ...prompt, id: ++promptSequence, answer, resolve },
        ],
      }));
      return answer;
    },
    settle: (allowed) => {
      const [head, ...rest] = get().queue;
      if (!head) return;
      set({ queue: rest });
      head.resolve(allowed);
    },
  }),
);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function readStdioCommandApprovalTerms(
  result: unknown,
): StdioCommandApprovalTerms | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (record.reason !== STDIO_COMMAND_APPROVAL_REQUIRED_REASON) return null;
  const approval = record.approval as Record<string, unknown> | undefined;
  if (
    !approval ||
    typeof approval !== "object" ||
    typeof approval.serverId !== "string" ||
    typeof approval.fingerprint !== "string" ||
    typeof approval.command !== "string" ||
    !isStringArray(approval.args) ||
    !isStringArray(approval.envNames)
  ) {
    return null;
  }
  return {
    serverId: approval.serverId,
    fingerprint: approval.fingerprint,
    command: approval.command,
    args: approval.args,
    envNames: approval.envNames,
    ...(isStringArray(approval.changedEnvNames)
      ? { changedEnvNames: approval.changedEnvNames }
      : {}),
    ...(typeof approval.cwd === "string" ? { cwd: approval.cwd } : {}),
    previouslyApproved: approval.previouslyApproved === true,
  };
}

const APPROVAL_FAILED_MESSAGE =
  "The command could not be approved on this device. Try approving it again.";

async function approveStdioCommand(args: {
  projectId: string;
  serverId: string;
  serverName: string;
  fingerprint: string;
}): Promise<
  | { ok: true }
  | { ok: false; error: string; terms: StdioCommandApprovalTerms | null }
> {
  const response = await authFetch("/api/mcp/servers/approve-command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown> | null;
  } catch {
    // Not JSON (a proxy's error page): the fallback message below applies.
  }
  if (response.ok && body?.success === true) return { ok: true };
  return {
    ok: false,
    error:
      typeof body?.error === "string" ? body.error : APPROVAL_FAILED_MESSAGE,
    terms: readStdioCommandApprovalTerms(body),
  };
}

// A teammate can edit the command between the dialog and the approval; the
// server then answers with the new terms, which are shown again. Bounded so a
// command in constant flux cannot loop the dialog forever.
const MAX_APPROVAL_ROUNDS = 3;

/** True when this device now holds an approval for the server's current command. */
export async function obtainStdioCommandApproval(
  prompt: StdioCommandApprovalPrompt,
): Promise<boolean> {
  let terms = prompt.terms;
  for (let round = 0; round < MAX_APPROVAL_ROUNDS; round++) {
    const allowed = await useStdioCommandApprovalStore
      .getState()
      .request({ ...prompt, terms });
    if (!allowed) return false;
    const outcome = await approveStdioCommand({
      projectId: prompt.projectId,
      serverId: terms.serverId,
      serverName: prompt.serverName,
      fingerprint: terms.fingerprint,
    });
    if (outcome.ok) return true;
    if (!outcome.terms) throw new Error(outcome.error);
    terms = outcome.terms;
  }
  return false;
}

/**
 * A chat turn the web route refused because this device has not approved a
 * stdio server's command. A plugin's local component spawns only there, with
 * no Connect to ask from, so the chat asks; the user then sends again.
 */
export async function askStdioCommandApprovalForChatError(
  error: Error,
  projectId: string,
): Promise<void> {
  const start = error.message.indexOf("{");
  if (start < 0) return;
  let details: Record<string, unknown> | undefined;
  try {
    details = JSON.parse(error.message.slice(start))?.details;
  } catch {
    return;
  }
  const terms = readStdioCommandApprovalTerms(details);
  if (!terms) return;
  try {
    const allowed = await obtainStdioCommandApproval({
      projectId,
      serverName:
        typeof details?.serverName === "string"
          ? details.serverName
          : terms.serverId,
      terms,
    });
    if (allowed)
      toast.success("Allowed on this device. Send your message again.");
  } catch (failure) {
    toast.error(
      failure instanceof Error ? failure.message : APPROVAL_FAILED_MESSAGE,
    );
  }
}
