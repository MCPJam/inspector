import { z } from "zod";
import { opaqueIdSchema } from "../contract/identity.js";
import { compileRecordedAppCase } from "../contract/recorded-app-case.js";
import { recordedAppTraceSchema } from "../contract/recorded-app-trace.js";
import type { EvalSuiteFileCaseV2 } from "../contract/suite-file.js";
import { widgetAssertionSchema } from "../contract/steps.js";
import { PlatformApiError } from "./errors.js";
import { resolveProjectOrThrow } from "./operation-support.js";
import type {
  PlatformOperation,
  PlatformOperationContext,
} from "./operations.js";
import { derivePermalinks, noPermalink } from "./permalinks.js";
import { operationInputError } from "./resource-selectors.js";

const id = z.string().trim().min(1);
const compileInput = z.object({
  sessionId: id.describe("The goal-run session ID."),
  project: id.optional(),
  toolCallId: id.describe("The recorded call that opened the MCP App."),
  caseId: opaqueIdSchema,
  title: id,
  serverName: id,
  serverId: id.optional(),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Opening arguments override. Defaults to the recorded tool input."
    ),
  assertions: z.array(widgetAssertionSchema).min(1),
});

export type CompileRecordedAppCaseInput = z.infer<typeof compileInput>;

async function projectIdFor(
  context: PlatformOperationContext,
  project?: string
) {
  if (!project) return undefined;
  const resolved = await resolveProjectOrThrow(context, project);
  return resolved.project.id;
}

async function readRecording(
  context: PlatformOperationContext,
  sessionId: string,
  projectId?: string
) {
  const trace = await context.client.getChatSessionTrace(
    { sessionId, projectId, includeSpans: false, includeAppRecording: true },
    { signal: context.signal }
  );
  return {
    trace,
    recording:
      trace.appRecording === undefined
        ? undefined
        : recordedAppTraceSchema.parse(trace.appRecording),
  };
}

const toolCallPartSchema = z.object({
  type: z.literal("tool-call"),
  toolCallId: id,
  input: z.record(z.string(), z.unknown()),
});

async function readRecordedArguments(
  context: PlatformOperationContext,
  sessionId: string,
  toolCallId: string,
  projectId?: string
) {
  let offset = 0;
  // Each detail response bounds its transcript window to 200 messages.
  for (let page = 0; page < 5; page++) {
    const trace = await context.client.getChatSession(
      { sessionId, projectId, afterMessageIndex: offset, limit: 200 },
      { signal: context.signal }
    );
    if (trace.transcriptUnavailable) break;
    for (const message of trace.messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content))
        continue;
      for (const part of message.content) {
        const parsed = toolCallPartSchema.safeParse(part);
        if (parsed.success && parsed.data.toolCallId === toolCallId) {
          return parsed.data.input;
        }
      }
    }
    if (
      trace.nextMessageIndex === undefined ||
      trace.nextMessageIndex <= offset
    )
      break;
    offset = trace.nextMessageIndex;
  }
  throw operationInputError(
    "The opening call arguments are missing or truncated. Supply replay arguments."
  );
}

type CompiledRecordedAppCase = {
  sessionId: string;
  projectId: string | null;
  case: EvalSuiteFileCaseV2;
};

export const compileRecordedAppCaseOperation: PlatformOperation<
  CompileRecordedAppCaseInput,
  CompiledRecordedAppCase
> = {
  name: "compile_recorded_app_case",
  title: "Compile a recorded MCP App into an eval case",
  description:
    "Read a goal-run recording and return a model-free eval case with the recorded clicks and selected assertions.",
  readOnly: true,
  permalink: derivePermalinks((result) =>
    result.projectId
      ? [
          {
            type: "chat_session",
            id: result.sessionId,
            projectId: result.projectId,
          },
        ]
      : []
  ),
  inputSchema: compileInput,
  async execute(input, context) {
    const projectId = await projectIdFor(context, input.project);
    const { trace, recording } = await readRecording(
      context,
      input.sessionId,
      projectId
    );
    if (!recording)
      throw operationInputError(
        "This session has no recorded persona app actions."
      );
    if (recording.truncated)
      throw operationInputError(
        "The app recording exceeds the supported eval case size."
      );
    const app = recording.apps.find(
      (entry) => entry.toolCallId === input.toolCallId
    );
    if (!app)
      throw operationInputError(
        "No rendered app matches that tool call in this session."
      );
    const args =
      input.arguments ??
      (await readRecordedArguments(
        context,
        input.sessionId,
        input.toolCallId,
        projectId
      ));
    return {
      sessionId: trace.sessionId,
      projectId: trace.projectId ?? projectId ?? null,
      case: compileRecordedAppCase({
        id: input.caseId,
        title: input.title,
        openingCall: {
          toolCallId: input.toolCallId,
          toolName: app.toolName,
          serverName: input.serverName,
          ...(input.serverId ? { serverId: input.serverId } : {}),
          arguments: args,
        },
        actions: recording.actions,
        assertions: input.assertions,
      }),
    };
  },
};

const summarizeInput = z.object({
  project: id.optional(),
  sessionIds: z
    .array(id)
    .min(1)
    .max(20)
    .describe("Goal-run session IDs. Repeated IDs are counted once."),
});
export type SummarizeRecordedAppActionsInput = z.infer<typeof summarizeInput>;

export const summarizeRecordedAppActionsOperation: PlatformOperation<
  SummarizeRecordedAppActionsInput,
  {
    sessions: {
      requested: number;
      counted: number;
      ungraded: number;
      unavailable: number;
    };
    actions: { attempted: number; succeeded: number; elapsedMs: number };
  }
> = {
  name: "summarize_recorded_app_actions",
  title: "Summarize persona app actions across goal-run sessions",
  description:
    "Count recorded app actions and elapsed time, with coverage for sessions without readable evidence.",
  readOnly: true,
  permalink: noPermalink("no-addressable-resource"),
  inputSchema: summarizeInput,
  async execute({ project, sessionIds }, context) {
    const projectId = await projectIdFor(context, project);
    const ids = [...new Set(sessionIds)];
    const sessions = {
      requested: ids.length,
      counted: 0,
      ungraded: 0,
      unavailable: 0,
    };
    const actions = { attempted: 0, succeeded: 0, elapsedMs: 0 };
    for (const sessionId of ids) {
      try {
        const { recording } = await readRecording(
          context,
          sessionId,
          projectId
        );
        if (!recording) {
          sessions.ungraded++;
          continue;
        }
        sessions.counted++;
        actions.attempted += recording.summary.attempted;
        actions.succeeded += recording.summary.succeeded;
        actions.elapsedMs += recording.summary.elapsedMs;
      } catch (error) {
        if (
          !(error instanceof PlatformApiError) ||
          error.status !== 404 ||
          error.codeSource !== "envelope"
        )
          throw error;
        sessions.unavailable++;
      }
    }
    return { sessions, actions };
  },
};
