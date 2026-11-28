import { z } from "zod";
import { opaqueIdSchema } from "../contract/identity.js";
import type { ClientActionReceipt } from "../contract/client-action-receipt.js";
import {
  inputAnswerSchema,
  inputAnswersSchema,
} from "../contract/input-answers.js";
import { compileRecordedAppCase } from "../contract/recorded-app-case.js";
import { recordedAppTraceSchema } from "../contract/recorded-app-trace.js";
import type { EvalSuiteFileCaseV2 } from "../contract/suite-file.js";
import { MAX_TEST_STEPS, widgetAssertionSchema } from "../contract/steps.js";
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
  questionReplies: z
    .record(z.string().uuid(), inputAnswerSchema)
    .optional()
    .describe(
      "Saved replies keyed by the recorded question receipt IDs. Form values need to be supplied again."
    ),
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
  projectId?: string,
  openingToolCallId?: string
) {
  const trace = await context.client.getChatSessionTrace(
    { sessionId, projectId, includeSpans: false, includeAppRecording: true, openingToolCallId },
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
      projectId,
      input.toolCallId
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
    const questionAndApproval = [...(trace.clientActions ?? [])]
      .sort((left, right) => left.order - right.order);
    const approvals = questionAndApproval.filter(
      ({ kind }) => kind === "approval"
    );
    const openingApproval = approvals.find(
      (receipt) =>
        receipt.invocationId === input.toolCallId &&
        receipt.outcome === "approved" &&
        receipt.serverId === app.serverId &&
        receipt.toolName === app.toolName
    );
    const denied = approvals.filter((receipt) => receipt !== openingApproval);
    for (const receipt of denied) {
      if (
        receipt.outcome !== "denied" ||
        !openingApproval ||
        receipt.order >= openingApproval.order ||
        !receipt.invocationId ||
        !receipt.toolName ||
        receipt.serverId !== app.serverId
      ) {
        throw operationInputError(
          `Approval ${receipt.id} (${receipt.outcome}) cannot be placed in the recorded app replay.`
        );
      }
    }
    const openingEvidence = trace.recordedAppOpening;
    const allowedCallIds = new Set([input.toolCallId, ...denied.map((receipt) => receipt.invocationId)]);
    if (
      !openingEvidence ||
      openingEvidence.toolCallIds.some((id) => !allowedCallIds.has(id)) ||
      recording.actions.some((step) => step.promptIndex !== openingEvidence.promptIndex)
    ) {
      throw operationInputError(
        "The recording needs a readable opening turn with no additional model actions. Record and replay the app in a single interaction phase."
      );
    }
    const questions = questionAndApproval.filter(
      ({ kind }) => kind === "question"
    );
    const inputAnswers = questions.map((receipt) => {
      const reply = input.questionReplies?.[receipt.id];
      const expected = {
        accept: "accepted",
        decline: "declined",
        cancel: "cancelled",
      } as const;
      if (receipt.invocationId !== input.toolCallId) {
        throw operationInputError(
          `Question ${receipt.id} did not come from the opening call. Only questions with a recorded opening invocation can be replayed.`
        );
      }
      if (
        !receipt.serverId ||
        receipt.serverId !== app.serverId ||
        !receipt.toolName ||
        receipt.toolName !== app.toolName ||
        !reply ||
        expected[reply.action] !== receipt.outcome
      ) {
        throw operationInputError(
          `Client ${receipt.kind} ${receipt.id} (${receipt.outcome}) cannot be replayed for this opening call. Supply a matching saved reply for a recorded question from this call.`
        );
      }
      if (questions.length > 1 && !reply.message) {
        throw operationInputError(
          `Question ${receipt.id} needs a message matcher to distinguish its reply from other questions.`
        );
      }
      return { ...reply, server: input.serverName, tool: app.toolName };
    });
    if (Object.keys(input.questionReplies ?? {}).length !== inputAnswers.length)
      throw operationInputError(
        "The saved replies must name the recorded questions."
      );
    const authored = inputAnswersSchema.parse(inputAnswers);
    const args = input.arguments ?? openingEvidence.arguments;
    if (!args) {
      throw operationInputError(
        "The opening call arguments are missing or truncated. Supply replay arguments."
      );
    }
    const testCase = compileRecordedAppCase({
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
    });
    if (openingApproval || authored.length) {
      const [opening, ...steps] = testCase.steps;
      if (opening.kind !== "toolCall")
        throw operationInputError(
          "The recording has no deterministic opening call."
        );
      testCase.steps = [
        ...denied.map((receipt) => ({
          id: `deny-${receipt.order}`,
          kind: "toolCall" as const,
          ...(input.serverId ? { serverId: input.serverId } : {}),
          serverName: input.serverName,
          toolName: receipt.toolName!,
          arguments: {},
          approval: "deny" as const,
        })),
        {
          ...opening,
          ...(openingApproval ? { approval: "approve" as const } : {}),
          ...(authored.length ? { expectedQuestions: authored.length } : {}),
        },
        ...steps,
      ];
      if (testCase.steps.length > MAX_TEST_STEPS)
        throw operationInputError(
          "The recorded approvals exceed the supported case size."
        );
    }
    return {
      sessionId: trace.sessionId,
      projectId: trace.projectId ?? projectId ?? null,
      case: {
        ...testCase,
        ...(authored.length ? { inputAnswers: authored } : {}),
      },
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

type ClientActionsSummary = {
  attempted: number;
  elapsedMs: number;
  outcomes: Partial<Record<ClientActionReceipt["outcome"], number>>;
};

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
    clientActions?: Partial<
      Record<ClientActionReceipt["kind"], ClientActionsSummary>
    >;
  }
> = {
  name: "summarize_recorded_app_actions",
  title: "Summarize persona app actions across goal-run sessions",
  description:
    "Count recorded app actions and elapsed time, with coverage for sessions without readable evidence.",
  readOnly: true,
  permalink: noPermalink(
    "no-addressable-resource",
    "The totals span several session recordings."
  ),
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
    const clientActions: Partial<
      Record<ClientActionReceipt["kind"], ClientActionsSummary>
    > = {};
    for (const sessionId of ids) {
      try {
        const { recording, trace } = await readRecording(
          context,
          sessionId,
          projectId
        );
        if (!recording && !trace.clientActions?.length) {
          sessions.ungraded++;
          continue;
        }
        sessions.counted++;
        if (recording) {
          actions.attempted += recording.summary.attempted;
          actions.succeeded += recording.summary.succeeded;
          actions.elapsedMs += recording.summary.elapsedMs;
        }
        for (const receipt of trace.clientActions ?? []) {
          const summary = (clientActions[receipt.kind] ??= {
            attempted: 0,
            elapsedMs: 0,
            outcomes: {},
          });
          summary.attempted++;
          summary.elapsedMs += receipt.elapsedMs;
          summary.outcomes[receipt.outcome] =
            (summary.outcomes[receipt.outcome] ?? 0) + 1;
        }
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
    return {
      sessions,
      actions,
      ...(Object.keys(clientActions).length ? { clientActions } : {}),
    };
  },
};
