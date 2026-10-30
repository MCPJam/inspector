import {
  validateInputRequests,
  type ElicitationCallbackRequest,
  type MrtrInputCollector,
  type TaskInputHandlers,
} from "@mcpjam/sdk";
import {
  specTypeSchemas,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import { z } from "zod/v4";
import { withAbort } from "./forwarding/execution-gate.js";

export type HarnessInputHandler = (
  request: ElicitationCallbackRequest,
  signal: AbortSignal,
) => Promise<ElicitResult>;

const elicitationModes = z
  .object({
    form: z.object({}).strict().optional(),
    url: z.object({}).strict().optional(),
  })
  .strict();

export function harnessElicitationModes(
  capabilities: unknown,
): ("form" | "url")[] {
  const caps = z
    .object({ elicitation: elicitationModes })
    .safeParse(capabilities);
  if (!caps.success) return [];
  const { form, url } = caps.data.elicitation;
  return [
    ...(form || !url ? ["form" as const] : []),
    ...(url ? ["url" as const] : []),
  ];
}

const inputParams = z.object({
  message: z.string(),
  mode: z.enum(["form", "url"]).optional(),
  requestedSchema: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
  elicitationId: z.string().optional(),
});

async function validatedParams(params: unknown) {
  const result = await specTypeSchemas.ElicitRequest["~standard"].validate({
    method: "elicitation/create",
    params,
  });
  if (result.issues) throw new Error("Malformed harness elicitation request");
  return inputParams.parse(params);
}

/** Adapt protocol input to one owned UI handler; SDK drivers still own continuation. */
export function createHarnessInputHost(args: {
  allowedServerIds: ReadonlySet<string>;
  modes: readonly ("form" | "url")[];
  handle: HarnessInputHandler;
  signal: AbortSignal;
}) {
  const answer: HarnessInputHandler = async (request, requestSignal) => {
    const signal = AbortSignal.any([args.signal, requestSignal]);
    if (signal.aborted || !args.modes.includes(request.mode ?? "form"))
      return { action: "cancel" };
    if (!request.serverId || !args.allowedServerIds.has(request.serverId))
      return { action: "decline" };
    const result = await args.handle(request, signal);
    return signal.aborted ? { action: "cancel" } : result;
  };

  const request = async (
    serverId: string,
    requestId: string,
    params: unknown,
    signal: AbortSignal,
    relatedTaskId?: string,
  ) => {
    const parsed = await validatedParams(params);
    return answer(
      {
        serverId,
        requestId,
        message: parsed.message,
        schema: parsed.requestedSchema,
        mode: parsed.mode ?? "form",
        ...(parsed.url !== undefined ? { url: parsed.url } : {}),
        ...(parsed.elicitationId !== undefined
          ? { elicitationId: parsed.elicitationId }
          : {}),
        ...(relatedTaskId !== undefined ? { relatedTaskId } : {}),
      },
      signal,
    );
  };

  const collectMrtrForServer =
    (serverId: string): MrtrInputCollector =>
    async ({ state, inputRequests, signal = args.signal }) => {
      const round = new AbortController();
      const active = AbortSignal.any([args.signal, signal, round.signal]);
      // Reject the entire round before any UI is opened, as the SDK driver does.
      validateInputRequests(inputRequests, args.modes);
      const entries = await Promise.all(
        Object.entries(inputRequests).map(
          async ([key, input]) =>
            [key, await validatedParams(input.params)] as const,
        ),
      );
      active.throwIfAborted();
      const pending = entries.map(
        async ([key, input]) =>
          [
            key,
            await withAbort(
              request(
                serverId,
                JSON.stringify(["mrtr", state.opId, state.round, key]),
                input,
                active,
              ),
              active,
            ),
          ] as const,
      );
      try {
        const responses = await Promise.all(pending);
        active.throwIfAborted();
        return Object.fromEntries(responses);
      } catch (error) {
        round.abort(error);
        await Promise.allSettled(pending);
        throw error;
      }
    };

  const taskHandlers: TaskInputHandlers = {
    elicitation: async (params, context) => {
      const signal = context.signal
        ? AbortSignal.any([args.signal, context.signal])
        : args.signal;
      signal.throwIfAborted();
      const result = await request(
        context.serverId,
        JSON.stringify(["task", context.taskId, context.inputKey]),
        params,
        signal,
        context.taskId,
      );
      signal.throwIfAborted();
      return { ...result };
    },
  };

  const callback = (
    request: ElicitationCallbackRequest,
    signal = args.signal,
  ) => answer(request, signal);
  return { answer, callback, collectMrtrForServer, taskHandlers };
}
