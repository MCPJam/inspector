/**
 * The input of a call an ACP runtime asks permission for.
 *
 * The ACP adapter holds each tool call's updates for up to a
 * second while it looks for a host-tool match, but answers a permission
 * request at once: the call it emits for the prompt then carries no input, so
 * an approval could not name the MCP server, tool and arguments it is for. The
 * raw ACP updates are emitted unbuffered, and Cursor sends the `rawInput`
 * update before it asks, so the input is restored from the latest one.
 * Exact call inputs survive approval pauses; a fresh prompt or result clears them.
 */
import type {
  HarnessV1,
  HarnessV1Session,
  HarnessV1PromptTurnOptions,
  HarnessV1ContinueTurnOptions,
} from "@ai-sdk/harness";
import { z } from "zod";
import { preserveLifecycleDataField } from "./lifecycle-data-field.js";

const MAX_TRACKED_CALLS = 256;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `{ toolCallId, rawInput }` from a raw ACP `tool_call` or `tool_call_update`. */
function rawToolInput(
  rawValue: unknown,
): { toolCallId: string; rawInput: Record<string, unknown> } | undefined {
  const update = record(rawValue);
  if (
    update?.sessionUpdate !== "tool_call" &&
    update?.sessionUpdate !== "tool_call_update"
  )
    return undefined;
  const rawInput = record(update.rawInput);
  return typeof update.toolCallId === "string" &&
    rawInput &&
    Object.keys(rawInput).length > 0
    ? { toolCallId: update.toolCallId, rawInput }
    : undefined;
}

const CACHE = "mcpjamAcpApprovalInputs";
const cacheSchema = z
  .array(z.object({ toolCallId: z.string(), input: z.string() }))
  .max(MAX_TRACKED_CALLS)
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024,
    "Cursor approval inputs exceed the continuation limit.",
  );

export function withAcpPermissionCallInput<T extends HarnessV1>(harness: T): T {
  return new Proxy(harness, {
    get(target, key) {
      if (key === "lifecycleStateSchema" && target.lifecycleStateSchema)
        return preserveLifecycleDataField(
          target.lifecycleStateSchema,
          CACHE,
          cacheSchema,
        );
      const value = Reflect.get(target, key);
      if (key !== "doStart")
        return typeof value === "function" ? value.bind(target) : value;
      return async (options: Parameters<T["doStart"]>[0]) => {
        const data = record(options.continueFrom?.data);
        const inputs = new Map(
          cacheSchema
            .parse(data?.[CACHE] ?? [])
            .map(
              ({ toolCallId, input }) =>
                [
                  toolCallId,
                  z.record(z.string(), z.unknown()).parse(JSON.parse(input)),
                ] as const,
            ),
        );
        const cacheEntries = () =>
          [...inputs].map(([toolCallId, rawInput]) => ({
            toolCallId,
            input: JSON.stringify(rawInput),
          }));
        const session = await target.doStart(options);
        const wrapTurn = (
          turn: HarnessV1PromptTurnOptions | HarnessV1ContinueTurnOptions,
          fresh: boolean,
        ) => {
          if (fresh) inputs.clear();
          return (part: Parameters<typeof turn.emit>[0]) => {
            if (part.type === "raw") {
              const seen = rawToolInput(part.rawValue);
              if (seen) {
                inputs.set(seen.toolCallId, seen.rawInput);
                if (!cacheSchema.safeParse(cacheEntries()).success) {
                  turn.emit({
                    type: "error",
                    error: new Error(
                      "Cursor approval inputs exceed the continuation limit. Start a new run.",
                    ),
                  });
                  return;
                }
              }
            } else if (part.type === "tool-call" && part.input === "{}") {
              const rawInput = inputs.get(part.toolCallId);
              if (rawInput) {
                const corrected = { ...part, input: JSON.stringify(rawInput) };
                for (const symbol of Object.getOwnPropertySymbols(part)) {
                  const descriptor = Object.getOwnPropertyDescriptor(
                    part,
                    symbol,
                  );
                  if (descriptor)
                    Object.defineProperty(corrected, symbol, descriptor);
                }
                turn.emit(corrected);
                return;
              }
            } else if (part.type === "tool-result")
              inputs.delete(part.toolCallId);
            turn.emit(part);
          };
        };
        return new Proxy(session, {
          get(inner, method) {
            if (method === "doPromptTurn")
              return (turn: HarnessV1PromptTurnOptions) =>
                inner.doPromptTurn({ ...turn, emit: wrapTurn(turn, true) });
            if (method === "doContinueTurn")
              return (turn: HarnessV1ContinueTurnOptions) =>
                inner.doContinueTurn({ ...turn, emit: wrapTurn(turn, false) });
            if (method === "doSuspendTurn")
              return async () => {
                const state = await inner.doSuspendTurn();
                const continuation = {
                  ...state,
                  data: {
                    ...z.record(z.string(), z.unknown()).parse(state.data),
                    [CACHE]: cacheSchema.parse(cacheEntries()),
                  },
                };
                return continuation;
              };
            const member = Reflect.get(inner, method);
            return typeof member === "function" ? member.bind(inner) : member;
          },
        }) satisfies HarnessV1Session;
      };
    },
  });
}
