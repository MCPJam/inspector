import type { MetadataSnapshot } from "./eval-tool-metadata";
import { isDescribeTarget } from "./describe-surface";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateId } from "ai";
import { z } from "zod";
import { stepsSchema, mintCaseId } from "@mcpjam/sdk/contract";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import { deriveQuery, deriveExpectedToolCalls } from "@/shared/steps";
import {
  getEvalDraft,
  isEvalContextReady,
  getEvalSuite,
  evalSuiteKey,
  useEvalGeneration,
} from "./eval-workspace";

const proposalSchema = z.object({
  subject: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(300),
  revision: z.string().min(1),
  cases: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        expectedOutput: z.string().trim().min(1).max(1000).optional(),
        steps: stepsSchema.refine(
          (steps) =>
            steps.length > 0 &&
            steps.some((s) => s.kind === "prompt" && s.prompt.trim()) &&
            new Set(steps.map((s) => s.id)).size === steps.length,
          "Provide valid, uniquely identified steps and a user prompt.",
        ),
      }),
    )
    .min(1)
    .max(5),
});
type Proposal = z.infer<typeof proposalSchema> & {
  id: string;
  target: string;
  metadataEnvironmentKey?: string;
  toolContracts?: string;
};
export interface DescribeFlow {
  phase: "describing" | "clarifying" | "proposed" | "reviewing";
  questionUsed: boolean;
  needsResume?: boolean;
  requestedCount?: number;
  question?: string;
  proposal?: Proposal;
  createdIds?: string[];
}
export const useDescribeFlow = create<{
  sessions: Record<string, DescribeFlow>;
}>()(
  persist(() => ({ sessions: {} }), {
    name: "mcpjam:describe-flow:v1",
    partialize: (state) => ({
      sessions: Object.fromEntries(Object.entries(state.sessions).slice(-30)),
    }),
  }),
);
function put(session: string, state: DescribeFlow) {
  useDescribeFlow.setState((s) => ({
    sessions: { ...s.sessions, [session]: state },
  }));
}
export function setDescribeNeedsResume(session: string, needsResume: boolean) {
  const flow = useDescribeFlow.getState().sessions[session];
  if (flow) put(session, { ...flow, needsResume });
}
function read(session: string) {
  const state = useDescribeFlow.getState().sessions[session];
  if (!state) throw new Error("Describe what you want to test first.");
  return state;
}
function target(scope: EvalAgentScope) {
  return JSON.stringify([
    scope.projectId,
    scope.suiteId,
    scope.caseId,
    scope.id,
  ]);
}
export function beginDescribe(session: string, text: string) {
  if (!text.trim()) throw new Error("Describe what you want to test.");
  const previous = useDescribeFlow.getState().sessions[session];
  const match = text.match(
    /\b([1-5]|one|two|three|four|five)\s+(?:[\w-]+\s+){0,2}tests?\b/i,
  );
  const words = ["one", "two", "three", "four", "five"];
  const requestedCount = match
    ? Number(match[1]) || words.indexOf(match[1].toLowerCase()) + 1
    : previous?.requestedCount ?? 1;
  put(session, {
    phase: "describing",
    questionUsed: previous?.questionUsed ?? false,
    requestedCount,
  });
}
export function askDescribeQuestion(session: string, question: string) {
  const state = read(session);
  if (state.questionUsed)
    throw new Error(
      "Only one follow-up is allowed. Prepare the proposal using the user's answer and tool metadata.",
    );
  if (state.phase !== "describing")
    throw new Error("A question is unavailable in this phase.");
  put(session, {
    ...state,
    phase: "clarifying",
    questionUsed: true,
    question: z.string().trim().min(1).max(180).parse(question),
  });
  return {
    status: "awaiting_answer",
    instruction: "Stop this turn. The user will answer in the composer.",
  };
}
/** Pin only referenced contracts: another server finishing must not stale a proposal. */
function toolContracts(
  cases: z.infer<typeof proposalSchema>["cases"],
  metadata?: MetadataSnapshot,
) {
  if (!metadata) return undefined;
  return JSON.stringify(
    cases.flatMap((draft) =>
      draft.steps.flatMap((step) => {
        if (step.kind !== "toolCall") return [];
        const serverId = step.serverId ?? step.serverName;
        const server = metadata.servers.find(
          (server) => server.serverId === serverId && server.status === "ready",
        );
        const tool = server?.tools.find((tool) => tool.name === step.toolName);
        if (!tool)
          throw new Error(
            `The tool ${step.toolName} is not available on ${serverId}. Wait for its tools or retry the connection.`,
          );
        return [{ serverId, name: tool.name, inputSchema: tool.inputSchema }];
      }),
    ),
  );
}
export function proposeDescribeCases(
  session: string,
  scope: EvalAgentScope,
  input: unknown,
) {
  const state = read(session);
  if (state.phase !== "describing")
    throw new Error(
      "Wait for the user's description or answer before proposing cases.",
    );
  const parsed = proposalSchema.parse(input);
  if (state.requestedCount && parsed.cases.length !== state.requestedCount)
    throw new Error(
      `Requested count is ${state.requestedCount}; propose exactly that many cases.`,
    );
  const context = getEvalDraft(scope).read();
  if (!isEvalContextReady(scope))
    throw new Error(
      "Tools are still unavailable. Retry the connection before preparing tests.",
    );
  if (context.revision !== parsed.revision)
    throw new Error("Draft changed. Read context again.");
  parsed.cases = parsed.cases.map((draft) => ({
    ...draft,
    expectedOutput: draft.expectedOutput ?? parsed.summary,
  }));
  const contracts = toolContracts(parsed.cases, context.metadata);
  const id = generateId();
  put(session, {
    ...state,
    phase: "proposed",
    questionUsed: true,
    proposal: {
      ...parsed,
      id,
      target: target(scope),
      metadataEnvironmentKey: context.metadata?.environmentKey,
      toolContracts: contracts,
    },
  });
  return id;
}
/** Application action only: deliberately never registered as an agent tool. */
export function createDescribeCases(
  session: string,
  scope: EvalAgentScope,
  proposalId: string,
) {
  if (!isDescribeTarget(scope))
    throw new Error("Proposal target is unavailable. Return to Describe.");
  const state = read(session);
  const proposal = state.proposal;
  if (!proposal || proposal.id !== proposalId)
    throw new Error("Proposal changed. Review the current proposal.");
  if (proposal.target !== target(scope))
    throw new Error("Proposal target changed. Return to Describe.");
  if (state.phase === "reviewing") return;
  if (state.phase !== "proposed")
    throw new Error("Review a proposal before creating cases.");
  const bridge = getEvalDraft(scope);
  const context = bridge.read();
  if (context.metadata?.environmentKey !== proposal.metadataEnvironmentKey)
    throw new Error(
      "Tools changed. Describe the test again to prepare an updated proposal.",
    );
  if (!isEvalContextReady(scope))
    throw new Error(
      "Tools are unavailable. Retry the connection before creating tests.",
    );
  if (
    toolContracts(proposal.cases, context.metadata) !== proposal.toolContracts
  )
    throw new Error(
      "Tools changed. Describe the test again to prepare an updated proposal.",
    );
  if (context.revision !== proposal.revision)
    throw new Error(
      "Draft changed. Describe the change again to prepare an updated proposal.",
    );
  let createdIds: string[] = [];
  if (proposal.cases.length === 1) {
    bridge.edit(proposal.revision, proposal.cases[0]);
  } else {
    getEvalSuite(scope);
    const drafts = proposal.cases.map((draft, index) => ({
      id: `describe-${proposal.id}-${index}`,
      revision: generateId(),
      input: {
        ...draft,
        suiteId: scope.suiteId,
        caseId: mintCaseId(),
        models: [],
        runs: 1,
        isNegativeTest: false,
        query: deriveQuery(draft.steps),
        expectedToolCalls: deriveExpectedToolCalls(draft.steps),
      },
    }));
    createdIds = drafts.map((d) => d.id);
    const key = evalSuiteKey(scope);
    useEvalGeneration.setState((s) => ({
      suites: {
        ...s.suites,
        [key]: {
          ...s.suites[key],
          status: s.suites[key]?.status ?? "ready",
          drafts: [...(s.suites[key]?.drafts ?? []), ...drafts],
        },
      },
    }));
  }
  put(session, { ...state, phase: "reviewing", createdIds });
}
