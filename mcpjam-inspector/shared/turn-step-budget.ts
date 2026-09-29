/**
 * How many steps one user message may buy, and how to count them from the
 * browser's UI history.
 *
 * A step is one model call. The emulated engine (`runChatEngineLoop`) counts
 * the assistant steps since the last user message ACROSS requests: a turn that
 * pauses for a browser-fulfilled tool and is resumed automatically keeps
 * spending the same budget. So a resumed request that arrives with the budget
 * already spent can run no model call at all — and before the loop guard it
 * answered with an empty, successful response whose last step still looked
 * resumable, which the browser resent every few seconds, indefinitely.
 *
 * Both ends read this file so they cannot disagree about the count:
 *  - the server refuses such a request before connecting anything
 *    (`server/utils/agent-loop-guard.ts`), and
 *  - the browser stops resuming automatically once the budget is spent
 *    (`client/src/lib/chat-auto-resume.ts`).
 *
 * Deliberately dependency-free: it is imported by the client bundle and the
 * server alike, and reads only plain `{ role, parts }` shapes.
 */

/**
 * Steps a chat turn may take per user message when its caller sets no ceiling.
 * Ask MCPJam sets its own, lower one (`AGENT_MAX_STEPS`).
 */
export const DEFAULT_TURN_MAX_STEPS = 30;

/**
 * Consecutive steps whose call to the SAME tool was rejected for its input
 * before a continuation is refused. Two in a row means the model is not
 * correcting the call — typically because the output-token limit cuts it off
 * at the same point every time — and a third attempt costs a model call for
 * the same outcome.
 */
export const REPEATED_TOOL_INPUT_FAILURE_LIMIT = 2;

/** The error code the server answers a refused continuation with. */
export const AGENT_STEP_LIMIT_CODE = "AGENT_STEP_LIMIT";

/** What the user reads when a continuation is refused for its step budget. */
export const STEP_LIMIT_REFUSAL_MESSAGE =
  "This reply reached its step limit, so it was stopped. Send a message to continue.";

/** What the user reads when the model keeps sending a call that cannot run. */
export const REPEATED_TOOL_FAILURE_REFUSAL_MESSAGE =
  "The model kept sending a tool call that could not run, so this reply was stopped. Send a message to continue.";

type PartLike = Record<string, unknown> & { type?: unknown };

function roleOf(message: unknown): unknown {
  return message && typeof message === "object"
    ? (message as { role?: unknown }).role
    : undefined;
}

function partsOf(message: unknown): unknown[] | undefined {
  const parts =
    message && typeof message === "object"
      ? (message as { parts?: unknown }).parts
      : undefined;
  return Array.isArray(parts) ? parts : undefined;
}

/**
 * Whether a UI part lands in a model message. Mirrors the AI SDK's
 * `convertToModelMessages`, which gathers exactly these part types into the
 * block between two `step-start` markers and emits one assistant message per
 * non-empty block — the unit the engine counts as a step.
 */
function isStepContentPart(part: unknown): part is PartLike {
  if (!part || typeof part !== "object") return false;
  const type = (part as { type?: unknown }).type;
  if (typeof type !== "string") return false;
  return (
    type === "text" ||
    type === "reasoning" ||
    type === "file" ||
    type === "dynamic-tool" ||
    type.startsWith("tool-") ||
    type.startsWith("data-")
  );
}

/**
 * The assistant steps since the last user message, oldest first, each as the
 * parts it holds.
 *
 * With no user message at all the answer is empty, matching the engine, which
 * then counts from the end of the history.
 */
export function assistantStepsSincePrompt(
  messages: readonly unknown[],
): PartLike[][] {
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (roleOf(messages[index]) === "user") {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return [];
  const steps: PartLike[][] = [];
  for (const message of messages.slice(start)) {
    if (roleOf(message) !== "assistant") continue;
    const parts = partsOf(message);
    if (!parts) continue;
    let block: PartLike[] = [];
    for (const part of parts) {
      if ((part as { type?: unknown } | null)?.type === "step-start") {
        if (block.length > 0) steps.push(block);
        block = [];
      } else if (isStepContentPart(part)) {
        block.push(part);
      }
    }
    if (block.length > 0) steps.push(block);
  }
  return steps;
}

/** How many steps the current user message has already bought. */
export function countAssistantStepsSincePrompt(
  messages: readonly unknown[],
): number {
  return assistantStepsSincePrompt(messages).length;
}

/**
 * True when the request continues a turn rather than starting one: the last
 * message is the assistant's, so no new user message came with it. Automatic
 * resumes and approval answers look like this; a typed message never does.
 */
export function isTurnContinuation(messages: readonly unknown[]): boolean {
  return roleOf(messages[messages.length - 1]) === "assistant";
}

/** The AI SDK's `InvalidToolInputError` message, unanchored because some
 *  providers wrap it in their own envelope. */
const INVALID_TOOL_INPUT_PATTERN = /Invalid input for tool\b/;

function toolNameOf(part: PartLike): string | undefined {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : undefined;
  }
  return typeof part.type === "string" && part.type.startsWith("tool-")
    ? part.type.slice("tool-".length)
    : undefined;
}

/**
 * A tool call the SDK refused before it ran because its input did not parse or
 * validate — the shape an output-token cut-off leaves when the provider still
 * closes the call. Never a call that ran and failed: that is the tool's own
 * answer, and a model retrying it is ordinary.
 */
export function isRejectedToolInputPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const candidate = part as PartLike;
  if (candidate.state !== "output-error") return false;
  if (!toolNameOf(candidate)) return false;
  const errorText =
    typeof candidate.errorText === "string" ? candidate.errorText : "";
  if (INVALID_TOOL_INPUT_PATTERN.test(errorText)) return true;
  // A static part minted from `tool-input-error` keeps the unparsed input
  // aside as `rawInput` and never gets a parsed `input`.
  return (
    candidate.type !== "dynamic-tool" &&
    "rawInput" in candidate &&
    candidate.input === undefined
  );
}

/**
 * The tool whose input was rejected in each of the last `limit` steps, or
 * `null`. Only a run of the SAME tool counts: a model that moves on to a
 * different call is not stuck.
 */
export function repeatedToolInputFailure(
  messages: readonly unknown[],
  limit: number = REPEATED_TOOL_INPUT_FAILURE_LIMIT,
): { toolName: string; steps: number } | null {
  const steps = assistantStepsSincePrompt(messages);
  if (limit < 1 || steps.length < limit) return null;
  const rejectedIn = (step: PartLike[]) =>
    new Set(
      step
        .filter(isRejectedToolInputPart)
        .map((part) => toolNameOf(part))
        .filter((name): name is string => Boolean(name)),
    );
  const last = rejectedIn(steps[steps.length - 1]!);
  for (const toolName of last) {
    let run = 1;
    for (let index = steps.length - 2; index >= 0; index -= 1) {
      if (!rejectedIn(steps[index]!).has(toolName)) break;
      run += 1;
    }
    if (run >= limit) return { toolName, steps: run };
  }
  return null;
}
