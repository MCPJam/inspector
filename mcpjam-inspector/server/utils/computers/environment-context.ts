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
      lines.push(step.name ? `- ${step.name}: \`${step.run}\`` : `- \`${step.run}\``);
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
