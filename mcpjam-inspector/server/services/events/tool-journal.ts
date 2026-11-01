/**
 * The tool journal of one event run (C6). Every tool call is recorded before
 * and after it runs, so a resumed run replays a finished call instead of
 * repeating it, and a call whose outcome is unknown parks the run.
 */

import type { ModelMessage, ToolSet } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import { StaleLeaseError, ToolOutcomeUnknownError } from "./backend-client.js";

/** Progressive discovery meta-tools: pure reads of the catalog, not journaled. */
const CATALOG_META_TOOLS = new Set(["search_mcp_tools", "load_mcp_tools"]);

/** Thrown inside a tool when the run must stop (the turn is aborted too). */
export class EventRunHaltError extends Error {
  constructor(
    readonly reason: "tool_outcome_unknown" | "lease_lost" | "checkpoint_failed",
  ) {
    super(
      reason === "tool_outcome_unknown"
        ? "A tool call from an earlier attempt of this run has an unknown outcome; the run is parked instead of repeating it."
        : reason === "checkpoint_failed"
          ? "The run's checkpoint could not be saved, so no further tool may run."
          : "This executor lost the run's lease.",
    );
    this.name = "EventRunHaltError";
  }
}

/** One tool call the model asked for, as a checkpoint records it. */
export interface EventRunToolIntent {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** Every tool-call / tool-result id a message list mentions. */
export function toolCallIdsIn(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const id = (part as { toolCallId?: unknown } | null)?.toolCallId;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

export interface ToolJournalPort {
  beginCall(args: {
    runId: string;
    token: string;
    callId: string;
    operation: string;
    input: unknown;
    replayable: boolean;
  }): Promise<{ replay: boolean; result?: unknown }>;
  finishCall(args: {
    runId: string;
    token: string;
    callId: string;
    result: unknown;
  }): Promise<void>;
}

const DENIED_WRITE_RESULT = {
  content: [
    {
      type: "text",
      text: "Denied by the trigger's approval policy (deny_writes): this tool is not declared read-only.",
    },
  ],
  isError: true,
};

/** Tool names declared `readOnlyHint: true` on every server that offers them. */
export function readOnlyToolNames(
  manager: Pick<MCPClientManager, "getAllToolAnnotations">,
  serverIds: string[],
): Set<string> {
  const readOnly = new Set<string>();
  const notReadOnly = new Set<string>();
  for (const serverId of serverIds) {
    let annotations: Record<string, Record<string, unknown> | undefined> = {};
    try {
      annotations = manager.getAllToolAnnotations(serverId);
    } catch {
      annotations = {};
    }
    for (const [name, value] of Object.entries(annotations)) {
      if (value?.readOnlyHint === true) readOnly.add(name);
      else notReadOnly.add(name);
    }
  }
  for (const name of notReadOnly) readOnly.delete(name);
  return readOnly;
}

/**
 * Journal every tool call of one run (C6). Mutates and returns `tools`.
 *
 * `halt` is called — and an {@link EventRunHaltError} thrown — when the
 * journal says the run must stop: `tool_outcome_unknown` (park) or a lost
 * lease (someone else owns the run now).
 *
 * A call that is not replayable runs only once its intent is durable:
 * `ensureDurable` resolves when a checkpoint the backend acknowledged names
 * the call, so a worker that dies after the effect resumes from a checkpoint
 * that still holds the call, and the journal replays its result instead of
 * the model asking again under a new id. Once the run has halted (`halted`
 * returns a reason) no tool runs at all.
 */
export function wrapToolsForEventRun(
  tools: ToolSet,
  options: {
    journal: ToolJournalPort;
    runId: string;
    token: string;
    approvalPolicy: "deny_writes" | "auto_deny";
    readOnlyTools?: ReadonlySet<string>;
    halt: (reason: EventRunHaltError["reason"]) => void;
    halted?: () => EventRunHaltError["reason"] | undefined;
    ensureDurable?: (intent: EventRunToolIntent) => Promise<void>;
  },
): ToolSet {
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute;
    if (typeof execute !== "function") continue;
    if (CATALOG_META_TOOLS.has(name)) continue;
    const readOnly = options.readOnlyTools?.has(name) === true;
    definition.execute = async (input: unknown, callOptions) => {
      if (options.approvalPolicy === "deny_writes" && !readOnly) {
        // Denied before any effect, so there is nothing to journal.
        return DENIED_WRITE_RESULT;
      }
      const callId = callOptions?.toolCallId;
      if (!callId) throw new Error("Event run tool call has no identity.");
      const stopped = options.halted?.();
      if (stopped) throw new EventRunHaltError(stopped);
      // Intent before effect. A read-only call may simply run again.
      if (!readOnly && options.ensureDurable) {
        await options.ensureDurable({
          toolCallId: callId,
          toolName: name,
          input: input ?? null,
        });
      }
      let begun: { replay: boolean; result?: unknown };
      try {
        begun = await options.journal.beginCall({
          runId: options.runId,
          token: options.token,
          callId,
          operation: name,
          input: input ?? null,
          replayable: readOnly,
        });
      } catch (error) {
        if (error instanceof ToolOutcomeUnknownError) {
          options.halt("tool_outcome_unknown");
          throw new EventRunHaltError("tool_outcome_unknown");
        }
        if (error instanceof StaleLeaseError) {
          options.halt("lease_lost");
          throw new EventRunHaltError("lease_lost");
        }
        throw error;
      }
      if (begun.replay) return begun.result;
      const result: unknown = await execute(input, callOptions);
      try {
        await options.journal.finishCall({
          runId: options.runId,
          token: options.token,
          callId,
          result: result ?? null,
        });
      } catch (error) {
        if (error instanceof StaleLeaseError) {
          options.halt("lease_lost");
          throw new EventRunHaltError("lease_lost");
        }
        throw error;
      }
      return result;
    };
  }
  return tools;
}
