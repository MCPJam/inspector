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
    request: (prompt) =>
      new Promise<boolean>((resolve) => {
        set((state) => ({
          queue: [...state.queue, { ...prompt, id: ++promptSequence, resolve }],
        }));
      }),
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

function readStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function readStdioCommandApprovalTerms(
  result: unknown,
): StdioCommandApprovalTerms | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (record.reason !== STDIO_COMMAND_APPROVAL_REQUIRED_REASON) return null;
  const approval = record.approval as Record<string, unknown> | undefined;
  const codeLoadingEnv = readStringRecord(approval?.codeLoadingEnv);
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
    ...(codeLoadingEnv ? { codeLoadingEnv } : {}),
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

async function askAndApprove(
  prompt: StdioCommandApprovalPrompt,
): Promise<boolean> {
  let terms = prompt.terms;
  for (let round = 0; round < MAX_APPROVAL_ROUNDS; round++) {
    const allowed = await useStdioCommandApprovalStore
      .getState()
      .request({ ...prompt, terms });
    if (!allowed) return false;
    let outcome: Awaited<ReturnType<typeof approveStdioCommand>>;
    try {
      outcome = await approveStdioCommand({
        projectId: prompt.projectId,
        serverId: terms.serverId,
        serverName: prompt.serverName,
        fingerprint: terms.fingerprint,
      });
    } catch {
      // The request never reached the local server.
      outcome = { ok: false, error: APPROVAL_FAILED_MESSAGE, terms: null };
    }
    if (outcome.ok) return true;
    if (!outcome.terms) {
      // The caller keeps the refusal it already holds, so the server stays
      // marked as not approved.
      toast.error(outcome.error);
      return false;
    }
    terms = outcome.terms;
  }
  return false;
}

const inFlight = new Map<string, Promise<boolean>>();

/**
 * True when this device now holds an approval for the server's current
 * command. Concurrent connects or chat columns refused for the same command
 * share one dialog and one approval request.
 */
export function obtainStdioCommandApproval(
  prompt: StdioCommandApprovalPrompt,
): Promise<boolean> {
  const key = `${prompt.terms.serverId}:${prompt.terms.fingerprint}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = askAndApprove(prompt).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/**
 * A chat turn refused because this device has not approved a stdio server's
 * command. A plugin's local component spawns only in a chat, with no Connect
 * to ask from, so the chat asks; the user then sends again. `details` is the
 * refusal's, as the chat's error handler parsed it.
 */
export async function askStdioCommandApprovalForChatError(
  details: unknown,
  projectId: string,
): Promise<void> {
  const terms = readStdioCommandApprovalTerms(details);
  if (!terms) return;
  const serverName = (details as { serverName?: unknown }).serverName;
  const allowed = await obtainStdioCommandApproval({
    projectId,
    serverName: typeof serverName === "string" ? serverName : terms.serverId,
    terms,
  });
  if (allowed)
    toast.success("Allowed on this device. Send your message again.");
}
