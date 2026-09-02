/**
 * Blueprint runtime context for chat turns: when the acting user's computer
 * boots from a blueprint image, its `knowledge` entries and `maintenance`
 * commands are appended to the turn's system prompt so the model knows how to
 * use the machine it was given.
 *
 * Mirrors `harness/runtime-skills.ts`: tri-state fetch (`{ ok: false }` on ANY
 * failure — a Convex blip degrades to "no extra context", never a broken
 * turn), and the scoped query is used whenever the turn carries an
 * `executionScope` so the backend re-resolves guest/swarm access.
 */
import { logger } from "../logger.js";
import type { ExecutionScope } from "../execution-scope.js";
import type { SandboxNoticeReason } from "@/shared/sandbox-notice";
import {
  convexGetEnvironmentRuntimeContext,
  convexGetEnvironmentRuntimeContextForExecution,
  type EnvironmentRuntimeContext,
} from "./convex-environment-client.js";

export type FetchEnvironmentContextResult =
  | { ok: true; context: EnvironmentRuntimeContext | null }
  | { ok: false };

export async function fetchEnvironmentContext(
  bearer: string,
  projectId: string,
  executionScope?: ExecutionScope,
): Promise<FetchEnvironmentContextResult> {
  try {
    const context = executionScope
      ? await convexGetEnvironmentRuntimeContextForExecution(
          bearer,
          executionScope,
        )
      : await convexGetEnvironmentRuntimeContext(bearer, projectId);
    return { ok: true, context };
  } catch (error) {
    logger.warn(
      "[environment-context] fetch failed; continuing without image context",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return { ok: false };
  }
}

/**
 * Render the context as a system-prompt block. Knowledge is verbatim
 * model-facing text; maintenance is explicitly framed as reference commands
 * the agent may run itself via bash — never auto-executed.
 */
export function formatEnvironmentContextPrompt(
  context: EnvironmentRuntimeContext,
): string {
  const lines: string[] = [
    `## Computer image: ${context.imageName}`,
    "",
    "Your bash tool runs on a computer booted from this custom image.",
  ];
  if (context.knowledge.length > 0) {
    lines.push("", "### Knowledge");
    for (const entry of context.knowledge) {
      lines.push("", `#### ${entry.name}`, "", entry.contents.trimEnd());
    }
  }
  if (context.maintenance.length > 0) {
    lines.push(
      "",
      "### Maintenance commands",
      "",
      "Listed for reference; they are NEVER run automatically. If project " +
        "dependencies look stale or missing, run the relevant ones yourself " +
        "via bash.",
      "",
    );
    for (const step of context.maintenance) {
      lines.push(
        step.name ? `- ${step.name}: \`${step.run}\`` : `- \`${step.run}\``,
      );
    }
  }
  return lines.join("\n");
}

/**
 * The one helper chat routes call: when the turn advertises a bash tool,
 * fetch the acting user's environment context and append it to the system
 * prompt. Returns the prompt unchanged on no-context or fetch failure.
 */
export async function maybeAppendEnvironmentContext(args: {
  systemPrompt: string | undefined;
  hasBashTool: boolean;
  bearer: string | undefined;
  projectId: string | undefined;
  executionScope?: ExecutionScope;
}): Promise<string | undefined> {
  if (!args.hasBashTool || !args.bearer || !args.projectId) {
    return args.systemPrompt;
  }
  const result = await fetchEnvironmentContext(
    args.bearer,
    args.projectId,
    args.executionScope,
  );
  if (!result.ok || !result.context) return args.systemPrompt;
  const block = formatEnvironmentContextPrompt(result.context);
  return args.systemPrompt ? `${args.systemPrompt}\n\n${block}` : block;
}

/**
 * Model-facing copy for a scenario sandbox notice.
 *
 * Separate from the client toast copy (`use-chat-session.ts`) on purpose: the
 * user needs to know what happened, the model needs to know what to DO about
 * it. Re-using one string for both would leave the model with a status update
 * and no instruction.
 */
const SANDBOX_NOTICE_MODEL_CONTEXT: Record<SandboxNoticeReason, string> = {
  sandbox_reset:
    "This conversation's sandbox was RESET since the last turn — it is a " +
    "fresh machine. Any files you created, packages you installed, or " +
    "processes you started earlier in this conversation are GONE, even " +
    "though the transcript above says you made them. Do not assume anything " +
    "from earlier turns still exists on disk: re-check with bash before " +
    "relying on it, and tell the user plainly if work has to be redone.",
  stale_image:
    "This conversation's sandbox was booted from an older build of the " +
    "environment image; a newer build exists but was deliberately not " +
    "swapped in, to preserve your shell state. If a tool or package seems " +
    "to be missing or out of date, that is why.",
  sandbox_unavailable:
    "This conversation normally runs bash in a disposable cloud sandbox, " +
    "but the server handling this turn cannot execute one, so you have NO " +
    "bash tool this conversation. Do not claim to have run commands or " +
    "inspected files; if a step needs a shell, say plainly that it can't be " +
    "done here.",
  secrets_undelivered:
    "This environment selects one or more MATERIALIZED project secrets, but " +
    "this conversation has no project-provisioned sandbox to receive them, so " +
    "they were NOT set and no command you run can see them. Do not try to " +
    "work around it by asking the user to paste a credential into the chat. " +
    "If a step needs one of those secrets, say plainly that it is unavailable " +
    "in this conversation.",
  secrets_unavailable:
    "This turn could not read the project's secrets, so you have NO bash " +
    "tool for it. The sandbox itself is intact and untouched — the shell is " +
    "withheld only because this conversation's box may still hold a " +
    "credential from an earlier turn and nothing this turn can enumerate " +
    "would redact it from the transcript. Do not claim to have run commands " +
    "or inspected files. If a step needs a shell, say plainly that it is " +
    "unavailable for this turn and that it should work again shortly; do not " +
    "ask the user to paste a credential into the chat instead.",
};

/**
 * Append the turn's sandbox notices to the system prompt as model-facing
 * context. Returns the prompt unchanged when there are none.
 *
 * Caller must pass only notices that were actually derived for THIS turn — they
 * are one-time facts, and repeating "your sandbox was reset" on every
 * subsequent turn would be its own kind of lie.
 */
export function appendSandboxNoticeContext(
  systemPrompt: string | undefined,
  notices: SandboxNoticeReason[] | undefined,
): string | undefined {
  if (!notices?.length) return systemPrompt;
  const block = [
    "## Sandbox state",
    "",
    ...notices.map((reason) => SANDBOX_NOTICE_MODEL_CONTEXT[reason]),
  ].join("\n");
  return systemPrompt ? `${systemPrompt}\n\n${block}` : block;
}
